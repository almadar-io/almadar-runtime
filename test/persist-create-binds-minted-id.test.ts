/**
 * C1-V13: after a `(persist create X @entity)` effect succeeds, the live
 * entity binding must carry the store's id — otherwise a same-instance
 * follow-up `(persist update X @entity)` in a later transition (Project
 * Friday's `CREATE_TASK -> backlog` then `START_TASK -> in_progress`) has
 * no row key to update against.
 */
import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';

const CREATE = ['persist', 'create', 'Task', '@entity', { emit: { success: 'TASK_CREATED' } }];

describe('EffectExecutor persist create — write-back onto @entity', () => {
    it('binds the store-minted id onto an id-less bound entity after a successful create', async () => {
        const persist = vi.fn(async (_action: string, _entityType: string, data: unknown) => ({
            ...(data as Record<string, unknown>),
            id: 'Task Id 1',
        }));
        const handlers = stubEffectHandlers({ persist, emit: vi.fn() });
        const bindings: BindingContext = { entity: { title: 'New Task' } };
        const context: EffectContext = { traitName: 'TaskLifecycle', state: 'backlog', transition: 'none->backlog' };
        const executor = new EffectExecutor({ handlers, bindings, context });

        await executor.execute(CREATE);

        expect(persist).toHaveBeenCalledTimes(1);
        expect(bindings.entity!.id).toBe('Task Id 1');
    });

    it('does not overwrite an already-bound entity id when the create is for unrelated literal data', async () => {
        const persist = vi.fn(async (_action: string, _entityType: string, data: unknown) => ({
            ...(data as Record<string, unknown>),
            id: 'Other Id 5',
        }));
        const handlers = stubEffectHandlers({ persist, emit: vi.fn() });
        // bindings.entity already carries a real id from an earlier fetch/select
        // in this transition — the create below targets a different entity via
        // a literal payload (not `@entity`), so it must never clobber it.
        const bindings: BindingContext = { entity: { id: 'already-selected-id', title: 'Selected' } };
        const context: EffectContext = { traitName: 'TaskLifecycle', state: 'backlog', transition: 'none->backlog' };
        const executor = new EffectExecutor({ handlers, bindings, context });

        await executor.execute(['persist', 'create', 'OtherThing', { name: 'unrelated' }, { emit: { success: 'OTHER_CREATED' } }]);

        expect(bindings.entity!.id).toBe('already-selected-id');
    });
});
