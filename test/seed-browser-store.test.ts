/**
 * A browser-stored entity starts with its written-out `instances`, or with the
 * shared mock seeder's rows when it declares `mock` — once, into an empty store,
 * never over rows the user already has.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalEntity } from '@almadar/core';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { InMemoryPersistence } from '@almadar/db/mock';
import { seedBrowserStore } from '../src/entities/seedBrowserStore';

const fields = [
  { name: 'id', type: 'string' as const, required: true },
  { name: 'client', type: 'string' as const },
  { name: 'amount', type: 'number' as const },
];
const invoice = (extra: Partial<OrbitalEntity>): OrbitalEntity => ({
  name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, fields, ...extra,
});
let n = 0;
const open = () => IndexedDbPersistence.open({ databaseName: `seed-${++n}`, entityTypes: ['Invoice'] });

describe('seedBrowserStore', () => {
  it('an empty store gets the written-out rows', async () => {
    const store = await open();
    await seedBrowserStore(store, [invoice({ instances: [{ id: 'INV-1', client: 'Noor', amount: 4200 }] })]);
    expect(await store.list('Invoice')).toMatchObject([{ id: 'INV-1', client: 'Noor', amount: 4200 }]);
  });

  it('a store that already has rows is not reseeded', async () => {
    const store = await open();
    await store.create('Invoice', { id: 'MINE', client: 'me', amount: 1 });
    await seedBrowserStore(store, [invoice({ instances: [{ id: 'INV-1', client: 'Noor', amount: 4200 }] })]);
    expect((await store.list('Invoice')).map((r) => r.id)).toEqual(['MINE']);
  });

  it('seeding twice inserts the rows once', async () => {
    const store = await open();
    const e = invoice({ instances: [{ id: 'INV-1', client: 'Noor', amount: 4200 }] });
    await seedBrowserStore(store, [e]);
    await seedBrowserStore(store, [e]);
    expect(await store.list('Invoice')).toHaveLength(1);
  });

  it('`mock` fills an empty store from the shared mock seeder', async () => {
    const store = await open();
    await seedBrowserStore(store, [invoice({ seedMock: true })]);
    const rows = await store.list('Invoice');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.id === 'string')).toBe(true);
    // The seeder leaves some optional fields unset per row; the declared field still appears.
    expect(rows.some((r) => typeof r.amount === 'number')).toBe(true);
  });

  it('control: an entity with neither seed source stays empty', async () => {
    const store = await open();
    await seedBrowserStore(store, [invoice({})]);
    expect(await store.list('Invoice')).toEqual([]);
  });

  it('control: server-stored entities are not seeded into the browser store', async () => {
    const store = new InMemoryPersistence();
    await seedBrowserStore(store, [invoice({ local: false, instances: [{ id: 'INV-1', client: 'x', amount: 1 }] })]);
    expect(await store.list('Invoice')).toEqual([]);
  });

  it('the same rule seeds the in-memory store headless verify uses', async () => {
    const store = new InMemoryPersistence();
    await seedBrowserStore(store, [invoice({ instances: [{ id: 'INV-1', client: 'Noor', amount: 4200 }] })]);
    expect((await store.list('Invoice')).map((r) => r.id)).toEqual(['INV-1']);
  });

  it('the viewer locale seeds its own written-out rows', async () => {
    const store = await open();
    const e = invoice({ instances: [{ id: 'INV-1', client: 'Noor', amount: 1 }], localeInstances: { ar: [{ id: 'INV-1', client: 'نور', amount: 1 }] } });
    await seedBrowserStore(store, [e], 'ar');
    expect(await store.list('Invoice')).toMatchObject([{ client: 'نور' }]);
  });

  it('control: a locale without its own block seeds the default rows', async () => {
    const store = await open();
    const e = invoice({ instances: [{ id: 'INV-1', client: 'Noor', amount: 1 }], localeInstances: { ar: [{ id: 'INV-1', client: 'نور', amount: 1 }] } });
    await seedBrowserStore(store, [e], 'sl');
    expect(await store.list('Invoice')).toMatchObject([{ client: 'Noor' }]);
  });
});
