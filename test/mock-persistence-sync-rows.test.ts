/**
 * The mock store is shared by both execution paths: the runtime reaches it through the async
 * `PersistenceAdapter` methods, and `@almadar/server`'s `MockDataService` (the compiled apps' mock,
 * a synchronous API generated seed code calls without awaiting) through the synchronous row
 * methods. Both surfaces are one implementation, so they must agree.
 *
 * Timestamps a caller supplies are kept (as ISO strings, the store's one representation); only an
 * absent timestamp is stamped with now.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';

describe('MockPersistenceAdapter synchronous rows', () => {
  it('insertRow / rowOf / rowsOf / patchRow / removeRow match the async surface', async () => {
    const adapter = new MockPersistenceAdapter();
    const made = adapter.insertRow('Task', { title: 'a' });
    expect(made).toMatchObject({ id: 'Task Id 1', title: 'a' });
    expect(adapter.rowOf('Task', 'Task Id 1')).toEqual(await adapter.getById('Task', 'Task Id 1'));
    expect(adapter.rowsOf('Task')).toEqual(await adapter.list('Task'));
    expect(adapter.patchRow('Task', 'Task Id 1', { title: 'b' })).toMatchObject({ id: 'Task Id 1', title: 'b' });
    expect(adapter.removeRow('Task', 'Task Id 1')).toBe(true);
    expect(adapter.rowsOf('Task')).toEqual([]);
  });

  it('control: on a missing row the sync methods report it, the async ones still throw', async () => {
    const adapter = new MockPersistenceAdapter();
    expect(adapter.patchRow('Task', 'nope', { title: 'x' })).toBeNull();
    expect(adapter.removeRow('Task', 'nope')).toBe(false);
    await expect(adapter.update('Task', 'nope', { title: 'x' })).rejects.toThrow('not found');
    await expect(adapter.delete('Task', 'nope')).rejects.toThrow('not found');
  });
});

describe('MockPersistenceAdapter timestamps', () => {
  it('keeps supplied createdAt / updatedAt, stored as ISO strings', async () => {
    const adapter = new MockPersistenceAdapter();
    const at = new Date('2025-03-04T05:06:07.000Z');
    await adapter.create('Task', { id: 't', createdAt: at, updatedAt: at });
    expect(await adapter.getById('Task', 't')).toMatchObject({ createdAt: at.toISOString(), updatedAt: at.toISOString() });
    const later = '2025-04-01T00:00:00.000Z';
    await adapter.update('Task', 't', { updatedAt: later, title: 'x' });
    expect(await adapter.getById('Task', 't')).toMatchObject({ createdAt: at.toISOString(), updatedAt: later });
  });

  it('control: absent timestamps are stamped with now', async () => {
    const adapter = new MockPersistenceAdapter();
    const before = Date.now();
    await adapter.create('Task', { id: 't' });
    const row = await adapter.getById('Task', 't');
    expect(typeof row?.createdAt).toBe('string');
    expect(Date.parse(String(row?.createdAt))).toBeGreaterThanOrEqual(before);
    expect(row?.updatedAt).toBe(row?.createdAt);
  });
});
