import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { ServerLegCollector } from '../src/effects/server-leg.js';

// P3 (docs/Almadar_Runtime_Stateless_Stateful_PLAN.md §4.2) — the JS twin of
// orbital-core's `RuntimeEnvironment::Client` + `KernelConfig.delegate`
// (`runtime/server_leg.rs`): a client-role `EffectExecutor` routes
// persist/fetch/call-service to the configured delegate instead of
// executing them, exactly the set `executor.rs`'s `do_persist`/`do_fetch`/
// `do_call_service` route.

function makeExecutor(opts: { environment?: 'client' | 'server'; delegate?: ServerLegCollector } = {}) {
    const emit = vi.fn();
    const persist = vi.fn(async () => ({ id: 'n-1', title: 'x' }));
    const fetch = vi.fn(async () => ({ rows: [{ id: 'n-1' }], total: 1 }));
    const callService = vi.fn(async () => ({ ok: true }));
    const handlers = stubEffectHandlers({ emit, persist, callService, fetch });
    const bindings: BindingContext = { entity: { id: 'ent-1', title: 'x' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const executor = new EffectExecutor({
        handlers,
        bindings,
        context,
        environment: opts.environment,
        delegate: opts.delegate,
    });
    return { emit, persist, fetch, callService, executor };
}

const PERSIST = ['persist', 'create', 'Note', { title: 'x' }];
const FETCH = ['fetch', 'Note', { id: 'n-1' }];
const CALL_SERVICE = ['call-service', 'payments', 'charge', { amount: 100 }];

describe('EffectExecutor client-role server-leg delegation', () => {
    it('client-role executor with a delegate collects persist/fetch/call-service into the leg and does not execute them', async () => {
        const collector = new ServerLegCollector();
        const { emit, persist, fetch, callService, executor } = makeExecutor({
            environment: 'client',
            delegate: collector,
        });

        const results = await executor.executeWithResults([PERSIST, FETCH, CALL_SERVICE]);

        expect(persist).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(callService).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(results.every((r) => r.status === 'executed')).toBe(true);

        expect(collector.drain()).toEqual([PERSIST, FETCH, CALL_SERVICE]);
    });

    it('client-role executor with NO delegate still does not execute (Rust noop case) and collects nothing', async () => {
        const { persist, fetch, callService, executor } = makeExecutor({ environment: 'client' });

        await executor.executeWithResults([PERSIST, FETCH, CALL_SERVICE]);

        expect(persist).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(callService).not.toHaveBeenCalled();
    });

    it('server-role executor (the default) executes persist/fetch/call-service locally even with a delegate configured', async () => {
        const collector = new ServerLegCollector();
        const { persist, fetch, callService, executor } = makeExecutor({ delegate: collector });

        await executor.executeWithResults([PERSIST, FETCH, CALL_SERVICE]);

        expect(persist).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(callService).toHaveBeenCalledTimes(1);
        expect(collector.drain()).toEqual([]);
    });

    it('drain empties the collector so a later dispatch never bleeds into an earlier leg', async () => {
        const collector = new ServerLegCollector();
        const { executor } = makeExecutor({ environment: 'client', delegate: collector });

        await executor.executeWithResults([PERSIST]);
        expect(collector.drain()).toEqual([PERSIST]);
        expect(collector.drain()).toEqual([]);

        await executor.executeWithResults([FETCH]);
        expect(collector.drain()).toEqual([FETCH]);
    });
});
