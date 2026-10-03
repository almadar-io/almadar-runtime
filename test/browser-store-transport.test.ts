/**
 * A compiled static client hands its browser legs to `openBrowserStoreTransport`:
 * the stateless leg (`traits[].from`, `entityByTrait`) runs the full effect stage
 * against the seeded browser store.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import { browserStoreName, openBrowserStore, openBrowserStoreTransport, openBundledBrowserStore } from '../src/evaluation/browser-store-transport';

function schema(local: boolean, localeInstances?: Record<string, EntityRow[]>): OrbitalSchema {
  return {
    name: 'Books',
    orbitals: [{
      name: 'Books',
      entity: {
        name: 'Invoice', persistence: 'persistent', collection: 'invoices', ...(local ? { local: true } : {}),
        fields: [{ name: 'id', type: 'string', required: true }, { name: 'amount', type: 'number' }],
        instances: [{ id: 'INV-1', amount: 4200 }],
        ...(localeInstances !== undefined ? { localeInstances } : {}),
      },
      traits: [{
        name: 'InvoiceList', linkedEntity: 'Invoice', category: 'interaction', scope: 'collection',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'open' }, { name: 'shown' }],
          events: [{ key: 'OPEN', name: 'OPEN' }, { key: 'LOAD', name: 'LOAD' }, { key: 'LOADED', name: 'LOADED' }],
          transitions: [
            { from: 'idle', to: 'open', event: 'OPEN', effects: [] },
            { from: 'open', to: 'open', event: 'LOAD', effects: [['fetch', 'Invoice', { emit: { success: 'LOADED' } }]] },
            { from: 'open', to: 'shown', event: 'LOADED', effects: [] },
          ],
        },
      }],
      pages: [],
    }],
  };
}

const db = () => `bst-${Math.random()}`;

describe('openBrowserStoreTransport', () => {
  it('runs a stateless leg from the carried state against the seeded store', async () => {
    const transport = await openBrowserStoreTransport({ databaseName: db(), schema: schema(true) });
    const response = await transport.send('Books', { event: 'LOAD', traits: [{ trait: 'InvoiceList', from: 'open' }] });
    expect(response.success).toBe(true);
    expect(JSON.stringify(response)).toContain('INV-1');
    expect(response.emittedEvents.map((e) => e.event)).toContain('LOADED');
  });

  it('control: the same leg from a state with no LOAD arm does nothing', async () => {
    const transport = await openBrowserStoreTransport({ databaseName: db(), schema: schema(true) });
    const response = await transport.send('Books', { event: 'LOAD', traits: [{ trait: 'InvoiceList', from: 'idle' }] });
    expect(JSON.stringify(response)).not.toContain('INV-1');
  });

  it('refuses a schema that declares no browser-stored entity', async () => {
    await expect(openBrowserStoreTransport({ databaseName: db(), schema: schema(false) })).rejects.toThrow(/no browser-stored entity/);
  });

  it('openBrowserStore returns null when nothing is browser-stored, and a seeded store otherwise', async () => {
    expect(await openBrowserStore(db(), schema(false).orbitals)).toBeNull();
    const store = await openBrowserStore(db(), schema(true).orbitals);
    expect(await store?.getById('Invoice', 'INV-1')).toMatchObject({ amount: 4200 });
  });

  it('openBundledBrowserStore parses a compiled client\'s bundled JSON with this runtime\'s core', async () => {
    const bundled = JSON.parse(JSON.stringify({ ...schema(true), name: `Bundled-${Math.random()}` }));
    const transport = await openBundledBrowserStore(bundled);
    const response = await transport.send('Books', { event: 'LOAD', traits: [{ trait: 'InvoiceList', from: 'open' }] });
    expect(JSON.stringify(response)).toContain('INV-1');
  });

  it('a compiled client relays its own cascade: the bundled store runs only the requested step', async () => {
    const bundled = JSON.parse(JSON.stringify({ ...schema(true), name: `Relay-${Math.random()}` }));
    const transport = await openBundledBrowserStore(bundled);
    const response = await transport.send('Books', { event: 'LOAD', traits: [{ trait: 'InvoiceList', from: 'open' }] });
    expect(response.states).toEqual({ InvoiceList: 'open' });
    const loaded = response.emittedEvents.find((e) => e.event === 'LOADED');
    expect(loaded?.source?.dispatched).toBeUndefined();
  });

  it('control: the runtime-path store applies the cascade in process and marks it consumed', async () => {
    const transport = await openBrowserStoreTransport({ databaseName: db(), schema: schema(true) });
    const response = await transport.send('Books', { event: 'LOAD', traits: [{ trait: 'InvoiceList', from: 'open' }] });
    expect(response.states).toEqual({ InvoiceList: 'shown' });
    expect(response.emittedEvents.find((e) => e.event === 'LOADED')?.source?.dispatched).toBe(true);
  });

  it('a viewer locale seeds its own database from its own rows', async () => {
    const app = `Locale-${Math.random()}`;
    const localized = { ...schema(true, { ar: [{ id: 'INV-1', amount: 4200, client: 'نور' }] }), name: app };
    const ar = await openBundledBrowserStore(JSON.parse(JSON.stringify(localized)), 'ar');
    const en = await openBundledBrowserStore(JSON.parse(JSON.stringify(localized)), 'en');
    const load = (t: Awaited<ReturnType<typeof openBundledBrowserStore>>) =>
      t.send('Books', { event: 'LOAD', traits: [{ trait: 'InvoiceList', from: 'open' }] }).then((r) => JSON.stringify(r));
    expect(await load(ar)).toContain('نور');
    expect(await load(en)).not.toContain('نور');
  });

  it('names one database per app and locale', () => {
    expect(browserStoreName('Books', 'ar')).toBe('almadar:Books:ar');
    expect(browserStoreName('Books', undefined)).toBe('almadar:Books');
  });
});
