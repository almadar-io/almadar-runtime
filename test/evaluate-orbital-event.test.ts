/**
 * evaluateOrbitalEvent — THE composition's behavioral pins: client-declared
 * vs discovery dispatch, the cross-trait fan-out (incl. the relay mask —
 * G-RUNTIME-031's shape), V4 id-carrying listens (G-RUNTIME-030's shape),
 * structured rejections, payload validation, targetTrait scoping.
 *
 * The runner is the REAL effect stage via `createIndexStageRunner` over
 * `InMemoryPersistence` — these are composition tests, not stage tests.
 */
import { describe, it, expect } from 'vitest';
import { asEventId, type EntityRow, type OrbitalId, type OrbitalSchema, type Trait, type TraitId, type TraitEventListener } from '@almadar/core';
import {
  buildTraitIndex,
  createIndexStageRunner,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  StateMachineManager,
  type EvaluateOrbitalEventDeps,
} from '../src/index.js';

function chatSchema(listenerSource?: TraitEventListener[]): OrbitalSchema {
  return {
    name: 'parity-chat',
    version: '1.0.0',
    orbitals: [
      {
        name: 'ChatOrbital',
        id: 'orb_chat' as OrbitalId,
        pages: [],
        entity: {
          name: 'ChatChannel',
          shared: true,
          fields: [
            { name: 'id', type: 'string' },
            { name: 'activeChannel', type: 'string' },
            { name: 'booted', type: 'boolean', default: false },
          ],
        },
        traits: [
          {
            name: 'Composer',
            id: 'trt_composer' as TraitId,
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'ready', isInitial: true }],
              events: [
                { key: 'SEND', name: 'Send', payloadSchema: [{ name: 'content', type: 'string', required: true }] },
              ],
              transitions: [
                {
                  from: 'ready', to: 'ready', event: 'INIT',
                  effects: [['set', '@entity.booted', true]],
                },
                {
                  from: 'ready', to: 'ready', event: 'SELECT',
                  effects: [['set', '@entity.activeChannel', '@payload.channel']],
                },
                {
                  from: 'ready', to: 'ready', event: 'SEND',
                  effects: [['emit', 'SAVE', { data: { content: '@payload.content', channel: '@entity.activeChannel' } }]],
                },
              ],
            },
            emits: [{ event: 'SAVE', eventId: asEventId('evt_save') }],
          },
          {
            name: 'Persistor',
            id: 'trt_persistor' as TraitId,
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'DO_CREATE',
                  effects: [['persist', 'create', 'ChatMessage',
                    { content: '@payload.data.content', channel: '@payload.data.channel' },
                    { emit: { success: 'MESSAGE_SAVED' } }]],
                },
              ],
            },
            listens: listenerSource ?? [{ event: 'Composer.SAVE', triggers: 'DO_CREATE' }],
          },
          {
            name: 'Thread',
            id: 'trt_thread' as TraitId,
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'displaying' }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'displaying', event: 'REFETCH',
                  effects: [['fetch', 'ChatMessage', { emit: { success: 'THREAD_LOADED' } }]],
                },
              ],
            },
            listens: [{ event: '*.MESSAGE_SAVED', triggers: 'REFETCH' }],
          },
          {
            name: 'Guarded',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'done', event: 'GO',
                  guard: ['=', '@payload.ok', true],
                  effects: [['set', '@entity.went', true]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function depsFor(
  schema: OrbitalSchema,
  overrides: Partial<Omit<EvaluateOrbitalEventDeps, 'persistence'>> = {},
): EvaluateOrbitalEventDeps & { persistence: InMemoryPersistence } {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const manager = new StateMachineManager(
    [...traitIndex.byName.values()].map((entry) => entry.traitDef),
  );
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, EntityRow>();
  return {
    traitIndex,
    manager,
    persistence,
    frames,
    runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema }),
    ...overrides,
  };
}

describe('evaluateOrbitalEvent — client-declared dispatch (stateless shape)', () => {
  it('runs the declared trait, fans SAVE out to the OFF-page persistor, and commits states', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SEND',
      payload: { content: 'hello', _activeTraits: ['Composer', 'Thread'] },
      traits: [{ trait: 'Composer', from: 'ready' }],
      clientId: 'tab-1',
    });

    expect(response.success).toBe(true);
    expect(response.transitioned).toBe(true);
    expect(response.states['Composer']).toBe('ready');
    // The off-page listener ran server-side (G-RUNTIME-031)…
    expect(response.states['Persistor']).toBe('idle');
    // …and the MOUNTED listen-armed Thread ran here too: the client never
    // relays a listen trigger itself (its local run could not fetch —
    // G-RUNTIME-029), so the server completes every listener and stamps
    // the consumed emit `dispatched: true` for the client to honor.
    expect(response.states['Thread']).toBe('displaying');
    expect(response.emittedEvents.some((e) => e.event === 'THREAD_LOADED')).toBe(true);
    expect(response.effectResults?.some(
      (r) => r.effect === 'persist' && r.action === 'create' && r.success,
    )).toBe(true);

    // SAVE carries the full V4 stamp (G-RUNTIME-030)…
    const save = response.emittedEvents.find((e) => e.event === 'SAVE');
    expect(save?.source).toMatchObject({
      orbital: 'ChatOrbital',
      orbitalId: 'orb_chat',
      trait: 'Composer',
      traitId: 'trt_composer',
      eventId: asEventId('evt_save'),
    });
    // …and the persist-success auto-emit fired for the listener's own cascade.
    expect(response.emittedEvents.some((e) => e.event === 'MESSAGE_SAVED')).toBe(true);

    // The row actually landed in persistence.
    const rows = await deps.persistence.list('ChatMessage');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'hello' });
  });

  it('an explicit empty traits list is an inert no-op (never discovery)', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SEND',
      payload: { content: 'x' },
      traits: [],
    });
    expect(response.transitioned).toBe(false);
    expect(response.rejections?.[0]?.code).toBe('no-dispatchable-traits');
    expect(await deps.persistence.list('ChatMessage')).toHaveLength(0);
  });

  it('entityByTrait round-trips the shared frame (composer set → thread sees it)', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SELECT',
      payload: { channel: 'ch-1', _activeTraits: ['Composer'] },
      traits: [{ trait: 'Composer', from: 'ready' }],
    });
    expect(response.transitioned).toBe(true);
    expect(response.entityByTrait?.['Composer']?.['activeChannel']).toBe('ch-1');
    // The frame echoes to EVERY trait bound to the shared entity, even ones
    // that never ran — or the next request's merge clobbers it with a stale row.
    expect(response.entityByTrait?.['Thread']?.['activeChannel']).toBe('ch-1');
  });
});

describe('evaluateOrbitalEvent — discovery dispatch (mount INIT)', () => {
  it('discovers INIT arms from initial states, scoped by _activeTraits', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'INIT',
      payload: { _activeTraits: ['Composer'] },
    });
    expect(response.transitioned).toBe(true);
    expect(response.states['Composer']).toBe('ready');
    expect(response.entityByTrait?.['Composer']?.['booted']).toBe(true);
    // Thread is out of the active set — never dispatched, never in states.
    expect(response.states['Thread']).toBeUndefined();
  });
});

describe('evaluateOrbitalEvent — targetTrait scoped dispatch', () => {
  it('addresses exactly one trait, bypassing the active set', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'DO_CREATE',
      payload: { data: { content: 'direct', channel: 'ch-9' } },
      targetTrait: 'Persistor',
    });
    expect(response.transitioned).toBe(true);
    expect(response.states['Persistor']).toBe('idle');
    const rows = await deps.persistence.list('ChatMessage');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'ch-9' });
  });
});

describe('evaluateOrbitalEvent — rejections', () => {
  it('guard rejection carries the structured reason', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'GO',
      payload: { ok: false },
      traits: [{ trait: 'Guarded', from: 'idle' }],
    });
    expect(response.transitioned).toBe(false);
    expect(response.guardFailed).toBe('Guarded.GO');
    expect(response.rejections?.[0]).toMatchObject({
      code: 'guard-rejected',
      trait: 'Guarded',
      from: 'idle',
      event: 'GO',
    });
  });

  it('no-matching-transition lists the states that DO declare the event', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'REFETCH',
      payload: {},
      traits: [{ trait: 'Thread', from: 'displaying' }],
    });
    expect(response.transitioned).toBe(false);
    expect(response.rejections?.[0]).toMatchObject({
      code: 'no-matching-transition',
      trait: 'Thread',
      from: 'displaying',
      statesDeclaringEvent: ['idle'],
    });
  });
});

describe('evaluateOrbitalEvent — payload validation (both paths converge)', () => {
  it('rejects a SEND with the required content field missing', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SEND',
      payload: {},
      traits: [{ trait: 'Composer', from: 'ready' }],
    });
    expect(response.success).toBe(false);
    expect(response.error).toContain('content');
    expect(await deps.persistence.list('ChatMessage')).toHaveLength(0);
  });
});

describe('evaluateOrbitalEvent — V4 id-carrying listens (rename-proof)', () => {
  it('a listen whose source carries the traitId matches even when the name diverged', async () => {
    const deps = depsFor(chatSchema([
      {
        event: 'SAVE',
        triggers: 'DO_CREATE',
        source: { kind: 'trait', trait: 'RenamedComposer', traitId: 'trt_composer' as TraitId },
      },
    ]));
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SEND',
      payload: { content: 'by-id' },
      traits: [{ trait: 'Composer', from: 'ready' }],
    });
    expect(response.transitioned).toBe(true);
    const rows = await deps.persistence.list('ChatMessage');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'by-id' });
  });
});

describe('evaluateOrbitalEvent — [runtime] row round-trip fold (the stateless singleton contract)', () => {
  function gameSchema(): OrbitalSchema {
    return {
      name: 'runtime-fold',
      version: '1.0.0',
      orbitals: [
        {
          name: 'GameOrbital',
          pages: [],
          entity: {
            name: 'GameState',
            persistence: 'runtime',
            fields: [
              { name: 'id', type: 'string' },
              { name: 'score', type: 'number', default: 0 },
            ],
          },
          traits: [
            {
              name: 'Player',
              scope: 'instance',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [],
                transitions: [
                  {
                    from: 'idle', to: 'idle', event: 'BUMP',
                    effects: [['set', '@entity.score', 42]],
                  },
                  {
                    from: 'idle', to: 'idle', event: 'READ',
                    effects: [['emit', 'SCORE', { score: '@entity.score' }]],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it('an id-carrying [runtime] row is folded into the frame — its CONTENT survives the round-trip, not just its addressing', async () => {
    const deps = depsFor(gameSchema());
    const response = await evaluateOrbitalEvent(
      { ...deps, runtimeRowSentinel: true },
      {
        event: 'READ',
        traits: [{ trait: 'Player', from: 'idle' }],
        // The client-held singleton row: the id is addressing, the fields
        // are the state (a [runtime] entity has no authoritative store).
        entityByTrait: { Player: { id: 'runtime', score: 41 } },
      },
    );
    const score = response.emittedEvents.find((e) => e.event === 'SCORE');
    expect((score?.payload as { score?: number } | undefined)?.score).toBe(41);
  });

  it('a `set` on the folded row is echoed back for the NEXT request\'s round-trip', async () => {
    const deps = depsFor(gameSchema());
    const response = await evaluateOrbitalEvent(
      { ...deps, runtimeRowSentinel: true },
      {
        event: 'BUMP',
        traits: [{ trait: 'Player', from: 'idle' }],
        entityByTrait: { Player: { id: 'runtime', score: 41 } },
      },
    );
    expect(response.entityByTrait?.['Player']?.['score']).toBe(42);
  });
});

describe('evaluateOrbitalEvent — discovery seeds the whole active set into states', () => {
  it('a trait inside _activeTraits with no matching arm is still echoed (the stateful "every registered trait" contract)', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'INIT',
      payload: { _activeTraits: ['Composer', 'Thread'] },
    });
    // Composer has the INIT arm and ran; Thread does not — but a fresh
    // mount's states map echoes every ACTIVE trait's held (initial) state.
    expect(response.states['Composer']).toBe('ready');
    expect(response.states['Thread']).toBe('idle');
    expect(response.transitioned).toBe(true);
  });
});

describe('evaluateOrbitalEvent — payload _targetTrait sidecar guards (the client page-scope contract)', () => {
  it('a sidecar _targetTrait OUTSIDE the page\'s _activeTraits never dispatches (no off-page bypass)', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'INIT',
      payload: { _targetTrait: 'Composer', _activeTraits: ['Thread'] },
    });
    expect(response.transitioned).toBe(false);
    expect(response.rejections).toEqual([{ code: 'no-dispatchable-traits', event: 'INIT' }]);
  });

  it('a sidecar _targetTrait naming an UNHELD multi-state trait never dispatches (its current state is not a fact)', async () => {
    const deps = depsFor(chatSchema());
    const response = await evaluateOrbitalEvent(deps, {
      event: 'REFETCH',
      payload: { _targetTrait: 'Thread', _activeTraits: ['Thread'] },
    });
    expect(response.transitioned).toBe(false);
    expect(response.rejections).toEqual([{ code: 'no-dispatchable-traits', event: 'REFETCH' }]);
  });
});

describe('evaluateOrbitalEvent — seedVisited (the client role\'s alreadyDelivered contract)', () => {
  it('a seeded (trait, event) pair is never re-run, even when the fan-out reaches it', async () => {
    const deps = depsFor(chatSchema(), {
      seedVisited: new Set(['Persistor\u0000DO_CREATE']),
    });
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SEND',
      payload: { content: 'hello', _activeTraits: ['Composer', 'Thread'] },
      traits: [{ trait: 'Composer', from: 'ready' }],
    });

    // Composer ran, but the already-delivered Persistor leg was skipped
    // (its state echoes from the manager — it never LEFT idle)…
    expect(response.transitioned).toBe(true);
    expect(response.states['Composer']).toBe('ready');
    expect(response.states['Persistor']).toBe('idle');
    expect(response.emittedEvents.some((e) => e.event === 'MESSAGE_SAVED')).toBe(false);
    expect(await deps.persistence.list('ChatMessage')).toHaveLength(0);
    // …so the Thread (listening on MESSAGE_SAVED) was never even enqueued —
    // the enqueue-time getState materializes a trait into the states echo,
    // and Thread was never reached.
    expect(response.states['Thread']).toBeUndefined();
  });

  it('an UNSEEDED pair still runs (the seed only suppresses exact pairs)', async () => {
    const deps = depsFor(chatSchema(), {
      seedVisited: new Set(['Thread\u0000REFETCH']),
    });
    const response = await evaluateOrbitalEvent(deps, {
      event: 'SEND',
      payload: { content: 'hello', _activeTraits: ['Composer', 'Thread'] },
      traits: [{ trait: 'Composer', from: 'ready' }],
    });

    // Persistor ran (not seeded) and persisted…
    expect(response.states['Persistor']).toBe('idle');
    expect(await deps.persistence.list('ChatMessage')).toHaveLength(1);
    expect(response.emittedEvents.some((e) => e.event === 'MESSAGE_SAVED')).toBe(true);
    // …but the seeded Thread leg was skipped — no REFETCH, no fetch, no display.
    expect(response.states['Thread']).toBe('idle');
    expect(response.emittedEvents.some((e) => e.event === 'THREAD_LOADED')).toBe(false);
  });
});
