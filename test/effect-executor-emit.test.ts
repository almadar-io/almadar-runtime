/**
 * Effect Executor — `emit:` config tests.
 *
 * Verifies that async/reactive data operators fire author-configured
 * success/failure events on the bus after the effect completes. See
 * `docs/Almadar_Std_Gaps.md` §3.1 (close-the-circuit plan).
 *
 * Scope:
 *   - fetch with emit.success + emit.failure
 *   - persist with emit.success
 *   - call-service with emit.success + emit.failure
 *   - set with emit.success (synchronous)
 *   - ref with emit.on_change
 *   - bare ops (no emit: config) → no events fired (back-compat)
 */

import { describe, it, expect, vi } from 'vitest';
import {
    EffectExecutor,
    type EffectHandlers,
    type BindingContext,
    type EffectContext,
} from '../src/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeContext(): {
    emit: ReturnType<typeof vi.fn>;
    handlers: EffectHandlers;
    executor: EffectExecutor;
} {
    const emit = vi.fn();
    const handlers: EffectHandlers = {
        emit,
        persist: vi.fn(async () => undefined),
        set: vi.fn(),
        callService: vi.fn(async (_s, _a, params) => ({ ok: true, echoed: params })),
        fetch: vi.fn(async (_type, opts) => ({ id: opts?.id ?? 'none', name: 'Fetched' })),
        ref: vi.fn(async (_type, opts) => ({ id: opts?.id ?? 'none', reactive: true })),
    };
    const bindings: BindingContext = {
        entity: { id: 'ent-1' } as unknown as BindingContext['entity'],
    };
    const context: EffectContext = {
        traitName: 'TestTrait',
        state: 'idle',
        transition: 'idle->idle',
    };
    const executor = new EffectExecutor({ handlers, bindings, context });
    return { emit, handlers, executor };
}

// ============================================================================
// Fetch
// ============================================================================

describe('emit: — fetch', () => {
    it('fires emit.success with fetched data after successful fetch', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'fetch',
            'Patient',
            {
                id: 'p-42',
                emit: { success: 'PATIENT_LOADED' },
            },
        ]);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'PATIENT_LOADED');
        expect(successCalls).toHaveLength(1);
        expect(successCalls[0][1]).toEqual({ id: 'p-42', name: 'Fetched' });
    });

    it('fires emit.failure when fetch throws and captures failure result', async () => {
        const { emit, handlers } = makeContext();
        // mockImplementationOnce so the rejection is created at call time,
        // not at mock setup — otherwise vitest reports an unhandled promise.
        (handlers.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            throw new Error('db down');
        });
        const executor = new EffectExecutor({
            handlers,
            bindings: { entity: undefined },
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        // executeWithResults captures errors without rethrowing — that's
        // the correct contract for surfacing per-effect status.
        const results = await executor.executeWithResults([
            [
                'fetch',
                'Patient',
                {
                    id: 'p-42',
                    emit: { success: 'OK', failure: 'PATIENT_LOAD_FAILED' },
                },
            ],
        ]);
        expect(results[0].status).toBe('failed');
        const failureCalls = emit.mock.calls.filter(([e]) => e === 'PATIENT_LOAD_FAILED');
        expect(failureCalls).toHaveLength(1);
        expect(failureCalls[0][1]).toMatchObject({ error: 'db down' });
    });

    it('does not fire any events when emit: is absent', async () => {
        const { emit, executor } = makeContext();
        await executor.execute(['fetch', 'Patient', { id: 'p-1' }]);
        expect(emit).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Persist
// ============================================================================

describe('emit: — persist', () => {
    it('fires emit.success after successful persist', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'persist',
            'update',
            'Patient',
            { id: 'p-1', status: 'done' },
            { emit: { success: 'PATIENT_SAVED' } },
        ]);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'PATIENT_SAVED');
        expect(successCalls).toHaveLength(1);
        // Runtime handler returns void → payload is the input data (best available).
        expect(successCalls[0][1]).toEqual({ id: 'p-1', status: 'done' });
    });

    it('fires emit.failure when persist throws', async () => {
        const { emit, handlers } = makeContext();
        (handlers.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            throw new Error('conflict');
        });
        const executor = new EffectExecutor({
            handlers,
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.executeWithResults([
            [
                'persist',
                'update',
                'Patient',
                { id: 'p-1' },
                { emit: { failure: 'PATIENT_SAVE_FAILED' } },
            ],
        ]);
        const failures = emit.mock.calls.filter(([e]) => e === 'PATIENT_SAVE_FAILED');
        expect(failures).toHaveLength(1);
    });
});

// ============================================================================
// call-service
// ============================================================================

describe('emit: — call-service', () => {
    it('fires emit.success with the service result', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'call-service',
            'mailer',
            'sendEmail',
            { to: 'a@b.com' },
            { emit: { success: 'EMAIL_SENT' } },
        ]);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'EMAIL_SENT');
        expect(successCalls).toHaveLength(1);
        // Service returns whatever — verify it flows through intact.
        expect(successCalls[0][1]).toMatchObject({ ok: true });
    });
});

// ============================================================================
// set
// ============================================================================

describe('emit: — set', () => {
    it('fires emit.success synchronously with the new value (4-elem form)', async () => {
        const { emit, executor } = makeContext();
        // The 4-elem form avoids @entity.<path> resolution semantics —
        // entityId + field + value are passed as discrete args so the
        // path-form's binding-interpolation ambiguity is irrelevant here.
        await executor.execute([
            'set',
            'ent-1',
            'status',
            'done',
            { emit: { success: 'STATUS_CHANGED' } },
        ]);
        const calls = emit.mock.calls.filter(([e]) => e === 'STATUS_CHANGED');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toBe('done');
    });

    it('fires emit.success from the @entity.<path> form with trailing options', async () => {
        // The path form is the canonical lolo shape:
        //   (set "@entity.status" "done" { emit: { success: "STATUS_CHANGED" } })
        // isSetPathForm in execute() must preserve args[0] through interpolation
        // so dispatch('set') can extract the field from the path prefix.
        const { emit, executor } = makeContext();
        await executor.execute([
            'set',
            '@entity.status',
            'done',
            { emit: { success: 'STATUS_CHANGED' } },
        ]);
        const calls = emit.mock.calls.filter(([e]) => e === 'STATUS_CHANGED');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toBe('done');
    });
});

// ============================================================================
// ref
// ============================================================================

describe('emit: — ref', () => {
    it('fires emit.on_change on initial subscription', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'ref',
            'Patient',
            {
                id: 'p-1',
                emit: { on_change: 'PATIENT_UPDATED' },
            },
        ]);
        const calls = emit.mock.calls.filter(([e]) => e === 'PATIENT_UPDATED');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toMatchObject({ reactive: true });
    });
});

// ============================================================================
// camelCase aliases
// ============================================================================

describe('emit: — camelCase aliases', () => {
    it('accepts onChange as an alias for on_change', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'ref',
            'Patient',
            {
                id: 'p-1',
                emit: { onChange: 'PATIENT_UPDATED' },
            },
        ]);
        const calls = emit.mock.calls.filter(([e]) => e === 'PATIENT_UPDATED');
        expect(calls).toHaveLength(1);
    });
});
