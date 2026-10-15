// `random-bytes`, `credential-status` and `credential-forget` on the interpreter and the kernel host: the twin of
// orbital-core `tests/host_effects.rs` (EXEC-HTTP-2). Same vectors, same messages, one set of host functions.
import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { base64Standard, base64Url, createHttpPorts, runHttpCall, userCredentialKey, type HttpCall, type HttpKernel, type HttpSecrets } from '../src/kernel/http-exchange.js';
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

describe('credential-status / credential-forget (interpreter)', () => {
    it('status reads the viewer\'s credential, never the program\'s principal or the app-wide one', async () => {
        const held = app(undefined, { tok_name: 'app-wide', [userCredentialKey('u1', 'tok_name')]: 'mine' });
        const a = run(held, member);
        await a.execute(['credential-status', 'tok_name', ROUTES]);
        expect(a.emitted).toEqual([{ event: 'OK', payload: { connected: true } }]);
        const b = run(held, { id: 'u2', role: 'member' });
        await b.execute(['credential-status', 'tok_name', ROUTES]);
        expect(b.emitted).toEqual([{ event: 'OK', payload: { connected: false } }]);
    });

    it('forget drops only the viewer\'s credential and reports not connected', async () => {
        const held = app(undefined, { tok_name: 'app-wide', [userCredentialKey('u1', 'tok_name')]: 'mine' });
        const { emitted, execute } = run(held, member);
        await execute(['credential-forget', 'tok_name', ROUTES]);
        expect(emitted).toEqual([{ event: 'OK', payload: { connected: false } }]);
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
        expect(await answer({ kind: 'credentialStatus', name: 'tok', principal: 'u1' })).toEqual({ kind: 'credentialStatus', result: { ok: true } });
        expect(await answer({ kind: 'credentialStatus', name: 'tok', principal: 'u2' })).toEqual({ kind: 'credentialStatus', result: { ok: false } });
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

    it('a user-scoped secretSet stores under the principal', async () => {
        const secrets = memorySecrets({});
        const answers: string[] = [];
        const ports = portsFor(scripted({ kind: 'secretSet', name: 'tok', value: 'v', ttlMs: 1000, scope: 'user' }, answers), secrets);
        await runHttpCall(ports, call, { principal: 'u1' });
        expect([...secrets.held.entries()]).toEqual([[userCredentialKey('u1', 'tok'), 'v']]);
    });
});
