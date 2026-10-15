// The kernel host's answers to the `http` family: the request the kernel built is sent as asked, a keyed one is
// aborted by cancel-call, secrets come from the host store. The built request is the kernel's; only transport is tested here.
import { describe, it, expect } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EventPayload } from '@almadar/core';
import { answerRequest, type KernelHostPorts } from '../src/kernel/host.js';
import { InFlightCalls } from '../src/effects/in-flight-calls.js';
import type { HttpRequestWire, IoRequestWire } from '../src/kernel/wire.js';
import { fakeApp, hangingFetch, replying, type FakeApp } from './helpers/fake-http-kernel.js';

const wireRequest = (extra: Partial<HttpRequestWire> = {}): HttpRequestWire => ({
  method: 'GET', url: 'https://api.example.com/search', headers: [['Accept', 'application/json']], body: { kind: 'empty' }, ...extra,
});

function host(app: FakeApp | undefined) {
  const live: Array<{ event: string; payload: EventPayload }> = [];
  const registry = new InFlightCalls();
  const ports: KernelHostPorts = {
    persistence: new InMemoryPersistence(),
    callService: async () => null,
    programEffect: () => undefined,
    inFlightCalls: registry,
    servicePorts: () => { throw new Error('unused'); },
    deliverLive: (site, payload) => { live.push({ event: site.event, payload }); },
    deferCallOutcome: () => undefined,
    ...(app !== undefined ? { http: app.ports } : {}),
  };
  const answer = (request: IoRequestWire) => answerRequest(ports, request, { orbital: 'Main' });
  return { live, answer };
}

describe('kernel host http', () => {
  it('answers a request with the reply, headers as pairs and a text body', async () => {
    const app = fakeApp({ fetch: replying(200, 'hello', [['X-A', '1']]) });
    const answer = await host(app).answer({ kind: 'http', request: wireRequest() });
    expect(answer).toMatchObject({ kind: 'http', result: { ok: { status: 200, body: { kind: 'text', text: 'hello' } } } });
    expect(app.urls).toEqual(['https://api.example.com/search']);
  });

  it('a non-2xx status is a reply, not an error', async () => {
    const answer = await host(fakeApp({ fetch: replying(503, 'down') })).answer({ kind: 'http', request: wireRequest() });
    expect(answer).toMatchObject({ kind: 'http', result: { ok: { status: 503 } } });
  });

  it('a request past timeoutMs answers timedOut', async () => {
    const answer = await host(fakeApp({ fetch: hangingFetch() })).answer({ kind: 'http', request: wireRequest({ timeoutMs: 20 }) });
    expect(answer).toEqual({ kind: 'http', result: { error: { kind: 'timedOut' } } });
  });

  it('a transport error answers failed with its message', async () => {
    const answer = await host(fakeApp({ fetch: () => { throw new Error('reset'); } })).answer({ kind: 'http', request: wireRequest() });
    expect(answer).toEqual({ kind: 'http', result: { error: { kind: 'failed', message: 'reset' } } });
  });

  it('refuses a private address without sending, and sends to a listed IP literal', async () => {
    const closed = fakeApp({ fetch: replying(200, 'x'), resolve: () => ({ literal: false, addresses: ['169.254.169.254'] }) });
    const refused = await host(closed).answer({ kind: 'http', request: wireRequest() });
    expect(closed.urls).toEqual([]);
    expect(refused).toMatchObject({ kind: 'http', result: { error: { kind: 'refused', message: expect.stringContaining('not a public address') } } });

    const open = fakeApp({ egress: ['http://127.0.0.1:9000'], fetch: replying(200, 'x'), resolve: () => ({ literal: true, addresses: ['127.0.0.1'] }) });
    const sent = await host(open).answer({ kind: 'http', request: wireRequest({ url: 'http://127.0.0.1:9000/x' }) });
    expect(sent).toMatchObject({ result: { ok: { status: 200 } } });
  });

  it('does not follow a redirect: the 3xx is the reply', async () => {
    const answer = await host(fakeApp({ fetch: (_url, init) => (init.redirect === 'manual' ? new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } }) : new Response('followed')) }))
      .answer({ kind: 'http', request: wireRequest() });
    expect(answer).toMatchObject({ result: { ok: { status: 302 } } });
  });

  it('cancel-call aborts a keyed request, which answers cancelled', async () => {
    const seen: AbortSignal[] = [];
    const h = host(fakeApp({ fetch: hangingFetch(seen) }));
    const pending = h.answer({ kind: 'http', request: wireRequest(), key: 'job' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(await h.answer({ kind: 'cancelCall', key: 'job' })).toEqual({ kind: 'cancelled', result: { ok: null } });
    expect(await pending).toEqual({ kind: 'serviceCancelled' });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('control: a keyed request that is not cancelled answers its reply', async () => {
    const answer = await host(fakeApp({ fetch: replying(200, 'x') })).answer({ kind: 'http', request: wireRequest(), key: 'job' });
    expect(answer).toMatchObject({ kind: 'http', result: { ok: { status: 200 } } });
  });

  it('streams framed events to the site live route and answers the final reply with an empty body', async () => {
    const h = host(fakeApp({ fetch: replying(200, 'data: a\n\ndata: b\n\n') }));
    const answer = await h.answer({
      kind: 'httpStream', request: wireRequest(), framing: 'sse',
      site: { trait: 'T', followOn: false, emit: { onMessage: 'CHUNK' } },
    });
    expect(h.live).toEqual([
      { event: 'CHUNK', payload: { data: 'a', event: null, id: null, key: null } },
      { event: 'CHUNK', payload: { data: 'b', event: null, id: null, key: null } },
    ]);
    expect(answer).toMatchObject({ kind: 'http', result: { ok: { status: 200, body: { kind: 'empty' } } } });
  });

  it('frames a keyed stream with the ask key', async () => {
    const h = host(fakeApp({ fetch: replying(200, 'data: a\n\n') }));
    await h.answer({
      kind: 'httpStream', request: wireRequest(), framing: 'sse', key: 'k7',
      site: { trait: 'T', followOn: false, emit: { onMessage: 'CHUNK' } },
    });
    expect(h.live).toEqual([{ event: 'CHUNK', payload: { data: 'a', event: null, id: null, key: 'k7' } }]);
  });

  it('answers secret from the host store: a held name its value, an unknown name null', async () => {
    const app = fakeApp({ fetch: replying(200, 'x'), secrets: { KEY: 'v' } });
    const h = host(app);
    expect(await h.answer({ kind: 'secret', name: 'KEY' })).toEqual({ kind: 'secret', result: { ok: 'v' } });
    expect(await h.answer({ kind: 'secret', name: 'NOPE' })).toEqual({ kind: 'secret', result: { ok: null } });
  });

  it('secretSet stores a minted value, and a zero ttl forgets it', async () => {
    const app = fakeApp({ fetch: replying(200, 'x') });
    const h = host(app);
    expect(await h.answer({ kind: 'secretSet', name: 'oauth2:t|ID', value: 'tok', ttlMs: 5000 })).toEqual({ kind: 'secretSet', result: { ok: null } });
    expect(app.secrets.held.get('oauth2:t|ID')).toBe('tok');
    await h.answer({ kind: 'secretSet', name: 'oauth2:t|ID', value: '', ttlMs: 0 });
    expect(app.secrets.held.has('oauth2:t|ID')).toBe(false);
  });

  it('without http ports every ask fails with the coded unavailable error', async () => {
    const h = host(undefined);
    expect(await h.answer({ kind: 'http', request: wireRequest() })).toMatchObject({ result: { error: { kind: 'failed', message: expect.stringContaining('HTTP_KERNEL_UNAVAILABLE') } } });
    expect(await h.answer({ kind: 'secret', name: 'K' })).toMatchObject({ result: { error: expect.stringContaining('HTTP_KERNEL_UNAVAILABLE') } });
  });
});
