/**
 * C1-V13: two-path parity — `createServerEffectHandlers` wired to a REAL
 * `MockPersistenceAdapter` must round-trip a caller-supplied create id the
 * same way the compiled path's `MockDataService` does (see
 * packages/almadar-server/src/services/__tests__/MockDataService.create-id.test.ts).
 * Regression for Project Friday's `CREATE_TASK -> backlog` then
 * `START_TASK -> in_progress`: create with an explicit id, then a
 * same-instance `persist update` by that id, against the real store.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/MockPersistenceAdapter.js';
import { createServerEffectHandlers, type ServerEffectResult } from '../src/ServerEffectHandlers.js';
import { EffectExecutor } from '../src/EffectExecutor.js';
import type { BindingContext, EffectContext } from '../src/types.js';

function makeExecutor(persistence: MockPersistenceAdapter, effectResults: ServerEffectResult[]) {
    const handlers = createServerEffectHandlers({
        persistence,
        eventBus: { emit: () => {} },
        entityType: 'Task',
        effectResults,
    });
    const bindings: BindingContext = {};
    const context: EffectContext = { traitName: 'TaskLifecycle', state: 'backlog', transition: 'none->backlog' };
    return new EffectExecutor({ handlers, bindings, context });
}

describe('createServerEffectHandlers + MockPersistenceAdapter — create then update by explicit id', () => {
    it('create with an explicit id, then update by that id, succeeds against the real store', async () => {
        const persistence = new MockPersistenceAdapter();
        const effectResults: ServerEffectResult[] = [];
        const executor = makeExecutor(persistence, effectResults);

        await executor.execute(['persist', 'create', 'Task', { id: 'task-explicit', title: 'Backlog item', status: 'backlog' }]);
        const created = await persistence.getById('Task', 'task-explicit');
        expect(created).not.toBeNull();

        await executor.execute(['persist', 'update', 'Task', { id: 'task-explicit', status: 'in_progress' }]);

        const updated = await persistence.getById('Task', 'task-explicit');
        expect(updated).not.toBeNull();
        expect(updated!.status).toBe('in_progress');
        expect(updated!.title).toBe('Backlog item');

        const updateResult = effectResults.find((r) => r.action === 'update');
        expect(updateResult?.success).toBe(true);
    });

    it('result row id is the store minted id when the create data had none', async () => {
        const persistence = new MockPersistenceAdapter();
        const effectResults: ServerEffectResult[] = [];
        const executor = makeExecutor(persistence, effectResults);

        await executor.execute(['persist', 'create', 'Task', { title: 'No id supplied' }]);

        const createResult = effectResults.find((r) => r.action === 'create');
        expect(createResult?.success).toBe(true);
        const resultId = (createResult?.data as { id?: string } | undefined)?.id;
        expect(resultId).toBeDefined();
        const stored = await persistence.getById('Task', resultId!);
        expect(stored).not.toBeNull();
        expect(stored!.title).toBe('No id supplied');
    });
});
