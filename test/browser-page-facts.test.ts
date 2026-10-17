/**
 * `browser/page-facts` on the JS path: the executor hands the requested fields to the host handler in list order and
 * emits the flat facts; the client handler reads only what was asked, in that order, and reports no page as
 * `available: false` while a throwing getter is a failure, never no-page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectExecutor, createClientEffectHandlers, type EffectHandlers } from '../src/index.js';
import type { BrowserPageFacts, EventPayload, PageFactField } from '@almadar/core';

interface Emitted {
    event: string;
    payload?: EventPayload;
}

function makeExecutor(handlers: Partial<EffectHandlers>) {
    const emitted: Emitted[] = [];
    const emit = vi.fn((event: string, payload?: EventPayload) => {
        emitted.push({ event, payload });
    });
    const executor = new EffectExecutor({
        handlers: { emit, ...handlers } as EffectHandlers,
        bindings: {},
        context: { traitName: 'FactsProbe', state: 'idle', transition: 'idle->idle' },
    });
    return { executor, emitted };
}

const ROUTES = { emit: { success: 'FACTS', failure: 'FACTS_FAILED' } };

describe('browser/page-facts through the executor', () => {
    it('passes the fields in list order and emits the flat facts', async () => {
        const facts: BrowserPageFacts = { available: true, hostname: '', referrer: 'https://r.example/', screenWidth: 1280 };
        const browserPageFacts = vi.fn(async (_fields: readonly PageFactField[]) => facts);
        const { executor, emitted } = makeExecutor({ browserPageFacts });

        await executor.execute(['browser/page-facts', ['referrer', 'screenWidth'], ROUTES]);

        expect(browserPageFacts).toHaveBeenCalledWith(['referrer', 'screenWidth']);
        expect(emitted).toEqual([{ event: 'FACTS', payload: { ...facts } }]);
    });

    it('a handler that rejects emits the failure with { error }, not an unavailable page', async () => {
        const browserPageFacts = vi.fn(async (): Promise<BrowserPageFacts> => {
            throw new Error('referrer blocked');
        });
        const { executor, emitted } = makeExecutor({ browserPageFacts });

        await executor.execute(['browser/page-facts', ['referrer'], ROUTES]);

        expect(emitted).toEqual([{ event: 'FACTS_FAILED', payload: { error: 'referrer blocked' } }]);
    });

    it('a host with no page-facts handler emits the failure instead of fabricating facts', async () => {
        const { executor, emitted } = makeExecutor({});

        await executor.execute(['browser/page-facts', ['hostname'], ROUTES]);

        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.event).toBe('FACTS_FAILED');
        expect(emitted[0]?.payload).toEqual({ error: 'browser/page-facts: this host has no page-facts handler' });
    });

    it('refuses a field outside the closed set before reading anything', async () => {
        const browserPageFacts = vi.fn(async (): Promise<BrowserPageFacts> => ({ available: true, hostname: 'x', referrer: '', screenWidth: null }));
        const { executor, emitted } = makeExecutor({ browserPageFacts });

        await executor.execute(['browser/page-facts', ['hostname', 'userAgent'], ROUTES]);

        expect(browserPageFacts).not.toHaveBeenCalled();
        expect(emitted).toEqual([{ event: 'FACTS_FAILED', payload: { error: 'browser/page-facts: userAgent is not one of hostname, referrer, screenWidth' } }]);
    });

    it('refuses an empty list and a duplicate', async () => {
        const browserPageFacts = vi.fn(async (): Promise<BrowserPageFacts> => ({ available: true, hostname: 'x', referrer: '', screenWidth: null }));
        const { executor, emitted } = makeExecutor({ browserPageFacts });

        await executor.execute(['browser/page-facts', [], ROUTES]);
        await executor.execute(['browser/page-facts', ['hostname', 'hostname'], ROUTES]);

        expect(browserPageFacts).not.toHaveBeenCalled();
        expect(emitted.map((e) => e.event)).toEqual(['FACTS_FAILED', 'FACTS_FAILED']);
    });
});

describe('browser/page-facts key', () => {
    const facts: BrowserPageFacts = { available: true, hostname: 'h', referrer: '', screenWidth: null };

    it('echoes the evaluated key on success and on failure', async () => {
        const ok = makeExecutor({ browserPageFacts: vi.fn(async () => facts) });
        await ok.executor.execute(['browser/page-facts', ['hostname'], { key: 'k1', emit: ROUTES.emit }]);
        expect(ok.emitted).toEqual([{ event: 'FACTS', payload: { ...facts, key: 'k1' } }]);
        const bad = makeExecutor({ browserPageFacts: vi.fn(async (): Promise<BrowserPageFacts> => { throw new Error('blocked'); }) });
        await bad.executor.execute(['browser/page-facts', ['hostname'], { key: 'k1', emit: ROUTES.emit }]);
        expect(bad.emitted).toEqual([{ event: 'FACTS_FAILED', payload: { error: 'blocked', key: 'k1' } }]);
    });

    it('control: no key means no key field, and an empty or non-string key never reads the page', async () => {
        const handler = vi.fn(async () => facts);
        const plain = makeExecutor({ browserPageFacts: handler });
        await plain.executor.execute(['browser/page-facts', ['hostname'], ROUTES]);
        expect(plain.emitted[0]?.payload).not.toHaveProperty('key');
        for (const key of ['', 5, null]) {
            const run = makeExecutor({ browserPageFacts: handler });
            handler.mockClear();
            await run.executor.execute(['browser/page-facts', ['hostname'], { key, emit: ROUTES.emit }]);
            expect(handler).not.toHaveBeenCalled();
            expect(run.emitted[0]?.event).toBe('FACTS_FAILED');
        }
    });
});

describe('browser/page-facts client handler', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function clientHandlers(): EffectHandlers {
        return createClientEffectHandlers({
            eventBus: { emit: vi.fn() },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        });
    }

    it('reads only the requested getters, in list order', async () => {
        const reads: string[] = [];
        vi.stubGlobal('window', {
            location: { get hostname() { reads.push('hostname'); return 'site.example'; } },
            screen: { get width() { reads.push('screenWidth'); return 1024; } },
        });
        vi.stubGlobal('document', { get referrer() { reads.push('referrer'); return 'https://from.example/'; } });
        const handlers = clientHandlers();

        const facts = await handlers.browserPageFacts?.(['referrer', 'screenWidth']);

        expect(reads).toEqual(['referrer', 'screenWidth']);
        expect(facts).toEqual({ available: true, hostname: '', referrer: 'https://from.example/', screenWidth: 1024 });
    });

    it('control: a hostname-only request reads nothing else', async () => {
        const reads: string[] = [];
        vi.stubGlobal('window', {
            location: { get hostname() { reads.push('hostname'); return 'site.example'; } },
            screen: { get width() { reads.push('screenWidth'); return 1024; } },
        });
        vi.stubGlobal('document', { get referrer() { reads.push('referrer'); return 'x'; } });

        const facts = await clientHandlers().browserPageFacts?.(['hostname']);

        expect(reads).toEqual(['hostname']);
        expect(facts).toEqual({ available: true, hostname: 'site.example', referrer: '', screenWidth: null });
    });

    it('a missing screen is a null width, not a failure', async () => {
        vi.stubGlobal('window', { location: { hostname: 'h' } });
        vi.stubGlobal('document', { referrer: '' });

        const facts = await clientHandlers().browserPageFacts?.(['screenWidth']);

        expect(facts).toEqual({ available: true, hostname: '', referrer: '', screenWidth: null });
    });

    it('no window or document is available: false with the defaults', async () => {
        const facts = await clientHandlers().browserPageFacts?.(['hostname', 'referrer', 'screenWidth']);

        expect(facts).toEqual({ available: false, hostname: '', referrer: '', screenWidth: null });
    });

    it('a window without a document is no page', async () => {
        vi.stubGlobal('window', { location: { hostname: 'h' } });

        const facts = await clientHandlers().browserPageFacts?.(['hostname']);

        expect(facts?.available).toBe(false);
    });

    it('a getter that throws rejects, which is not the no-page outcome', async () => {
        vi.stubGlobal('window', { location: { get hostname(): string { throw new Error('blocked'); } } });
        vi.stubGlobal('document', { referrer: '' });

        await expect(clientHandlers().browserPageFacts?.(['hostname'])).rejects.toThrow('blocked');
    });
});
