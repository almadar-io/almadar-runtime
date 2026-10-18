// `random-bytes`, `credential-status` and `credential-forget` on the interpreter and the kernel host: the twin of
// orbital-core `tests/host_effects.rs` (EXEC-HTTP-2). Same vectors, same messages, one set of host functions.
import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { base64Standard, base64Url, createHttpPorts, type CredentialAdminPort, runHttpCall, userCredentialKey, type HttpCall, type HttpKernel, type HttpSecrets } from '../src/kernel/http-exchange.js';
import { fakeApp, memorySecrets, replying, type FakeApp } from './helpers/fake-http-kernel.js';

interface Emitted { event: string; payload: EventPayload | undefined }

const ROUTES = { emit: { success: 'OK', failure: 'BAD' } };
const fixed = (...bytes: number[]) => (count: number): Uint8Array => Uint8Array.from({ length: count }, (_, i) => bytes[i % bytes.length] ?? 0);

function run(app: FakeApp, user?: { id: string; role: string }) {
    const emitted: Emitted[] = [];
    const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); } });
    const bindings: BindingContext = { entity: { id: 'row-1' }, payload: { principal: 'evil' }, ...(user !== undefined ? { user } : {}) };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const execute = (effect: Parameters<EffectExecutor['execute']>[0]) =>
        new EffectExecutor({ handlers, bindings, context, inFlightCalls: new InFlightCalls(), http: app.ports }).execute(effect);
    return { emitted, execute };
}

const app = (random = fixed(0xfb, 0xff), secrets: { [name: string]: string } = {}) => fakeApp({ fetch: replying(200, 'x'), random, secrets });
const member = { id: 'u1', role: 'member' };

describe('random-bytes (interpreter)', () => {
    it('emits base64url without padding, the kernel path\'s vector', async () => {
        const { emitted, execute } = run(app());
        await execute(['random-bytes', 2, ROUTES]);
        expect(emitted).toEqual([{ event: 'OK', payload: { value: '-_8' } }]);
    });

    it('a bad count fails the effect with the kernel path\'s message and draws nothing', async () => {
        for (const bad of [0, 1025, 1.5, 'many', -3]) {
            let draws = 0;
            const { emitted, execute } = run(app((count) => { draws += 1; return new Uint8Array(count); }));
            await execute(['random-bytes', bad, ROUTES]);
            expect(draws).toBe(0);
            expect(emitted).toEqual([{ event: 'BAD', payload: { error: `random-bytes: the byte count must be an integer from 1 to 1024, got ${String(bad)}` } }]);
        }
    });

    it('control: the bounds 1 and 1024 draw', async () => {
        for (const good of [1, 1024]) {
            const { emitted, execute } = run(app());
            await execute(['random-bytes', good, ROUTES]);
            expect(emitted[0]).toMatchObject({ event: 'OK' });
        }
    });

    it('a failing source fires the failure route; with no route the effect throws', async () => {
        const broken = app(() => { throw new Error('entropy source down'); });
        const a = run(broken);
        await a.execute(['random-bytes', 8, ROUTES]);
        expect(a.emitted).toEqual([{ event: 'BAD', payload: { error: 'entropy source down' } }]);
        await expect(run(broken).execute(['random-bytes', 8])).rejects.toThrow('entropy source down');
    });
});

describe('random-bytes key (interpreter)', () => {
    const KEYED = { key: 'k1', emit: { success: 'OK', failure: 'BAD' } };

    it('a keyed call echoes its key in the success and failure payloads', async () => {
        const ok = run(app());
        await ok.execute(['random-bytes', 2, KEYED]);
        expect(ok.emitted).toEqual([{ event: 'OK', payload: { value: '-_8', key: 'k1' } }]);
        const down = run(app(() => { throw new Error('entropy source down'); }));
        await down.execute(['random-bytes', 8, KEYED]);
        expect(down.emitted).toEqual([{ event: 'BAD', payload: { error: 'entropy source down', key: 'k1' } }]);
        const bad = run(app());
        await bad.execute(['random-bytes', 0, KEYED]);
        expect(bad.emitted[0]).toMatchObject({ event: 'BAD', payload: { key: 'k1' } });
    });

    it('control: an unkeyed call adds no key field, and an empty key draws nothing', async () => {
        const plain = run(app());
        await plain.execute(['random-bytes', 2, ROUTES]);
        expect(plain.emitted).toEqual([{ event: 'OK', payload: { value: '-_8' } }]);
        let draws = 0;
        const empty = run(app((count) => { draws += 1; return new Uint8Array(count); }));
        await empty.execute(['random-bytes', 2, { key: '', emit: ROUTES.emit }]);
        expect(draws).toBe(0);
        expect(empty.emitted.map((e) => e.event)).toEqual(['BAD']);
    });
});

describe('credential-status / credential-forget (interpreter)', () => {
    it('explicit app status reads only the app slot, including without a viewer', async () => {
        for (const viewer of [undefined, member]) {
            const held = app(undefined, { KEY: 'app-token' });
            const probe = run(held, viewer);
            await probe.execute(['credential-status', { credential: 'KEY', scope: 'app' }, ROUTES]);
            expect(probe.emitted).toEqual([{ event: 'OK', payload: { connected: true, label: '' } }]);
            expect(held.urls).toEqual([]);
        }
        const held = app(undefined, { [userCredentialKey('u1', 'KEY')]: 'user-token' });
        const probe = run(held, member);
        await probe.execute(['credential-status', { credential: 'KEY', scope: 'app' }, ROUTES]);
        expect(probe.emitted).toEqual([{ event: 'OK', payload: { connected: false, label: '' } }]);
    });

    it('app status treats an authoritative empty value as disconnected without changing user presence', async () => {
        const held = app(undefined, { KEY: '', [userCredentialKey('u1', 'KEY')]: '' });
        const scopedApp = run(held, member);
        await scopedApp.execute(['credential-status', { credential: 'KEY', scope: 'app' }, ROUTES]);
        expect(scopedApp.emitted).toEqual([{ event: 'OK', payload: { connected: false, label: '' } }]);
        for (const selection of ['KEY', { credential: 'KEY', scope: 'user' }]) {
            const user = run(held, member);
            await user.execute(['credential-status', selection, ROUTES]);
            expect(user.emitted).toEqual([{ event: 'OK', payload: { connected: true, label: '' } }]);
        }
        expect(held.secrets.held.get('KEY')).toBe('');
    });

    it('explicit user status never falls back and still needs the dispatch viewer', async () => {
        const held = app(undefined, { KEY: 'app-token', [userCredentialKey('u1', 'KEY')]: 'first-user' });
        const second = run(held, { id: 'u2', role: 'member' });
        await second.execute(['credential-status', { credential: 'KEY', scope: 'user' }, ROUTES]);
        expect(second.emitted).toEqual([{ event: 'OK', payload: { connected: false, label: '' } }]);
        const anonymous = run(held);
        await anonymous.execute(['credential-status', { credential: 'KEY', scope: 'user' }, ROUTES]);
        expect(anonymous.emitted).toEqual([{ event: 'BAD', payload: { error: 'credential-status: nobody is signed in' } }]);
    });

    it('malformed scoped selections fail before reading a credential', async () => {
        for (const selection of [{ credential: 'KEY' }, { credential: 'KEY', scope: 'world' }, { credential: 'KEY', scope: 'app', principal: 'evil' }, { scope: 'app' }, { credential: 7, scope: 'app' }]) {
            const held = app(undefined, { KEY: 'app-token' });
            let reads = 0;
            held.ports.secrets = { ...held.secrets, async get() { reads += 1; return 'app-token'; } };
            const probe = run(held, member);
            await probe.execute(['credential-status', selection, ROUTES]);
            expect(probe.emitted[0]?.event).toBe('BAD');
            expect(reads).toBe(0);
        }
    });

    it('explicit app status propagates a failed lookup rather than reporting disconnected', async () => {
        const held = app();
        held.ports.secrets = { ...held.secrets, async get() { throw new Error('credential store unavailable'); } };
        const probe = run(held);
        await probe.execute(['credential-status', { credential: 'KEY', scope: 'app' }, ROUTES]);
        expect(probe.emitted).toEqual([{ event: 'BAD', payload: { error: 'credential store unavailable' } }]);
    });

    it('control: an explicit status selection does not widen credential-forget', async () => {
        const held = app(undefined, { KEY: 'app-token', [userCredentialKey('u1', 'KEY')]: 'user-token' });
        const probe = run(held, member);
        await probe.execute(['credential-forget', { credential: 'KEY', scope: 'app' }, ROUTES]);
        expect(probe.emitted).toEqual([{ event: 'BAD', payload: { error: "credential-forget: the credential must be a secret knob's name" } }]);
        expect(held.secrets.held.size).toBe(2);
    });

    it('status reads the viewer\'s credential, never the program\'s principal or the app-wide one', async () => {
        const held = app(undefined, { tok_name: 'app-wide', [userCredentialKey('u1', 'tok_name')]: 'mine' });
        const a = run(held, member);
        await a.execute(['credential-status', 'tok_name', ROUTES]);
        expect(a.emitted).toEqual([{ event: 'OK', payload: { connected: true, label: '' } }]);
        const b = run(held, { id: 'u2', role: 'member' });
        await b.execute(['credential-status', 'tok_name', ROUTES]);
        expect(b.emitted).toEqual([{ event: 'OK', payload: { connected: false, label: '' } }]);
    });

    it('forget drops only the viewer\'s credential and reports not connected', async () => {
        const held = app(undefined, { tok_name: 'app-wide', [userCredentialKey('u1', 'tok_name')]: 'mine' });
        const { emitted, execute } = run(held, member);
        await execute(['credential-forget', 'tok_name', ROUTES]);
        expect(emitted).toEqual([{ event: 'OK', payload: { connected: false, label: '' } }]);
        expect([...held.secrets.held.keys()]).toEqual(['tok_name']);
    });

    it('nobody signed in fails both with the kernel path\'s message and touches nothing', async () => {
        for (const head of ['credential-status', 'credential-forget']) {
            const held = app(undefined, { tok_name: 'app-wide' });
            const { emitted, execute } = run(held);
            await execute([head, 'tok_name', ROUTES]);
            expect(emitted).toEqual([{ event: 'BAD', payload: { error: `${head}: nobody is signed in` } }]);
            expect([...held.secrets.held.keys()]).toEqual(['tok_name']);
        }
    });

    it('a non-text credential fails the effect', async () => {
        const { emitted, execute } = run(app(), member);
        await execute(['credential-status', 7, ROUTES]);
        expect(emitted).toEqual([{ event: 'BAD', payload: { error: 'credential-status: the credential must be a secret knob\'s name' } }]);
    });
});

describe('kernel host answers', () => {
    function host(a: FakeApp) {
        const ports: KernelHostPorts = {
            persistence: new InMemoryPersistence(),
            callService: async () => null,
            programEffect: () => undefined,
            inFlightCalls: new InFlightCalls(),
            servicePorts: () => { throw new Error('unused'); },
            deliverLive: () => undefined,
            deferCallOutcome: () => undefined,
            http: a.ports,
        };
        return (request: Parameters<typeof answerRequest>[1]) => answerRequest(ports, request, { orbital: 'Main' });
    }

    it('random answers standard base64 of the drawn bytes', async () => {
        expect(await host(app())({ kind: 'random', bytes: 2 })).toEqual({ kind: 'random', result: { ok: base64Standard(Uint8Array.of(0xfb, 0xff)) } });
        expect(base64Standard(Uint8Array.of(0xfb, 0xff))).toBe('+/8=');
        expect(base64Url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
    });

    it('random answers a failing source as an error', async () => {
        const answer = await host(app(() => { throw new Error('down'); }))({ kind: 'random', bytes: 1 });
        expect(answer).toEqual({ kind: 'random', result: { error: 'down' } });
    });

    it('os is denied on a host given no os port, as the native host with none, and never touches the host adapter', async () => {
        const answer = await host(app())({ kind: 'os', op: 'os/read-file', args: ['/data/a'], key: null, site: null });
        expect(answer).toEqual({ kind: 'os', result: { error: { kind: 'denied', message: 'os/read-file: no os host configured' } } });
    });

    it('os is denied for every op the interpreter once handled in process when no os port is given', async () => {
        for (const op of ['os/watch-cron', 'os/watch-files', 'os/debounce']) {
            const answer = await host(app())({ kind: 'os', op, args: [], key: null, site: null });
            expect(answer).toEqual({ kind: 'os', result: { error: { kind: 'denied', message: `${op}: no os host configured` } } });
        }
    });

    it('deliver answers down on a JS host: there is no router, so a cross-unit emit is refused visibly', async () => {
        const envelope = {
            id: 'e1',
            from: { instance: 'api', orbital: 'Src', trait: 'Sender' },
            to: { instance: 'web', orbital: 'Dst', trait: 'Receiver' },
            event: 'GOT',
            payload: { n: 1 },
            causalId: 'api#1',
            hop: 1,
        };
        const answer = await host(app())({ kind: 'deliver', envelope, key: null, site: { trait: 'Sender', followOn: false, emit: {} } });
        expect(answer).toEqual({ kind: 'deliver', result: { error: { kind: 'down', id: 'e1' } } });
    });

    it('control: a non-os request is still answered by its own arm', async () => {
        const answer = await host(app())({ kind: 'random', bytes: 1 });
        expect(answer.kind).toBe('random');
    });

    it('secret and secretSet are scoped by the principal the kernel sent', async () => {
        const a = app();
        const answer = host(a);
        await answer({ kind: 'secretSet', name: 'tok', value: 'v1', ttlMs: 1000, principal: 'u1' });
        expect(await answer({ kind: 'secret', name: 'tok', principal: 'u1' })).toEqual({ kind: 'secret', result: { ok: 'v1' } });
        expect(await answer({ kind: 'secret', name: 'tok', principal: 'u2' })).toEqual({ kind: 'secret', result: { ok: null } });
        expect(await answer({ kind: 'secret', name: 'tok' })).toEqual({ kind: 'secret', result: { ok: null } });
    });

    it('credentialStatus and credentialForget act on the principal\'s credential only', async () => {
        const a = app(undefined, { tok: 'app-wide', [userCredentialKey('u1', 'tok')]: 'mine' });
        const answer = host(a);
        expect(await answer({ kind: 'credentialStatus', name: 'tok', principal: 'u1' })).toEqual({ kind: 'credentialStatus', result: { ok: { connected: true } } });
        expect(await answer({ kind: 'credentialStatus', name: 'tok', principal: 'u2' })).toEqual({ kind: 'credentialStatus', result: { ok: { connected: false } } });
        expect(await answer({ kind: 'credentialForget', name: 'tok', principal: 'u1' })).toEqual({ kind: 'credentialForget', result: { ok: null } });
        expect([...a.secrets.held.keys()]).toEqual(['tok']);
    });
});

describe('the driver\'s asks on the interpreter path', () => {
    function scripted(ask: object, answers: string[]): HttpKernel {
        return {
            httpDriverStart: () => JSON.stringify({ driver: {}, step: { kind: 'ask', ask } }),
            httpDriverResume: (_driver, answer) => {
                answers.push(answer);
                return JSON.stringify({ driver: null, step: { kind: 'done', result: { ok: { status: 200 } } } });
            },
            isPublicAddress: () => true,
            frameStream: () => '{"events":[],"carry":""}',
            frameStreamFinish: () => '[]',
            httpDriverDrop: () => undefined,
        };
    }
    const call: HttpCall = { method: 'GET', origin: 'https://api.example.com', path: '/x', request: {} };
    const portsFor = (kernel: HttpKernel, secrets: HttpSecrets) =>
        createHttpPorts({ kernel: async () => kernel, egress: [], secrets, random: fixed(1, 2, 3) });

    it('a random ask is answered with standard base64 of the host source', async () => {
        const answers: string[] = [];
        await runHttpCall(portsFor(scripted({ kind: 'random', bytes: 3 }, answers), memorySecrets({})), call);
        expect(answers.map((a) => JSON.parse(a))).toEqual([{ kind: 'random', result: { ok: 'AQID' } }]);
    });

    it('a user-scoped secret ask reads the dispatch principal\'s value, never the app-wide one', async () => {
        const secrets = memorySecrets({ tok: 'app-wide', [userCredentialKey('u1', 'tok')]: 'mine' });
        const answers: string[] = [];
        const ports = portsFor(scripted({ kind: 'secret', name: 'tok', scope: 'user' }, answers), secrets);
        await runHttpCall(ports, call, { principal: 'u1' });
        await runHttpCall(ports, call);
        expect(answers.map((a) => JSON.parse(a))).toEqual([
            { kind: 'secret', result: { ok: 'mine' } },
            { kind: 'secret', result: { error: 'nobody is signed in' } },
        ]);
    });

    it('control: an app-scoped ask ignores the principal', async () => {
        const answers: string[] = [];
        const ports = portsFor(scripted({ kind: 'secret', name: 'tok' }, answers), memorySecrets({ tok: 'app-wide', [userCredentialKey('u1', 'tok')]: 'mine' }));
        await runHttpCall(ports, call, { principal: 'u1' });
        expect(JSON.parse(answers[0] ?? '')).toEqual({ kind: 'secret', result: { ok: 'app-wide' } });
    });

    it('a secretRotate ask replaces the stored credential durably, scoped by the principal', async () => {
        const secrets = memorySecrets({ RT: 'old', [userCredentialKey('u1', 'RT')]: 'old-u1' });
        const answers: string[] = [];
        await runHttpCall(portsFor(scripted({ kind: 'secretRotate', name: 'RT', value: 'new-u1', scope: 'user' }, answers), secrets), call, { principal: 'u1' });
        expect(JSON.parse(answers[0] ?? '')).toEqual({ kind: 'secretRotate', result: { ok: null } });
        expect(secrets.held.get(userCredentialKey('u1', 'RT'))).toBe('new-u1');
        expect(secrets.held.get('RT')).toBe('old');
        const appAnswers: string[] = [];
        await runHttpCall(portsFor(scripted({ kind: 'secretRotate', name: 'RT', value: 'new-app' }, appAnswers), secrets), call, { principal: 'u1' });
        expect(secrets.held.get('RT')).toBe('new-app');
    });

    it('a secretRotate ask answers an error when the host cannot rotate, the credential is unknown, or nobody is signed in', async () => {
        const cases: Array<[string, HttpSecrets, object, string | undefined, string]> = [
            ['no rotate port', memorySecrets({ RT: 'old' }, false), { kind: 'secretRotate', name: 'RT', value: 'n' }, undefined, 'rotatable'],
            ['unknown credential', memorySecrets({}), { kind: 'secretRotate', name: 'RT', value: 'n' }, undefined, 'not stored'],
            ['user scope, nobody signed in', memorySecrets({ RT: 'old' }), { kind: 'secretRotate', name: 'RT', value: 'n', scope: 'user' }, undefined, 'nobody is signed in'],
        ];
        for (const [name, secrets, ask, principal, message] of cases) {
            const answers: string[] = [];
            await runHttpCall(portsFor(scripted(ask, answers), secrets), call, principal === undefined ? {} : { principal });
            expect(JSON.parse(answers[0] ?? ''), name).toEqual({ kind: 'secretRotate', result: { error: expect.stringContaining(message) } });
            expect(secrets.held.get('RT') ?? 'old', name).toBe('old');
        }
        const malformed = scripted({ kind: 'secretRotate', name: 'RT' }, []);
        await expect(runHttpCall(portsFor(malformed, memorySecrets({ RT: 'old' })), call, {})).rejects.toThrow(/malformed/);
    });

    it('a user-scoped secretSet stores under the principal', async () => {
        const secrets = memorySecrets({});
        const answers: string[] = [];
        const ports = portsFor(scripted({ kind: 'secretSet', name: 'tok', value: 'v', ttlMs: 1000, scope: 'user' }, answers), secrets);
        await runHttpCall(ports, call, { principal: 'u1' });
        expect([...secrets.held.entries()]).toEqual([[userCredentialKey('u1', 'tok'), 'v']]);
    });
});


describe('credential store asks (kernel host)', () => {
    const scope = { orbital: 'O' };
    const ports = (credentials: CredentialAdminPort | undefined): KernelHostPorts => ({
        persistence: new InMemoryPersistence(),
        callService: async () => null,
        programEffect: () => undefined,
        inFlightCalls: new InFlightCalls(),
        servicePorts: () => { throw new Error('unused'); },
        deliverLive: () => undefined,
        deferCallOutcome: () => undefined,
        ...(credentials !== undefined ? { http: { ...app().ports, credentials } } : {}),
    });
    const port = (calls: string[]): CredentialAdminPort => ({
        list: async () => { calls.push('list'); return { enabled: true, entries: [{ service: 's', name: 'n' }] }; },
        read: async (name) => { calls.push(`read:${name}`); return name === 'n' ? 'value' : null; },
        write: async (service, name) => { calls.push(`write:${service}:${name}`); },
        remove: async (name) => { calls.push(`remove:${name}`); return name === 'n'; },
        rotate: async () => { calls.push('rotate'); return { rotated: 1, alreadyCurrent: 2, unreadable: 0 }; },
        mode: async () => { calls.push('mode'); return 'real'; },
        setMode: async (mode) => { calls.push(`setMode:${mode}`); if (mode === 'mock') throw new Error('refused'); return mode; },
    });

    it('answers each ask from the port and decides nothing', async () => {
        const calls: string[] = [];
        const p = ports(port(calls));
        expect(await answerRequest(p, { kind: 'credentialStoreList' }, scope)).toEqual({ kind: 'credentialStoreList', result: { ok: { enabled: true, entries: [{ service: 's', name: 'n' }] } } });
        expect(await answerRequest(p, { kind: 'credentialStoreRead', name: 'n' }, scope)).toEqual({ kind: 'credentialStoreRead', result: { ok: 'value' } });
        expect(await answerRequest(p, { kind: 'credentialStoreRead', name: 'other' }, scope)).toEqual({ kind: 'credentialStoreRead', result: { ok: null } });
        expect(await answerRequest(p, { kind: 'credentialStoreWrite', service: 's', name: 'n', value: 'v' }, scope)).toEqual({ kind: 'credentialStoreWrite', result: { ok: null } });
        expect(await answerRequest(p, { kind: 'credentialStoreRemove', name: 'n' }, scope)).toEqual({ kind: 'credentialStoreRemove', result: { ok: true } });
        expect(await answerRequest(p, { kind: 'credentialStoreRotate' }, scope)).toEqual({ kind: 'credentialStoreRotate', result: { ok: { rotated: 1, alreadyCurrent: 2, unreadable: 0 } } });
        expect(await answerRequest(p, { kind: 'credentialModeRead' }, scope)).toEqual({ kind: 'credentialModeRead', result: { ok: 'real' } });
        expect(await answerRequest(p, { kind: 'credentialModeWrite', mode: 'real' }, scope)).toEqual({ kind: 'credentialModeWrite', result: { ok: 'real' } });
        expect(calls).toEqual(['list', 'read:n', 'read:other', 'write:s:n', 'remove:n', 'rotate', 'mode', 'setMode:real']);
    });

    it('a refusal of the port is the ask\'s error, and a host with no port is unavailable', async () => {
        expect(await answerRequest(ports(port([])), { kind: 'credentialModeWrite', mode: 'mock' }, scope)).toEqual({ kind: 'credentialModeWrite', result: { error: 'refused' } });
        const none = await answerRequest(ports(undefined), { kind: 'credentialStoreList' }, scope);
        expect(none).toMatchObject({ kind: 'credentialStoreList', result: { error: expect.stringContaining('HTTP_KERNEL_UNAVAILABLE') } });
    });
});
