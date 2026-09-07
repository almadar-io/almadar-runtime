/**
 * C1-V13: `MockPersistenceAdapter.create` must honor a caller-supplied
 * `data.id` (store truth) instead of always minting a fresh one — the bug
 * that made Project Friday's `CREATE_TASK -> backlog` create succeed under
 * the payload id while the very next `START_TASK -> in_progress`
 * `persist update` failed with "Entity Task with id <payload id> not
 * found", because the store had actually keyed the row under a different,
 * minted id.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/MockPersistenceAdapter.js';

describe('MockPersistenceAdapter.create — id contract', () => {
    it('keeps an explicit data.id and the row is retrievable via getById', async () => {
        const adapter = new MockPersistenceAdapter();
        const { id } = await adapter.create('Task', { id: 'task-explicit-1', title: 'Explicit' });
        expect(id).toBe('task-explicit-1');
        const row = await adapter.getById('Task', 'task-explicit-1');
        expect(row).not.toBeNull();
        expect(row!.title).toBe('Explicit');
    });

    it('throws on a second create with the same explicit id (unique constraint)', async () => {
        const adapter = new MockPersistenceAdapter();
        await adapter.create('Task', { id: 'task-dupe', title: 'First' });
        await expect(
            adapter.create('Task', { id: 'task-dupe', title: 'Second' }),
        ).rejects.toThrow('Entity Task with id task-dupe already exists');
    });

    it('mints an id when the caller supplies none', async () => {
        const adapter = new MockPersistenceAdapter();
        const { id } = await adapter.create('Task', { title: 'No id supplied' });
        expect(id).toBe('Task Id 1');
        const row = await adapter.getById('Task', id);
        expect(row).not.toBeNull();
    });
});
