/**
 * Parity suite — the teeth of the stateless/stateful unification
 * (docs/Almadar_Runtime_Stateless_Stateful_PLAN.md §6).
 *
 * The SAME scenarios run through `evaluateOrbitalEvent` with BOTH dep
 * configurations:
 *
 * - **Stateless**: fresh manager + frames per request, seeded from the
 *   client's round-tripped `traits`/`entityByTrait`; `runtimeRowSentinel`.
 * - **Stateful**: long-lived manager + frames (states persist across
 *   requests server-side); the host strips `traits`/`entityByTrait` and
 *   discovery runs off server-held states.
 *
 * The contract asserted is "what ran and what it produced" — identical
 * `transitioned`, identical emitted events (name + V4 source stamp),
 * identical effect results, identical persisted rows. Transport-only
 * differences (the stateful `states` map being a superset) are normalized,
 * deliberately.
 */
import { describe, it, expect } from 'vitest';
import type {
  BusEventSource,
  EntityRow,
  OrbitalEventRequest,
  OrbitalEventResponse,
  OrbitalId,
  OrbitalSchema,
  TraitId,
  TraitEventListener,
} from '@almadar/core';
import {
  buildTraitIndex,
  createIndexStageRunner,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  StateMachineManager,
  type DeliverEmit,
  type EvaluateOrbitalEventDeps,
  type TraitIndex,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fixture — the chat SEND → SAVE → persistor → MESSAGE_SAVED circuit, plus a
// guarded arm and a required-payload event. Same schema for both configs.
// ---------------------------------------------------------------------------

function paritySchema(): OrbitalSchema {
  return {
    name: 'parity-app',
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
            listens: [{ event: 'Composer.SAVE', triggers: 'DO_CREATE' }],
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

// ---------------------------------------------------------------------------
// The two hosts
// ---------------------------------------------------------------------------

interface Host {
  persistence: InMemoryPersistence;
  busDeliveries: Array<{ event: string; source?: BusEventSource }>;
}

/** Stateless: a FRESH manager/frames per request; the client round-trips
 *  states + entity rows. `send` emulates the client carrying the response
 *  forward (states + entityByTrait) into the next request. */
function makeStatelessHost(schema: OrbitalSchema): Host & {
  send: (request: OrbitalEventRequest) => Promise<OrbitalEventResponse>;
} {
  const traitIndex: TraitIndex = buildTraitIndex(schema.orbitals);
  const persistence = new InMemoryPersistence();
  const busDeliveries: Host['busDeliveries'] = [];
  // Client-held circuit state, carried across requests by hand.
  let carriedStates: Record<string, string> = {};
  let carriedEntities: Record<string, EntityRow> = {};

  const send = async (request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    const manager = new StateMachineManager(
      [...traitIndex.byName.values()].map((entry) => entry.traitDef),
    );
    const frames = new Map<string, EntityRow>();
    const deps: EvaluateOrbitalEventDeps = {
      traitIndex,
      manager,
      persistence,
      frames,
      runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema }),
      runtimeRowSentinel: true,
      ...(request.clientId !== undefined ? { originClientId: request.clientId } : {}),
    };
    const response = await evaluateOrbitalEvent(deps, {
      ...request,
      // The client sends its locally-dispatched traits (stateless: the
      // client's own dispatch IS the dispatch) and its carried rows.
      traits: request.traits ?? carriedStatesFor(request.event),
      entityByTrait: carriedEntities,
    });
    carriedStates = { ...carriedStates, ...response.states };
    carriedEntities = { ...carriedEntities, ...(response.entityByTrait ?? {}) };
    return response;
  };

  // A stateless client only declares traits it actually dispatched locally.
  // For these scenarios that is the trait under test; discovery (INIT) is
  // expressed by omitting `traits` entirely.
  const carriedStatesFor = (event: string): Array<{ trait: string; from: string }> => {
    if (event === 'INIT') return undefined as never; // discovery mode
    if (event === 'SEND') return [{ trait: 'Composer', from: carriedStates['Composer'] ?? 'ready' }];
    if (event === 'SELECT') return [{ trait: 'Composer', from: carriedStates['Composer'] ?? 'ready' }];
    if (event === 'GO') return [{ trait: 'Guarded', from: carriedStates['Guarded'] ?? 'idle' }];
    return [];
  };

  return {
    persistence,
    busDeliveries,
    send,
  };
}

/** Stateful: ONE long-lived manager + frames for the whole session; the
 *  host strips `traits`/`entityByTrait` (server-authoritative discovery);
 *  emits are delivered to the "bus" (recorded) + in-band fan-out. */
function makeStatefulHost(schema: OrbitalSchema): Host & {
  send: (request: OrbitalEventRequest) => Promise<OrbitalEventResponse>;
} {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const manager = new StateMachineManager(
    [...traitIndex.byName.values()].map((entry) => entry.traitDef),
  );
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, EntityRow>();
  const busDeliveries: Host['busDeliveries'] = [];
  const deliverEmit: DeliverEmit = (event, _payload, stamp) => {
    busDeliveries.push({ event, source: stamp });
  };

  const send = async (request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    const deps: EvaluateOrbitalEventDeps = {
      traitIndex,
      manager,
      persistence,
      frames,
      runEffects: createIndexStageRunner({
        traitIndex, persistence, frames, manager, schema, deliverEmit,
      }),
      ...(request.clientId !== undefined ? { originClientId: request.clientId } : {}),
      // NO runtimeRowSentinel — the stateful server has no such contract.
    };
    // The stateful host strips the client-state fields: discovery runs off
    // server-held states via canHandleEvent.
    const { traits: _traits, entityByTrait: _rows, ...serverRequest } = request;
    return evaluateOrbitalEvent(deps, serverRequest);
  };

  return { persistence, busDeliveries, send };
}

// ---------------------------------------------------------------------------
// Normalization — "what ran and what it produced", transport facts removed.
// ---------------------------------------------------------------------------

function normalize(response: OrbitalEventResponse) {
  return {
    success: response.success,
    transitioned: response.transitioned,
    error: response.error,
    guardFailed: response.guardFailed,
    emitted: response.emittedEvents.map((e) => ({
      event: e.event,
      source: {
        orbital: e.source?.orbital,
        orbitalId: e.source?.orbitalId,
        trait: e.source?.trait,
        traitId: e.source?.traitId,
        eventId: e.source?.eventId,
      },
    })),
    effects: (response.effectResults ?? []).map((r) => ({
      effect: r.effect, action: r.action, entityType: r.entityType, success: r.success,
    })),
    rejections: response.rejections,
  };
}

async function rows(persistence: InMemoryPersistence, entityType: string) {
  return (await persistence.list(entityType)).map((row) => ({
    content: row['content'], channel: row['channel'],
  }));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('parity — stateless vs stateful produce the same circuit outcome', () => {
  it('chat SEND → SAVE → off-page persistor → DO_CREATE → MESSAGE_SAVED', async () => {
    const schema = paritySchema();
    const stateless = makeStatelessHost(schema);
    const stateful = makeStatefulHost(schema);

    const request: OrbitalEventRequest = {
      event: 'SEND',
      payload: { content: 'hello', _activeTraits: ['Composer', 'Thread'] },
      clientId: 'tab-1',
    };
    const [slRes, sfRes] = await Promise.all([stateless.send(request), stateful.send(request)]);

    expect(normalize(slRes)).toEqual(normalize(sfRes));
    // The circuit actually ran end-to-end (not two vacuous no-ops agreeing).
    expect(slRes.transitioned).toBe(true);
    expect(slRes.emittedEvents.map((e) => e.event)).toEqual(['SAVE', 'MESSAGE_SAVED', 'THREAD_LOADED']);
    expect(slRes.emittedEvents[0]?.source).toMatchObject({
      orbitalId: 'orb_chat', traitId: 'trt_composer', eventId: 'evt_save',
    });
    // The off-page listener ran server-side on BOTH paths (G-RUNTIME-031)…
    expect(await rows(stateless.persistence, 'ChatMessage')).toEqual([{ content: 'hello', channel: undefined }]);
    expect(await rows(stateful.persistence, 'ChatMessage')).toEqual([{ content: 'hello', channel: undefined }]);
    // …and the MOUNTED Thread ran server-side on BOTH paths too — the
    // client never relays a listen trigger (its local run could not
    // fetch, G-RUNTIME-029); the consumed emit's `dispatched: true` stamp
    // is what keeps the client from re-applying the hop. (Proof: the
    // fetch's success auto- emit — the stage records no fetch effectResult.)
    expect(slRes.states['Thread']).toBe('displaying');
    expect(sfRes.states['Thread']).toBe('displaying');
  });

  it('two sequential requests converge (SELECT then SEND, channel filter carried)', async () => {
    const schema = paritySchema();
    const stateless = makeStatelessHost(schema);
    const stateful = makeStatefulHost(schema);

    for (const host of [stateless, stateful]) {
      await host.send({
        event: 'SELECT',
        payload: { channel: 'ch-1', _activeTraits: ['Composer'] },
        clientId: 'tab-1',
      });
    }
    const request: OrbitalEventRequest = {
      event: 'SEND',
      payload: { content: 'second', _activeTraits: ['Composer'] },
      clientId: 'tab-1',
    };
    const [slRes, sfRes] = await Promise.all([stateless.send(request), stateful.send(request)]);
    expect(normalize(slRes)).toEqual(normalize(sfRes));
    // The composer's `set @entity.activeChannel` from request 1 reached
    // request 2's SAVE payload on BOTH paths (frames map vs round-trip).
    const save = slRes.emittedEvents.find((e) => e.event === 'SAVE');
    expect((save?.payload as EntityRow | undefined)?.['data']).toMatchObject({ channel: 'ch-1' });
    expect(await rows(stateless.persistence, 'ChatMessage')).toEqual([{ content: 'second', channel: 'ch-1' }]);
    expect(await rows(stateful.persistence, 'ChatMessage')).toEqual([{ content: 'second', channel: 'ch-1' }]);
  });

  it('discovery INIT fires the same arms on both paths', async () => {
    const schema = paritySchema();
    const stateless = makeStatelessHost(schema);
    const stateful = makeStatefulHost(schema);

    const request: OrbitalEventRequest = {
      event: 'INIT',
      payload: { _activeTraits: ['Composer'] },
      clientId: 'tab-1',
    };
    const [slRes, sfRes] = await Promise.all([stateless.send(request), stateful.send(request)]);
    expect(normalize(slRes)).toEqual(normalize(sfRes));
    expect(slRes.transitioned).toBe(true);
    expect(slRes.states['Composer']).toBe('ready');
    expect(sfRes.states['Composer']).toBe('ready');
    expect(slRes.entityByTrait?.['Composer']?.['booted']).toBe(true);
    expect(sfRes.entityByTrait?.['Composer']?.['booted']).toBe(true);
  });

  it('guard rejection is structured identically on both paths', async () => {
    const schema = paritySchema();
    const stateless = makeStatelessHost(schema);
    const stateful = makeStatefulHost(schema);

    const request: OrbitalEventRequest = {
      event: 'GO',
      payload: { ok: false },
      clientId: 'tab-1',
    };
    const [slRes, sfRes] = await Promise.all([stateless.send(request), stateful.send(request)]);
    expect(normalize(slRes)).toEqual(normalize(sfRes));
    expect(slRes.transitioned).toBe(false);
    expect(slRes.rejections?.[0]?.code).toBe('guard-rejected');
    expect(slRes.guardFailed).toBe('Guarded.GO');
  });

  it('payload validation rejects identically on both paths', async () => {
    const schema = paritySchema();
    const stateless = makeStatelessHost(schema);
    const stateful = makeStatefulHost(schema);

    const request: OrbitalEventRequest = {
      event: 'SEND',
      payload: {}, // required `content` missing
      clientId: 'tab-1',
    };
    const [slRes, sfRes] = await Promise.all([stateless.send(request), stateful.send(request)]);
    expect(normalize(slRes)).toEqual(normalize(sfRes));
    expect(slRes.success).toBe(false);
    expect(slRes.error).toContain('content');
    expect(await rows(stateless.persistence, 'ChatMessage')).toEqual([]);
    expect(await rows(stateful.persistence, 'ChatMessage')).toEqual([]);
  });
});
