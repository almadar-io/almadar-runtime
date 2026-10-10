/**
 * A browser-stored seed that leaves its initial state on mount (`idle -INIT-> loading`
 * with a fetch) must still run its fetch: the in-process browser store shares the
 * client's state manager, so the mount leg has to carry the seed's pre-dispatch
 * state, exactly as a single dispatch's leg does.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition, OrbitalEntity, Transition } from '@almadar/core';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore } from '../src/index.js';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';
import { seedBrowserStore } from '../src/entities/seedBrowserStore';

const invoice: OrbitalEntity = {
  name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true,
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'amount', type: 'number' }],
  instances: [{ id: 'INV-1', amount: 4200 }],
};

function orbital(initTransition: Transition): OrbitalDefinition {
  return {
    name: 'Books',
    entity: invoice,
    traits: [{
      name: 'InvoiceDetail', linkedEntity: 'Invoice', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'loading' }, { name: 'shown' }],
        events: [{ key: 'INIT', name: 'INIT' }, { key: 'LOADED', name: 'LOADED' }],
        transitions: [
          initTransition,
          { from: 'loading', to: 'shown', event: 'LOADED', effects: [] },
          { from: 'idle', to: 'shown', event: 'LOADED', effects: [] },
        ],
      },
    }],
    pages: [],
  };
}

const fetchOne: Transition['effects'] = [['fetch', 'Invoice', { id: 'INV-1', emit: { success: 'LOADED' } }]];

async function mountOnce(def: OrbitalDefinition): Promise<string | undefined> {
  const traitIndex = buildTraitIndex([def]);
  const persistence = await IndexedDbPersistence.open({ databaseName: `mount-from-${Math.random()}`, entityTypes: ['Invoice'] });
  await seedBrowserStore(persistence, [invoice]);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  const transport = createLocalStoreTransport({ traitIndex, persistence, store });
  const kernel = createClientKernel({ orbitalName: 'Books', traitIndex, store, transport, carriesCircuitState: false });
  await kernel.dispatchMount([{ trait: 'InvoiceDetail', event: 'INIT' }]);
  return store.manager.getState('InvoiceDetail')?.currentState;
}

describe('mount leg over the browser store', () => {
  it('a seed that leaves its initial state still runs its fetch', async () => {
    expect(await mountOnce(orbital({ from: 'idle', to: 'loading', event: 'INIT', effects: fetchOne }))).toBe('shown');
  });

  it('control: a self-loop seed runs its fetch', async () => {
    expect(await mountOnce(orbital({ from: 'idle', to: 'idle', event: 'INIT', effects: fetchOne }))).toBe('shown');
  });
});
