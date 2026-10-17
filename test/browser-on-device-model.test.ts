// `browser/prompt` and `browser/embed` on the interpreter and the kernel host: the twin of orbital-core
// `tests/http_effect.rs` `on_device_model` (same vectors, same emitted traces). A keyed ask is cancellable by
// `cancel-call`, a reply that arrives after the cancel is dropped, and a host with no model fails `unconfigured`.
import { describe, expect, it } from 'vitest';
import type { EventPayload, OnDeviceEmbedderPort, OnDeviceModelPort, OnDeviceModelPorts } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { onDeviceHandlers } from '../src/effects/on-device-model.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';

interface Emitted { event: string; payload: EventPayload | undefined }

const ROUTES = { emit: { success: 'OK', failure: 'BAD', cancelled: 'STOPPED' } };
const keyed = (key: string) => ({ key, ...ROUTES });
const SCHEMA = '{"type":"object"}';

function model(over: Partial<OnDeviceModelPort> & { calls?: Array<{ text: string; schema: object }> } = {}): OnDeviceModelPort {
    const { calls, ...port } = over;
    return {
        availability: async () => 'available',
        prompt: async (text, schema) => {
            calls?.push({ text, schema });
            return '{"category":"a"}';
        },
        ...port,
    };
}

function run(ports: OnDeviceModelPorts | undefined, calls = new InFlightCalls()) {
    const emitted: Emitted[] = [];
    const handlers = stubEffectHandlers({
        emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); },
        ...(ports !== undefined ? onDeviceHandlers(ports) : {}),
    });
    const bindings: BindingContext = { entity: { id: 'row-1' }, payload: {} };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const execute = (effect: Parameters<EffectExecutor['execute']>[0]) =>
        new EffectExecutor({ handlers, bindings, context, inFlightCalls: calls }).execute(effect);
    return { emitted, execute };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('browser/prompt (interpreter)', () => {
    it('asks the model once with the text and the parsed schema and emits the reply flat with a null key', async () => {
        const calls: Array<{ text: string; schema: object }> = [];
        const { emitted, execute } = run({ model: model({ calls }) });
        await execute(['browser/prompt', 'hello', SCHEMA, ROUTES]);
        expect(calls).toEqual([{ text: 'hello', schema: { type: 'object' } }]);
        expect(emitted).toEqual([{ event: 'OK', payload: { reply: '{"category":"a"}', key: null } }]);
    });

    it('echoes a call key on success', async () => {
        const { emitted, execute } = run({ model: model() });
        await execute(['browser/prompt', 'hello', SCHEMA, keyed('batch-1')]);
        expect(emitted).toEqual([{ event: 'OK', payload: { reply: '{"category":"a"}', key: 'batch-1' } }]);
    });

    it('a host with no model fails unconfigured, naming the key', async () => {
        for (const ports of [undefined, {}]) {
            const { emitted, execute } = run(ports);
            await execute(['browser/prompt', 'hello', SCHEMA, keyed('k')]);
            expect(emitted).toEqual([{ event: 'BAD', payload: { error: 'browser/prompt: no on-device model is wired into this host', kind: 'unconfigured', key: 'k' } }]);
        }
    });

    it('a model that cannot answer now fails unavailable and is never prompted', async () => {
        const calls: Array<{ text: string; schema: object }> = [];
        const { emitted, execute } = run({ model: model({ calls, availability: async () => 'downloading' }) });
        await execute(['browser/prompt', 'hello', SCHEMA, ROUTES]);
        expect(calls).toEqual([]);
        expect(emitted).toEqual([{ event: 'BAD', payload: { error: 'The on-device model is downloading', kind: 'unavailable', key: null } }]);
    });

    it('a model that errors fails with the error, kind failed', async () => {
        const { emitted, execute } = run({ model: model({ prompt: async () => { throw new Error('quota exceeded'); } }) });
        await execute(['browser/prompt', 'hello', SCHEMA, ROUTES]);
        expect(emitted).toEqual([{ event: 'BAD', payload: { error: 'quota exceeded', kind: 'failed', key: null } }]);
    });

    it('a text or schema that is not text fails before the model is asked', async () => {
        const calls: Array<{ text: string; schema: object }> = [];
        const { emitted, execute } = run({ model: model({ calls }) });
        await execute(['browser/prompt', 5, SCHEMA, ROUTES]);
        await execute(['browser/prompt', 'hello', { type: 'object' }, ROUTES]);
        expect(calls).toEqual([]);
        expect(emitted.map((e) => e.event)).toEqual(['BAD', 'BAD']);
        expect(emitted[0]?.payload).toEqual({ error: 'browser/prompt: the text and the response schema must be text', kind: 'failed', key: null });
    });

    it('a failure with no failure route is thrown, and a key that is not a string never asks the model', async () => {
        const calls: Array<{ text: string; schema: object }> = [];
        const { execute } = run({ model: model({ calls, prompt: async () => { throw new Error('quota exceeded'); } }) });
        await expect(execute(['browser/prompt', 'hello', SCHEMA, { emit: { success: 'OK' } }])).rejects.toThrow('quota exceeded');
        for (const key of [5, null, '']) {
            await expect(execute(['browser/prompt', 'hello', SCHEMA, { key, ...ROUTES }])).rejects.toThrow('browser/prompt key: key resolved to');
        }
        expect(calls).toEqual([]);
    });

    it('cancel-call aborts a keyed ask: the cancelled route fires with the key and the late reply is dropped', async () => {
        let release: (reply: string) => void = () => undefined;
        const signals: Array<AbortSignal | undefined> = [];
        const slow = model({ prompt: (_text, _schema, signal) => { signals.push(signal); return new Promise<string>((resolve) => { release = resolve; }); } });
        const calls = new InFlightCalls();
        const { emitted, execute } = run({ model: slow }, calls);
        const pending = execute(['browser/prompt', 'hello', SCHEMA, keyed('job')]);
        await flush();
        expect(calls.inFlight('job')).toBe(true);
        await execute(['cancel-call', 'job']);
        await pending;
        expect(signals[0]?.aborted).toBe(true);
        release('{"late":true}');
        await flush();
        expect(emitted).toEqual([{ event: 'STOPPED', payload: { key: 'job' } }]);
    });

    it('cancel-call of an unknown key, or of a call that finished, is a no-op', async () => {
        const calls = new InFlightCalls();
        const { emitted, execute } = run({ model: model() }, calls);
        await execute(['cancel-call', 'nope']);
        await execute(['browser/prompt', 'hello', SCHEMA, keyed('done')]);
        await execute(['cancel-call', 'done']);
        expect(emitted).toEqual([{ event: 'OK', payload: { reply: '{"category":"a"}', key: 'done' } }]);
    });

    it('control: cancelling another key leaves the ask running to its reply', async () => {
        let release: (reply: string) => void = () => undefined;
        const slow = model({ prompt: () => new Promise<string>((resolve) => { release = resolve; }) });
        const { emitted, execute } = run({ model: slow });
        const pending = execute(['browser/prompt', 'hello', SCHEMA, keyed('job')]);
        await flush();
        await execute(['cancel-call', 'other']);
        release('{"ok":1}');
        await pending;
        expect(emitted).toEqual([{ event: 'OK', payload: { reply: '{"ok":1}', key: 'job' } }]);
    });
});

describe('browser/embed (interpreter)', () => {
    const embedder = (over: Partial<OnDeviceEmbedderPort> = {}): OnDeviceEmbedderPort => ({
        embed: async (texts) => texts.map((_t, i) => [i, i + 0.5]),
        ...over,
    });

    it('asks the embedder once and emits one vector per text with the key', async () => {
        const asked: string[][] = [];
        const { emitted, execute } = run({ embedder: embedder({ embed: async (texts) => { asked.push(texts); return texts.map((_t, i) => [i, i + 0.5]); } }) });
        await execute(['browser/embed', ['a', 'b'], keyed('k')]);
        expect(asked).toEqual([['a', 'b']]);
        expect(emitted).toEqual([{ event: 'OK', payload: { embeddings: [[0, 0.5], [1, 1.5]], key: 'k' } }]);
    });

    it('an empty list resolves with no vectors and never asks the embedder, wired or not', async () => {
        for (const ports of [undefined, { embedder: embedder({ embed: async () => { throw new Error('asked'); } }) }]) {
            const { emitted, execute } = run(ports);
            await execute(['browser/embed', [], ROUTES]);
            expect(emitted).toEqual([{ event: 'OK', payload: { embeddings: [], key: null } }]);
        }
    });

    it('a host with no embedder fails unconfigured', async () => {
        const { emitted, execute } = run({ model: model() });
        await execute(['browser/embed', ['a'], ROUTES]);
        expect(emitted).toEqual([{ event: 'BAD', payload: { error: 'browser/embed: no on-device embedder is wired into this host', kind: 'unconfigured', key: null } }]);
    });

    it('hands back whatever vectors the embedder answers and leaves the count check to the program', async () => {
        const { emitted, execute } = run({ embedder: embedder({ embed: async () => [[1]] }) });
        await execute(['browser/embed', ['a', 'b'], ROUTES]);
        expect(emitted).toEqual([{ event: 'OK', payload: { embeddings: [[1]], key: null } }]);
    });

    it('texts that are not a list of text fail before the embedder is asked', async () => {
        const { emitted, execute } = run({ embedder: embedder({ embed: async () => { throw new Error('asked'); } }) });
        await execute(['browser/embed', 'a', ROUTES]);
        await execute(['browser/embed', ['a', 2], ROUTES]);
        expect(emitted.map((e) => e.payload)).toEqual([
            { error: 'browser/embed: the texts must be a list of text', kind: 'failed', key: null },
            { error: 'browser/embed: the texts must be a list of text', kind: 'failed', key: null },
        ]);
    });

    it('cancel-call aborts a keyed embed and drops the late vectors', async () => {
        let release: (vectors: number[][]) => void = () => undefined;
        const signals: Array<AbortSignal | undefined> = [];
        const slow = embedder({ embed: (_texts, signal) => { signals.push(signal); return new Promise<number[][]>((resolve) => { release = resolve; }); } });
        const { emitted, execute } = run({ embedder: slow });
        const pending = execute(['browser/embed', ['a'], keyed('job')]);
        await flush();
        await execute(['cancel-call', 'job']);
        await pending;
        release([[1]]);
        await flush();
        expect(signals[0]?.aborted).toBe(true);
        expect(emitted).toEqual([{ event: 'STOPPED', payload: { key: 'job' } }]);
    });
});

describe('prompt and embed on the kernel host', () => {
    function ports(onDevice: OnDeviceModelPorts | undefined): KernelHostPorts {
        return {
            persistence: new InMemoryPersistence(),
            callService: async () => null,
            programEffect: () => undefined,
            inFlightCalls: new InFlightCalls(),
            servicePorts: () => { throw new Error('no service ports'); },
            deliverLive: () => undefined,
            deferCallOutcome: () => undefined,
            ...(onDevice !== undefined ? { onDevice } : {}),
        };
    }
    const scope = { orbital: 'Main' };

    it('answers a prompt and an embed with the same results as the interpreter', async () => {
        const host = ports({ model: model(), embedder: { embed: async (texts) => texts.map(() => [1, 2]) } });
        expect(await answerRequest(host, { kind: 'prompt', text: 'hello', schema: SCHEMA }, scope)).toEqual({ kind: 'prompt', result: { ok: '{"category":"a"}' } });
        expect(await answerRequest(host, { kind: 'embed', texts: ['a', 'b'] }, scope)).toEqual({ kind: 'embed', result: { ok: [[1, 2], [1, 2]] } });
    });

    it('answers unconfigured when the host wires nothing, and unavailable when the model cannot answer', async () => {
        expect(await answerRequest(ports(undefined), { kind: 'prompt', text: 'hello', schema: SCHEMA }, scope)).toEqual({
            kind: 'prompt',
            result: { error: { kind: 'unconfigured', message: 'browser/prompt: no on-device model is wired into this host' } },
        });
        expect(await answerRequest(ports(undefined), { kind: 'embed', texts: ['a'] }, scope)).toEqual({
            kind: 'embed',
            result: { error: { kind: 'unconfigured', message: 'browser/embed: no on-device embedder is wired into this host' } },
        });
        const down = ports({ model: model({ availability: async () => 'unavailable' }) });
        expect(await answerRequest(down, { kind: 'prompt', text: 'hello', schema: SCHEMA }, scope)).toEqual({
            kind: 'prompt',
            result: { error: { kind: 'unavailable', message: 'The on-device model is unavailable' } },
        });
    });

    it('a cancelCall aborts a keyed ask, which settles serviceCancelled', async () => {
        const slow = model({ prompt: () => new Promise<string>(() => undefined) });
        const host = ports({ model: slow });
        const pending = answerRequest(host, { kind: 'prompt', text: 'hello', schema: SCHEMA, key: 'job' }, scope);
        await flush();
        await answerRequest(host, { kind: 'cancelCall', key: 'job' }, scope);
        expect(await pending).toEqual({ kind: 'serviceCancelled' });
    });
});
