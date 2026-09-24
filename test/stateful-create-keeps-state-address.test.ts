/**
 * project-friday /global-search on the STATEFUL topology: the searcher's
 * SEARCH arm persists a history row (`persist create SearchQuery`) and moves
 * idle -> searching. The step adopted the created row's id as the trait's
 * address, so `searching` was committed under that id; the modules' answers
 * came back through the cross-orbital relay with no id, found the trait at
 * its original address still `idle`, and the SEARCH_RESULTS arm never ran.
 * A created row is what later READS see; the state machine stays addressed
 * where the event came in (the Rust kernel never re-addresses on a create).
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

function schema(): OrbitalSchema {
  return {
    name: 'create-keeps-address',
    version: '1.0.0',
    orbitals: [
      {
        name: 'SearchOrbital',
        pages: [],
        entity: { name: 'Query', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }, { name: 'text', type: 'string' }, { name: 'answered', type: 'number', default: 0 }] },
        traits: [{
          name: 'Searcher',
          scope: 'instance',
          linkedEntity: 'Query',
          emits: [{ event: 'REQUESTED', scope: 'external', payloadSchema: [{ name: 'q', type: 'string' }] }],
          listens: [{ event: 'RESULTS', source: { kind: 'any' }, triggers: 'RESULTS' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'searching' }, { name: 'done' }],
            events: [],
            transitions: [
              {
                from: 'idle', to: 'searching', event: 'SEARCH',
                effects: [['persist', 'create', 'Query', { text: '@payload.q' }], ['emit', 'REQUESTED', { q: '@payload.q' }]],
              },
              { from: 'searching', to: 'searching', event: 'RESULTS', effects: [['set', '@entity.answered', ['+', ['object/get', '@entity', 'answered', 0], 1]]] },
            ],
          },
        }],
      },
      {
        name: 'TaskOrbital',
        pages: [],
        entity: { name: 'Task', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [{
          name: 'Responder',
          scope: 'instance',
          linkedEntity: 'Task',
          emits: [{ event: 'RESULTS', scope: 'external', payloadSchema: [{ name: 'q', type: 'string' }] }],
          listens: [{ event: 'REQUESTED', source: { kind: 'any' }, triggers: 'REQUESTED' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'REQUESTED', effects: [['emit', 'RESULTS', { q: '@payload.q' }]] }],
          },
        }],
      },
      {
        name: 'ClientOrbital',
        pages: [],
        entity: { name: 'Client', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [{
          name: 'ClientResponder',
          scope: 'instance',
          linkedEntity: 'Client',
          emits: [{ event: 'RESULTS', scope: 'external', payloadSchema: [{ name: 'q', type: 'string' }] }],
          listens: [{ event: 'REQUESTED', source: { kind: 'any' }, triggers: 'REQUESTED' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'REQUESTED', effects: [['emit', 'RESULTS', { q: ['str/concat', '@payload.q', '-clients'] }]] }],
          },
        }],
      },
    ],
  } as OrbitalSchema;
}

describe('stateful: a persist create does not re-address the trait state', () => {
  it('every cross-orbital answer reaches the searcher in `searching`', async () => {
    const persistence = new InMemoryPersistence();
    const rt = new OrbitalServerRuntime({ debug: false, persistence });
    await rt.register(schema());
    const response = await rt.processOrbitalEvent('SearchOrbital', { event: 'SEARCH', targetTrait: 'Searcher', payload: { q: 'e' } });
    expect((await persistence.list('Query')).map((r) => r['text'])).toEqual(['e']);
    expect(response.states['Searcher']).toBe('searching');
    expect(response.entityByTrait?.['Searcher']?.['answered']).toBe(2);
  });
});
