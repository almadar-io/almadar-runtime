// A call-service awaits its provider with the browser host's queue released, so while a slow call is in
// flight a view's request and a `cancel-call` are served; non-I/O work stays serialized.
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { EventPayload, OrbitalSchema, OrbitalEventResponse, ServiceParams } from '@almadar/core';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';

const counter = { name: 'Counter', persistence: 'runtime' as const, fields: [{ name: 'id', type: 'string' as const, required: true }] };

const program: OrbitalSchema = {
  name: 'Cancellable',
  orbitals: [{
    name: 'Cancellable',
    entity: counter,
    traits: [{
      name: 'Worker', linkedEntity: 'Counter', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'CALL', name: 'CALL' }, { key: 'CANCEL', name: 'CANCEL' }, { key: 'PING', name: 'PING' }, { key: 'DONE', name: 'DONE' }, { key: 'CANCELLED', name: 'CANCELLED' }],
        transitions: [
          { from: 'idle', to: 'idle', event: 'CALL', effects: [['call-service', 'slow', 'work', {}, { key: 'job', emit: { success: 'DONE', cancelled: 'CANCELLED' } }]] },
          { from: 'idle', to: 'idle', event: 'CANCEL', effects: [['cancel-call', 'job']] },
          { from: 'idle', to: 'idle', event: 'PING', effects: [] },
          { from: 'idle', to: 'idle', event: 'DONE', effects: [] },
          { from: 'idle', to: 'idle', event: 'CANCELLED', effects: [] },
        ],
      },
    }],
    pages: [],
  }],
};

const hosts: BrowserHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.close()));
const db = () => `cancel-${Math.random()}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emitted = (response: OrbitalEventResponse) => response.emittedEvents.map((e) => e.event);

function slowProvider() {
  const seen: { signal: AbortSignal | undefined }[] = [];
  let finish: (value: EventPayload) => void = () => undefined;
  return {
    seen,
    finish: (value: EventPayload) => finish(value),
    callService: (_s: string, _a: string, _p: ServiceParams | undefined, context?: { signal?: AbortSignal }) =>
      new Promise<EventPayload | null>((resolve, reject) => {
        seen.push({ signal: context?.signal });
        finish = resolve;
        context?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };
}

describe('openBrowserHost: call-service releases the queue', () => {
  it('serves a view request and a cancel-call while a slow call is in flight, then routes the call to cancelled', async () => {
    const provider = slowProvider();
    const host = await openBrowserHost({ databaseName: db(), schema: program, callService: provider.callService });
    hosts.push(host);
    await host.send('Cancellable', { event: 'INIT', targetTrait: 'Worker', payload: {} });
    const call = host.send('Cancellable', { event: 'CALL', payload: {} });
    await wait(20);
    expect(provider.seen).toHaveLength(1);
    const ping = await host.send('Cancellable', { event: 'PING', payload: {} });
    expect(ping.success).toBe(true);
    await host.send('Cancellable', { event: 'CANCEL', payload: {} });
    const response = await call;
    expect(provider.seen[0].signal?.aborted).toBe(true);
    expect(emitted(response)).toEqual(['CANCELLED']);
    expect(response.emittedEvents[0].payload).toEqual({ key: 'job' });
  });

  it('control: without a cancel-call the call completes and routes to success', async () => {
    const provider = slowProvider();
    const host = await openBrowserHost({ databaseName: db(), schema: program, callService: provider.callService });
    hosts.push(host);
    await host.send('Cancellable', { event: 'INIT', targetTrait: 'Worker', payload: {} });
    const call = host.send('Cancellable', { event: 'CALL', payload: {} });
    await wait(20);
    provider.finish({ ok: true });
    expect(emitted(await call)).toEqual(['DONE']);
  });

  it('control: non-I/O steps stay serialized — a request made while another runs waits its turn', async () => {
    const order: string[] = [];
    const host = await openBrowserHost({
      databaseName: db(),
      schema: program,
      callService: async () => ({}),
    });
    hosts.push(host);
    await host.send('Cancellable', { event: 'INIT', targetTrait: 'Worker', payload: {} });
    const first = host.send('Cancellable', { event: 'PING', payload: {} }).then(() => order.push('first'));
    const second = host.send('Cancellable', { event: 'PING', payload: {} }).then(() => order.push('second'));
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('edge: a call-service re-takes the queue before its transition continues — a request queued meanwhile runs first, not interleaved', async () => {
    const provider = slowProvider();
    const host = await openBrowserHost({ databaseName: db(), schema: program, callService: provider.callService });
    hosts.push(host);
    await host.send('Cancellable', { event: 'INIT', targetTrait: 'Worker', payload: {} });
    const finished: string[] = [];
    const call = host.send('Cancellable', { event: 'CALL', payload: {} }).then(() => finished.push('call'));
    await wait(20);
    const ping = host.send('Cancellable', { event: 'PING', payload: {} }).then(() => finished.push('ping'));
    provider.finish({});
    await Promise.all([call, ping]);
    expect(finished).toEqual(['ping', 'call']);
  });
});

// While a keyed call waits outside the queue, another turn moves the trait; the call's cancelled result
// must be handled from the state that turn committed, not the waiting cascade's stale copy (which would
// overwrite it and strand the trait).
const twoState: OrbitalSchema = {
  name: 'Busy',
  orbitals: [{
    name: 'Busy',
    entity: counter,
    traits: [{
      name: 'Judge', linkedEntity: 'Counter', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'busy' }],
        events: [{ key: 'CALL', name: 'CALL' }, { key: 'STOP', name: 'STOP' }, { key: 'DONE', name: 'DONE' }, { key: 'CANCELLED', name: 'CANCELLED' }],
        transitions: [
          { from: 'idle', to: 'busy', event: 'CALL', effects: [['call-service', 'slow', 'work', {}, { key: 'job', emit: { success: 'DONE', cancelled: 'CANCELLED' } }]] },
          { from: 'busy', to: 'idle', event: 'STOP', effects: [['cancel-call', 'job']] },
          { from: 'busy', to: 'idle', event: 'DONE', effects: [] },
          { from: 'busy', to: 'busy', event: 'CANCELLED', effects: [] },
          { from: 'idle', to: 'idle', event: 'CANCELLED', effects: [] },
        ],
      },
    }],
    pages: [],
  }],
};

describe('openBrowserHost: a call result after another turn moved the trait', () => {
  it('is handled from the committed state, so the trait can take new work', async () => {
    const provider = slowProvider();
    const host = await openBrowserHost({ databaseName: db(), schema: twoState, callService: provider.callService });
    hosts.push(host);
    await host.send('Busy', { event: 'INIT', targetTrait: 'Judge', payload: {} });
    const call = host.send('Busy', { event: 'CALL', payload: {} });
    await wait(20);
    await host.send('Busy', { event: 'STOP', payload: {} });
    await call;
    const again = host.send('Busy', { event: 'CALL', payload: {} });
    await wait(20);
    expect(provider.seen).toHaveLength(2);
    provider.finish({ ok: true });
    expect(emitted(await again)).toEqual(['DONE']);
  });

  it('control: an uncancelled call finishes from where it started', async () => {
    const provider = slowProvider();
    const host = await openBrowserHost({ databaseName: db(), schema: twoState, callService: provider.callService });
    hosts.push(host);
    await host.send('Busy', { event: 'INIT', targetTrait: 'Judge', payload: {} });
    const call = host.send('Busy', { event: 'CALL', payload: {} });
    await wait(20);
    provider.finish({ ok: true });
    expect(emitted(await call)).toEqual(['DONE']);
    const again = host.send('Busy', { event: 'CALL', payload: {} });
    await wait(20);
    expect(provider.seen).toHaveLength(2);
  });
});
