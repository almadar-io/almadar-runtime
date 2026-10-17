// `browser/tab-*` on the kernel host: the host hands each raw ask to the browser-tab port and holds no decision
// (the twin of orbital-core `tests/http_effect.rs` `tab_effects`). A keyed ask is cancellable by `cancel-call`, a
// host with no tabs answers `unavailable`, and a watch's elements reach the program as the declared input the ask names.
import { describe, expect, it } from 'vitest';
import { TabHostFailure, type BrowserTabPort, type EventPayload, type ExternalInputRequest, type ServiceHostPorts } from '@almadar/core';
import type { TabAsk } from '@almadar/core/kernel-wire';
import { InMemoryPersistence } from '@almadar/db/mock';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { decodeRequest } from '../src/kernel/decode.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Dispatched { orbital: string; request: Omit<ExternalInputRequest, 'user'> }

function ports(tabs: BrowserTabPort | undefined, calls = new InFlightCalls(), dispatched: Dispatched[] = []): KernelHostPorts {
    return {
        persistence: new InMemoryPersistence(),
        callService: async () => null,
        programEffect: () => undefined,
        inFlightCalls: calls,
        servicePorts: (caller): ServiceHostPorts => ({
            caller,
            inputs: () => [],
            readableEntities: () => [],
            dispatchInput: async (orbital, request) => {
                dispatched.push({ orbital, request });
                return { success: true, transitioned: true, states: {}, emittedEvents: [] };
            },
            read: async () => [],
            message: () => undefined,
        }),
        deliverLive: () => undefined,
        deferCallOutcome: () => undefined,
        ...(tabs !== undefined ? { tabs } : {}),
    };
}

const scope = { orbital: 'Main' };
const LIST: TabAsk = { kind: 'list' };

describe('tab asks on the kernel host', () => {
    it('hands the raw ask to the port and answers its reply untouched', async () => {
        const seen: TabAsk[] = [];
        const port: BrowserTabPort = {
            perform: async (ask) => {
                seen.push(ask);
                return [{ tab: 1, url: 'https://example.com/a', title: 'A', active: true }];
            },
        };
        const answer = await answerRequest(ports(port), { kind: 'tab', ask: LIST }, scope);
        expect(seen).toEqual([LIST]);
        expect(answer).toEqual({ kind: 'tab', result: { ok: [{ tab: 1, url: 'https://example.com/a', title: 'A', active: true }] } });
    });

    it('a host with no browser tabs answers unavailable', async () => {
        expect(await answerRequest(ports(undefined), { kind: 'tab', ask: LIST }, scope)).toEqual({
            kind: 'tab',
            result: { error: { kind: 'unavailable', message: 'browser/tab: no host answers browser tabs' } },
        });
    });

    it('a port failure keeps its kind, and any other error is a failure', async () => {
        const refusing: BrowserTabPort = { perform: async () => { throw new TabHostFailure('not-ready', 'Tab 3 has no page script'); } };
        expect(await answerRequest(ports(refusing), { kind: 'tab', ask: LIST }, scope)).toEqual({
            kind: 'tab',
            result: { error: { kind: 'not-ready', message: 'Tab 3 has no page script' } },
        });
        const broken: BrowserTabPort = { perform: async () => { throw new Error('No tab with id: 4'); } };
        expect(await answerRequest(ports(broken), { kind: 'tab', ask: LIST }, scope)).toEqual({
            kind: 'tab',
            result: { error: { kind: 'failed', message: 'No tab with id: 4' } },
        });
    });

    it('cancel-call aborts a keyed ask: it answers cancelled and the late reply is dropped', async () => {
        let release: (value: number) => void = () => undefined;
        const signals: Array<AbortSignal | undefined> = [];
        const port: BrowserTabPort = {
            perform: (_ask, context) => {
                signals.push(context.signal);
                return new Promise<number>((resolve) => { release = resolve; });
            },
        };
        const calls = new InFlightCalls();
        const host = ports(port, calls);
        const pending = answerRequest(host, { kind: 'tab', ask: { kind: 'close', tab: 4 }, key: 'job' }, scope);
        await flush();
        expect(calls.inFlight('job')).toBe(true);
        await answerRequest(host, { kind: 'cancelCall', key: 'job' }, scope);
        expect(await pending).toEqual({ kind: 'serviceCancelled' });
        expect(signals[0]?.aborted).toBe(true);
        release(1);
        await flush();
    });

    it('control: an unkeyed ask is never cancellable and carries no signal', async () => {
        const signals: Array<AbortSignal | undefined> = [];
        const port: BrowserTabPort = { perform: async (_ask, context) => { signals.push(context.signal); return null; } };
        await answerRequest(ports(port), { kind: 'tab', ask: { kind: 'close', tab: 4 } }, scope);
        expect(signals).toEqual([undefined]);
    });

    it('a watch delivers each reported element to the declared input its ask names, as a dispatch of its own', async () => {
        const dispatched: Dispatched[] = [];
        let deliver: (payload: EventPayload) => void = () => undefined;
        const port: BrowserTabPort = { perform: async (_ask, context) => { deliver = context.deliver; return null; } };
        const ask: TabAsk = {
            kind: 'watch',
            watchId: 'w-1',
            match: 'https://example.com/*',
            selector: '.item',
            fields: [{ name: 'title', selector: 'h2' }],
            deliver: { orbital: 'Feed', trait: 'Watch', event: 'ITEM_SEEN' },
        };
        expect(await answerRequest(ports(port, new InFlightCalls(), dispatched), { kind: 'tab', ask }, scope)).toEqual({ kind: 'tab', result: { ok: null } });
        deliver({ tab: 1, elementId: 'el-5', url: 'https://example.com/home', fields: { title: 'Hello' } });
        await flush();
        expect(dispatched).toEqual([
            { orbital: 'Feed', request: { targetTrait: 'Watch', event: 'ITEM_SEEN', payload: { tab: 1, elementId: 'el-5', url: 'https://example.com/home', fields: { title: 'Hello' } } } },
        ]);
    });

    it('control: delivering from an ask that is not a watch dispatches nothing', async () => {
        const dispatched: Dispatched[] = [];
        let deliver: (payload: EventPayload) => void = () => undefined;
        const port: BrowserTabPort = { perform: async (_ask, context) => { deliver = context.deliver; return []; } };
        await answerRequest(ports(port, new InFlightCalls(), dispatched), { kind: 'tab', ask: LIST }, scope);
        deliver({ tab: 1 });
        await flush();
        expect(dispatched).toEqual([]);
    });
});

describe('tab asks on the wire', () => {
    const wire = (ask: object, key?: string) => JSON.stringify({ kind: 'tab', ask, ...(key !== undefined ? { key } : {}) });

    it('decodes every ask the kernel makes into the typed wire', () => {
        const asks: TabAsk[] = [
            { kind: 'list' },
            { kind: 'open', url: 'https://example.com/r?q=a', active: false },
            { kind: 'close', tab: 4 },
            { kind: 'navigate', tab: 4, url: 'https://example.com/next' },
            { kind: 'awaitReady', tab: 4, timeoutMs: 1000 },
            { kind: 'unwatch', watchId: 'w-1' },
            { kind: 'command', tab: 4, command: { kind: 'query', selector: '.i', fields: [{ name: 't', selector: 'h2', resolve: true, required: true }], limit: 3, waitMs: 500 } },
            { kind: 'command', tab: 4, command: { kind: 'watch', watchId: 'w-1', selector: '.i', fields: [{ name: 't', template: '{a}!' }] } },
            { kind: 'command', tab: 4, command: { kind: 'unwatch', watchId: 'w-1' } },
            { kind: 'command', tab: 4, command: { kind: 'apply', elementId: 'el-1', styles: [{ property: 'display', value: 'none' }], label: 'why' } },
            { kind: 'command', tab: 4, command: { kind: 'applyMany', items: [{ elementId: 'el-1', styles: [] }] } },
            { kind: 'command', tab: 4, command: { kind: 'act', elementId: 'el-1', action: 'type', text: 'hello' } },
            { kind: 'watch', watchId: 'w-1', match: 'https://example.com/*', selector: '.i', fields: [], deliver: { orbital: 'Feed', trait: 'Watch', event: 'ITEM_SEEN' } },
        ];
        for (const ask of asks) {
            expect(decodeRequest(JSON.parse(wire(ask, 'k')))).toEqual({ kind: 'tab', ask, key: 'k' });
        }
        expect(decodeRequest(JSON.parse(wire(LIST)))).toEqual({ kind: 'tab', ask: LIST });
    });

    it('control: an unknown ask, command or action is refused, never passed to a host', () => {
        expect(() => decodeRequest(JSON.parse(wire({ kind: 'eval' })))).toThrow(/unknown tab ask/);
        expect(() => decodeRequest(JSON.parse(wire({ kind: 'command', tab: 1, command: { kind: 'eval' } })))).toThrow(/unknown tab command/);
        expect(() => decodeRequest(JSON.parse(wire({ kind: 'command', tab: 1, command: { kind: 'act', elementId: 'e', action: 'drag' } })))).toThrow(/unknown tab action/);
        expect(() => decodeRequest(JSON.parse(wire({ kind: 'close', tab: '4' })))).toThrow(/not an integer/);
    });
});
