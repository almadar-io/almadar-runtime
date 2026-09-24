/**
 * project-friday /global-search: the client's local run of the fan-out
 * emitted MODULE_SEARCH_REQUESTED { moduleKey: null } with no queryText. A
 * same-trait cascade's second step (FAN_OUT_STEP) read `@entity` as the bare
 * persisted row — the client effect runner bound only that, while the server
 * stage binds declared defaults < persisted row < the live frame the first
 * step wrote. Both runners bind `@entity` the same way at every step.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalId, OrbitalSchema } from '@almadar/core';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import {
  buildTraitIndex,
  createIndexStageRunner,
  createMemoryCircuitStore,
  dispatchWithServerLeg,
  evaluateOrbitalEvent,
  StateMachineManager,
} from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'fan-out-steps',
    version: '1.0.0',
    orbitals: [{
      name: 'SearchOrbital',
      id: 'orb_search' as OrbitalId,
      pages: [],
      entity: {
        name: 'Query',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string' },
          { name: 'queryText', type: 'string' },
          { name: 'pending', type: 'array', default: [] },
          { name: 'label', type: 'string', default: 'declared' },
        ],
      },
      traits: [{
        name: 'Searcher',
        linkedEntity: 'Query',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'searching' }],
          events: [],
          transitions: [
            {
              from: 'idle', to: 'searching', event: 'SEARCH',
              effects: [
                ['set', '@entity.queryText', '@payload.queryText'],
                ['set', '@entity.pending', ['list', 'tasks', 'clients']],
                ['emit', 'STEP', { remaining: 2 }],
              ],
            },
            {
              from: 'searching', to: 'searching', event: 'STEP', guard: ['>', '@payload.remaining', 0],
              effects: [['emit', 'REQUESTED', {
                moduleKey: ['array/first', '@entity.pending'],
                queryText: '@entity.queryText',
                label: '@entity.label',
              }]],
            },
          ],
        },
      }],
    }],
  } as OrbitalSchema;
}

function requested(emitted: ReadonlyArray<{ event: string; payload?: Record<string, unknown> }>) {
  return emitted.find((e) => e.event === 'REQUESTED')?.payload;
}

describe('@entity binding across a same-trait cascade', () => {
  it('client: the second step sees what the first step wrote, over declared defaults', async () => {
    const s = schema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const d = await dispatchWithServerLeg(
      { orbitalName: 'SearchOrbital', traitIndex, store, carriesCircuitState: true },
      { event: 'SEARCH', targetTrait: 'Searcher', payload: { queryText: 'a' } },
    );
    expect(requested(d.response.emittedEvents)).toEqual({ moduleKey: 'tasks', queryText: 'a', label: 'declared' });
  });

  it('server stage binds the same values (twin)', async () => {
    const s = schema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const persistence = new InMemoryPersistence();
    const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frames = new Map<string, EntityRow>();
    const r = await evaluateOrbitalEvent(
      { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) },
      { event: 'SEARCH', targetTrait: 'Searcher', payload: { queryText: 'a' } },
    );
    expect(requested(r.emittedEvents)).toEqual({ moduleKey: 'tasks', queryText: 'a', label: 'declared' });
  });
});
