import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { runHttpCall, type HttpPorts, type ResolvedHost } from '../src/kernel/http-exchange.js';
import { fakeApp, hangingFetch, replying } from './helpers/fake-http-kernel.js';

interface Running {
  completion: Promise<object>;
  cancel(): Promise<void>;
}

function startDriver(ports: HttpPorts, timeoutMs: number): Running {
  const controller = new AbortController();
  return {
    completion: runHttpCall(ports, {
      method: 'GET', origin: 'https://api.example.com', path: '/dns', request: { timeoutMs }, key: 'job',
    }, { signal: controller.signal }),
    cancel: async () => { controller.abort(); },
  };
}

function startHost(http: HttpPorts, timeoutMs: number): Running {
  const ports: KernelHostPorts = {
    persistence: new InMemoryPersistence(),
    callService: async () => null,
    programEffect: () => undefined,
    inFlightCalls: new InFlightCalls(),
    servicePorts: () => { throw new Error('unused'); },
    deliverLive: () => undefined,
    deferCallOutcome: () => undefined,
    http,
  };
  return {
    completion: answerRequest(ports, {
      kind: 'http', key: 'job', request: {
        method: 'GET', url: 'https://api.example.com/dns', headers: [], body: { kind: 'empty' }, timeoutMs,
      },
    }, { orbital: 'Main' }),
    cancel: async () => { await answerRequest(ports, { kind: 'cancelCall', key: 'job' }, { orbital: 'Main' }); },
  };
}

function lookup() {
  let release: ((host: ResolvedHost) => void) | undefined;
  const pending = new Promise<ResolvedHost>((resolve) => { release = resolve; });
  return {
    pending,
    release() {
      if (release === undefined) throw new Error('lookup fixture was not initialized');
      release({ literal: false, addresses: ['93.184.216.34'] });
    },
  };
}

function observe(running: Running): object[] {
  const results: object[] = [];
  void running.completion.then(
    (result) => { results.push(result); },
    (error: Error) => { results.push({ rejected: error.message }); },
  );
  return results;
}

describe.each([
  { route: 'driver adapter', start: startDriver },
  { route: 'kernel host', start: startHost },
])('HTTP DNS deadline: $route', ({ route, start }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => { controller.abort(new DOMException('deadline elapsed', 'TimeoutError')); }, ms);
      return controller.signal;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function failure(kind: 'failed' | 'timeout' | 'refused', message?: string): object {
    return route === 'kernel host'
      ? { kind: 'http', result: { error: { kind: kind === 'timeout' ? 'timedOut' : kind, ...(message !== undefined ? { message } : {}) } } }
      : { error: { kind, ...(message !== undefined ? { error: message } : {}), key: 'job' } };
  }

  it('reports a rejected DNS lookup as the declared failed outcome', async () => {
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const running = start({ ...app.ports, resolve: async () => { throw new Error('DNS unavailable'); } }, 100);
    const results = observe(running);
    await vi.advanceTimersByTimeAsync(0);
    expect([...results]).toMatchObject([failure('failed', 'DNS unavailable')]);
    expect(app.urls).toEqual([]);
  });

  it('times out while DNS is pending and never fetches after its late release', async () => {
    const dns = lookup();
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const running = start({ ...app.ports, resolve: () => dns.pending }, 100);
    const results = observe(running);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect([...results]).toMatchObject([failure('timeout')]);
      expect(app.urls).toEqual([]);
      dns.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(app.urls).toEqual([]);
      expect(results).toHaveLength(1);
    } finally {
      dns.release();
      await vi.runAllTimersAsync();
    }
  });

  it('gives fetch only the deadline remaining after DNS', async () => {
    const dns = lookup();
    const signals: AbortSignal[] = [];
    const app = fakeApp({ fetch: hangingFetch(signals) });
    const running = start({ ...app.ports, resolve: () => dns.pending }, 100);
    const results = observe(running);
    try {
      await vi.advanceTimersByTimeAsync(40);
      dns.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(app.urls).toEqual(['https://api.example.com/dns']);
      expect(signals).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(59);
      expect(results).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect([...results]).toMatchObject([failure('timeout')]);
      expect(signals[0]?.aborted).toBe(true);
      expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
      expect(AbortSignal.timeout).toHaveBeenCalledWith(100);
    } finally {
      dns.release();
      await vi.runAllTimersAsync();
    }
  });

  it('cancels promptly during pending DNS and sends nothing after late release', async () => {
    const dns = lookup();
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const running = start({ ...app.ports, resolve: () => dns.pending }, 100);
    const results = observe(running);
    try {
      await vi.advanceTimersByTimeAsync(20);
      await running.cancel();
      await vi.advanceTimersByTimeAsync(0);
      expect([...results]).toMatchObject([route === 'kernel host'
        ? { kind: 'serviceCancelled' }
        : { rejected: expect.any(String) }]);
      dns.release();
      await vi.advanceTimersByTimeAsync(200);
      expect(app.urls).toEqual([]);
      expect(results).toHaveLength(1);
    } finally {
      dns.release();
      await vi.runAllTimersAsync();
    }
  });

  it('control: ordinary public DNS sends once and returns its reply', async () => {
    const app = fakeApp({ fetch: replying(200, 'ok') });
    const result = await start(app.ports, 100).completion;
    expect(result).toMatchObject(route === 'kernel host'
      ? { kind: 'http', result: { ok: { status: 200 } } }
      : { ok: { status: 200, key: 'job' } });
    expect(app.urls).toEqual(['https://api.example.com/dns']);
  });

  it('control: private DNS is refused before any fetch', async () => {
    const app = fakeApp({ fetch: replying(200, 'ok'), resolve: () => ({ literal: false, addresses: ['10.0.0.1'] }) });
    expect(await start(app.ports, 100).completion).toMatchObject(failure('refused'));
    expect(app.urls).toEqual([]);
  });
});
