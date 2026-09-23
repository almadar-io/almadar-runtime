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
import type { OrbitalId, OrbitalSchema, Trait, TraitId, TraitEventListener } from '@almadar/core';
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
            stateMachine: {
              states: [{ name: 'ready', isInitial: true }],
              events: [
                { key: 'SEND', payloadSchema: [{ name: 'content', type: 'string', required: true }] },
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
            emits: [{ event: 'SAVE', eventId: 'evt_save' }],
          },
          {
            name: 'Persistor',
            id: 'trt_persistor' as TraitId,
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
  overrides: Partial<EvaluateOrbitalEventDeps> = {},
): EvaluateOrbitalEventDeps & { persistence: InMemoryPersistence } {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const manager = new StateMachineManager(
    [...traitIndex.byName.values()].map((entry) => entry.traitDef),
  );
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, Record<string, unknown>>();
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
    // …and the mounted Thread did NOT (the client relays it) — no fetch ran.
    expect(response.states['Thread']).toBeUndefined();
    expect(response.effectResults?.some((r) => r.effect === 'fetch')).toBe(false);
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
      eventId: 'evt_save',
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
