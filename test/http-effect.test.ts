// The `http` effect on the interpreter path: the kernel builds the request, the host moves the bytes, the
// outcome routes to emit.success / failure / cancelled. A non-2xx reply is a success. Twin of the kernel host tests below.
import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { OAUTH_CACHE, dropped, fakeApp, hangingFetch, replying, type FakeApp, type FakeFetch } from './helpers/fake-http-kernel.js';

interface Emitted { event: string; payload: EventPayload | undefined }

const ORIGIN = 'https://api.example.com';
const ALL = { success: 'OK', failure: 'ERR', cancelled: 'CANCELLED' };
const flush = () => new Promise((r) => setTimeout(r, 0));

function run(app: FakeApp) {
    const emitted: Emitted[] = [];
    const registry = new InFlightCalls();
    const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); } });
    const bindings: BindingContext = { entity: { id: 'row-1' }, payload: { q: 'cat' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const execute = (effect: Parameters<EffectExecutor['execute']>[0]) =>
        new EffectExecutor({ handlers, bindings, context, inFlightCalls: registry, http: app.ports }).execute(effect);
    return { emitted, execute };
}

const http = (request: object, options: object = { emit: ALL }, origin = ORIGIN) => ['http', 'GET', origin, '/search', request, options];

describe('http effect (interpreter)', () => {
    it('sends the built request and routes the reply payload to success', async () => {
        const app = fakeApp({ fetch: replying(200, '{"ok":1}', [['Content-Type', 'application/json']]), secrets: { KEY: 'tok' } });
        const { emitted, execute } = run(app);
        await execute(http({ auth: { scheme: 'bearer', credential: 'KEY' } }));
        expect(app.urls).toEqual([`${ORIGIN}/search`]);
        expect(emitted).toEqual([{ event: 'OK', payload: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}', key: null } }]);
    });

    it('a non-2xx reply is a success, never a failure', async () => {
        const app = fakeApp({ fetch: replying(404, 'nope') });
        const { emitted, execute } = run(app);
        await execute(http({}));
        expect(emitted).toEqual([{ event: 'OK', payload: { status: 404, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: 'nope', key: null } }]);
    });

    it('a transport error routes to failure with kind failed', async () => {
        const app = fakeApp({ fetch: () => { throw new Error('connection reset'); } });
        const { emitted, execute } = run(app);
        await execute(http({}));
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'connection reset', kind: 'failed', key: null } }]);
    });

    it('a request past its timeoutMs routes to failure with kind timeout', async () => {
        const app = fakeApp({ fetch: hangingFetch() });
        const { emitted, execute } = run(app);
        await execute(http({ timeoutMs: 20 }));
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'timed out', kind: 'timeout', key: null } }]);
    });

    it('refuses an origin outside egress before sending', async () => {
        const app = fakeApp({ fetch: replying(200, 'x') });
        const { emitted, execute } = run(app);
        await execute(http({}, { emit: ALL }, 'https://evil.example.com'));
        expect(app.urls).toEqual([]);
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'https://evil.example.com is not in egress', kind: 'refused', key: null } }]);
    });

    it('refuses a host that resolves to a private address, and sends to a literal the program listed', async () => {
        const refused = fakeApp({ fetch: replying(200, 'x'), resolve: () => ({ literal: false, addresses: ['10.0.0.5'] }) });
        const a = run(refused);
        await a.execute(http({}));
        expect(refused.urls).toEqual([]);
        expect(a.emitted[0]).toMatchObject({ event: 'ERR', payload: { kind: 'refused' } });

        const literal = fakeApp({ egress: ['http://127.0.0.1:8080'], fetch: replying(200, 'x'), resolve: () => ({ literal: true, addresses: ['127.0.0.1'] }) });
        const b = run(literal);
        await b.execute(http({}, { emit: ALL }, 'http://127.0.0.1:8080'));
        expect(literal.urls).toEqual(['http://127.0.0.1:8080/search']);
        expect(b.emitted[0]).toMatchObject({ event: 'OK' });
    });

    it('refuses a named credential the store does not hold', async () => {
        const app = fakeApp({ fetch: replying(200, 'x') });
        const { emitted, execute } = run(app);
        await execute(http({ auth: { scheme: 'bearer', credential: 'MISSING' } }));
        expect(app.urls).toEqual([]);
        expect(emitted[0]).toMatchObject({ event: 'ERR', payload: { kind: 'refused' } });
    });

    it('cancel-call aborts a keyed request and routes to cancelled with { key }', async () => {
        const seen: AbortSignal[] = [];
        const app = fakeApp({ fetch: hangingFetch(seen) });
        const { emitted, execute } = run(app);
        const pending = execute(http({}, { key: 'job-1', emit: ALL }));
        await flush();
        await flush();
        expect(seen[0]?.aborted).toBe(false);
        await execute(['cancel-call', 'job-1']);
        await pending;
        expect(seen[0]?.aborted).toBe(true);
        expect(emitted).toEqual([{ event: 'CANCELLED', payload: { key: 'job-1' } }]);
    });

    it('releases the kernel call when it is cancelled before its final step, and not when it finishes', async () => {
        dropped.length = 0;
        const hanging = run(fakeApp({ fetch: hangingFetch() }));
        const pending = hanging.execute(http({}, { key: 'job-1', emit: ALL }));
        await flush();
        await flush();
        await hanging.execute(['cancel-call', 'job-1']);
        await pending;
        await flush();
        expect(dropped).toHaveLength(1);
        dropped.length = 0;
        await run(fakeApp({ fetch: replying(200, 'done') })).execute(http({}, { key: 'job-2', emit: ALL }));
        expect(dropped).toEqual([]);
    });

    it('a keyed failure echoes the call key on the failure payload', async () => {
        const app = fakeApp({ fetch: replying(200, 'x') });
        const { emitted, execute } = run(app);
        await execute(http({}, { key: 'job-9', emit: ALL }, 'https://evil.example.com'));
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'https://evil.example.com is not in egress', kind: 'refused', key: 'job-9' } }]);
    });

    it('control: a keyed request that is not cancelled routes to success', async () => {
        const app = fakeApp({ fetch: replying(200, 'done') });
        const { emitted, execute } = run(app);
        await execute(http({}, { key: 'job-1', emit: ALL }));
        expect(emitted).toEqual([{ event: 'OK', payload: expect.objectContaining({ status: 200 }) }]);
    });

    it('fails loudly with a coded error when the host gave no http ports', async () => {
        const handlers = stubEffectHandlers({ emit: () => undefined });
        const executor = new EffectExecutor({ handlers, bindings: { entity: {}, payload: {} }, context: { traitName: 'T', state: 'idle', transition: 't' } });
        await expect(executor.execute(http({}, {}))).rejects.toThrow(/HTTP_KERNEL_UNAVAILABLE/);
    });

    it('streams framed events to the live route and ends with an empty-bodied reply', async () => {
        const live: Array<{ event: string; payload: EventPayload }> = [];
        const app = fakeApp({ fetch: replying(200, 'data: one\n\ndata: two\n\n') });
        const emitted: Emitted[] = [];
        const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); } });
        const executor = new EffectExecutor({
            handlers,
            bindings: { entity: {}, payload: {} },
            context: { traitName: 'T', state: 'idle', transition: 't' },
            http: app.ports,
            deliverLive: (route, payload) => { live.push({ event: route.event, payload }); },
        });
        await executor.execute(http({ stream: 'sse' }, { emit: { ...ALL, onMessage: 'CHUNK' } }));
        expect(live.map((m) => m.payload)).toEqual([{ data: 'one', event: null, id: null, key: null }, { data: 'two', event: null, id: null, key: null }]);
        expect(live.every((m) => m.event === 'CHUNK')).toBe(true);
        expect(emitted).toEqual([{ event: 'OK', payload: { status: 200, headers: expect.any(Object), body: '', key: null } }]);
    });

    it('pins the connection to the address it checked', async () => {
        const app = fakeApp({ fetch: replying(200, 'x'), resolve: () => ({ literal: false, addresses: ['93.184.216.34', '93.184.216.35'] }) });
        await run(app).execute(http({}));
        expect(app.pinned).toEqual(['93.184.216.34']);
    });

    describe('oauth2-client asks answered from the credential store', () => {
        const auth = { scheme: 'oauth2-client', tokenUrl: `${ORIGIN}/token`, clientId: 'ID', clientSecret: 'SECRET' };
        const sent: Array<{ url: string; auth: string | undefined }> = [];
        const server: FakeFetch = (url, init) => {
            sent.push({ url, auth: init.headers.find(([name]) => name === 'Authorization')?.[1] });
            return new Response(url.endsWith('/token') ? 'token-1' : 'data', { status: 200 });
        };

        it('stores the minted token through the secret store and sends it as the bearer', async () => {
            sent.length = 0;
            const app = fakeApp({ fetch: server });
            const { emitted, execute } = run(app);
            await execute(http({ auth }));
            expect(sent.map((s) => s.url)).toEqual([`${ORIGIN}/token`, `${ORIGIN}/search`]);
            expect(sent[1].auth).toBe('Bearer token-1');
            expect(app.secrets.held.get(OAUTH_CACHE)).toBe('token-1');
            expect(emitted[0]).toMatchObject({ event: 'OK' });
        });

        it('control: a cached token is used with no grant', async () => {
            sent.length = 0;
            const app = fakeApp({ fetch: server, secrets: { [OAUTH_CACHE]: 'cached' } });
            await run(app).execute(http({ auth }));
            expect(sent.map((s) => s.url)).toEqual([`${ORIGIN}/search`]);
            expect(sent[0].auth).toBe('Bearer cached');
        });
    });
});
