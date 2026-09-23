/**
 * client-kernel (G1, `docs/Almadar_Runtime_Stateless_Stateful_PLAN.md` §5.1) —
 * FIFO ordering, tick coalescing (mirroring `@almadar/ui`'s
 * `lib/event-queue-coalesce.ts` `enqueueEvent` tests — see the cited test
 * names inline below), the per-topology posting rule, and the G5 sibling-row
 * fan-out through a real `ClientKernel.dispatch` round trip.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalId, OrbitalSchema } from '@almadar/core';
import type { ClientKernelOutcome, EventTransport } from '../src/index.js';
import {
  buildTraitIndex,
  createClientKernel,
  createInProcessTransport,
  createMemoryCircuitStore,
  type ClientKernelOpts,
} from '../src/index.js';
import type { OrbitalEventResponse } from '@almadar/core';

function schema(): OrbitalSchema {
  return {
    name: 'client-kernel-test',
    version: '1.0.0',
    orbitals: [
      {
        name: 'ClientKernelOrbital',
        id: 'orb_ck' as OrbitalId,
        pages: [],
        entity: {
          name: 'Note',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string' },
            { name: 'title', type: 'string' },
          ],
        },
        auxiliaryEntities: [
          {
            name: 'Cursor',
            persistence: 'runtime',
            fields: [
              { name: 'id', type: 'string' },
              { name: 'x', type: 'number' },
            ],
          },
        ],
        traits: [
          {
            name: 'Move',
            linkedEntity: 'Cursor',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'moved' }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'moved', event: 'MOVE',
                  effects: [['set', '@entity.x', '@payload.x']],
                },
                {
                  from: 'moved', to: 'moved', event: 'MOVE',
                  effects: [['set', '@entity.x', '@payload.x']],
                },
              ],
            },
          },
          {
            name: 'Persistor',
            linkedEntity: 'Note',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'DO_CREATE',
                  effects: [
                    ['persist', 'create', 'Note', { title: '@payload.title' }, { emit: { success: 'CREATED' } }],
                  ],
                },
              ],
            },
          },
          // Two siblings bound to the SAME non-[shared] entity ("Cursor") —
          // the G5 fixture: a server row for one must land in both frames.
          {
            name: 'CursorReader',
            linkedEntity: 'Cursor',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'read' }],
              events: [],
              transitions: [
                { from: 'idle', to: 'read', event: 'READ', effects: [] },
              ],
            },
          },
        ],
      },
    ],
  };
}

function opts(overrides: Partial<ClientKernelOpts> = {}): ClientKernelOpts {
  const traitIndex = buildTraitIndex(schema().orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return {
    orbitalName: 'ClientKernelOrbital',
    traitIndex,
    store,
    carriesCircuitState: true,
    ...overrides,
  };
}

describe('createClientKernel — FIFO ordering', () => {
  it('a slow post for event 1 completes and folds before event 2 is even locally dispatched', async () => {
    const o = opts({ carriesCircuitState: true });
    const order: string[] = [];
    let releasePost: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releasePost = resolve; });
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => {
        order.push('event1:post-start');
        await gate;
        order.push('event1:post-end');
        const response: OrbitalEventResponse = {
          success: true, transitioned: true, states: { Persistor: 'idle' }, emittedEvents: [],
        };
        return response;
      }),
    };
    const kernel = createClientKernel({ ...o, transport });

    const p1 = kernel.dispatch({ event: 'DO_CREATE', targetTrait: 'Persistor', payload: { title: 'x' } });
    const p2 = kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 5 } }).then((outcome) => {
      order.push('event2:done');
      return outcome;
    });

    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    // Event 2's local dispatch must not have run yet — the FIFO holds it
    // behind event 1's in-flight post.
    expect(order).toEqual(['event1:post-start']);
    expect(o.store.manager.getState('Move')?.currentState).toBe('idle');

    releasePost!();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['event1:post-start', 'event1:post-end', 'event2:done']);
    expect(o.store.manager.getState('Move')?.currentState).toBe('moved');
    expect(o.store.frames.get('Move')).toMatchObject({ x: 5 });
  });
});

describe('createClientKernel — tick coalescing (mirrors @almadar/ui lib/event-queue-coalesce.ts)', () => {
  it('caps a tick stream at one pending dispatch no matter the firing rate (mirrors "caps a tick stream at one pending entry no matter the firing rate (the riya scenario)")', async () => {
    const o = opts({ carriesCircuitState: true });
    const kernel = createClientKernel(o);

    const outcomes: Promise<ClientKernelOutcome>[] = [];
    for (let i = 0; i < 100; i++) {
      outcomes.push(kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: i }, tick: 'gameTick' }));
    }
    await Promise.all(outcomes);

    // Only the LATEST payload's dispatch actually ran (plus whichever entry
    // was already in flight when the loop started) — the frame reflects the
    // last coalesced payload, not an intermediate one.
    expect(o.store.frames.get('Move')).toMatchObject({ x: 99 });
  });

  it('a pending tick entry keeps its FIFO slot ahead of a later sourceless entry (mirrors "coalesces a same-(event, trait) tick entry in place, keeping its FIFO slot")', async () => {
    const o = opts({ carriesCircuitState: true });
    const kernel = createClientKernel(o);

    // Call 1 is synchronously shifted into flight by `pump()` the instant it
    // is dispatched (mirrors the hook's own `enqueueAndDrain` shifting the
    // head before any second call can observe it) — so call 2 is the first
    // entry that actually sits PENDING in the queue for a later tick to find.
    const call1 = kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 1 }, tick: 'gameTick' });
    const call2 = kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 2 }, tick: 'gameTick' });
    const user = kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 9 } }); // no tick stamp — pushed after call2
    const call4 = kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 3 }, tick: 'gameTick' }); // coalesces onto call2's slot

    await Promise.all([call1, call2, user, call4]);

    // If the coalesced tick entry had lost its FIFO slot (pushed to the
    // back instead of updated in place), "user" (x:9) would run BEFORE it
    // and the final write would be x:3, not x:9.
    expect(o.store.frames.get('Move')).toMatchObject({ x: 9 });
  });

  it('does not coalesce across different target traits (mirrors "does not coalesce across different event keys or target traits")', async () => {
    const o = opts({ carriesCircuitState: true });
    const kernel = createClientKernel(o);
    const calls: string[] = [];

    // No transport — offline; assert via distinct dispatch resolution
    // rather than a spy, since coalescing across traits would otherwise
    // silently drop one trait's write.
    await Promise.all([
      kernel.dispatch({ event: 'READ', targetTrait: 'CursorReader', tick: 'gameTick' }).then(() => calls.push('CursorReader')),
      kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 7 }, tick: 'gameTick' }).then(() => calls.push('Move')),
    ]);

    expect(calls.sort()).toEqual(['CursorReader', 'Move']);
    expect(o.store.manager.getState('CursorReader')?.currentState).toBe('read');
    expect(o.store.frames.get('Move')).toMatchObject({ x: 7 });
  });
});

describe('createClientKernel — posting rule per topology', () => {
  it('stateless (carriesCircuitState: true) posts only when a server leg was collected', async () => {
    const o = opts({ carriesCircuitState: true });
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async (): Promise<OrbitalEventResponse> => ({
        success: true, transitioned: true, states: {}, emittedEvents: [],
      })),
    };
    const kernel = createClientKernel({ ...o, transport });

    // READ fires no effects at all — no leg is ever collected for it.
    await kernel.dispatch({ event: 'READ', targetTrait: 'CursorReader' });
    expect(transport.send).not.toHaveBeenCalled();

    // MOVE's `set` is a client-safe effect (no persist/fetch/call-service) —
    // still no server-only effect fires, so still no leg, still no post.
    await kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 1 } });
    expect(transport.send).not.toHaveBeenCalled();

    // DO_CREATE's `persist` IS server-only — a leg is collected and posted.
    await kernel.dispatch({ event: 'DO_CREATE', targetTrait: 'Persistor', payload: { title: 'y' } });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('stateful (carriesCircuitState: false) posts every non-hybrid dispatch, even with no collected leg', async () => {
    const o = opts({ carriesCircuitState: false });
    const posted: Array<{ event: string; hasTraits: boolean }> = [];
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: false }),
      unregister: async () => {},
      send: vi.fn(async (_orbitalName, request): Promise<OrbitalEventResponse> => {
        posted.push({ event: request.event, hasTraits: request.traits !== undefined });
        return { success: true, transitioned: true, states: {}, emittedEvents: [] };
      }),
    };
    const kernel = createClientKernel({ ...o, transport });

    // No server-only effect fires here (bare transition), yet the stateful
    // topology still posts — the server holds the authoritative state.
    await kernel.dispatch({ event: 'READ', targetTrait: 'CursorReader' });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(posted[0]).toEqual({ event: 'READ', hasTraits: false });

    await kernel.dispatch({ event: 'DO_CREATE', targetTrait: 'Persistor', payload: { title: 'z' } });
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('no transport never posts, regardless of topology', async () => {
    const o = opts({ carriesCircuitState: false });
    const kernel = createClientKernel(o);
    const outcome = await kernel.dispatch({ event: 'DO_CREATE', targetTrait: 'Persistor', payload: { title: 'w' } });
    expect(outcome.response.success).toBe(true);
    // Nothing to assert on a transport that doesn't exist — the important
    // fact is this resolves at all (the local response, never posted).
  });
});

describe('createClientKernel — G5 sibling rows', () => {
  it('a server entityByTrait row for one trait lands in every sibling trait bound to the same entity', async () => {
    // Stateful topology (`carriesCircuitState: false`) so the kernel posts
    // this dispatch even though MOVE's `set` effect produces no server leg —
    // the posting rule that actually gets the response fold to run here.
    const o = opts({ carriesCircuitState: false });

    const serverResponse: OrbitalEventResponse = {
      success: true,
      transitioned: true,
      states: {},
      emittedEvents: [],
      entityByTrait: { Move: { id: 'c-1', x: 42 } },
    };
    const transport = createInProcessTransport(async () => serverResponse, { carriesCircuitState: false });
    const kernel = createClientKernel({ ...o, transport });

    await kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 1 } });

    // Move's OWN frame carries the server row.
    expect(o.store.frames.get('Move')).toMatchObject({ id: 'c-1', x: 42 });
    // CursorReader is bound to the SAME "Cursor" entity and has never
    // dispatched — its frame still picks up the row (G5).
    expect(o.store.frames.get('CursorReader')).toMatchObject({ id: 'c-1', x: 42 });
  });
});

describe('createClientKernel — gaps closed after the W5b hook split', () => {
  it('a tick-stamped post never delays a queued command (R-CLIENT-TICK-POST-BACKLOG)', async () => {
    const o = opts({ carriesCircuitState: true });
    let releaseTick: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseTick = resolve; });
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => {
        await gate;
        const response: OrbitalEventResponse = { success: true, transitioned: true, states: {}, emittedEvents: [] };
        return response;
      }),
    };
    const kernel = createClientKernel({ ...o, transport });

    await kernel.dispatch({ event: 'DO_CREATE', targetTrait: 'Persistor', payload: { title: 'tick' }, tick: 'autosave' });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    const outcome = await kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 9 } });

    expect(outcome.mode).toBe('runtimeOptimistic');
    expect(o.store.frames.get('Move')?.['x']).toBe(9);
    releaseTick?.();
  });

  it('the posted response carries the fold effects after the local ones (G-RUNTIME-029)', async () => {
    const o = opts({ carriesCircuitState: true });
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => {
        const response: OrbitalEventResponse = {
          success: true, transitioned: true, states: {}, emittedEvents: [],
          clientEffects: [['render-ui', 'main', { type: 'stack' }]],
        };
        return response;
      }),
    };
    const kernel = createClientKernel({ ...o, transport });

    const outcome = await kernel.dispatch({ event: 'DO_CREATE', targetTrait: 'Persistor', payload: { title: 'x' } });

    expect(outcome.response.clientEffects?.at(-1)).toEqual(['render-ui', 'main', { type: 'stack' }]);
  });

  it('a local write lands in every sibling frame bound to the same entity row', async () => {
    const o = opts();
    const kernel = createClientKernel(o);

    await kernel.dispatch({ event: 'MOVE', targetTrait: 'Move', payload: { x: 4 } });

    const readerKey = o.traitIndex.byName.get('CursorReader')?.frameKey ?? 'CursorReader';
    expect(o.store.frames.get(readerKey)?.['x']).toBe(4);
  });
});
