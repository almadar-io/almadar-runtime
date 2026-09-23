/**
 * client-role (P4) — one scenario per `DispatchMode`, `alreadyDelivered`
 * suppression, subscriber notification, and the G-RUNTIME-029-shaped case:
 * a persisted trait's listen arm with a `fetch` then a same-trait render
 * bound to `@payload.data` — the local (Client-env) run collects the fetch
 * into the leg (nothing renders locally), and after folding the REAL
 * server response the render carries the server's rows, not a skeleton.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalId, OrbitalSchema } from '@almadar/core';
import type { EventTransport } from '../src/index.js';
import {
  alreadyDeliveredFrom,
  applyOrbitalEventResponse,
  buildTraitIndex,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  dispatchWithServerLeg,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  postServerLeg,
  StateMachineManager,
  type ClientDispatch,
  type ClientRoleOpts,
} from '../src/index.js';
import type { EntityRow } from '../src/index.js';
import type { OrbitalEventResponse } from '@almadar/core';

function schema(): OrbitalSchema {
  return {
    name: 'client-role-test',
    version: '1.0.0',
    orbitals: [
      {
        name: 'ClientRoleOrbital',
        id: 'orb_cr' as OrbitalId,
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
            name: 'LocalToggle',
            linkedEntity: 'Cursor',
            local: true,
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'created' }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'created', event: 'CREATE',
                  effects: [['persist', 'create', 'Cursor', {}]],
                },
              ],
            },
          },
          {
            name: 'Move',
            linkedEntity: 'Cursor',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'moved' }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'moved', event: 'MOVE',
                  effects: [
                    ['set', '@entity.x', 5],
                    ['call-service', 'SyncService', 'move', {}],
                  ],
                },
              ],
            },
          },
          {
            name: 'Persistor',
            linkedEntity: 'Note',
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
          {
            name: 'Thread',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'displaying' }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'displaying', event: 'REFETCH',
                  effects: [['fetch', 'Note', { emit: { success: 'LOADED' } }]],
                },
                {
                  from: 'displaying', to: 'displaying', event: 'LOADED',
                  effects: [['render-ui', 'list', { type: 'data-list' }, { data: '@payload.data' }]],
                },
              ],
            },
            listens: [{ event: 'Persistor.CREATED', triggers: 'REFETCH' }],
          },
        ],
      },
    ],
  };
}

function opts(overrides: Partial<ClientRoleOpts> = {}): ClientRoleOpts {
  const traitIndex = buildTraitIndex(schema().orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return {
    orbitalName: 'ClientRoleOrbital',
    traitIndex,
    store,
    carriesCircuitState: true,
    ...overrides,
  };
}

describe('dispatchWithServerLeg — hybridClientOnly never posts', () => {
  it('runs locally, produces no leg, and postServerLeg never touches the transport', async () => {
    const o = opts();
    const dispatch = await dispatchWithServerLeg(o, { event: 'CREATE', targetTrait: 'LocalToggle' });

    expect(dispatch.mode).toBe('hybridClientOnly');
    expect(dispatch.serverLeg).toBeUndefined();
    expect(dispatch.response.states['LocalToggle']).toBe('created');

    const panicTransport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => {
        throw new Error('must never be called for a hybridClientOnly leg');
      }),
    };
    const response = await postServerLeg(panicTransport, 'ClientRoleOrbital', dispatch, o.store, o);
    expect(response).toBe(dispatch.response);
    expect(panicTransport.send).not.toHaveBeenCalled();
  });
});

describe('dispatchWithServerLeg — runtimeOptimistic', () => {
  it('commits locally, posts the collected call-service leg', async () => {
    const o = opts();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });

    expect(dispatch.mode).toBe('runtimeOptimistic');
    expect(dispatch.response.states['Move']).toBe('moved');
    expect(o.store.frames.get('Move')).toMatchObject({ x: 5 });
    expect(dispatch.serverLeg).toBeDefined();
    expect(dispatch.serverLeg?.traits).toEqual([{ trait: 'Move', from: 'idle' }]);
    expect(dispatch.snapshot).toEqual({ state: 'idle', frame: undefined });
  });

  it('rolls back state + frame on a success:false response, presenting the server response', async () => {
    const o = opts();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });
    const serverResponse: OrbitalEventResponse = {
      success: false, transitioned: false, states: {}, emittedEvents: [], error: 'sync rejected',
    };
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => serverResponse),
    };

    const response = await postServerLeg(transport, 'ClientRoleOrbital', dispatch, o.store, o);

    expect(response).toBe(serverResponse);
    expect(o.store.manager.getState('Move')?.currentState).toBe('idle');
    expect(o.store.frames.has('Move')).toBe(false);
  });

  it('rolls back and rethrows on a transport error', async () => {
    const o = opts();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => {
        throw new Error('network down');
      }),
    };

    await expect(postServerLeg(transport, 'ClientRoleOrbital', dispatch, o.store, o)).rejects.toThrow('network down');
    expect(o.store.manager.getState('Move')?.currentState).toBe('idle');
    expect(o.store.frames.has('Move')).toBe(false);
  });
});

describe('dispatchWithServerLeg — persistedAwaited', () => {
  it('posts the leg, folds server entityByTrait/ids, presents the local response', async () => {
    const o = opts();
    const dispatch = await dispatchWithServerLeg(o, {
      event: 'DO_CREATE',
      targetTrait: 'Persistor',
      payload: { title: 'hello' },
    });

    // The local run never actually persisted (Client env delegates it) —
    // no emit fired locally either, since `emit:{success}` only fires
    // after a REAL persist.
    expect(dispatch.mode).toBe('persistedAwaited');
    expect(dispatch.response.emittedEvents).toHaveLength(0);
    expect(dispatch.serverLeg?.traits).toEqual([{ trait: 'Persistor', from: 'idle' }]);

    const serverResponse: OrbitalEventResponse = {
      success: true,
      transitioned: true,
      states: { Persistor: 'idle' },
      entityByTrait: { Persistor: { id: 'n-1', title: 'From server' } },
      emittedEvents: [
        { event: 'CREATED', payload: { id: 'n-1', title: 'From server' }, source: { orbital: 'ClientRoleOrbital', trait: 'Persistor' } },
      ],
    };
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: true }),
      unregister: async () => {},
      send: vi.fn(async () => serverResponse),
    };

    const response = await postServerLeg(transport, 'ClientRoleOrbital', dispatch, o.store, o);

    // The PRESENTED response is the local one — the fold lands data for
    // the next render, it doesn't replace what THIS call returns.
    expect(response).toBe(dispatch.response);
    expect(o.store.frames.get('Persistor')).toMatchObject({ id: 'n-1', title: 'From server' });
  });
});

describe('alreadyDeliveredFrom — suppresses re-running an echo', () => {
  const createdFromPersistor: OrbitalEventResponse = {
    success: true,
    transitioned: true,
    states: {},
    emittedEvents: [{ event: 'CREATED', source: { orbital: 'ClientRoleOrbital', trait: 'Persistor' } }],
  };

  it('CREATED not yet delivered — the fold fans it out to Thread', async () => {
    const o = opts();
    await applyOrbitalEventResponse(o.store, createdFromPersistor, new Set(), o);
    expect(o.store.manager.getState('Thread')?.currentState).toBe('displaying');
  });

  it('CREATED already delivered locally — the fold does not re-run Thread', async () => {
    const o = opts();
    // `alreadyDeliveredFrom` reads its dispatch's own `response.emittedEvents`
    // + `serverLeg.{targetTrait,event}` — build a fixture whose local run
    // already realized (Persistor, CREATED).
    const dispatch: ClientDispatch = {
      response: {
        success: true, transitioned: true, states: {},
        emittedEvents: [{ event: 'CREATED', source: { trait: 'Persistor' } }],
      },
      mode: 'persistedAwaited',
      trait: 'Persistor',
      frameKey: 'Persistor',
    };
    const already = alreadyDeliveredFrom(dispatch);

    await applyOrbitalEventResponse(o.store, createdFromPersistor, already, o);
    expect(o.store.manager.getState('Thread')?.currentState).toBe('idle');
  });
});

describe('CircuitStore subscribers — notified on dispatch/fold', () => {
  it('notify() fires after dispatchWithServerLeg', async () => {
    const o = opts();
    const listener = vi.fn();
    o.store.subscribe(listener);
    await dispatchWithServerLeg(o, { event: 'CREATE', targetTrait: 'LocalToggle' });
    expect(listener).toHaveBeenCalled();
  });

  it('notify() fires after applyOrbitalEventResponse', async () => {
    const o = opts();
    const listener = vi.fn();
    o.store.subscribe(listener);
    await applyOrbitalEventResponse(o.store, { success: true, transitioned: false, states: {}, emittedEvents: [] }, new Set(), o);
    expect(listener).toHaveBeenCalled();
  });
});

describe('G-RUNTIME-029 — the fold carries the server rows, not the skeleton', () => {
  it('a delegated fetch renders nothing locally; the folded server response carries the real render', async () => {
    const o = opts();
    const request = {
      event: 'DO_CREATE',
      targetTrait: 'Persistor',
      payload: { title: 'real title', _activeTraits: ['Persistor', 'Thread'] },
    };

    const dispatch = await dispatchWithServerLeg(o, request);
    // LOCAL run: persist delegated, no emit — Thread never even ran.
    expect(dispatch.response.clientEffects ?? []).toHaveLength(0);
    expect(o.store.manager.getState('Thread')?.currentState).toBe('idle');

    // A REAL stateless-topology server: fresh manager/frames per request,
    // the real effect stage, real persistence — the plan §6 third seeding.
    // `relayMask: new Set()` — the leg's own `_activeTraits` sidecar names
    // the CLIENT's mounted set (used below only to gate which render
    // effects the response carries back); it must NOT also mask the
    // server's fan-out here the way it does for a live browser tab's own
    // bus relay (`deps.relayMask ?? activeTraits`'s default) — a
    // client-role POST has no such relay, so the server must run every
    // listener itself, on-page or not (this is the G-RUNTIME-031 shape:
    // an off-page-from-the-server's-view listener with an on-page origin).
    const persistence = new InMemoryPersistence();
    const serverTraitIndex = buildTraitIndex(schema().orbitals);
    const transport = createInProcessTransport(
      async (_orbitalName, req) => {
        const manager = new StateMachineManager(
          [...serverTraitIndex.byName.values()].map((e) => e.traitDef),
        );
        const frames = new Map<string, EntityRow>();
        const runEffects = createIndexStageRunner({
          traitIndex: serverTraitIndex, persistence, frames, manager, schema: schema(),
        });
        return evaluateOrbitalEvent(
          { traitIndex: serverTraitIndex, manager, persistence, frames, runEffects, relayMask: new Set() },
          req,
        );
      },
      { carriesCircuitState: true },
    );

    expect(dispatch.serverLeg).toBeDefined();
    const posted = await transport.send('ClientRoleOrbital', dispatch.serverLeg!);
    expect(posted.success).toBe(true);

    const folded = await applyOrbitalEventResponse(o.store, posted, alreadyDeliveredFrom(dispatch), o);

    // The REAL row, fetched and rendered entirely server-side within ONE
    // evaluateOrbitalEvent call (Persistor.CREATED fan-out → Thread.REFETCH
    // → same-trait LOADED continuation → render-ui bound to @payload.data).
    const render = folded.clientEffects.find((e) => e[0] === 'render-ui' && e[1] === 'list');
    expect(render).toBeDefined();
    const props = render?.[3] as { data?: Array<{ title?: string }> } | undefined;
    expect(props?.data?.[0]?.title).toBe('real title');

    const rows = await persistence.list('Note');
    expect(rows).toHaveLength(1);
  });
});
