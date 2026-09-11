/**
 * EffectExecutor `persist` case — `@intrinsic` frame-field stripping.
 *
 * `@intrinsic` entity fields (e.g. `std-realtime-chat`'s
 * `ChatMessage.activeChannel`/`draft`) are trait-owned view state, NEVER a
 * persisted column — full stop, for every write shape: a bare
 * `(persist create|update E @entity)`, an explicit `{...}` literal that
 * happens to name an intrinsic field, or an `(object/merge @entity {...})`
 * result. The strip is deterministic on the entity's declared schema
 * (`resolveIntrinsicFields`), never on how `data` was constructed — a
 * reference-equality "was this the bare binding" test would be a heuristic
 * (fragile against any layer that clones a bare `@entity`, and too narrow
 * per the language rule anyway).
 *
 * `resolveIntrinsicFields` is supplied only by a caller holding the
 * registered schema (`OrbitalServerRuntime`); this file exercises
 * `EffectExecutor`'s own generic dispatch logic directly, independent of
 * that caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import {
    EffectExecutor,
    type BindingContext,
    type EffectContext,
    type EntityRow,
} from '../src/index.js';

function makeContext(entity: EntityRow, resolveIntrinsicFields?: (entityType: string) => readonly string[]) {
    const persist = vi.fn(async (_action: string, _entityType: string, data?: EntityRow) => ({
        ...(data ?? {}),
        id: (data?.id as string | undefined) ?? 'row-1',
    }));
    const handlers = stubEffectHandlers({ emit: vi.fn(), persist });
    const bindings: BindingContext = { entity };
    const context: EffectContext = { traitName: 'Composer', state: 'idle', transition: 'idle->idle' };
    const executor = new EffectExecutor({ handlers, bindings, context, resolveIntrinsicFields });
    return { persist, executor };
}

describe('EffectExecutor persist — intrinsic frame strip', () => {
    it('strips @intrinsic fields when data is the bare @entity binding', async () => {
        const entity: EntityRow = { id: 'row-1', text: 'hi', draft: 'unsaved' };
        const { persist, executor } = makeContext(entity, (type) => (type === 'Message' ? ['draft'] : []));

        await executor.execute(['persist', 'update', 'Message', '@entity']);

        expect(persist).toHaveBeenCalledTimes(1);
        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect(writtenData).toEqual({ id: 'row-1', text: 'hi' });
        expect('draft' in writtenData).toBe(false);
    });

    it('strips @intrinsic fields on a bare-@entity create too', async () => {
        const entity: EntityRow = { text: 'hi', draft: 'unsaved' };
        const { persist, executor } = makeContext(entity, () => ['draft']);

        await executor.execute(['persist', 'create', 'Message', '@entity']);

        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect(writtenData).toEqual({ text: 'hi' });
    });

    it('ALSO strips an explicit object literal naming the intrinsic field — @intrinsic is never a persisted column, no matter the write shape', async () => {
        const entity: EntityRow = { id: 'row-1', draft: 'unsaved' };
        const { persist, executor } = makeContext(entity, () => ['draft']);

        await executor.execute(['persist', 'update', 'Message', { id: '@entity.id', draft: 'x', body: 'y' }]);

        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect(writtenData).toEqual({ id: 'row-1', body: 'y' });
        expect('draft' in writtenData).toBe(false);
    });

    it('leaves data untouched when no resolveIntrinsicFields is supplied (no schema)', async () => {
        const entity: EntityRow = { id: 'row-1', draft: 'unsaved' };
        const { persist, executor } = makeContext(entity, undefined);

        await executor.execute(['persist', 'update', 'Message', '@entity']);

        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect(writtenData).toEqual({ id: 'row-1', draft: 'unsaved' });
    });

    it('strips a bare-@entity operand inside a batch operation', async () => {
        const entity: EntityRow = { id: 'row-1', text: 'hi', draft: 'unsaved' };
        const { persist, executor } = makeContext(entity, (type) => (type === 'Message' ? ['draft'] : []));

        await executor.execute(['persist', 'batch', [['update', 'Message', 'row-1', '@entity']]]);

        const batchArg = persist.mock.calls[0]?.[2] as { operations: unknown[][] };
        const [, , , opData] = batchArg.operations[0];
        expect(opData).toEqual({ id: 'row-1', text: 'hi' });
    });

    it('strips an explicit-literal operand inside a batch operation too', async () => {
        const entity: EntityRow = { id: 'row-1' };
        const { persist, executor } = makeContext(entity, (type) => (type === 'Message' ? ['draft'] : []));

        await executor.execute([
            'persist',
            'batch',
            [['update', 'Message', 'row-1', { draft: 'x', body: 'y' }]],
        ]);

        const batchArg = persist.mock.calls[0]?.[2] as { operations: unknown[][] };
        const [, , , opData] = batchArg.operations[0];
        expect(opData).toEqual({ body: 'y' });
    });
});
