// `browser/beacon` on the JS host: the kernel driver builds and egress-checks the request, then the host's beacon
// port takes it (queue first, one keepalive cors fetch otherwise) and answers a status only; cancelling stops the
// wait without aborting what the browser already has.
import { describe, expect, it } from 'vitest';
import type { EventPayload } from '@almadar/core';
import type { BeaconDeliveryPorts, BeaconFetchInit } from '@almadar/analytics';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { createBrowserHttpPorts, runHttpCall, type HttpCall, type HttpPorts } from '../src/kernel/http-exchange.js';
import { ServerLegCollector } from '../src/effects/server-leg.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { fakeHttpKernel } from './helpers/fake-http-kernel.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';

const COLLECTOR = 'https://collector.example.com';
const URL_ = `${COLLECTOR}/api/event?v=1`;
const call = (over: Partial<HttpCall> = {}): HttpCall => ({ method: 'POST', origin: URL_, path: '', request: { text: '{"n":"pageview"}' }, delivery: 'beacon', ...over });

interface Rig {
  queued: Array<{ url: string; text: string }>;
  fetched: Array<{ url: string; init: BeaconFetchInit }>;
  ports: HttpPorts;
}

function rig(queue: 'accept' | 'decline' | 'throw' | 'absent', fetching: number | 'reject' | 'hang', egress = [COLLECTOR]): Rig {
  const queued: Rig['queued'] = [];
  const fetched: Rig['fetched'] = [];
  const beacon: BeaconDeliveryPorts = {
    ...(queue === 'absent' ? {} : {
      queue(url: string, text: string): boolean {
        if (queue === 'throw') throw new Error('blocked');
        queued.push({ url, text });
        return queue === 'accept';
      },
    }),
    fetch(url: string, init: BeaconFetchInit): Promise<{ status: number }> {
      fetched.push({ url, init });
      if (fetching === 'hang') return new Promise(() => undefined);
      return fetching === 'reject' ? Promise.reject(new Error('offline')) : Promise.resolve({ status: fetching });
    },
  };
  const ports = { ...createBrowserHttpPorts({ kernel: async () => fakeHttpKernel, egress }), beacon };
  return { queued, fetched, ports };
}

describe('browser/beacon through the http driver', () => {
  it('an accepted queue is sent via queue and nothing is fetched', async () => {
    const r = rig('accept', 200);
    expect(await runHttpCall(r.ports, call({ key: 'k' }))).toEqual({ ok: { sent: true, via: 'queue', status: null, key: 'k' } });
    expect(r.queued).toEqual([{ url: URL_, text: '{"n":"pageview"}' }]);
    expect(r.fetched).toEqual([]);
  });

  it('a declined, throwing or absent queue falls back to exactly one keepalive cors fetch of the same body', async () => {
    for (const queue of ['decline', 'throw', 'absent'] as const) {
      const r = rig(queue, 204);
      expect(await runHttpCall(r.ports, call())).toEqual({ ok: { sent: true, via: 'fetch', status: 204, key: null } });
      expect(r.fetched).toEqual([{ url: URL_, init: { method: 'POST', body: '{"n":"pageview"}', keepalive: true, mode: 'cors', headers: { 'Content-Type': 'text/plain' } } }]);
    }
  });

  it('only a 2xx fetch is sent, and a network throw is sent:false via fetch, never a failure', async () => {
    for (const [status, sent] of [[200, true], [299, true], [300, false], [400, false], [500, false]] as const) {
      expect(await runHttpCall(rig('decline', status).ports, call())).toEqual({ ok: { sent, via: 'fetch', status, key: null } });
    }
    expect(await runHttpCall(rig('decline', 'reject').ports, call())).toEqual({ ok: { sent: false, via: 'fetch', status: null, key: null } });
  });

  it('an undeclared origin and a relative URL are refused before the queue or the fetch', async () => {
    for (const origin of ['https://elsewhere.example.com/e', '/api/event']) {
      const r = rig('accept', 200);
      expect(await runHttpCall(r.ports, call({ origin }))).toMatchObject({ error: { kind: 'refused' } });
      expect(r.queued).toEqual([]);
      expect(r.fetched).toEqual([]);
    }
  });

  it('a host with no beacon port fails unavailable and touches neither queue nor fetch', async () => {
    const withoutBeacon = createBrowserHttpPorts({ kernel: async () => fakeHttpKernel, egress: [COLLECTOR] });
    const bare: HttpPorts = { kernel: withoutBeacon.kernel, random: withoutBeacon.random, egress: withoutBeacon.egress, secrets: withoutBeacon.secrets, fetch: withoutBeacon.fetch, resolve: null };
    expect(await runHttpCall(bare, call({ key: 'k' }))).toMatchObject({ error: { kind: 'unavailable', key: 'k' } });
  });

  it('cancelling before the call touches nothing', async () => {
    const r = rig('accept', 200);
    const controller = new AbortController();
    controller.abort();
    await expect(runHttpCall(r.ports, call(), { signal: controller.signal })).rejects.toThrow();
    expect(r.queued).toEqual([]);
    expect(r.fetched).toEqual([]);
  });

  it('cancelling while the fetch waits rejects promptly without aborting the fetch', async () => {
    const r = rig('decline', 'hang');
    const controller = new AbortController();
    const running = runHttpCall(r.ports, call(), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(r.fetched).toHaveLength(1);
    expect(r.fetched[0]?.init).not.toHaveProperty('signal');
  });
});

describe('the executor runs browser/beacon', () => {
  const bindings: BindingContext = { entity: { id: 'row-1', body: 'hello' }, payload: {} };
  const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };

  async function run(r: Rig, effect: Array<string | object>, inFlightCalls = new InFlightCalls()) {
    const emitted: Array<{ event: string; payload: EventPayload | undefined }> = [];
    const handlers = stubEffectHandlers({ emit: (event: string, payload?: EventPayload) => { emitted.push({ event, payload }); } });
    const executor = new EffectExecutor({ handlers, bindings, context, environment: 'client', delegate: new ServerLegCollector(), http: r.ports, inFlightCalls });
    await executor.execute(effect);
    return emitted;
  }
  const routes = { emit: { success: 'DONE', failure: 'FAILED', cancelled: 'CANCELLED' } };

  it('emits the flat payload with the key from the request object', async () => {
    const r = rig('accept', 200);
    expect(await run(r, ['browser/beacon', URL_, { text: 'hello', key: 'row-1' }, routes])).toEqual([
      { event: 'DONE', payload: { sent: true, via: 'queue', status: null, key: 'row-1' } },
    ]);
    expect(r.queued).toEqual([{ url: URL_, text: 'hello' }]);
  });

  it('control: a key in the options works the same and no key echoes null', async () => {
    expect(await run(rig('accept', 200), ['browser/beacon', URL_, { text: 'x' }, { ...routes, key: 'opt' }])).toEqual([
      { event: 'DONE', payload: { sent: true, via: 'queue', status: null, key: 'opt' } },
    ]);
    expect(await run(rig('accept', 200), ['browser/beacon', URL_, { text: 'x' }, routes])).toEqual([
      { event: 'DONE', payload: { sent: true, via: 'queue', status: null, key: null } },
    ]);
  });

  it('cancel-call while the fetch waits fires the cancelled route and suppresses any late completion', async () => {
    const r = rig('decline', 'hang');
    const calls = new InFlightCalls();
    const running = run(r, ['browser/beacon', URL_, { text: 'x', key: 'k1' }, routes], calls);
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls.cancel('k1');
    expect(await running).toEqual([{ event: 'CANCELLED', payload: { key: 'k1' } }]);
  });

  it('a refusal fires the failure route with the closed failure payload', async () => {
    const emitted = await run(rig('accept', 200), ['browser/beacon', 'https://elsewhere.example.com/e', { text: 'x' }, routes]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe('FAILED');
    expect(emitted[0]?.payload).toMatchObject({ kind: 'refused', key: null });
  });

  it('a request carrying anything but text is refused', async () => {
    const emitted = await run(rig('accept', 200), ['browser/beacon', URL_, { text: 'x', json: {} }, routes]);
    expect(emitted[0]?.event).toBe('FAILED');
  });
});

describe('the kernel host answers httpBeacon and pageFacts', () => {
  const host = (http?: HttpPorts) => {
    const ports: KernelHostPorts = {
      persistence: new InMemoryPersistence(),
      callService: async () => null,
      programEffect: () => undefined,
      inFlightCalls: new InFlightCalls(),
      servicePorts: () => { throw new Error('unused'); },
      deliverLive: () => undefined,
      deferCallOutcome: () => undefined,
      ...(http !== undefined ? { http } : {}),
    };
    return (request: Parameters<typeof answerRequest>[1]) => answerRequest(ports, request, { orbital: 'Main' });
  };
  const built = { method: 'POST', url: URL_, headers: [['Content-Type', 'text/plain']] as Array<[string, string]>, body: { kind: 'text' as const, text: 'hello' } };

  it('a queued beacon answers via queue; a fetched one its status; a thrown fetch an error', async () => {
    expect(await host(rig('accept', 200).ports)({ kind: 'httpBeacon', request: built })).toEqual({ kind: 'httpBeacon', result: { ok: { via: 'queue' } } });
    expect(await host(rig('decline', 503).ports)({ kind: 'httpBeacon', request: built })).toEqual({ kind: 'httpBeacon', result: { ok: { via: 'fetch', status: 503 } } });
    expect(await host(rig('decline', 'reject').ports)({ kind: 'httpBeacon', request: built })).toEqual({ kind: 'httpBeacon', result: { error: { kind: 'failed', message: 'the beacon fetch failed' } } });
  });

  it('control: a host with no ports answers unavailable, never a send', async () => {
    const answer = await host()({ kind: 'httpBeacon', request: built });
    expect(answer).toMatchObject({ kind: 'httpBeacon', result: { ok: { via: 'unavailable' } } });
  });

  it('page facts answer available:false with the defaults where there is no page', async () => {
    expect(await host()({ kind: 'pageFacts', fields: ['hostname'] })).toEqual({
      kind: 'pageFacts',
      result: { ok: { available: false, hostname: '', referrer: '', screenWidth: null } },
    });
  });
});
