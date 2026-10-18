// The `http` effect on the interpreter path: the kernel builds the request, the host moves the bytes, the
// outcome routes to emit.success / failure / cancelled. A non-2xx reply is a success. Twin of the kernel host tests below.
import { describe, it, expect } from 'vitest';
import type { CallServiceEmitConfig, EventPayload, HttpEffect, SExpr } from '@almadar/core';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext, type HttpEffectReport } from '../src/index.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { OAUTH_CACHE, dropped, fakeApp, fakeHttpKernel, hangingFetch, replying, type FakeApp, type FakeFetch } from './helpers/fake-http-kernel.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

interface Emitted { event: string; payload: EventPayload | undefined }

const ORIGIN = 'https://api.example.com';
const ALL = { success: 'OK', failure: 'ERR', cancelled: 'CANCELLED' };
const flush = () => new Promise((r) => setTimeout(r, 0));

function run(app: FakeApp, now?: number) {
    const emitted: Emitted[] = [];
    const reports: HttpEffectReport[] = [];
    const registry = new InFlightCalls();
    const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); }, httpResult: (report: HttpEffectReport) => { reports.push(report); } });
    const bindings: BindingContext = { entity: { id: 'row-1' }, payload: { q: 'cat' }, ...(now !== undefined ? { now } : {}) };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const execute = (effect: Parameters<EffectExecutor['execute']>[0]) =>
        new EffectExecutor({ handlers, bindings, context, inFlightCalls: registry, http: app.ports }).execute(effect);
    return { emitted, reports, execute };
}

const http = (request: SExpr, options: CallServiceEmitConfig = { emit: ALL }, origin = ORIGIN): HttpEffect => ['http', 'GET', origin, '/search', request, options];

describe('http effect (interpreter)', () => {
    it('passes the dispatch stamp as execution metadata, not an authored request option', async () => {
        const app = fakeApp({ fetch: replying(200, 'ok') });
        const kernel = await app.ports.kernel();
        const starts: string[] = [];
        app.ports.kernel = async () => ({ ...kernel, httpDriverStart: (callJson, egressJson) => {
            starts.push(callJson);
            return kernel.httpDriverStart(callJson, egressJson);
        } });
        await run(app, 1440938160000).execute(http({}));
        expect(starts).toEqual([JSON.stringify({ method: 'GET', origin: ORIGIN, path: '/search', request: {}, nowMs: 1440938160000 })]);
    });
    it('evaluates a key expression before dispatch and echoes it', async () => {
        const app = fakeApp({ fetch: replying(200, 'ok') });
        const { emitted, execute } = run(app);
        await execute(http({}, { key: ['str/concat', 'request:', '@payload.q'], emit: ALL }));
        expect(app.urls).toEqual([`${ORIGIN}/search`]);
        expect(emitted[0]?.payload?.key).toBe('request:cat');
    });

    it('rejects keys that evaluate to non-string values before sending', async () => {
        for (const key of [['+', 1, 2], 17, null, '']) {
            const app = fakeApp({ fetch: replying(200, 'ok') });
            const { execute } = run(app);
            await expect(execute(http({}, { key, emit: ALL }))).rejects.toThrow('http key: key resolved to');
            expect(app.urls).toEqual([]);
        }
    });

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
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'connection reset', kind: 'failed', key: null, credential: null, phase: null, grantStatus: null, grantBody: null, code: null, reason: null } }]);
    });

    describe('trace report', () => {
        const noNetwork = () => { throw new Error('verify has no network'); };
        const target = `GET ${ORIGIN}/search`;
        it('a request the transport could not carry reports its target and its routed failure', async () => {
            const app = fakeApp({ fetch: noNetwork });
            const { emitted, reports, execute } = run(app);
            await execute(http({}));
            expect(emitted.map((e) => e.event)).toEqual(['ERR']);
            expect(reports).toEqual([{ success: false, target, error: 'verify has no network', routed: 'ERR' }]);
        });
        it('a reply reports its target as a success', async () => {
            const app = fakeApp({ fetch: replying(500, 'down') });
            const { reports, execute } = run(app);
            await execute(http({}));
            expect(reports).toEqual([{ success: true, target }]);
        });
        it('a request refused before sending reports its target and its routed failure', async () => {
            const app = fakeApp({ fetch: noNetwork });
            const { reports, execute } = run(app);
            await execute(http({}, { emit: ALL }, 'https://evil.example.com'));
            expect(reports).toEqual([{ success: false, target: 'GET https://evil.example.com/search', error: 'https://evil.example.com is not in egress', routed: 'ERR' }]);
        });
        it('control: a failure with no declared failure route is reported unrouted and still throws', async () => {
            const app = fakeApp({ fetch: noNetwork });
            const { emitted, reports, execute } = run(app);
            await expect(execute(http({}, { emit: { success: 'OK' } }))).rejects.toThrow('verify has no network');
            expect(emitted).toEqual([]);
            expect(reports).toEqual([{ success: false, target, error: 'verify has no network' }]);
        });
    });

    it('a request past its timeoutMs routes to failure with kind timeout', async () => {
        const app = fakeApp({ fetch: hangingFetch() });
        const { emitted, execute } = run(app);
        await execute(http({ timeoutMs: 20 }));
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'timed out', kind: 'timeout', key: null, credential: null, phase: null, grantStatus: null, grantBody: null, code: null, reason: null } }]);
    });

    it('refuses an origin outside egress before sending', async () => {
        const app = fakeApp({ fetch: replying(200, 'x') });
        const { emitted, execute } = run(app);
        await execute(http({}, { emit: ALL }, 'https://evil.example.com'));
        expect(app.urls).toEqual([]);
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'https://evil.example.com is not in egress', kind: 'refused', credential: null, phase: null, grantStatus: null, grantBody: null, code: null, reason: null, key: null } }]);
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

    it('names an unconfigured credential the store does not hold', async () => {
        const app = fakeApp({ fetch: replying(200, 'x') });
        const { emitted, execute } = run(app);
        await execute(http({ auth: { scheme: 'bearer', credential: 'MISSING' } }));
        expect(app.urls).toEqual([]);
        expect(emitted[0]).toMatchObject({ event: 'ERR', payload: { kind: 'unconfigured', credential: 'MISSING' } });
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

    it('a reply that arrives after cancel-call is dropped, though the transport ignored the abort', async () => {
        let answer: () => void = () => undefined;
        const ignoring: FakeFetch = () => new Promise((resolve) => { answer = () => resolve(new Response('late', { status: 200 })); });
        const { emitted, execute } = run(fakeApp({ fetch: ignoring }));
        const pending = execute(http({}, { key: 'job-1', emit: ALL }));
        await flush();
        await flush();
        await execute(['cancel-call', 'job-1']);
        await pending;
        answer();
        await flush();
        await flush();
        expect(emitted).toEqual([{ event: 'CANCELLED', payload: { key: 'job-1' } }]);
    });

    it('cancel-call of a key with nothing in flight, or of a request that finished, is a no-op', async () => {
        const { emitted, execute } = run(fakeApp({ fetch: replying(200, 'done') }));
        await execute(['cancel-call', 'nope']);
        await execute(http({}, { key: 'job-1', emit: ALL }));
        await execute(['cancel-call', 'job-1']);
        expect(emitted).toEqual([{ event: 'OK', payload: expect.objectContaining({ status: 200 }) }]);
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
        expect(emitted).toEqual([{ event: 'ERR', payload: { error: 'https://evil.example.com is not in egress', kind: 'refused', credential: null, phase: null, grantStatus: null, grantBody: null, code: null, reason: null, key: 'job-9' } }]);
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

describe('http effect (server runtime)', () => {
    function schema(): OrbitalSchema {
        return {
            name: 'http-app', version: '1.0.0', egress: [ORIGIN],
            orbitals: [{
                name: 'Ask', pages: [],
                entity: { name: 'Turn', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
                traits: [{
                    name: 'Asker', scope: 'instance', linkedEntity: 'Turn',
                    stateMachine: {
                        states: [{ name: 'idle', isInitial: true }],
                        events: [{ key: 'ASK', name: 'Ask' }, { key: 'ERR', name: 'Err' }, { key: 'OK', name: 'Ok' }],
                        transitions: [{ from: 'idle', to: 'idle', event: 'ASK', effects: [http({}, { emit: ALL })] }],
                    },
                }],
            }],
        };
    }
    it('lists the http effect and the emit of its failure route among the effect results when the transport has no network', async () => {
        const runtime = new OrbitalServerRuntime({
            persistence: new InMemoryPersistence(), debug: false, mode: 'mock',
            http: { kernel: async () => fakeHttpKernel, fetch: () => { throw new Error('verify has no network'); }, resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }) },
        });
        await runtime.register(schema());
        const res = await runtime.processOrbitalEvent('Ask', { event: 'ASK', targetTrait: 'Asker' });
        expect(res.effectResults?.filter((e) => e.effect === 'http' || e.effect === 'emit')).toEqual([
            { effect: 'http', success: false, target: `GET ${ORIGIN}/search`, error: 'verify has no network', routed: 'ERR' },
            { effect: 'emit', success: true, target: 'ERR' },
        ]);
    });
});
