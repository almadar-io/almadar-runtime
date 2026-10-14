import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { ServerLegCollector } from '../src/effects/server-leg.js';

// A call to a service that runs only in the browser (core `isBrowserOnlyService`, the twin of
// orbital-core `effects::is_browser_only`) is the client leg's own work: a client-role executor
// answers it through its `callService` handler and never hands it to the server, which has no such
// integration ("Unknown integration: analytics").

function makeExecutor(options: { callServiceDelegated?: boolean } = {}) {
    const callService = vi.fn(async () => ({ sent: true }));
    const emit = vi.fn();
    const handlers = stubEffectHandlers({
        emit,
        callService,
        ...(options.callServiceDelegated === true ? { callServiceDelegated: true as const } : {}),
    });
    const collector = new ServerLegCollector();
    const bindings: BindingContext = { entity: { id: 'e-1' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const executor = new EffectExecutor({ handlers, bindings, context, environment: 'client', delegate: collector });
    return { callService, emit, collector, executor };
}

const withEmit = (service: string) => ['call-service', service, 'run', {}, { emit: { success: 'DONE', failure: 'FAILED' } }];

describe('client-role call-service to a browser-only service', () => {
    it.each(['analytics', 'page'])('%s runs through the client callService and is not delegated to the server', async (service) => {
        const { callService, collector, emit, executor } = makeExecutor();
        await executor.executeWithResults([withEmit(service)]);
        expect(callService).toHaveBeenCalledTimes(1);
        expect(collector.drain()).toEqual([]);
        expect(emit).toHaveBeenCalledWith('DONE', expect.anything(), expect.anything(), undefined);
    });

    it('runs on the client even in bridge mode, where the server carries no browser-only call', async () => {
        const { callService, collector, executor } = makeExecutor({ callServiceDelegated: true });
        await executor.executeWithResults([withEmit('analytics')]);
        expect(callService).toHaveBeenCalledTimes(1);
        expect(collector.drain()).toEqual([]);
    });

    it('control: a node service is still handed to the server leg', async () => {
        const { callService, collector, executor } = makeExecutor();
        const call = withEmit('github');
        await executor.executeWithResults([call]);
        expect(callService).not.toHaveBeenCalled();
        expect(collector.drain()).toEqual([call]);
    });

    it('control: a service declared for both runtimes is still server work', async () => {
        const { callService, collector, executor } = makeExecutor();
        const call = withEmit('llm');
        await executor.executeWithResults([call]);
        expect(callService).not.toHaveBeenCalled();
        expect(collector.drain()).toEqual([call]);
    });
});
