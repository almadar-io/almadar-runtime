import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { runHttpCall, type HttpKernel } from '../src/kernel/http-exchange.js';
import type { HttpRequestWire } from '../src/kernel/wire.js';
import { fakeApp, fakeHttpKernel, replying, type FakeApp } from './helpers/fake-http-kernel.js';

const request: HttpRequestWire = {
  method: 'GET', url: 'https://api.example.com/retry', headers: [], body: { kind: 'empty' },
};

interface Running {
  completion: Promise<object>;
  cancel(): Promise<void>;
}

function startDriver(app: FakeApp, delayMs: number | undefined): Running {
  const kernel: HttpKernel = {
    ...fakeHttpKernel,
    httpDriverStart: () => JSON.stringify({ driver: {}, step: {
      kind: 'ask', ask: { kind: 'http', request, ...(delayMs !== undefined ? { delayMs } : {}) },
    } }),
    httpDriverResume: () => JSON.stringify({ driver: null, step: {
      kind: 'done', result: { ok: { status: 200, headers: {}, body: 'ok', key: 'job' } },
    } }),
  };
  const controller = new AbortController();
  return {
    completion: runHttpCall({ ...app.ports, kernel: async () => kernel }, {
      method: 'GET', origin: 'https://api.example.com', path: '/retry', request: {}, key: 'job',
    }, { signal: controller.signal }),
    cancel: async () => { controller.abort(); },
  };
}

function startHost(app: FakeApp, delayMs: number | undefined): Running {
  const ports: KernelHostPorts = {
    persistence: new InMemoryPersistence(),
    callService: async () => null,
    programEffect: () => undefined,
    inFlightCalls: new InFlightCalls(),
    servicePorts: () => { throw new Error('unused'); },
    deliverLive: () => undefined,
    deferCallOutcome: () => undefined,
    http: app.ports,
  };
  return {
    completion: answerRequest(ports, {
      kind: 'http', request, key: 'job', ...(delayMs !== undefined ? { delayMs } : {}),
    }, { orbital: 'Main' }),
    cancel: async () => { await answerRequest(ports, { kind: 'cancelCall', key: 'job' }, { orbital: 'Main' }); },
  };
}

describe.each([
  { route: 'wasm driver adapter', start: startDriver },
  { route: 'kernel host', start: startHost },
])('HTTP retry backoff: $route', ({ route, start }) => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends exactly once after the complete requested delay', async () => {
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const running = start(app, 100);
    await vi.advanceTimersByTimeAsync(99);
    expect(app.urls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await running.completion;
    expect(app.urls).toEqual([request.url]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0])('control: delay %s sends immediately without a timer', async (delay) => {
    const app = fakeApp({ fetch: replying(200, 'ok') });
    await start(app, delay).completion;
    expect(app.urls).toEqual([request.url]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels during backoff without sending or leaving a timer', async () => {
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const running = start(app, 100);
    const settled = running.completion.then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(20);
    await running.cancel();
    expect(await settled).toMatchObject(route === 'kernel host'
      ? { result: { kind: 'serviceCancelled' } }
      : { error: expect.any(Error) });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(app.urls).toEqual([]);
  });

  it('keeps delays above the platform timer limit pending until cancelled', async () => {
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const running = start(app, 2_147_483_648);
    const settled = running.completion.catch((error: Error) => ({ error }));
    await vi.advanceTimersByTimeAsync(1);
    expect(app.urls).toEqual([]);
    await running.cancel();
    await settled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 100])('does not send when cancelled during address resolution after delay %s', async (delay) => {
    let running: Running;
    let cancellation: Promise<void> | undefined;
    const app = fakeApp({
      fetch: replying(200, 'ok'),
      resolve: () => {
        cancellation = running.cancel();
        return { literal: false, addresses: ['93.184.216.34'] };
      },
    });
    running = start(app, delay);
    const settled = running.completion.then(
      (result) => ({ result }),
      (error: Error) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(delay);
    expect(cancellation).toBeDefined();
    await cancellation;
    expect(await settled).toMatchObject(route === 'kernel host'
      ? { result: { kind: 'serviceCancelled' } }
      : { error: expect.any(Error) });
    expect(app.urls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
