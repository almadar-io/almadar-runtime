// The OAuth effects and the OAuth port on the interpreter and the kernel host: the twin of orbital-core
// `tests/host_effects.rs` (`mod oauth`). The kernel's rules (client parsing, the authorization URL, the safe
// messages) are Rust's and are stood in for here; this file pins the host's asks, their order and the failures.
import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@almadar/core';
import type { OAuthAsk } from '@almadar/core/kernel-wire';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { decodeOAuthAsk } from '../src/kernel/decode.js';
import { createOAuthPort, PENDING_GRACE_MS } from '../src/kernel/oauth-port.js';
import { base64Standard, type HttpKernel, type HttpPorts, type HttpSecrets, type OAuthPort } from '../src/kernel/http-exchange.js';
import { fakeApp, fakeHttpKernel, replying } from './helpers/fake-http-kernel.js';
import { InMemoryPersistence } from '@almadar/db/mock';

interface Emitted { event: string; payload: EventPayload | undefined }

const ROUTES = { emit: { success: 'OK', failure: 'BAD' } };
const member = { id: 'u1', role: 'member' };
const CLIENT = { tag: 'google', mode: 'real', issuer: 'https://idp.example.com', clientId: 'CID', clientSecret: 'CSEC', clientAuth: 'post' };
const META = { issuer: 'https://idp.example.com', authorization_endpoint: 'https://idp.example.com/authorize' };

const MESSAGES = {
    'not-signed-in': ['A provider connection needs a signed-in caller', 'AUTH_ERROR'],
    'store-unavailable': ['No OAuth connection store is available on this host', 'NOT_CONFIGURED'],
    'metadata-invalid': ['The authorization server metadata is unusable', 'SERVICE_ERROR'],
    'unconfigured-client': ['The OAuth client is not configured', 'NOT_CONFIGURED'],
} as const;

function kernel(log: string[]): HttpKernel {
    return {
        ...fakeHttpKernel,
        oauthAuthorizePlan(clientJson, optionsJson) {
            log.push('plan');
            if (JSON.parse(optionsJson).bogus !== undefined) throw new Error('oauth-authorize: unknown option `bogus`');
            if (JSON.parse(clientJson).mode === 'mock') return JSON.stringify({ plan: {}, mode: 'mock', clientId: { name: 'CID', scope: 'app' }, issuer: null, metadata: null });
            return JSON.stringify({ plan: { client: JSON.parse(clientJson), options: JSON.parse(optionsJson) }, clientId: { name: 'CID', scope: 'app' }, issuer: 'https://idp.example.com', metadata: null });
        },
        oauthAuthorizeBuild(_plan, clientId, metadataJson, stateBase64, verifierBase64) {
            log.push(`build:${clientId}:${stateBase64}:${verifierBase64}:${Object.keys(JSON.parse(metadataJson)).length}`);
            return JSON.stringify({ ok: { authUrl: 'https://idp.example.com/authorize?state=S', state: 'S', grant: { provider: 'google', redirectUri: 'https://app/cb', verifier: 'V', subject: 'u1' } } });
        },
        oauthAuthorizeMockBuild(_plan, stateBase64) {
            log.push(`mock:${stateBase64}`);
            return JSON.stringify({ authUrl: 'https://mock/authorize?state=M', state: 'M', grant: { provider: 'google', redirectUri: 'u', verifier: '', subject: null, scopes: ['openid'] } });
        },
        oauthFailure(reason) {
            const [error, code] = MESSAGES[reason as keyof typeof MESSAGES] ?? ['unknown', 'SERVICE_ERROR'];
            return JSON.stringify({ error, code, reason });
        },
    };
}

function harness(options: { oauth?: OAuthPort | undefined; secrets?: { [name: string]: string }; log?: string[]; user?: { id: string; role: string } } = {}) {
    const log = options.log ?? [];
    const held = fakeApp({ fetch: replying(200, 'x'), random: (count) => new Uint8Array(count).fill(7), secrets: options.secrets ?? { CID: 'client-id' } });
    const ports: HttpPorts = { ...held.ports, kernel: async () => kernel(log), ...(options.oauth !== undefined ? { oauth: options.oauth } : {}) };
    const emitted: Emitted[] = [];
    const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); } });
    const bindings: BindingContext = { entity: { id: 'row-1' }, payload: {}, ...(options.user !== undefined ? { user: options.user } : {}) };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const execute = (effect: Parameters<EffectExecutor['execute']>[0]) =>
        new EffectExecutor({ handlers, bindings, context, inFlightCalls: new InFlightCalls(), http: ports }).execute(effect);
    return { emitted, execute, log, ports };
}

function recordingPort(inner: OAuthPort, asks: OAuthAsk[]): OAuthPort {
    return { async answer(ask, principal) { asks.push(ask); return inner.answer(ask, principal); } };
}

interface MemorySecrets extends HttpSecrets {
    stored: Map<string, string>;
    minted: Map<string, { value: string; expiresAt: number }>;
}

function memorySecrets(options: { now?: () => number; durable?: boolean } = {}): MemorySecrets {
    const now = options.now ?? Date.now;
    const keeps = options.durable ?? true;
    const minted = new Map<string, { value: string; expiresAt: number }>();
    const stored = new Map<string, string>();
    const slot = (name: string, principal: string | undefined): string => `${principal ?? ''}|${name}`;
    return {
        stored,
        minted,
        async get(name, principal) {
            const held = minted.get(slot(name, principal));
            if (held !== undefined && held.expiresAt > now()) return held.value;
            return stored.get(slot(name, principal));
        },
        async set(name, value, ttlMs, principal) { minted.set(slot(name, principal), { value, expiresAt: now() + ttlMs }); },
        async forget(name, principal) { minted.delete(slot(name, principal)); stored.delete(slot(name, principal)); },
        async persist(name, value, principal) {
            if (!keeps) throw new Error('this host keeps no credential store to persist into');
            stored.set(slot(name, principal), value);
        },
        async take(name, principal) {
            const held = minted.get(slot(name, principal));
            minted.delete(slot(name, principal));
            return held !== undefined && held.expiresAt > now() ? held.value : undefined;
        },
        async durable() { return keeps; },
    };
}

describe('oauth port', () => {
    const grant = { provider: 'google', redirectUri: 'https://app/cb', verifier: 'V', subject: 'u1', scopes: ['openid'] };

    it('takes a pending grant once and answers an unknown state as missing', async () => {
        const port = createOAuthPort({ secrets: memorySecrets() });
        expect(await port.answer({ ask: 'pendingPut', state: 's', grant, ttlMs: 60_000 }, undefined)).toEqual({ reply: 'done' });
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toEqual({ reply: 'taken', taken: { found: 'grant', grant } });
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toEqual({ reply: 'taken', taken: { found: 'missing' } });
        expect(await port.answer({ ask: 'pendingTake', state: 'never' }, undefined)).toEqual({ reply: 'taken', taken: { found: 'missing' } });
    });

    it('twin of the native store: live exactly through the inclusive TTL boundary, then expired, then missing', async () => {
        for (const [advance, found] of [[600_000, 'grant'], [600_001, 'expired']] as const) {
            let clock = 1_000;
            const port = createOAuthPort({ secrets: memorySecrets({ now: () => clock }), now: () => clock });
            await port.answer({ ask: 'pendingPut', state: 's', grant, ttlMs: 600_000 }, undefined);
            clock += advance;
            expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toMatchObject({ taken: { found } });
            expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toEqual({ reply: 'taken', taken: { found: 'missing' } });
        }
    });

    it('twin of the native mock tokens: a token answers the provider that issued it, refresh keeps it', async () => {
        const port = createOAuthPort({ secrets: memorySecrets(), now: () => 0 });
        await port.answer({ ask: 'mockTokenPut', accessToken: 'g', refreshToken: 'rg', expiresAtMs: 10, provider: 'google' }, undefined);
        await port.answer({ ask: 'mockTokenPut', accessToken: 'h', refreshToken: 'rh', expiresAtMs: 10, provider: 'github' }, undefined);
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'h' }, undefined)).toEqual({ reply: 'mockToken', state: 'valid', provider: 'github' });
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'g' }, undefined)).toEqual({ reply: 'mockToken', state: 'valid', provider: 'google' });
        await port.answer({ ask: 'mockTokenRefresh', refreshToken: 'rh', newAccessToken: 'h2', expiresAtMs: 10 }, undefined);
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'h2' }, undefined)).toEqual({ reply: 'mockToken', state: 'valid', provider: 'github' });
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'nope' }, undefined)).toEqual({ reply: 'mockToken', state: 'missing', provider: null });
    });

    it('twin of the native mock tokens: refresh survives access expiry, revoke works by either token', async () => {
        let clock = 0;
        const port = createOAuthPort({ secrets: memorySecrets({ now: () => clock }), now: () => clock });
        await port.answer({ ask: 'mockTokenPut', accessToken: 'a1', refreshToken: 'r1', expiresAtMs: 3_600_000, provider: 'google' }, undefined);
        await port.answer({ ask: 'subjectRemember', accessToken: 'a1', subject: 'sub' }, undefined);
        clock = 3_600_000;
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'a1' }, undefined)).toEqual({ reply: 'mockToken', state: 'valid', provider: 'google' });
        clock += 1;
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'a1' }, undefined)).toEqual({ reply: 'mockToken', state: 'expired', provider: null });
        expect(await port.answer({ ask: 'mockTokenCheck', accessToken: 'a1' }, undefined)).toEqual({ reply: 'mockToken', state: 'missing', provider: null });
        expect(await port.answer({ ask: 'mockTokenRefresh', refreshToken: 'r1', newAccessToken: 'a2', expiresAtMs: clock + 3_600_000 }, undefined)).toEqual({ reply: 'flag', value: true });
        expect(await port.answer({ ask: 'subjectLookup', accessToken: 'a2' }, undefined)).toEqual({ reply: 'subject', subject: null });
        expect(await port.answer({ ask: 'mockTokenRefresh', refreshToken: 'nope', newAccessToken: 'a3', expiresAtMs: 0 }, undefined)).toEqual({ reply: 'flag', value: false });
        expect(await port.answer({ ask: 'mockTokenRevoke', token: 'r1' }, undefined)).toEqual({ reply: 'flag', value: true });
        expect(await port.answer({ ask: 'mockTokenRevoke', token: 'r1' }, undefined)).toEqual({ reply: 'flag', value: false });
    });

    it('control: a grant with no subject round-trips with a null subject', async () => {
        const port = createOAuthPort({ secrets: memorySecrets() });
        await port.answer({ ask: 'pendingPut', state: 's', grant: { ...grant, subject: null }, ttlMs: 60_000 }, undefined);
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toMatchObject({ taken: { grant: { subject: null } } });
    });

    it('keeps a pending grant in one app slot keyed by state, which every principal resolves alike, once', async () => {
        const secrets = memorySecrets();
        const port = createOAuthPort({ secrets });
        await port.answer({ ask: 'pendingPut', state: 's', grant, ttlMs: 60_000 }, 'alice');
        expect([...secrets.minted.keys()]).toEqual(['|oauth:grant:s']);
        expect(secrets.stored.size).toBe(0);
        expect(JSON.parse(secrets.minted.get('|oauth:grant:s')?.value ?? '{}').grant.subject).toBe('u1');
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, 'bob')).toEqual({ reply: 'taken', taken: { found: 'grant', grant } });
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, 'alice')).toEqual({ reply: 'taken', taken: { found: 'missing' } });
        expect(secrets.minted.size).toBe(0);
    });

    it('control: an anonymous authorization is taken by the signed-in callback, once', async () => {
        const port = createOAuthPort({ secrets: memorySecrets() });
        await port.answer({ ask: 'pendingPut', state: 's', grant, ttlMs: 60_000 }, undefined);
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, 'alice')).toEqual({ reply: 'taken', taken: { found: 'grant', grant } });
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toEqual({ reply: 'taken', taken: { found: 'missing' } });
    });

    it('a pending grant is forgotten once its grace has passed', async () => {
        let clock = 1_000;
        const port = createOAuthPort({ secrets: memorySecrets({ now: () => clock }), now: () => clock });
        await port.answer({ ask: 'pendingPut', state: 's', grant, ttlMs: 600_000 }, undefined);
        clock += 600_000 + PENDING_GRACE_MS + 1;
        expect(await port.answer({ ask: 'pendingTake', state: 's' }, undefined)).toEqual({ reply: 'taken', taken: { found: 'missing' } });
    });

    it('keeps a connection as the owner\'s durable credential and never answers its tokens', async () => {
        const secrets = memorySecrets();
        const port = createOAuthPort({ secrets });
        const save: OAuthAsk = { ask: 'connectionSave', provider: 'google', grant: { accessToken: 'AT-SECRET', refreshToken: 'RT-SECRET', expiresIn: 1, tokenType: 'bearer', scope: ['x'], subject: 'acct' } };
        const saved = await port.answer(save, 'u1');
        expect([...secrets.stored.keys()]).toEqual(['u1|oauth:connection:google']);
        expect(secrets.stored.get('u1|oauth:connection:google')).toContain('AT-SECRET');
        const status = await port.answer({ ask: 'connectionStatus', provider: 'google' }, 'u1');
        expect(status).toMatchObject({ row: { connected: true, account: 'acct', scope: ['x'] } });
        for (const answered of [saved, status]) expect(JSON.stringify(answered)).not.toMatch(/AT-SECRET|RT-SECRET/);
        await port.answer({ ask: 'connectionRemove', provider: 'google' }, 'u1');
        expect(secrets.stored.size).toBe(0);
    });

    it('an unreadable held grant fails without echoing it, and a host that cannot take refuses', async () => {
        const secrets = memorySecrets();
        await secrets.set('oauth:grant:s', 'TOKEN-SHAPED-GARBAGE', 60_000);
        const failure = await createOAuthPort({ secrets }).answer({ ask: 'pendingTake', state: 's' }, undefined).catch((error: Error) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain('GARBAGE');
        const bare: HttpSecrets = { async get() { return undefined; }, async set() {}, async forget() {} };
        await expect(createOAuthPort({ secrets: bare }).answer({ ask: 'pendingTake', state: 's' }, undefined)).rejects.toThrow('no derived secrets');
        expect(await createOAuthPort({ secrets: bare }).answer({ ask: 'connectionAvailable' }, undefined)).toEqual({ reply: 'flag', value: false });
    });

    it('keeps connections per principal and denies an anonymous caller', async () => {
        const port = createOAuthPort({ secrets: memorySecrets() });
        const save: OAuthAsk = { ask: 'connectionSave', provider: 'google', grant: { accessToken: 'a', refreshToken: null, expiresIn: 1, tokenType: 'bearer', scope: ['x'], subject: null } };
        expect(await port.answer(save, 'u1')).toMatchObject({ reply: 'row', row: { connected: true } });
        expect(await port.answer({ ask: 'connectionStatus', provider: 'google' }, 'u1')).toMatchObject({ row: { connected: true } });
        expect(await port.answer({ ask: 'connectionStatus', provider: 'google' }, 'u2')).toMatchObject({ row: { connected: false } });
        await expect(port.answer({ ask: 'connectionStatus', provider: 'google' }, undefined)).rejects.toThrow('signed-in caller');
        await expect(port.answer(save, undefined)).rejects.toThrow('signed-in caller');
        expect(await port.answer({ ask: 'connectionAvailable' }, undefined)).toEqual({ reply: 'flag', value: true });
        expect(await createOAuthPort({ secrets: memorySecrets({ durable: false }) }).answer({ ask: 'connectionAvailable' }, undefined)).toEqual({ reply: 'flag', value: false });
        await expect(createOAuthPort({ secrets: memorySecrets({ durable: false }) }).answer(save, 'u1')).rejects.toThrow('no OAuth connection store');
    });

    it('remembers subjects, caches metadata and reads the clock', async () => {
        const port = createOAuthPort({ secrets: memorySecrets(), now: () => 42 });
        await port.answer({ ask: 'subjectRemember', accessToken: 't', subject: 'sub' }, undefined);
        expect(await port.answer({ ask: 'subjectLookup', accessToken: 't' }, undefined)).toEqual({ reply: 'subject', subject: 'sub' });
        await port.answer({ ask: 'subjectForget', accessToken: 't' }, undefined);
        expect(await port.answer({ ask: 'subjectLookup', accessToken: 't' }, undefined)).toEqual({ reply: 'subject', subject: null });
        expect(await port.answer({ ask: 'metadataGet', issuer: 'i' }, undefined)).toEqual({ reply: 'metadata', metadata: null });
        await port.answer({ ask: 'metadataPut', issuer: 'i', metadata: META }, undefined);
        expect(await port.answer({ ask: 'metadataGet', issuer: 'i' }, undefined)).toEqual({ reply: 'metadata', metadata: META });
        expect(await port.answer({ ask: 'clock' }, undefined)).toEqual({ reply: 'millis', value: 42 });
    });
});

describe('oauth wire', () => {
    it('decodes every ask the driver can make and refuses an unknown or malformed one', () => {
        const asks: OAuthAsk[] = [
            { ask: 'pendingTake', state: 's' },
            { ask: 'connectionAvailable' },
            { ask: 'connectionStatus', provider: 'github' },
            { ask: 'metadataPut', issuer: 'i', metadata: META },
            { ask: 'clock' },
        ];
        for (const ask of asks) expect(decodeOAuthAsk(JSON.parse(JSON.stringify(ask)))).toEqual(ask);
        expect(() => decodeOAuthAsk({ ask: 'wipeEverything' })).toThrow('unknown');
        expect(() => decodeOAuthAsk({ ask: 'connectionStatus', provider: 'okta' })).toThrow('provider');
        expect(() => decodeOAuthAsk({ ask: 'pendingTake' })).toThrow('state');
    });

    it('the kernel host answers an oauth request from the port, and a host with none says so', async () => {
        const port = createOAuthPort({ secrets: memorySecrets(), now: () => 5 });
        const base = (http: HttpPorts | undefined): KernelHostPorts => ({
            persistence: new InMemoryPersistence(), callService: async () => null, programEffect: () => undefined, inFlightCalls: new InFlightCalls(),
            servicePorts: () => ({}) as never, deliverLive: () => undefined, deferCallOutcome: () => undefined, ...(http !== undefined ? { http } : {}),
        });
        const held = harness({ oauth: port });
        const answered = await answerRequest(base(held.ports), { kind: 'oauth', ask: { ask: 'clock' } }, { orbital: 'Main' });
        expect(answered).toEqual({ kind: 'oauth', result: { ok: { reply: 'millis', value: 5 } } });
        const bare = await answerRequest(base(harness().ports), { kind: 'oauth', ask: { ask: 'clock' } }, { orbital: 'Main' });
        expect(bare).toEqual({ kind: 'oauth', result: { error: 'this host keeps no OAuth state' } });
    });
});

describe('oauth-authorize (interpreter)', () => {
    const authorize = ['oauth-authorize', CLIENT, { redirectUri: 'https://app/cb', subject: 'u1' }, ROUTES] as const;

    it('asks in the kernel\'s order and emits only the url and the state', async () => {
        const asks: OAuthAsk[] = [];
        const inner = createOAuthPort({ secrets: memorySecrets() });
        await inner.answer({ ask: 'metadataPut', issuer: 'https://idp.example.com', metadata: META }, undefined);
        const probe = harness({ oauth: recordingPort(inner, asks), user: member });
        await probe.execute([...authorize]);
        expect(probe.emitted).toEqual([{ event: 'OK', payload: { authUrl: 'https://idp.example.com/authorize?state=S', state: 'S', code: '', key: null } }]);
        expect(asks.map((a) => a.ask)).toEqual(['metadataGet', 'pendingPut', 'consent']);
        const put = asks[1];
        expect(put).toMatchObject({ ask: 'pendingPut', ttlMs: 600_000, grant: { verifier: 'V' } });
        expect(probe.log[1]).toBe(`build:client-id:${base64Standard(new Uint8Array(32).fill(7))}:${base64Standard(new Uint8Array(32).fill(7))}:2`);
        expect(JSON.stringify(probe.emitted)).not.toContain('"V"');
    });

    it('a mock client asks no secret and no metadata, draws 16 bytes and keeps a grant that never expires', async () => {
        const asks: OAuthAsk[] = [];
        const probe = harness({ oauth: recordingPort(createOAuthPort({ secrets: memorySecrets() }), asks), secrets: {} });
        await probe.execute(['oauth-authorize', { ...CLIENT, mode: 'mock' }, { redirectUri: 'u', scope: ['openid'] }, ROUTES]);
        expect(probe.emitted).toEqual([{ event: 'OK', payload: { authUrl: 'https://mock/authorize?state=M', state: 'M', code: '', key: null } }]);
        expect(probe.log).toEqual(['plan', `mock:${base64Standard(new Uint8Array(16).fill(7))}`]);
        expect(asks).toMatchObject([{ ask: 'pendingPut', ttlMs: Number.MAX_SAFE_INTEGER, grant: { scopes: ['openid'] } }]);
    });

    it('a host that opens the consent page hands the code back beside the url and state', async () => {
        const asks: OAuthAsk[] = [];
        const consents: Array<{ authUrl: string; state: string; redirectUri: string }> = [];
        const inner = createOAuthPort({ secrets: memorySecrets(), consent: async (request) => { consents.push(request); return 'CODE-FROM-BROWSER'; } });
        await inner.answer({ ask: 'metadataPut', issuer: 'https://idp.example.com', metadata: META }, undefined);
        const probe = harness({ oauth: recordingPort(inner, asks), user: member });
        await probe.execute([...authorize]);
        expect(probe.emitted).toEqual([{ event: 'OK', payload: { authUrl: 'https://idp.example.com/authorize?state=S', state: 'S', code: 'CODE-FROM-BROWSER', key: null } }]);
        expect(consents).toEqual([{ authUrl: 'https://idp.example.com/authorize?state=S', state: 'S', redirectUri: 'https://app/cb' }]);
    });

    it('control: a declined consent is no code, a failing window is store-unavailable, and a mock authorization asks nobody', async () => {
        const declined = createOAuthPort({ secrets: memorySecrets(), consent: async () => null });
        await declined.answer({ ask: 'metadataPut', issuer: 'https://idp.example.com', metadata: META }, undefined);
        const a = harness({ oauth: declined, user: member });
        await a.execute([...authorize]);
        expect(a.emitted).toMatchObject([{ event: 'OK', payload: { code: '' } }]);

        const broken = createOAuthPort({ secrets: memorySecrets(), consent: async () => { throw new Error('window closed'); } });
        await broken.answer({ ask: 'metadataPut', issuer: 'https://idp.example.com', metadata: META }, undefined);
        const b = harness({ oauth: broken, user: member });
        await b.execute([...authorize]);
        expect(b.emitted).toMatchObject([{ event: 'BAD', payload: { reason: 'store-unavailable' } }]);

        const asks: OAuthAsk[] = [];
        const never = createOAuthPort({ secrets: memorySecrets(), consent: async () => 'MUST-NOT-APPEAR' });
        const c = harness({ oauth: recordingPort(never, asks), secrets: {} });
        await c.execute(['oauth-authorize', { ...CLIENT, mode: 'mock' }, { redirectUri: 'u', scope: ['openid'] }, ROUTES]);
        expect(asks.map((x) => x.ask)).toEqual(['pendingPut']);
        expect(c.emitted).toMatchObject([{ event: 'OK', payload: { code: '' } }]);
    });

    it('fails metadata-invalid when discovery has not run, and unconfigured-client without the client id', async () => {
        const port = createOAuthPort({ secrets: memorySecrets() });
        const cold = harness({ oauth: port });
        await cold.execute([...authorize]);
        expect(cold.emitted).toEqual([{ event: 'BAD', payload: { error: MESSAGES['metadata-invalid'][0], code: 'SERVICE_ERROR', reason: 'metadata-invalid', key: null } }]);
        const nobody = harness({ oauth: port, secrets: {} });
        await nobody.execute([...authorize]);
        expect(nobody.emitted[0]?.payload).toMatchObject({ reason: 'unconfigured-client' });
    });

    it('a keyed authorize echoes the key in the success and the failure payload, and an empty key is refused', async () => {
        const inner = createOAuthPort({ secrets: memorySecrets() });
        await inner.answer({ ask: 'metadataPut', issuer: 'https://idp.example.com', metadata: META }, undefined);
        const warm = harness({ oauth: inner });
        await warm.execute(['oauth-authorize', CLIENT, { redirectUri: 'u' }, { key: 'job', ...ROUTES }]);
        expect(warm.emitted[0]?.payload).toMatchObject({ state: 'S', key: 'job' });
        const cold = harness({ oauth: createOAuthPort({ secrets: memorySecrets() }) });
        await cold.execute(['oauth-authorize', CLIENT, { redirectUri: 'u' }, { key: 'job', ...ROUTES }]);
        expect(cold.emitted[0]?.payload).toMatchObject({ reason: 'metadata-invalid', key: 'job' });
        const empty = harness({ oauth: inner });
        await empty.execute(['oauth-authorize', CLIENT, { redirectUri: 'u' }, { key: '', ...ROUTES }]);
        expect(empty.emitted[0]?.payload).toMatchObject({ key: null });
        expect(empty.emitted[0]?.event).toBe('BAD');
    });

    it('without an oauth port the effect fails store-unavailable, and a bad option fails with the kernel\'s message before any ask', async () => {
        const none = harness();
        await none.execute([...authorize]);
        expect(none.emitted[0]?.payload).toMatchObject({ reason: 'store-unavailable' });
        const asks: OAuthAsk[] = [];
        const bad = harness({ oauth: recordingPort(createOAuthPort({ secrets: memorySecrets() }), asks) });
        await bad.execute(['oauth-authorize', CLIENT, { redirectUri: 'u', bogus: 1 }, ROUTES]);
        expect(bad.emitted).toEqual([{ event: 'BAD', payload: { error: 'oauth-authorize: unknown option `bogus`', key: null } }]);
        expect(asks).toEqual([]);
    });
});

describe('oauth-connection-status / oauth-connection-forget (interpreter)', () => {
    it('are per user, forget disconnects, and an anonymous viewer is denied after the store check', async () => {
        const secrets = memorySecrets();
        const port = createOAuthPort({ secrets });
        await port.answer({ ask: 'connectionSave', provider: 'google', grant: { accessToken: 'a', refreshToken: null, expiresIn: 1, tokenType: 'bearer', scope: null, subject: null } }, 'u1');
        const mine = harness({ oauth: port, user: member });
        await mine.execute(['oauth-connection-status', 'google', ROUTES]);
        expect(mine.emitted[0]?.payload).toMatchObject({ provider: 'google', connected: true });
        const other = harness({ oauth: port, user: { id: 'u2', role: 'member' } });
        await other.execute(['oauth-connection-status', 'google', ROUTES]);
        expect(other.emitted[0]?.payload).toMatchObject({ connected: false });
        const anonymous = harness({ oauth: port });
        await anonymous.execute(['oauth-connection-status', 'google', ROUTES]);
        expect(anonymous.emitted).toEqual([{ event: 'BAD', payload: { error: MESSAGES['not-signed-in'][0], code: 'AUTH_ERROR', reason: 'not-signed-in' } }]);
        await mine.execute(['oauth-connection-forget', 'google', ROUTES]);
        expect(mine.emitted[1]?.payload).toMatchObject({ connected: false });
        expect(secrets.stored.size).toBe(0);
    });

    it('a host with no connection store fails store-unavailable even for an anonymous viewer, and an unknown provider fails the effect', async () => {
        const port = createOAuthPort({ secrets: memorySecrets({ durable: false }) });
        const probe = harness({ oauth: port });
        await probe.execute(['oauth-connection-status', 'google', ROUTES]);
        expect(probe.emitted[0]?.payload).toMatchObject({ reason: 'store-unavailable' });
        await probe.execute(['oauth-connection-status', 'okta', ROUTES]);
        expect(probe.emitted[1]).toEqual({ event: 'BAD', payload: { error: 'oauth-connection-status: provider must be google, github or auth0, not `okta`' } });
        await probe.execute(['oauth-connection-forget', 7, ROUTES]);
        expect(probe.emitted[2]?.payload).toEqual({ error: 'oauth-connection-forget: provider must be a provider word' });
    });
});

