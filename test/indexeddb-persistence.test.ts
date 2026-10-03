/**
 * Browser-stored entities (`[persistent: x, local]`) keep their rows in
 * IndexedDB: they survive a reload, every write is logged for a later sync, and
 * a reopened database gains new entity types without losing rows.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IndexedDbPersistence, CHANGE_LOG } from '../src/entities/IndexedDbPersistence';

let n = 0;
const name = () => `idb-${++n}`;

describe('IndexedDbPersistence', () => {
  it('rows survive closing and reopening the database', async () => {
    const databaseName = name();
    const first = await IndexedDbPersistence.open({ databaseName, entityTypes: ['Invoice'] });
    await first.create('Invoice', { id: 'INV-1', amount: 4 });
    first.close();
    const second = await IndexedDbPersistence.open({ databaseName, entityTypes: ['Invoice'] });
    expect(await second.getById('Invoice', 'INV-1')).toMatchObject({ amount: 4 });
  });

  it('a minted id is a UUID and every write stamps updatedAt', async () => {
    const store = await IndexedDbPersistence.open({ databaseName: name(), entityTypes: ['Invoice'], now: () => '2026-10-03T10:00:00.000Z' });
    const { id } = await store.create('Invoice', { amount: 4 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.getById('Invoice', id)).toMatchObject({ updatedAt: '2026-10-03T10:00:00.000Z' });
  });

  it('every write is appended to the change log in order', async () => {
    const store = await IndexedDbPersistence.open({ databaseName: name(), entityTypes: ['Invoice'], now: () => 't' });
    await store.create('Invoice', { id: 'INV-1', amount: 4 });
    await store.update('Invoice', 'INV-1', { amount: 5 });
    await store.delete('Invoice', 'INV-1');
    const log = await store.changes();
    expect(log.map((c) => [c.op, c.entityType, c.id])).toEqual([
      ['create', 'Invoice', 'INV-1'],
      ['update', 'Invoice', 'INV-1'],
      ['delete', 'Invoice', 'INV-1'],
    ]);
    expect(CHANGE_LOG).toBe('__changes');
  });

  it('control: a read logs nothing', async () => {
    const store = await IndexedDbPersistence.open({ databaseName: name(), entityTypes: ['Invoice'] });
    await store.list('Invoice');
    await store.getById('Invoice', 'X');
    expect(await store.changes()).toEqual([]);
  });

  it('reopening with a new entity type keeps the existing rows', async () => {
    const databaseName = name();
    const first = await IndexedDbPersistence.open({ databaseName, entityTypes: ['Invoice'] });
    await first.create('Invoice', { id: 'INV-1' });
    first.close();
    const second = await IndexedDbPersistence.open({ databaseName, entityTypes: ['Invoice', 'Ledger'] });
    await second.create('Ledger', { id: 'L-1' });
    expect(await second.getById('Invoice', 'INV-1')).not.toBeNull();
    expect(await second.getById('Ledger', 'L-1')).not.toBeNull();
  });

  it('countRows counts without reading rows', async () => {
    const store = await IndexedDbPersistence.open({ databaseName: name(), entityTypes: ['Invoice'] });
    await store.create('Invoice', { id: 'A' });
    await store.create('Invoice', { id: 'B' });
    expect(await store.countRows('Invoice')).toBe(2);
  });

  it('an entity type it was not opened with is an error, never a silent empty store', async () => {
    const store = await IndexedDbPersistence.open({ databaseName: name(), entityTypes: ['Invoice'] });
    await expect(store.list('Unknown')).rejects.toThrow(/not opened with entity type "Unknown"/);
  });
});
