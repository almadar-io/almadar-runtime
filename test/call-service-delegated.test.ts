import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';

// Bridge mode: `@almadar/ui`'s client handlers carry `callServiceDelegated: true`
// because the SERVER runs every call-service and its cascade carries the
// success/failure emits — the client's mock `callService` must not also run
// one (mirrors `persistDelegated`, see `test/persist-delegated.test.ts`).
function makeExecutor(callServiceDelegated: boolean) {
    const emit = vi.fn();
    const callService = vi.fn(async () => ({ ok: true }));
    const handlers = stubEffectHandlers({
        emit,
        callService,
        ...(callServiceDelegated ? { callServiceDelegated: true as const } : {}),
    });
    const bindings: BindingContext = { entity: { id: 'ent-1', title: 'x' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    return { emit, callService, executor: new EffectExecutor({ handlers, bindings, context }) };
}

const CALL_SERVICE = ['call-service', 'payments', 'charge', { amount: 100 }, { emit: { success: 'CHARGED', failure: 'CHARGE_FAILED' } }];

describe('EffectHandlers.callServiceDelegated (bridge mode)', () => {
    it('skips the call-service locally: no handler call, no emit, result executed', async () => {
        const { emit, callService, executor } = makeExecutor(true);
        const results = await executor.executeWithResults([CALL_SERVICE]);
        expect(callService).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('executed');
    });

    it('without the flag callService runs and the declared success emit fires', async () => {
        const { emit, callService, executor } = makeExecutor(false);
        const results = await executor.executeWithResults([CALL_SERVICE]);
        expect(callService).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith('CHARGED', expect.anything(), expect.anything(), undefined);
        expect(results[0].status).toBe('executed');
    });
});
