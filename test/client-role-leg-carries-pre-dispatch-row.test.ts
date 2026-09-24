/**
 * std-realtime-chat "sending does nothing": the composer's SEND emits the
 * draft and then clears it. The server leg replays SEND from the trait's
 * pre-dispatch STATE (`traits[].from`), so it must also carry the
 * pre-dispatch ROW — carrying the post-transition row (draft already "")
 * fails the replayed `draft != ""` guard and the message never persists.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalId, OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import {
  buildTraitIndex,
  createClientKernel,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  dispatchWithServerLeg,
  evaluateOrbitalEvent,
  StateMachineManager,
  type ClientRoleOpts,
  type EventTransport,
} from '../src/index.js';

function schema(local: boolean): OrbitalSchema {
  return {
    name: 'clearing-composer',
    version: '1.0.0',
    orbitals: [{
      name: 'ChatOrbital',
      id: 'orb_chat' as OrbitalId,
      pages: [],
      entity: { name: 'Message', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }, { name: 'content', type: 'string' }] },
      traits: [
        {
          name: 'Composer',
          linkedEntity: 'Message',
          scope: 'instance',
          ...(local ? { local: true } : {}),
          stateMachine: {
            states: [{ name: 'ready', isInitial: true }],
            events: [],
            transitions: [
              { from: 'ready', to: 'ready', event: 'DRAFT', effects: [['set', '@entity.content', '@payload.value']] },
              {
                from: 'ready', to: 'ready', event: 'SEND', guard: ['!=', ['str/default', '@entity.content', ''], ''],
                effects: [['emit', 'SAVE', { content: '@entity.content' }], ['set', '@entity.content', '']],
              },
            ],
          },
        },
        {
          name: 'Persistor',
          linkedEntity: 'Message',
          scope: 'instance',
          listens: [{ event: 'SAVE', source: { kind: 'trait', trait: 'Composer' }, triggers: 'DO_CREATE' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'DO_CREATE', effects: [['persist', 'create', 'Message', { content: '@payload.content' }]] }],
          },
        },
      ],
    }],
  };
}

function statelessTransport(s: OrbitalSchema, persistence: InMemoryPersistence): EventTransport {
  const traitIndex = buildTraitIndex(s.orbitals);
  return createInProcessTransport(async (_orbital, request) => {
    const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frames = new Map<string, EntityRow>();
    return evaluateOrbitalEvent(
      { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) },
      request,
    );
  }, { carriesCircuitState: true });
}

async function statefulTransport(s: OrbitalSchema, persistence: InMemoryPersistence): Promise<EventTransport> {
  const runtime = new OrbitalServerRuntime({ debug: false, persistence });
  await runtime.register(s);
  return createInProcessTransport((orbital, request) => runtime.processOrbitalEvent(orbital, request));
}

describe.each([true, false])('composer that clears its draft on SEND (local=%s)', (local) => {
  it('the leg carries the row SEND was dispatched against', async () => {
    const s = schema(local);
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const opts: ClientRoleOpts = { orbitalName: 'ChatOrbital', traitIndex, store, carriesCircuitState: true };
    await dispatchWithServerLeg(opts, { event: 'DRAFT', targetTrait: 'Composer', payload: { value: 'hi' } });
    const dispatch = await dispatchWithServerLeg(opts, { event: 'SEND', targetTrait: 'Composer' });
    expect(dispatch.serverLeg?.entityByTrait?.['Composer']?.['content']).toBe('hi');
    expect(dispatch.serverLeg?.traits).toContainEqual({ trait: 'Composer', from: 'ready' });
  });

  it.each(['stateful', 'stateless'] as const)('%s: the sent draft is persisted', async (topology) => {
    const s = schema(local);
    const persistence = new InMemoryPersistence();
    const transport = topology === 'stateful' ? await statefulTransport(s, persistence) : statelessTransport(s, persistence);
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({
      orbitalName: 'ChatOrbital',
      traitIndex,
      store,
      carriesCircuitState: topology === 'stateless',
      transport,
    });
    await kernel.dispatch({ event: 'DRAFT', targetTrait: 'Composer', payload: { value: 'typed' } });
    await kernel.dispatch({ event: 'SEND', targetTrait: 'Composer' });
    expect((await persistence.list('Message')).map((r) => r['content'])).toEqual(['typed']);
  });

  it('an empty draft still sends nothing (guard control)', async () => {
    const s = schema(local);
    const persistence = new InMemoryPersistence();
    const traitIndex = buildTraitIndex(s.orbitals);
    const kernel = createClientKernel({
      orbitalName: 'ChatOrbital',
      traitIndex,
      store: createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef)),
      carriesCircuitState: false,
      transport: await statefulTransport(s, persistence),
    });
    await kernel.dispatch({ event: 'SEND', targetTrait: 'Composer' });
    expect(await persistence.list('Message')).toEqual([]);
  });
});
