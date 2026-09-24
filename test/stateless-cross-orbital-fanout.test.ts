/**
 * G-RUNTIME-041, stateless composition: a client-declared GO whose
 * self-emitted STEP loop fans REQUESTED to a responder in ANOTHER orbital. The
 * responder's RESULTS targets the declared (client-owned) searcher — it must
 * be handed back for the client, never run against a stale state.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createIndexStageRunner,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  StateMachineManager,
} from '../src/index.js';

function schema(persistedQuery = false): OrbitalSchema {
  return {
    name: 'stateless-fanout',
    version: '1.0.0',
    orbitals: [
      {
        name: 'SearchOrbital',
        entity: {
          name: 'Query',
          ...(persistedQuery ? { persistence: 'persistent' as const, collection: 'queries' } : { persistence: 'runtime' as const }),
          fields: [
            { name: 'id', type: 'string' },
            { name: 'pending', type: 'array', default: [] },
            { name: 'answered', type: 'number', default: 0 },
          ],
        },
        traits: [
          {
            name: 'Searcher',
            scope: 'instance',
            linkedEntity: 'Query',
            emits: [{ event: 'REQUESTED', scope: 'external', payloadSchema: [{ name: 'moduleKey', type: 'string' }] }],
            listens: [{ event: 'RESULTS', source: { kind: 'any' }, triggers: 'RESULTS' }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'searching' }],
              events: [],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'button', label: 'Go', action: 'GO' }]] },
                {
                  from: 'idle', to: 'searching', event: 'GO',
                  effects: [
                    ...(persistedQuery ? [['persist', 'create', 'Query', { answered: 0 }]] : []),
                    ['set', '@entity.pending', ['list', 'tasks', 'clients']],
                    ['set', '@entity.answered', 0],
                    ['emit', 'STEP', { remaining: 2 }],
                    ['render-ui', 'main', { type: 'typography', content: 'Searching…' }],
                  ],
                },
                {
                  from: 'searching', to: 'searching', event: 'STEP', guard: ['>', '@payload.remaining', 0],
                  effects: [
                    ['emit', 'REQUESTED', { moduleKey: ['array/first', '@entity.pending'] }],
                    ['set', '@entity.pending', ['array/drop', '@entity.pending', 1]],
                    ['when', ['>', ['array/len', '@entity.pending'], 0], ['emit', 'STEP', { remaining: ['array/len', '@entity.pending'] }]],
                  ],
                },
                {
                  from: 'searching', to: 'searching', event: 'RESULTS',
                  effects: [
                    ['set', '@entity.answered', ['+', '@entity.answered', 1]],
                    ['render-ui', 'main', { type: 'typography', content: ['str/concat', 'answered:', '@entity.answered'] }],
                  ],
                },
              ],
            },
          },
        ],
        pages: [{ name: 'SearchPage', path: '/search', traits: [{ ref: 'Searcher' }] }],
      },
      {
        name: 'ModuleOrbital',
        entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Responder',
            scope: 'instance',
            linkedEntity: 'Item',
            category: 'lifecycle',
            emits: [{ event: 'RESULTS', scope: 'external', payloadSchema: [{ name: 'moduleKey', type: 'string' }] }],
            listens: [{ event: 'REQUESTED', source: { kind: 'any' }, triggers: 'REQUESTED' }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'REQUESTED', guard: ['!=', '@payload.moduleKey', null],
                  effects: [['emit', 'RESULTS', { moduleKey: '@payload.moduleKey' }]],
                },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  } as OrbitalSchema;
}

describe('stateless cross-orbital fan-out from a declared dispatch', () => {
  it('runs the declared loop, reaches the responder, and returns its answers for the client', async () => {
    const s = schema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const persistence = new InMemoryPersistence();
    const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frames = new Map<string, EntityRow>();
    const response = await evaluateOrbitalEvent(
      {
        traitIndex,
        manager,
        persistence,
        frames,
        runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }),
        runtimeRowSentinel: true,
      },
      { event: 'GO', targetTrait: 'Searcher', sourceTrait: 'Searcher', traits: [{ trait: 'Searcher', from: 'idle' }] },
    );
    expect(response.states['Searcher']).toBe('searching');
    const requested = response.emittedEvents.filter((e) => e.event === 'REQUESTED').map((e) => e.payload?.['moduleKey']);
    expect(requested).toEqual(['tasks', 'clients']);
    const answers = response.emittedEvents.filter((e) => e.event === 'RESULTS');
    expect(answers.map((e) => e.payload?.['moduleKey'])).toEqual(['tasks', 'clients']);
    // A delegated leg runs the whole circuit server-side: both answers land.
    expect(response.entityByTrait?.['Searcher']?.['answered']).toBe(2);
    const lastRender = (response.clientEffectsByTrait ?? []).filter((e) => e.traitName === 'Searcher').at(-1);
    expect(JSON.stringify(lastRender?.effect)).toContain('answered:');
  });

  it('keeps the searcher\'s state when its own step persisted a row (entity scope follows the step)', async () => {
    const s = schema(true);
    const traitIndex = buildTraitIndex(s.orbitals);
    const persistence = new InMemoryPersistence();
    const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frames = new Map<string, EntityRow>();
    const response = await evaluateOrbitalEvent(
      {
        traitIndex,
        manager,
        persistence,
        frames,
        runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }),
        runtimeRowSentinel: true,
      },
      { event: 'GO', targetTrait: 'Searcher', sourceTrait: 'Searcher', traits: [{ trait: 'Searcher', from: 'idle' }] },
    );
    expect(response.states['Searcher']).toBe('searching');
    expect(response.entityByTrait?.['Searcher']?.['answered']).toBe(2);
  });
});
