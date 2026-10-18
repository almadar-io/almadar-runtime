// A client-site `http` (no `auth`) runs through the SAME kernel driver and exchange as the server's, over the
// browser's `fetch`: a browser cannot resolve a name, so there is no address check and no pinning — the
// program's egress list (checked by the driver) and the browser's own CORS bound the call.
import { describe, it, expect } from 'vitest';
import type { JsonObject, OrbitalDefinition } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { runsBrowserDataEffect, runsServerEffect } from '../src/traits/trait-index';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';
import { createBrowserHttpPorts, runHttpCall, type HttpCall, type HttpPorts } from '../src/kernel/http-exchange.js';
import { fakeHttpKernel } from './helpers/fake-http-kernel.js';
import { KERNEL_DIR, testKernel } from './helpers/kernel-module.js';
import { localStorePersistence, openLocalKernel } from '../src/evaluation/local-store-transport.js';

const ORIGIN = 'https://api.example.com';
const call: HttpCall = { method: 'GET', origin: ORIGIN, path: '/search', request: { query: { q: 'a' } } };

function ports(browserFetch: (url: string, init: RequestInit) => Promise<Response>, egress = [ORIGIN]) {
  return createBrowserHttpPorts({ kernel: async () => fakeHttpKernel, egress, fetch: browserFetch });
}

describe.skipIf(KERNEL_DIR === undefined)('browser http ports', () => {
  it('send a keyless call through the driver with the browser fetch, without resolving the host', async () => {
    const seen: Array<{ url: string; redirect: string | undefined }> = [];
    const p = ports(async (url, init) => {
      seen.push({ url, redirect: init.redirect });
      return new Response('ok', { status: 200 });
    });
    expect(p.resolve).toBeNull();
    expect(await runHttpCall(p, call)).toMatchObject({ ok: { status: 200, body: 'ok', key: null } });
    expect(seen).toEqual([{ url: `${ORIGIN}/search`, redirect: 'manual' }]);
  });

  it('control: an origin outside egress is refused by the driver before any fetch', async () => {
    let sends = 0;
    const p = ports(async () => { sends += 1; return new Response('x'); });
    expect(await runHttpCall(p, { ...call, origin: 'https://evil.example.com' })).toMatchObject({ error: { kind: 'refused' } });
    expect(sends).toBe(0);
  });

  it('a private literal address is not checked in a browser: egress alone admits it', async () => {
    const p = ports(async () => new Response('local'), ['http://127.0.0.1:8080']);
    expect(await runHttpCall(p, { ...call, origin: 'http://127.0.0.1:8080' })).toMatchObject({ ok: { body: 'local' } });
  });

  it('a transport error is an outcome of kind failed', async () => {
    const p = ports(async () => { throw new TypeError('Failed to fetch'); });
    expect(await runHttpCall(p, call)).toEqual({ error: { error: 'Failed to fetch', kind: 'failed', key: null, credential: null, phase: null, grantStatus: null, grantBody: null, code: null, reason: null } });
  });

  it('hold no credential: a credential ask fails the call instead of reaching a store', async () => {
    let sends = 0;
    const p = ports(async () => { sends += 1; return new Response('x'); });
    const keyed: HttpCall = { ...call, request: { auth: { scheme: 'bearer', credential: 'KEY' } } };
    expect(await runHttpCall(p, keyed)).toMatchObject({ error: { kind: 'unconfigured', credential: 'KEY' } });
    expect(sends).toBe(0);
  });
});

describe.skipIf(KERNEL_DIR === undefined)('a browser store runs a leg with a keyless http', () => {
  const orbital = (request: JsonObject): OrbitalDefinition => ({
    name: 'Feed',
    entity: { name: 'Row', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{
      name: 'Loader', linkedEntity: 'Row', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'LOAD', name: 'LOAD' }, { key: 'GOT', name: 'GOT' }, { key: 'FAILED', name: 'FAILED' }],
        transitions: [
          { from: 'idle', to: 'idle', event: 'LOAD', effects: [['http', 'GET', ORIGIN, '/x', request, { emit: { success: 'GOT', failure: 'FAILED' } }]] },
          { from: 'idle', to: 'idle', event: 'GOT', effects: [] },
          { from: 'idle', to: 'idle', event: 'FAILED', effects: [] },
        ],
      },
    }],
    pages: [],
  });

  async function load(def: OrbitalDefinition, httpPorts: HttpPorts | undefined) {
    const transport = createLocalStoreTransport({ kernelEngine: testKernel().then((kernel) => openLocalKernel({ kernel, schema: { name: 'http', orbitals: [def], egress: [ORIGIN] }, persistence: localStorePersistence({ name: 'http', orbitals: [def], egress: [ORIGIN] }, new InMemoryPersistence()), ...(httpPorts !== undefined ? { http: httpPorts } : {}) })) });
    const response = await transport.send('Feed', { event: 'LOAD', targetTrait: 'Loader' });
    return response.emittedEvents.map((e) => ({ event: e.event, payload: e.payload }));
  }

  it('sends the call through the supplied browser ports and routes the reply to success', async () => {
    const urls: string[] = [];
    const events = await load(orbital({ query: { q: 'a' } }), ports(async (url) => { urls.push(url); return new Response('ok', { status: 201 }); }));
    expect(urls).toEqual([`${ORIGIN}/x?q=a`]);
    expect(events).toEqual([{ event: 'GOT', payload: expect.objectContaining({ status: 201, body: 'ok' }) }]);
  });

  it('control: a host given no ports fails the call as unavailable, never reaching the network', async () => {
    const events = await load(orbital({}), undefined);
    expect(events.map((e) => e.event)).toEqual(['FAILED']);
    expect(JSON.stringify(events[0]?.payload)).toContain('HTTP_KERNEL_UNAVAILABLE');
  });
});

describe.skipIf(KERNEL_DIR === undefined)('the run-site predicates over http (twin of orbital-core runs_browser_data_effect / sexpr_runs_server_effect)', () => {
  const keyless = ['http', 'GET', ORIGIN, '/x', { query: { q: 'a' } }];
  const keyed = ['http', 'GET', ORIGIN, '/x', { auth: { scheme: 'bearer', credential: '@config.key' } }];

  it('a keyless http is a browser leg and not server work', () => {
    expect(runsBrowserDataEffect(keyless, () => false)).toBe(true);
    expect(runsServerEffect(keyless)).toBe(false);
  });

  it('control: an http with auth is server work and not a browser leg', () => {
    expect(runsBrowserDataEffect(keyed, () => false)).toBe(false);
    expect(runsServerEffect(keyed)).toBe(true);
  });

  it('control: an http whose request is a binding is server work', () => {
    expect(runsServerEffect(['http', 'GET', ORIGIN, '/x', '@payload.request'])).toBe(true);
  });
});
