/**
 * std-realtime-chat "sending does nothing" / "changing channels does nothing":
 * the composer is `local` (a client-only trait — its OWN effects never need
 * the server), but its emit fans out to traits that DO: the persistor's
 * `persist create`, the thread's refetch. The client role dropped the whole
 * server leg because the SEED was local ("hybrid-trait-produced-server-leg"),
 * so the message never persisted and the thread never refetched. A local
 * seed's leg is dropped only when the seed itself produced it; work collected
 * from the traits its cascade reached is posted.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalEventRequest, OrbitalId, OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import {
  buildTraitIndex,
  createClientKernel,
  createInProcessTransport,
  createMemoryCircuitStore,
  dispatchWithServerLeg,
  postServerLeg,
  type ClientRoleOpts,
} from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'local-seed',
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
          local: true,
          stateMachine: {
            states: [{ name: 'ready', isInitial: true }],
            events: [],
            transitions: [
              { from: 'ready', to: 'ready', event: 'DRAFT', effects: [['set', '@entity.content', '@payload.value']] },
              { from: 'ready', to: 'ready', event: 'SEND', guard: ['!=', '@entity.content', ''], effects: [['emit', 'SAVE', { content: '@entity.content' }]] },
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

describe('local seed whose cascade reaches server-bound work', () => {
  it('collects and posts the downstream leg', async () => {
    const s = schema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const opts: ClientRoleOpts = { orbitalName: 'ChatOrbital', traitIndex, store, carriesCircuitState: true };
    await dispatchWithServerLeg(opts, { event: 'DRAFT', targetTrait: 'Composer', payload: { value: 'hi' } });
    const dispatch = await dispatchWithServerLeg(opts, { event: 'SEND', targetTrait: 'Composer' });
    expect(dispatch.mode).toBe('hybridClientOnly');
    expect(dispatch.serverLeg).toBeDefined();

    const sent: OrbitalEventRequest[] = [];
    const transport = createInProcessTransport(vi.fn(async (_orbital: string, request: OrbitalEventRequest) => {
      sent.push(request);
      return { success: true, transitioned: true, states: {}, emittedEvents: [] };
    }));
    await postServerLeg(transport, 'ChatOrbital', dispatch, store, opts);
    expect(sent.map((r) => r.event)).toEqual(['SEND']);
  });

  it('stateful: the server runs the downstream persist with the local seed\'s own state', async () => {
    const s = schema();
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence });
    await runtime.register(s);
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({
      orbitalName: 'ChatOrbital',
      traitIndex,
      store,
      carriesCircuitState: false,
      transport: createInProcessTransport((orbital, request) => runtime.processOrbitalEvent(orbital, request)),
    });
    await kernel.dispatch({ event: 'DRAFT', targetTrait: 'Composer', payload: { value: 'typed' } });
    await kernel.dispatch({ event: 'SEND', targetTrait: 'Composer' });
    const rows = await persistence.list('Message');
    expect(rows.map((r) => r['content'])).toEqual(['typed']);
  });
});
