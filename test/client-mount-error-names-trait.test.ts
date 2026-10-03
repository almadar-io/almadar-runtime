/**
 * A mount whose seed throws rejects with a TraitMountError naming THAT seed's trait and
 * lifecycle event, the evaluator's message kept — the studio card named every trait that
 * was starting (16 of them for one bad AppLayout).
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, TraitMountError } from '../src/index.js';

function layout(name: string, items: string | string[]): Trait {
  return {
    name, scope: 'instance', linkedEntity: 'Item',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [{
        from: 'idle', to: 'idle', event: 'INIT',
        effects: [['render-ui', 'main', { type: 'typography', content: ['array/len', ['array/filter', Array.isArray(items) ? ['list', ...items] : items, ['fn', 'x', true]]] }]],
      }],
    },
  };
}

function kernelFor(traits: Trait[]) {
  const orbitals: OrbitalSchema['orbitals'] = [{
    name: 'Shell', pages: [],
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits,
  }];
  const traitIndex = buildTraitIndex(orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return createClientKernel({ orbitalName: 'Shell', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false });
}

describe('a failed mount names the trait that failed', () => {
  it('the failing seed is named, with its event and the evaluator message', async () => {
    const kernel = kernelFor([layout('Header', ['a']), layout('Layout', 'not-a-list')]);
    const failure = await kernel.dispatchMount([{ trait: 'Header', event: 'INIT' }, { trait: 'Layout', event: 'INIT' }]).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(TraitMountError);
    expect(failure).toMatchObject({ trait: 'Layout', event: 'INIT', message: 'Type mismatch: expected array, got string' });
  });

  it('edge: the first seed failing names the first, not a later one', async () => {
    const kernel = kernelFor([layout('Layout', 'not-a-list'), layout('Footer', ['a'])]);
    const failure = await kernel.dispatchMount([{ trait: 'Layout', event: 'INIT' }, { trait: 'Footer', event: 'INIT' }]).catch((e: Error) => e);
    expect(failure).toMatchObject({ trait: 'Layout', event: 'INIT' });
  });

  it('control: seeds that all start resolve with no error', async () => {
    const kernel = kernelFor([layout('Header', ['a']), layout('Footer', ['b', 'c'])]);
    const outcome = await kernel.dispatchMount([{ trait: 'Header', event: 'INIT' }, { trait: 'Footer', event: 'INIT' }]);
    expect(outcome.success).toBe(true);
    expect(outcome.seeds.map((s) => s.trait)).toEqual(['Header', 'Footer']);
  });
});
