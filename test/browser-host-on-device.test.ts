// `openBrowserHost({ onDevice })`: the extension worker plugs its model and embedder in here. A prompt waits with the
// host's queue released, a `cancel-call` from another request aborts it by key, and a host with no model fails
// `unconfigured` through the program's own failure route.
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { OnDeviceModelPort, OrbitalSchema, OrbitalEventResponse } from '@almadar/core';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';

const counter = { name: 'Counter', persistence: 'runtime' as const, fields: [{ name: 'id', type: 'string' as const, required: true }] };
const events = ['ASK', 'EMBED', 'CANCEL', 'PING', 'REPLIED', 'EMBEDDED', 'FAILED', 'STOPPED'];

const program: OrbitalSchema = {
  name: 'OnDevice',
  orbitals: [{
    name: 'OnDevice',
    entity: counter,
    traits: [{
      name: 'Asker', linkedEntity: 'Counter', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: events.map((key) => ({ key, name: key })),
        transitions: [
          { from: 'idle', to: 'idle', event: 'ASK', effects: [['browser/prompt', 'hello', '{"type":"object"}', { key: 'job', emit: { success: 'REPLIED', failure: 'FAILED', cancelled: 'STOPPED' } }]] },
          { from: 'idle', to: 'idle', event: 'EMBED', effects: [['browser/embed', ['a', 'b'], { key: 'vec', emit: { success: 'EMBEDDED', failure: 'FAILED', cancelled: 'STOPPED' } }]] },
          { from: 'idle', to: 'idle', event: 'CANCEL', effects: [['cancel-call', 'job']] },
          ...['PING', 'REPLIED', 'EMBEDDED', 'FAILED', 'STOPPED'].map((event) => ({ from: 'idle', to: 'idle', event, effects: [] })),
        ],
      },
    }],
    pages: [],
  }],
};

const hosts: BrowserHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.close()));
const db = () => `ondevice-${Math.random()}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emitted = (response: OrbitalEventResponse) => response.emittedEvents.map((e) => ({ event: e.event, payload: e.payload }));

function slowModel() {
  const signals: Array<AbortSignal | undefined> = [];
  let finish: (reply: string) => void = () => undefined;
  const model: OnDeviceModelPort = {
    availability: async () => 'available',
    prompt: (_text, _schema, signal) => new Promise<string>((resolve) => { signals.push(signal); finish = resolve; }),
  };
  return { model, signals, finish: (reply: string) => finish(reply) };
}

async function open(onDevice?: Parameters<typeof openBrowserHost>[0]['onDevice']): Promise<BrowserHost> {
  const host = await openBrowserHost({ databaseName: db(), schema: program, callService: async () => null, ...(onDevice !== undefined ? { onDevice } : {}) });
  hosts.push(host);
  await host.send('OnDevice', { event: 'INIT', targetTrait: 'Asker', payload: {} });
  return host;
}

describe('openBrowserHost: on-device model', () => {
  it('answers a prompt with the plugged-in model and routes the reply with the key', async () => {
    const model: OnDeviceModelPort = { availability: async () => 'available', prompt: async () => '{"ok":1}' };
    const host = await open({ model });
    expect(emitted(await host.send('OnDevice', { event: 'ASK', payload: {} }))).toEqual([{ event: 'REPLIED', payload: { reply: '{"ok":1}', key: 'job' } }]);
  });

  it('serves another request and a cancel-call while the model is thinking, then routes the ask to cancelled and drops the late reply', async () => {
    const slow = slowModel();
    const host = await open({ model: slow.model });
    const ask = host.send('OnDevice', { event: 'ASK', payload: {} });
    await wait(20);
    expect(slow.signals).toHaveLength(1);
    expect((await host.send('OnDevice', { event: 'PING', payload: {} })).success).toBe(true);
    await host.send('OnDevice', { event: 'CANCEL', payload: {} });
    const response = await ask;
    expect(slow.signals[0]?.aborted).toBe(true);
    slow.finish('{"late":true}');
    await wait(20);
    expect(emitted(response)).toEqual([{ event: 'STOPPED', payload: { key: 'job' } }]);
  });

  it('control: without a cancel-call the ask completes and routes to success', async () => {
    const slow = slowModel();
    const host = await open({ model: slow.model });
    const ask = host.send('OnDevice', { event: 'ASK', payload: {} });
    await wait(20);
    slow.finish('{"done":true}');
    expect(emitted(await ask)).toEqual([{ event: 'REPLIED', payload: { reply: '{"done":true}', key: 'job' } }]);
  });

  it('a host with no model or embedder fails unconfigured through the failure route', async () => {
    const host = await open();
    expect(emitted(await host.send('OnDevice', { event: 'ASK', payload: {} }))).toEqual([
      { event: 'FAILED', payload: { error: 'browser/prompt: no on-device model is wired into this host', kind: 'unconfigured', key: 'job' } },
    ]);
    expect(emitted(await host.send('OnDevice', { event: 'EMBED', payload: {} }))).toEqual([
      { event: 'FAILED', payload: { error: 'browser/embed: no on-device embedder is wired into this host', kind: 'unconfigured', key: 'vec' } },
    ]);
  });

  it('answers an embed with the plugged-in embedder, one vector per text', async () => {
    const host = await open({ embedder: { embed: async (texts) => texts.map((_t, i) => [i, 0.5]) } });
    expect(emitted(await host.send('OnDevice', { event: 'EMBED', payload: {} }))).toEqual([{ event: 'EMBEDDED', payload: { embeddings: [[0, 0.5], [1, 0.5]], key: 'vec' } }]);
  });
});
