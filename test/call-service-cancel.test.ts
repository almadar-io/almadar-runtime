// Explicit cancellation of an in-flight `call-service`: a keyed call is registered in the running
// app's registry, `cancel-call` aborts it, the provider sees the signal, and the call routes to its
// declared `emit.cancelled` with `{ key }` — never success/failure. Twin of the Rust executor tests.
import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { ServerLegCollector } from '../src/effects/server-leg.js';
import { runsServerEffect } from '../src/traits/trait-index.js';
import type { ServiceCallContext } from '../src/types.js';

interface Emitted { event: string; payload: EventPayload | undefined }

interface PendingCall {
    context: ServiceCallContext | undefined;
    resolve: (value: EventPayload) => void;
    reject: (error: Error) => void;
}

function app(options: { honourSignal: boolean } = { honourSignal: true }) {
    const emitted: Emitted[] = [];
    const calls: PendingCall[] = [];
    const registry = new InFlightCalls();
    const handlers = stubEffectHandlers({
        emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); },
        callService: (_service, _action, _params, context) =>
            new Promise<EventPayload | null>((resolve, reject) => {
                calls.push({ context, resolve, reject });
                if (options.honourSignal) context?.signal?.addEventListener('abort', () => reject(new Error('aborted by provider')));
            }),
    });
    const bindings: BindingContext = { entity: { id: 'row-1' }, payload: { id: 'p-1' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    // Each transition gets its own executor over the one app registry.
    const run = (effect: Parameters<EffectExecutor['execute']>[0]) =>
        new EffectExecutor({ handlers, bindings, context, inFlightCalls: registry }).execute(effect);
    return { emitted, calls, run, registry };
}

const call = (key: string | undefined, emit: Record<string, string>) =>
    ['call-service', 'llm', 'generate', {}, { ...(key !== undefined ? { key } : {}), emit }];
const flush = () => new Promise((r) => setTimeout(r, 0));
const ALL = { success: 'OK', failure: 'ERR', cancelled: 'CANCELLED' };

describe('call-service key + cancel-call', () => {
    it('cancels a keyed call mid-flight: provider sees the abort, the call routes to cancelled with { key }', async () => {
        const { emitted, calls, run } = app();
        const pending = run(call('job-1', ALL));
        await flush();
        expect(calls[0].context?.signal?.aborted).toBe(false);
        await run(['cancel-call', 'job-1']);
        await pending;
        expect(calls[0].context?.signal?.aborted).toBe(true);
        expect(emitted).toEqual([{ event: 'CANCELLED', payload: { key: 'job-1' } }]);
    });

    it('cancels a call whose provider ignores the signal without waiting for it', async () => {
        const { emitted, run } = app({ honourSignal: false });
        const pending = run(call('job-1', ALL));
        await flush();
        await run(['cancel-call', 'job-1']);
        await pending;
        expect(emitted).toEqual([{ event: 'CANCELLED', payload: { key: 'job-1' } }]);
    });

    it('control: a keyed call that is not cancelled routes to success', async () => {
        const { emitted, calls, run } = app();
        const pending = run(call('job-1', ALL));
        await flush();
        calls[0].resolve({ answer: 1 });
        await pending;
        expect(calls[0].context?.signal?.aborted).toBe(false);
        expect(emitted).toEqual([{ event: 'OK', payload: { answer: 1 } }]);
    });

    it('control: a keyed call whose provider fails routes to failure', async () => {
        const { emitted, calls, run } = app();
        const pending = run(call('job-1', ALL));
        await flush();
        calls[0].reject(new Error('boom'));
        await pending;
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'boom' } }]);
    });

    it('control: an unkeyed call is unaffected by a cancel-call of some key', async () => {
        const { emitted, calls, run } = app();
        const pending = run(call(undefined, ALL));
        await flush();
        await run(['cancel-call', 'job-1']);
        calls[0].resolve({ answer: 2 });
        await pending;
        expect(emitted).toEqual([{ event: 'OK', payload: { answer: 2 } }]);
    });

    it('cancels without a declared cancelled event: nothing is emitted', async () => {
        const { emitted, run } = app();
        const pending = run(call('job-1', { success: 'OK', failure: 'ERR' }));
        await flush();
        await run(['cancel-call', 'job-1']);
        await pending;
        expect(emitted).toEqual([]);
    });

    it('cancel-call of a key with nothing in flight is a no-op', async () => {
        const { emitted, run } = app();
        await run(['cancel-call', 'nothing']);
        expect(emitted).toEqual([]);
    });

    it('a call that completed before cancel-call is not re-routed', async () => {
        const { emitted, calls, run, registry } = app();
        const pending = run(call('job-1', ALL));
        await flush();
        calls[0].resolve({ answer: 3 });
        await pending;
        await run(['cancel-call', 'job-1']);
        expect(emitted).toEqual([{ event: 'OK', payload: { answer: 3 } }]);
        expect(registry.inFlight('job-1')).toBe(false);
    });

    it('with two keys in flight, cancelling one leaves the other', async () => {
        const { emitted, calls, run } = app();
        const a = run(call('a', ALL));
        const b = run(call('b', ALL));
        await flush();
        await run(['cancel-call', 'a']);
        await a;
        expect(calls[1].context?.signal?.aborted).toBe(false);
        calls[1].resolve({ done: true });
        await b;
        expect(emitted).toEqual([
            { event: 'CANCELLED', payload: { key: 'a' } },
            { event: 'OK', payload: { done: true } },
        ]);
    });

    it('evaluates the key expression at call time', async () => {
        const { emitted, run } = app();
        const pending = run(['call-service', 'llm', 'generate', {}, { key: '@payload.id', emit: ALL }]);
        await flush();
        await run(['cancel-call', '@payload.id']);
        await pending;
        expect(emitted).toEqual([{ event: 'CANCELLED', payload: { key: 'p-1' } }]);
    });

    it('a key that does not resolve to a string fails the call instead of running it unkeyed', async () => {
        const { emitted, calls, run } = app();
        await run(['call-service', 'llm', 'generate', {}, { key: '@payload.missing', emit: ALL }]);
        expect(calls).toEqual([]);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].event).toBe('ERR');
    });

    it('a keyed call without a running app registry fails instead of running uncancellable', async () => {
        const emitted: Emitted[] = [];
        const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); } });
        const executor = new EffectExecutor({ handlers, bindings: {}, context: { traitName: 'T', state: 'idle', transition: 'idle->idle' } });
        await executor.execute(call('job-1', ALL));
        expect(emitted.map((e) => e.event)).toEqual(['ERR']);
    });
});

describe('cancel-call placement', () => {
    it('is a server effect like call-service; control: emit is not', () => {
        expect(runsServerEffect(['cancel-call', 'job-1'])).toBe(true);
        expect(runsServerEffect(['call-service', 'llm', 'generate'])).toBe(true);
        expect(runsServerEffect(['emit', 'E'])).toBe(false);
    });

    it('a client executor delegates cancel-call to the server leg instead of running it; a server runs it', async () => {
        const stub = () => stubEffectHandlers({ emit: () => undefined });
        const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
        const collector = new ServerLegCollector();
        await new EffectExecutor({ handlers: stub(), bindings: {}, context, environment: 'client', delegate: collector }).execute(['cancel-call', 'job-1']);
        expect(collector.drain()).toEqual([['cancel-call', 'job-1']]);
        const registry = new InFlightCalls();
        const server = new EffectExecutor({ handlers: stub(), bindings: {}, context, environment: 'server', delegate: collector, inFlightCalls: registry });
        await server.execute(['cancel-call', 'job-1']);
        expect(collector.drain()).toEqual([]);
    });
});
