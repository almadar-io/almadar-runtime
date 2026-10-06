/**
 * A browser-stored entity end to end, with no server: seeded written-out rows
 * come back from a `fetch` run in-process, and a `persist` survives into the
 * browser store.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition, OrbitalEntity } from '@almadar/core';
import { buildTraitIndex } from '../src/traits/trait-index';
import { createMemoryCircuitStore } from '../src/evaluation/circuit-store';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { seedBrowserStore } from '../src/entities/seedBrowserStore';

const invoice: OrbitalEntity = {
  name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true,
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'amount', type: 'number' }],
  instances: [{ id: 'INV-1', amount: 4200 }, { id: 'INV-2', amount: 980 }],
};

const orbital: OrbitalDefinition = {
  name: 'Books',
  entity: invoice,
  traits: [{
    name: 'InvoiceList', linkedEntity: 'Invoice', category: 'interaction', scope: 'collection',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'LOAD', name: 'LOAD' }, { key: 'ADD', name: 'ADD' }, { key: 'LOADED', name: 'LOADED' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'Invoice', { emit: { success: 'LOADED' } }]] },
        { from: 'idle', to: 'idle', event: 'ADD', effects: [['persist', 'create', 'Invoice', { id: 'INV-3', amount: 15 }]] },
        { from: 'idle', to: 'idle', event: 'LOADED', effects: [] },
      ],
    },
  }],
  pages: [],
};

async function host() {
  const traitIndex = buildTraitIndex([orbital]);
  const persistence = await IndexedDbPersistence.open({ databaseName: `e2e-${Math.random()}`, entityTypes: ['Invoice'] });
  await seedBrowserStore(persistence, [invoice]);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  return { persistence, transport: createLocalStoreTransport({ traitIndex, persistence, store }) };
}

describe('browser-stored entity end to end', () => {
  it('a fetch returns the written-out rows from the browser store', async () => {
    const { transport } = await host();
    const response = await transport.send('Books', { event: 'LOAD', targetTrait: 'InvoiceList' });
    expect(response.success).toBe(true);
    const rows = JSON.stringify(response);
    expect(rows).toContain('INV-1');
    expect(rows).toContain('INV-2');
    expect(response.emittedEvents.map((e) => e.event)).toContain('LOADED');
  });

  it('a persist writes into the browser store', async () => {
    const { transport, persistence } = await host();
    await transport.send('Books', { event: 'ADD', targetTrait: 'InvoiceList' });
    expect(await persistence.getById('Invoice', 'INV-3')).toMatchObject({ amount: 15 });
    expect((await persistence.changes()).at(-1)).toMatchObject({ op: 'create', id: 'INV-3' });
  });
});
