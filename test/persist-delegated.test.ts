import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';

// Bridge mode: `@almadar/ui`'s client handlers carry `persistDelegated: true`
// because the SERVER executes every persist and returns its outcome. Before
// this contract the client executor read the placeholder's `undefined` as a
// denial — an error in every browser console (which failed the verifier's
// console-errors check on every walk) and a client-side `failure` emit while
// the server had succeeded (std-notes `RevisionRollbackFailed` beside the
// server's `RevisionRolledBack`, 2026-09-06).
function makeExecutor(persistDelegated: boolean) {
    const emit = vi.fn();
    const persist = vi.fn(async () => undefined);
    const handlers = stubEffectHandlers({
        emit,
        persist,
        ...(persistDelegated ? { persistDelegated: true as const } : {}),
    });
    const bindings: BindingContext = { entity: { id: 'ent-1', title: 'x' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    return { emit, persist, executor: new EffectExecutor({ handlers, bindings, context }) };
}

const UPDATE = ['persist', 'update', 'Note', '@entity', { emit: { success: 'NOTE_UPDATED', failure: 'NOTE_UPDATE_FAILED' } }];

describe('EffectHandlers.persistDelegated (bridge mode)', () => {
    it('skips the persist locally: no handler call, no failure emit, no success emit, result executed', async () => {
        const { emit, persist, executor } = makeExecutor(true);
        const results = await executor.executeWithResults([UPDATE]);
        expect(persist).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('executed');
    });

    it('without the flag a placeholder handler still reads as a failed write (the honest non-bridge contract)', async () => {
        const { emit, persist, executor } = makeExecutor(false);
        const results = await executor.executeWithResults([UPDATE]);
        expect(persist).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith('NOTE_UPDATE_FAILED', expect.anything(), expect.anything());
        expect(results[0].status).toBe('failed');
    });
});
