// A client executor delegates exactly the registry's `runsOn: 'server'` effects; twin of orbital-core `tests/runs_on_delegation.rs`.
import { describe, it, expect, vi } from 'vitest';
import { getOperatorsRunningOn } from '@almadar/std/registry';
import type { RuntimeValue } from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, HANDLER_MANIFEST, type BindingContext, type EffectContext } from '../src/index.js';
import { ServerLegCollector } from '../src/effects/server-leg.js';

function makeExecutor(environment: 'client' | 'server', delegate?: ServerLegCollector) {
    const emit = vi.fn();
    const navigate = vi.fn();
    const handlers = stubEffectHandlers({ emit, navigate });
    const bindings: BindingContext = { entity: { id: 'e-1', n: 1 } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    return { emit, navigate, executor: new EffectExecutor({ handlers, bindings, context, environment, delegate }) };
}

const serverEffect = (op: string): RuntimeValue[] => [op, 'Note'];

describe('runsOn delegation', () => {
    it('a client delegates every server effect, including ones it has no case for', async () => {
        const collector = new ServerLegCollector();
        const { executor } = makeExecutor('client', collector);
        const server = getOperatorsRunningOn('server');
        await executor.executeWithResults(server.map(serverEffect));
        expect(collector.drain().map((e) => e[0]).sort()).toEqual(server);
    });

    it('a client runs client and any effects itself', async () => {
        const collector = new ServerLegCollector();
        const { emit, navigate, executor } = makeExecutor('client', collector);
        await executor.executeWithResults([['emit', 'SAVED'], ['navigate', '/home']]);
        expect(collector.drain()).toEqual([]);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('a server never delegates, not even with a delegate configured', async () => {
        const collector = new ServerLegCollector();
        const { executor } = makeExecutor('server', collector);
        await executor.executeWithResults([['swap!', '@entity.n', 2], ['emit', 'SAVED']]);
        expect(collector.drain()).toEqual([]);
    });

    it('the handler manifest follows the same sites', () => {
        const server = getOperatorsRunningOn('server');
        const client = getOperatorsRunningOn('client');
        for (const op of server) expect(HANDLER_MANIFEST.client, op).not.toContain(op);
        for (const op of client) expect(HANDLER_MANIFEST.server, op).not.toContain(op);
        for (const op of ['emit', 'set', 'ref', 'watch']) {
            expect(HANDLER_MANIFEST.client).toContain(op);
            expect(HANDLER_MANIFEST.server).toContain(op);
        }
        expect(HANDLER_MANIFEST.client).toContain('render');
        expect(HANDLER_MANIFEST.server).not.toContain('render');
    });
});
