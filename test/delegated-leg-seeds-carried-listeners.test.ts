/**
 * Stateless composition, delegated server leg (`targetTrait` + carried
 * `traits`): the seed's emit fans to a listener the client also carried. The
 * listener must run from the client's state, not its declared initial one
 * (project-friday's cleared filter reached its browse list at `loading`,
 * where REFETCH has no arm, and the fold wrote `loading` back to the client).
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalEventRequest, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createIndexStageRunner,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  StateMachineManager,
} from '../src/index.js';

const schema: OrbitalSchema = {
  name: 'delegated-leg',
  version: '1.0.0',
  orbitals: [
    {
      name: 'ListOrbital',
      entity: { name: 'Row', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        {
          name: 'Filter',
          scope: 'instance',
          linkedEntity: 'Row',
          emits: [{ event: 'FILTER', scope: 'internal' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'CLEAR', effects: [['emit', 'FILTER', {}]] }],
          },
        },
        {
          name: 'List',
          scope: 'instance',
          linkedEntity: 'Row',
          listens: [{ event: 'FILTER', source: { kind: 'trait', trait: 'Filter' }, triggers: 'REFETCH' }],
          stateMachine: {
            states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
            events: [],
            transitions: [
              { from: 'loading', to: 'browsing', event: 'LOADED', effects: [] },
              { from: 'browsing', to: 'browsing', event: 'REFETCH', effects: [['render-ui', 'main', { type: 'typography', content: 'refetched' }]] },
            ],
          },
        },
      ],
      pages: [{ name: 'ListPage', path: '/list', traits: [{ ref: 'Filter' }, { ref: 'List' }] }],
    },
  ],
};

async function run(request: OrbitalEventRequest) {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const persistence = new InMemoryPersistence();
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const frames = new Map<string, EntityRow>();
  return evaluateOrbitalEvent(
    { traitIndex, manager, persistence, frames, runtimeRowSentinel: true, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema }) },
    request,
  );
}

const leg = (traits: Array<{ trait: string; from: string }>, activeTraits?: string[]): OrbitalEventRequest => ({
  event: 'CLEAR',
  targetTrait: 'Filter',
  sourceTrait: 'Filter',
  traits,
  ...(activeTraits !== undefined ? { payload: { _activeTraits: activeTraits } } : {}),
});

describe('delegated server leg seeds every carried trait', () => {
  it('fans the seed\'s emit to a carried listener from the client\'s state', async () => {
    const response = await run(leg([{ trait: 'Filter', from: 'idle' }, { trait: 'List', from: 'browsing' }]));
    expect(response.states['List']).toBe('browsing');
    expect(JSON.stringify(response.clientEffectsByTrait?.filter((e) => e.traitName === 'List'))).toContain('refetched');
  });

  it('honours the page\'s active set for carried traits (the same as a declared dispatch)', async () => {
    const response = await run(leg([{ trait: 'Filter', from: 'idle' }, { trait: 'List', from: 'browsing' }], ['Filter']));
    expect(response.clientEffectsByTrait?.some((e) => e.traitName === 'List') ?? false).toBe(false);
  });

  it('control: an uncarried listener still starts from its declared initial state', async () => {
    const response = await run(leg([{ trait: 'Filter', from: 'idle' }]));
    expect(response.states['List']).toBe('loading');
    expect(response.clientEffectsByTrait?.some((e) => e.traitName === 'List') ?? false).toBe(false);
  });
});
