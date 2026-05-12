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
        // fetch/ref now return the FetchResult shape: { rows, total }. The
        // emit payload is { data: result.rows, totalCount: result.total }.
        fetch: vi.fn(async (_type, opts) => ({
            rows: [{ id: opts?.id ?? 'none', name: 'Fetched' }],
            total: 1,
        })),
        ref: vi.fn(async (_type, opts) => ({
            rows: [{ id: opts?.id ?? 'none', reactive: true }],
            total: 1,
        })),
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
        expect(successCalls[0][1]).toEqual({
            data: [{ id: 'p-42', name: 'Fetched' }],
            totalCount: 1,
        });
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

    // Permanent observability for the persist hot path. The runtime logger
    // (`createLogger('almadar:runtime:effects')`) writes these log lines at
    // every persist boundary so a future verifier-failure on DO_UPDATE /
    // DO_DELETE can be triaged from the run log alone, without re-instrumenting.
    it('logs persist:dispatch + persist:emit-config + persist:emit-fired around a successful update', async () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        try {
            const { executor } = makeContext();
            await executor.execute([
                'persist',
                'update',
                'Patient',
                { id: 'p-1', status: 'done' },
                { emit: { success: 'PATIENT_SAVED' } },
            ]);
            const debugMessages = debugSpy.mock.calls.map((call) => String(call[1] ?? ''));
            expect(debugMessages).toContain('persist:dispatch');
            expect(debugMessages).toContain('persist:emit-config');
            expect(debugMessages).toContain('persist:emit-fired');
            const emitFiredCall = debugSpy.mock.calls.find((call) => call[1] === 'persist:emit-fired');
            expect(emitFiredCall?.[2]).toMatchObject({ action: 'update', eventName: 'PATIENT_SAVED' });
        } finally {
            debugSpy.mockRestore();
        }
    });

    it('logs persist:error with action and entityType on failure', async () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { handlers } = makeContext();
            (handlers.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
                throw new Error('boom');
            });
            const executor = new EffectExecutor({
                handlers,
                bindings: {},
                context: { traitName: 'T', state: 's', transition: 't' },
            });
            await executor.executeWithResults([
                ['persist', 'update', 'Patient', { id: 'p-1' }, { emit: { failure: 'F' } }],
            ]);
            const errorCall = errorSpy.mock.calls.find((call) => call[1] === 'persist:error');
            expect(errorCall).toBeDefined();
            expect(errorCall?.[2]).toMatchObject({ action: 'update', entityType: 'Patient', error: 'boom' });
        } finally {
            debugSpy.mockRestore();
            errorSpy.mockRestore();
        }
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
        expect(calls[0][1]).toMatchObject({
            data: [{ id: 'p-1', reactive: true }],
            totalCount: 1,
        });
    });
});

// ============================================================================
// G46 — set against an id-less in-memory entity
// ============================================================================

describe('set: — in-memory mirror without entity id (G46)', () => {
    it('mirrors @entity.<field> writes onto bindings.entity even when no id is available', async () => {
        // Reproduces std-agent-completion's SHOW transition: the trait's
        // entity is an id-less in-memory singleton; SHOW carries
        // { message, notificationType } with no id. Compiled path renders
        // the alert with the new message; runtime previously dropped the
        // set as 'missing-entity-id' and rendered empty.
        const emit = vi.fn();
        const handlers: EffectHandlers = {
            emit,
            set: vi.fn(),
        };
        const bindings: BindingContext = {
            entity: undefined,
            payload: { message: 'hello', notificationType: 'info' },
        };
        const context: EffectContext = {
            traitName: 'AgentCompletionNotification',
            state: 'hidden',
            transition: 'hidden->visible',
        };
        const executor = new EffectExecutor({ handlers, bindings, context });
        await executor.execute(['set', '@entity.message', '@payload.message']);
        expect(bindings.entity).toBeDefined();
        expect(bindings.entity?.message).toBe('hello');
        // The runtime mirrors to bindings.entity AND dispatches `set` with an
        // empty id so the per-trait scalar-state wrapper in
        // useTraitStateMachine populates traitFieldStatesRef — guards in
        // subsequent sendEvent calls read @entity.<field> from there.
        // Without the dispatch the wrapper never runs and step-skip guards
        // always fail.
        expect(handlers.set).toHaveBeenCalledWith('', 'message', 'hello');
    });

    it('mirrors successive @entity.<field> writes onto the same in-memory row', async () => {
        const emit = vi.fn();
        const handlers: EffectHandlers = { emit, set: vi.fn() };
        const bindings: BindingContext = {
            entity: undefined,
            payload: { message: 'm', notificationType: 'success' },
        };
        const executor = new EffectExecutor({
            handlers,
            bindings,
            context: { traitName: 't', state: 's', transition: 's->s' },
        });
        await executor.execute(['set', '@entity.message', '@payload.message']);
        await executor.execute(['set', '@entity.notificationType', '@payload.notificationType']);
        expect(bindings.entity?.message).toBe('m');
        expect(bindings.entity?.notificationType).toBe('success');
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
