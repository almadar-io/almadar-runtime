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
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
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
    const handlers = stubEffectHandlers({
        emit,
        // A real store returns the persisted ROW on every genuine success
        // (create/update/delete); `undefined` is reserved for a denied or
        // otherwise failed write (see EffectHandlers.persist). Tests that
        // want to exercise a denial override this per-call with
        // `mockImplementationOnce(async () => undefined)`.
        persist: vi.fn(async (_action, _entityType, data) => data ?? { id: 'mock-persist-id' }),
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
        substrateComposeAll: vi.fn(async (config: Parameters<NonNullable<EffectHandlers['substrateComposeAll']>>[0]) => ({
            orbitalCount: config.orbitals.length,
            composedPath: config.appName,
            success: true,
        })),
    });
    const bindings: BindingContext = {
        entity: { id: 'ent-1' },
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

    it('fires emit.failure (not success with data: null) on a BY-ID fetch miss', async () => {
        const { emit, handlers } = makeContext();
        (handlers.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => null);
        const executor = new EffectExecutor({
            handlers,
            bindings: { entity: undefined },
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.execute([
            'fetch',
            'Patient',
            { id: 'p-missing', emit: { success: 'PATIENT_LOADED', failure: 'PATIENT_LOAD_FAILED' } },
        ]);
        expect(emit).not.toHaveBeenCalledWith('PATIENT_LOADED', expect.anything(), expect.anything());
        const failureCalls = emit.mock.calls.filter(([e]) => e === 'PATIENT_LOAD_FAILED');
        expect(failureCalls).toHaveLength(1);
        expect(failureCalls[0][1]).toEqual({ error: 'Patient p-missing not found' });
    });

    it('fires emit.success with data: [] (not null) when a collection fetch matches nothing', async () => {
        const { emit, handlers } = makeContext();
        (handlers.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => null);
        const executor = new EffectExecutor({
            handlers,
            bindings: { entity: undefined },
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.execute([
            'fetch',
            'Patient',
            { filter: { status: 'archived' }, emit: { success: 'PATIENTS_LOADED', failure: 'PATIENTS_LOAD_FAILED' } },
        ]);
        const failureCalls = emit.mock.calls.filter(([e]) => e === 'PATIENTS_LOAD_FAILED');
        expect(failureCalls).toHaveLength(0);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'PATIENTS_LOADED');
        expect(successCalls).toHaveLength(1);
        expect(successCalls[0][1]).toEqual({ data: [], totalCount: 0 });
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
        // The store handler echoes the persisted row back.
        expect(successCalls[0][1]).toEqual({ id: 'p-1', status: 'done' });
    });

    it('fires emit.success after a successful delete', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'persist',
            'delete',
            'Note',
            'note-1',
            { emit: { success: 'NOTE_DELETED' } },
        ]);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'NOTE_DELETED');
        expect(successCalls).toHaveLength(1);
    });

    // B4-V3: a store that DENIES a write (policy rejection, missing row,
    // etc.) signals it by returning `undefined` — same as a thrown error,
    // this must never be read as success. Pre-fix, `successPayload =
    // persisted ?? data` fell back to the submitted data, so a denied
    // delete logged `persist:success` and fired the declared success event
    // for a row the store never touched.
    it('does not fire success — and fires the declared failure event — when the store denies a delete', async () => {
        const { emit, handlers } = makeContext();
        (handlers.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => undefined);
        const executor = new EffectExecutor({
            handlers,
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.execute([
            'persist',
            'delete',
            'Note',
            'note-1',
            { emit: { success: 'NOTE_DELETED', failure: 'NOTE_DELETE_FAILED' } },
        ]);
        expect(emit.mock.calls.some(([e]) => e === 'NOTE_DELETED')).toBe(false);
        const failureCalls = emit.mock.calls.filter(([e]) => e === 'NOTE_DELETE_FAILED');
        expect(failureCalls).toHaveLength(1);
        expect(failureCalls[0][1]).toMatchObject({ entityType: 'Note', id: 'note-1' });
    });

    it('does not fire success — and fires nothing — when the store denies an update with no failure event declared', async () => {
        const { emit, handlers } = makeContext();
        (handlers.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => undefined);
        const executor = new EffectExecutor({
            handlers,
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.execute([
            'persist',
            'update',
            'Note',
            { id: 'note-1', title: 'x' },
            { emit: { success: 'NOTE_UPDATED' } },
        ]);
        expect(emit).not.toHaveBeenCalled();
    });

    // C1-V1: a denied persist doesn't throw — `dispatch` used to report
    // `void` unconditionally, so `executeWithResults` always pushed
    // `status: 'executed'` even for a write the store rejected. The
    // verification trace read that as success.
    it('executeWithResults reports status "failed" — not "executed" — when the store denies a write', async () => {
        const { handlers } = makeContext();
        (handlers.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => undefined);
        const executor = new EffectExecutor({
            handlers,
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        const results = await executor.executeWithResults([
            ['persist', 'delete', 'Note', 'note-1'],
        ]);
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('failed');
        expect(results[0].error).toContain('denied or failed');
    });

    it('executeWithResults reports status "executed" when the store accepts the write', async () => {
        const { executor } = makeContext();
        const results = await executor.executeWithResults([
            ['persist', 'update', 'Patient', { id: 'p-1', status: 'done' }],
        ]);
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe('executed');
    });

    it('never logs persist:success — and logs persist:denied — when the store denies the write', async () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { handlers } = makeContext();
            (handlers.persist as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => undefined);
            const executor = new EffectExecutor({
                handlers,
                bindings: {},
                context: { traitName: 'T', state: 's', transition: 't' },
            });
            await executor.execute([
                'persist',
                'delete',
                'Note',
                'note-1',
                { emit: { success: 'NOTE_DELETED' } },
            ]);
            const debugMessages = debugSpy.mock.calls.map((call) => String(call[1] ?? ''));
            expect(debugMessages).not.toContain('persist:success');
            const errorMessages = errorSpy.mock.calls.map((call) => String(call[1] ?? ''));
            expect(errorMessages).toContain('persist:denied');
        } finally {
            debugSpy.mockRestore();
            errorSpy.mockRestore();
        }
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
        const handlers = stubEffectHandlers({
            emit,
            set: vi.fn(),
        });
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
        const handlers = stubEffectHandlers({ emit, set: vi.fn() });
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
// Substrate operators (effect-position) — emit.success/failure wiring
// ============================================================================

describe('emit: — substrate operators (effect-position)', () => {
    it('compose/compose-all fires emit.success with uniform { result }', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'compose/compose-all',
            { appName: 'demo', orbitals: [] },
            { emit: { success: 'COMPOSED', failure: 'COMPOSE_FAILED' } },
        ]);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'COMPOSED');
        expect(successCalls).toHaveLength(1);
        // Uniform { result } payload so `?result` captures the return value.
        expect(successCalls[0][1]).toMatchObject({
            result: { orbitalCount: 0, composedPath: 'demo', success: true },
        });
    });

    it('compose/compose-all fires emit.failure with { error } on handler throw', async () => {
        const emit = vi.fn();
        const executor = new EffectExecutor({
            handlers: stubEffectHandlers({
                emit,
                persist: vi.fn(async () => undefined),
                set: vi.fn(),
                substrateComposeAll: vi.fn(async () => {
                    throw new Error('boom');
                }),
            }),
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 's->s' },
        });
        await executor.execute([
            'compose/compose-all',
            { appName: 'demo', orbitals: [] },
            { emit: { success: 'COMPOSED', failure: 'COMPOSE_FAILED' } },
        ]);
        const failCalls = emit.mock.calls.filter(([e]) => e === 'COMPOSE_FAILED');
        expect(failCalls).toHaveLength(1);
        expect(failCalls[0][1]).toMatchObject({ error: 'boom' });
    });

    it('compose/compose-all without emit config is fire-and-forget (no events)', async () => {
        const { emit, executor } = makeContext();
        await executor.execute([
            'compose/compose-all',
            { appName: 'demo', orbitals: [] },
        ]);
        expect(emit).not.toHaveBeenCalled();
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
