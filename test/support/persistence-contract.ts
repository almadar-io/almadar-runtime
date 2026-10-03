/**
 * The PersistenceAdapter contract every adapter runs: create/read/update/delete
 * behave the same whichever store holds the rows.
 */
import { describe, it, expect } from 'vitest';
import type { PersistenceAdapter } from '../../src/entities/PersistenceAdapter';

export function runPersistenceContract(name: string, make: () => Promise<PersistenceAdapter>): void {
  describe(`${name} — PersistenceAdapter contract`, () => {
    it('create returns the given id and getById reads the row back', async () => {
      const store = await make();
      const { id } = await store.create('Invoice', { id: 'INV-1', amount: 4 });
      expect(id).toBe('INV-1');
      expect(await store.getById('Invoice', 'INV-1')).toMatchObject({ id: 'INV-1', amount: 4 });
    });

    it('create without an id mints one', async () => {
      const store = await make();
      const { id } = await store.create('Invoice', { amount: 4 });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(await store.getById('Invoice', id)).toMatchObject({ id, amount: 4 });
    });

    it('update merges into the existing row', async () => {
      const store = await make();
      await store.create('Invoice', { id: 'INV-1', amount: 4, status: 'draft' });
      await store.update('Invoice', 'INV-1', { status: 'paid' });
      expect(await store.getById('Invoice', 'INV-1')).toMatchObject({ id: 'INV-1', amount: 4, status: 'paid' });
    });

    it('update of a missing row creates nothing', async () => {
      const store = await make();
      await store.update('Invoice', 'NOPE', { status: 'paid' });
      expect(await store.getById('Invoice', 'NOPE')).toBeNull();
    });

    it('delete removes the row', async () => {
      const store = await make();
      await store.create('Invoice', { id: 'INV-1' });
      await store.delete('Invoice', 'INV-1');
      expect(await store.getById('Invoice', 'INV-1')).toBeNull();
    });

    it('list returns every row of one entity type only', async () => {
      const store = await make();
      await store.create('Invoice', { id: 'INV-1' });
      await store.create('Invoice', { id: 'INV-2' });
      await store.create('Ledger', { id: 'L-1' });
      expect((await store.list('Invoice')).map((r) => r.id).sort()).toEqual(['INV-1', 'INV-2']);
      expect(await store.list('Empty')).toEqual([]);
    });
  });
}
