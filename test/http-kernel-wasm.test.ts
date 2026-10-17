// The real `@almadar/kernel` driver behind the host's transport: skipped without a built kernel (ALMADAR_KERNEL_DIR).
// The driver's decisions (credentials, OAuth, pagination, framing) are orbital-core's; this proves the host answers its asks.
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { isJsonObject, type HttpStreamEvent, type JsonObject, type JsonValue } from '@almadar/core';
import { createHttpPorts, createHttpSecrets, runHttpCall, type HttpCall, type PinnedResponse } from '../src/kernel/http-exchange.js';
import { loadHttpKernel } from '../src/kernel/load-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';
import type { FakeFetch } from './helpers/fake-http-kernel.js';

describe.skipIf(KERNEL_DIR === undefined)('http effect on the real kernel driver', () => {
  const ports = async (secrets: Record<string, string>, fetchImpl: FakeFetch) => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    const kernel = await loadHttpKernel(KERNEL_DIR);
    const store = createHttpSecrets();
    for (const [name, value] of Object.entries(secrets)) await store.set(name, value, 60_000);
    return createHttpPorts({
      kernel: async () => kernel,
      egress: ['https://api.example.com'],
      secrets: store,
      fetch: async (url, init, address) => fetchImpl(url.href, init, address),
      resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
    });
  };
  const call: HttpCall = { method: 'GET', origin: 'https://api.example.com', path: '/search', request: { query: { q: 'a b' }, auth: { scheme: 'bearer', credential: 'KEY' } } };

  it('builds the encoded URL and bearer header, and shapes the reply', async () => {
    const sent: Array<{ url: string; auth: string | undefined }> = [];
    const p = await ports({ KEY: 'tok' }, (url, init) => {
      sent.push({ url, auth: init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] });
      return new Response('ok', { status: 404 });
    });
    expect(await runHttpCall(p, call)).toMatchObject({ ok: { status: 404, body: 'ok' } });
    expect(sent).toEqual([{ url: 'https://api.example.com/search?q=a%20b', auth: 'Bearer tok' }]);
  });

  it('waits the request delayMs before the first send, and a cancel during the wait sends nothing', async () => {
    const sent: number[] = [];
    const p = await ports({ KEY: 'tok' }, () => { sent.push(Date.now()); return new Response('ok'); });
    const delayed: HttpCall = { ...call, request: { ...call.request, delayMs: 150 } };
    const started = Date.now();
    expect(await runHttpCall(p, delayed)).toMatchObject({ ok: { status: 200 } });
    expect(sent[0] - started).toBeGreaterThanOrEqual(140);
    // Control: the same call without delayMs sends at once.
    sent.length = 0;
    const immediate = Date.now();
    await runHttpCall(p, call);
    expect(sent[0] - immediate).toBeLessThan(100);
    // Cancel while the delay runs: the abort rejects the call and nothing reaches the network.
    sent.length = 0;
    const controller = new AbortController();
    const cancelled = runHttpCall(p, { ...delayed, request: { ...delayed.request, delayMs: 5000 } }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(cancelled).rejects.toBeDefined();
    expect(sent).toEqual([]);
  });

  it('refuses a missing credential and an origin outside egress without sending', async () => {
    let sends = 0;
    const p = await ports({}, () => { sends += 1; return new Response('x'); });
    expect(await runHttpCall(p, call)).toMatchObject({ error: { kind: 'unconfigured', credential: 'KEY', key: null } });
    expect(await runHttpCall(p, { ...call, request: { auth: { scheme: 'bearer', credential: '' } } })).toMatchObject({ error: { kind: 'unconfigured', credential: '', key: null } });
    expect(await runHttpCall(p, { ...call, origin: 'https://evil.example.com' })).toMatchObject({ error: { kind: 'refused', credential: null, key: null } });
    expect(sends).toBe(0);
  });

  it('keeps JWT credentials and early-refresh token caches isolated per principal', async () => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    const kernel = await loadHttpKernel(KERNEL_DIR);
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    let now = 1_000_000;
    const secrets = createHttpSecrets(() => now);
    for (const principal of ['u1', 'u2']) {
      await secrets.set('ACCOUNT', JSON.stringify({ client_email: `${principal}@example.com`, private_key: privateKey }), 10_000_000, principal);
    }
    const issuers: string[] = [];
    const bearers: string[] = [];
    const tokenUrl = 'https://auth.example.com/token';
    const p = createHttpPorts({
      kernel: async () => kernel,
      egress: ['https://api.example.com', 'https://auth.example.com'],
      secrets,
      resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
      fetch: async (url, init) => {
        if (url.href === tokenUrl) {
          expect(init.body).toBeDefined();
          const form = new URLSearchParams(new TextDecoder().decode(init.body));
          expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
          const assertion = form.get('assertion');
          if (assertion === null) throw new Error('assertion is missing');
          const payloadPart = assertion.split('.')[1];
          if (payloadPart === undefined) throw new Error('assertion payload is missing');
          const payload: JsonValue = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
          if (!isJsonObject(payload) || typeof payload.iss !== 'string') throw new Error('assertion issuer is missing');
          issuers.push(payload.iss);
          return new Response(JSON.stringify({ access_token: `T${issuers.length}`, expires_in: 3600 }), { status: 200 });
        }
        const bearer = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        if (bearer === undefined) throw new Error('authorization header is missing');
        bearers.push(bearer);
        return new Response('ok', { status: 200 });
      },
    });
    const jwt: HttpCall = { ...call, key: 'job', request: { auth: {
      scheme: 'jwt-bearer', key: { credential: 'ACCOUNT', scope: 'user' }, alg: 'ES256',
      claims: { scope: 'calendar', aud: tokenUrl, iat: 1000, exp: 4600 }, tokenUrl,
      expiresMarginMs: 300000, storeAs: { name: 'google:token', scope: 'user' },
    } } };
    for (const principal of ['u1', 'u1', 'u2']) {
      expect(await runHttpCall(p, jwt, { principal })).toMatchObject({ ok: { body: 'ok', key: 'job' } });
    }
    expect(issuers).toEqual(['u1@example.com', 'u2@example.com']);
    expect(bearers).toEqual(['Bearer T1', 'Bearer T1', 'Bearer T2']);
    now += 3_300_000;
    expect(await runHttpCall(p, jwt, { principal: 'u1' })).toMatchObject({ ok: { body: 'ok' } });
    expect(issuers).toEqual(['u1@example.com', 'u2@example.com', 'u1@example.com']);
    expect(bearers).toEqual(['Bearer T1', 'Bearer T1', 'Bearer T2', 'Bearer T3']);
    expect(await runHttpCall(p, jwt)).toMatchObject({ error: { kind: 'failed', credential: null, key: 'job' } });
    expect(bearers).toHaveLength(4);
  });

  it('does not reuse a JWT token for a delimiter-colliding signing slot', async () => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    const kernel = await loadHttpKernel(KERNEL_DIR);
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const secrets = createHttpSecrets(() => 1000);
    await secrets.set('B', JSON.stringify({ client_email: 'first@example.com', private_key: privateKey }), 60_000);
    const bearers: string[] = [];
    let grants = 0;
    const p = createHttpPorts({
      kernel: async () => kernel,
      egress: ['https://api.example.com', 'https://auth.example.com'],
      secrets,
      resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
      fetch: async (url, init) => {
        if (url.origin === 'https://auth.example.com') {
          grants += 1;
          return new Response(JSON.stringify({ access_token: 'FIRST_ACCOUNT', expires_in: 3600 }));
        }
        const bearer = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        if (bearer === undefined) throw new Error('missing bearer');
        bearers.push(bearer);
        return new Response('ok');
      },
    });
    const jwt = (tokenUrl: string, key: string): HttpCall => ({ ...call, request: { auth: {
      scheme: 'jwt-bearer', key, alg: 'ES256', tokenUrl,
      claims: { scope: 'calendar', aud: 'https://auth.example.com/token', iat: 1000, exp: 4600 },
    } } });
    const first = jwt('https://auth.example.com/token|A', 'B');
    expect(await runHttpCall(p, first)).toMatchObject({ ok: { body: 'ok' } });
    expect(await runHttpCall(p, jwt('https://auth.example.com/token', 'A|B'))).toMatchObject({ error: { kind: 'unconfigured', credential: 'A|B' } });
    expect(await runHttpCall(p, first)).toMatchObject({ ok: { body: 'ok' } });
    expect(grants).toBe(1);
    expect(bearers).toEqual(['Bearer FIRST_ACCOUNT', 'Bearer FIRST_ACCOUNT']);
  });

  it('keeps JWT early-refresh policy in the default cache identity', async () => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    const kernel = await loadHttpKernel(KERNEL_DIR);
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    let now = 1_000_000;
    const secrets = createHttpSecrets(() => now);
    await secrets.set('MARGIN_ACCOUNT', JSON.stringify({ client_email: 'margin@example.com', private_key: privateKey }), 10_000_000);
    let grants = 0;
    const bearers: string[] = [];
    const p = createHttpPorts({
      kernel: async () => kernel,
      egress: ['https://api.example.com', 'https://auth.example.com'],
      secrets,
      resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
      fetch: async (url, init) => {
        if (url.origin === 'https://auth.example.com') {
          grants += 1;
          return new Response(JSON.stringify({ access_token: `M${grants}`, expires_in: 3600 }));
        }
        const bearer = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        if (bearer === undefined) throw new Error('missing bearer');
        bearers.push(bearer);
        return new Response('ok');
      },
    });
    const jwt = (expiresMarginMs: number): HttpCall => ({ ...call, request: { auth: {
      scheme: 'jwt-bearer', key: 'MARGIN_ACCOUNT', alg: 'ES256', tokenUrl: 'https://auth.example.com/margin',
      claims: { scope: 'calendar', aud: 'https://auth.example.com/margin', iat: 1000, exp: 4600 }, expiresMarginMs,
    } } });
    expect(await runHttpCall(p, jwt(0))).toMatchObject({ ok: { body: 'ok' } });
    expect(await runHttpCall(p, jwt(300000))).toMatchObject({ ok: { body: 'ok' } });
    expect(grants).toBe(2);
    now += 3_300_000;
    expect(await runHttpCall(p, jwt(300000))).toMatchObject({ ok: { body: 'ok' } });
    expect(await runHttpCall(p, jwt(0))).toMatchObject({ ok: { body: 'ok' } });
    expect(grants).toBe(3);
    expect(bearers).toEqual(['Bearer M1', 'Bearer M2', 'Bearer M3', 'Bearer M1']);
  });

  it('paginates by link header through the driver', async () => {
    const p = await ports({}, (url) => (url.endsWith('/p2')
      ? new Response('b', { status: 200 })
      : new Response('a', { status: 200, headers: { Link: '<https://api.example.com/p2>; rel="next"' } })));
    const paged: HttpCall = { ...call, request: { paginate: { style: 'link-header', collect: ['list', '@response.body'], max: 5 } } };
    expect(await runHttpCall(p, paged)).toMatchObject({ ok: { pages: 2, items: ['a', 'b'] } });
  });

  it('isolates default token-exchange caches across users and authored permissions', async () => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    const kernel = await loadHttpKernel(KERNEL_DIR);
    const secrets = createHttpSecrets(() => 1000);
    await secrets.set('REFRESH', 'first-refresh', 60000, 'u1');
    await secrets.set('REFRESH', 'second-refresh', 60000, 'u2');
    const grants: string[] = [];
    const bearers: string[] = [];
    const p = createHttpPorts({
      kernel: async () => kernel,
      egress: ['https://api.example.com', 'https://auth.example.com'],
      secrets,
      resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
      fetch: async (url, init) => {
        if (url.origin === 'https://auth.example.com') {
          const form = new URLSearchParams(new TextDecoder().decode(init.body));
          grants.push(`${form.get('refresh_token')}:${form.get('scope')}`);
          return new Response(JSON.stringify({ access_token: `T${grants.length}`, expires_in: 3600 }));
        }
        const bearer = init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
        if (bearer === undefined) throw new Error('missing bearer');
        bearers.push(bearer);
        return new Response('ok');
      },
    });
    const exchange = (scope: string): HttpCall => ({ ...call, request: { auth: {
      scheme: 'token-exchange', tokenUrl: 'https://auth.example.com/token', grant: 'refresh_token',
      body: { form: { refresh_token: { credential: 'REFRESH', scope: 'user' }, scope } },
    } } });
    for (const [principal, permission] of [['u1', 'calendar'], ['u1', 'calendar'], ['u2', 'calendar'], ['u1', 'drive'], ['u2', 'drive'], ['u1', 'drive']]) {
      expect(await runHttpCall(p, exchange(permission), { principal })).toMatchObject({ ok: { body: 'ok' } });
    }
    expect(grants).toEqual(['first-refresh:calendar', 'second-refresh:calendar', 'first-refresh:drive', 'second-refresh:drive']);
    expect(bearers).toEqual(['Bearer T1', 'Bearer T1', 'Bearer T2', 'Bearer T3', 'Bearer T4', 'Bearer T3']);
  });

  describe('real-wasm concurrent call isolation', () => {
    const rendezvous = <T>() => {
      let release: ((value: T) => void) | undefined;
      const promise = new Promise<T>((resolve) => { release = resolve; });
      return {
        promise,
        release(value: T) {
          if (release === undefined) throw new Error('rendezvous resolver is missing');
          release(value);
        },
      };
    };

    it('isolates distinct keys and principals when grants and resources complete in reverse order', async () => {
      if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
      const kernel = await loadHttpKernel(KERNEL_DIR);
      const secrets = createHttpSecrets(() => 1000);
      await secrets.set('REFRESH', 'refresh-u1', 60000, 'u1');
      await secrets.set('REFRESH', 'refresh-u2', 60000, 'u2');
      const grantOne = rendezvous<Response>();
      const grantTwo = rendezvous<Response>();
      const grantOneRequested = rendezvous<void>();
      const grantTwoRequested = rendezvous<void>();
      const resourceOne = rendezvous<Response>();
      const resourceTwo = rendezvous<Response>();
      const resourceOneRequested = rendezvous<void>();
      const resourceTwoRequested = rendezvous<void>();
      const grants: string[] = [];
      const resources: Array<{ path: string; bearer: string | undefined }> = [];
      const completed: string[] = [];
      const abortOne = new AbortController();
      const abortTwo = new AbortController();
      const p = createHttpPorts({
        kernel: async () => kernel,
        egress: ['https://api.example.com', 'https://auth.example.com'],
        secrets,
        resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
        fetch: async (url, init) => {
          if (url.href === 'https://auth.example.com/token') {
            const form = new URLSearchParams(new TextDecoder().decode(init.body));
            expect(form.get('grant_type')).toBe('refresh_token');
            const refresh = form.get('refresh_token');
            if (refresh === 'refresh-u1') {
              grants.push(refresh);
              grantOneRequested.release();
              return grantOne.promise;
            }
            if (refresh === 'refresh-u2') {
              grants.push(refresh);
              grantTwoRequested.release();
              return grantTwo.promise;
            }
            throw new Error(`unexpected refresh credential: ${refresh}`);
          }
          resources.push({ path: url.pathname, bearer: init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] });
          if (url.pathname === '/u1') {
            resourceOneRequested.release();
            return resourceOne.promise;
          }
          if (url.pathname === '/u2') {
            resourceTwoRequested.release();
            return resourceTwo.promise;
          }
          throw new Error(`unexpected resource: ${url.href}`);
        },
      });
      const exchange = (principal: string): HttpCall => ({ ...call, key: `job-${principal}`, path: `/${principal}`, request: { auth: {
        scheme: 'token-exchange', tokenUrl: 'https://auth.example.com/token', grant: 'refresh_token',
        body: { form: { refresh_token: { credential: 'REFRESH', scope: 'user' } } },
        storeAs: { name: 'shared:access', scope: 'user' },
      } } });
      const one = runHttpCall(p, exchange('u1'), { principal: 'u1', signal: abortOne.signal }).then(
        (outcome) => { completed.push('u1'); return { kind: 'outcome' as const, outcome }; },
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      const two = runHttpCall(p, exchange('u2'), { principal: 'u2', signal: abortTwo.signal }).then(
        (outcome) => { completed.push('u2'); return { kind: 'outcome' as const, outcome }; },
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        watchdogTimer = setTimeout(() => { reject(new Error('concurrent HTTP rendezvous timed out')); }, 2000);
      });
      try {
        await Promise.race([Promise.all([grantOneRequested.promise, grantTwoRequested.promise]), watchdog]);
        expect([...grants].sort()).toEqual(['refresh-u1', 'refresh-u2']);
        expect(resources).toEqual([]);
        expect(completed).toEqual([]);
        grantTwo.release(new Response(JSON.stringify({ access_token: 'TOKEN-u2', expires_in: 3600 })));
        await Promise.race([resourceTwoRequested.promise, watchdog]);
        expect(resources).toEqual([{ path: '/u2', bearer: 'Bearer TOKEN-u2' }]);
        expect(await secrets.get('shared:access', 'u2')).toBe('TOKEN-u2');
        expect(await secrets.get('shared:access', 'u1')).toBeUndefined();
        grantOne.release(new Response(JSON.stringify({ access_token: 'TOKEN-u1', expires_in: 3600 })));
        await Promise.race([resourceOneRequested.promise, watchdog]);
        expect(resources).toEqual([{ path: '/u2', bearer: 'Bearer TOKEN-u2' }, { path: '/u1', bearer: 'Bearer TOKEN-u1' }]);
        expect(completed).toEqual([]);
        resourceTwo.release(new Response('result-u2', { status: 202 }));
        expect(await Promise.race([two, watchdog])).toMatchObject({ kind: 'outcome', outcome: { ok: { status: 202, body: 'result-u2', key: 'job-u2' } } });
        expect(completed).toEqual(['u2']);
        resourceOne.release(new Response('result-u1', { status: 201 }));
        expect(await Promise.race([one, watchdog])).toMatchObject({ kind: 'outcome', outcome: { ok: { status: 201, body: 'result-u1', key: 'job-u1' } } });
        expect(completed).toEqual(['u2', 'u1']);
        expect(await secrets.get('shared:access', 'u1')).toBe('TOKEN-u1');
        expect(await secrets.get('shared:access', 'u2')).toBe('TOKEN-u2');
      } finally {
        clearTimeout(watchdogTimer);
        abortOne.abort();
        abortTwo.abort();
        grantOne.release(new Response('{}'));
        grantTwo.release(new Response('{}'));
        resourceOne.release(new Response('cleanup-u1'));
        resourceTwo.release(new Response('cleanup-u2'));
        await Promise.all([one, two]);
      }
    }, 5000);

    it.each(['sse', 'json-lines'] as const)('isolates %s events and lets the other principal finish after one stream is cancelled', async (framing) => {
      if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
      const kernel = await loadHttpKernel(KERNEL_DIR);
      const secrets = createHttpSecrets(() => 1000);
      await secrets.set('KEY', 'TOKEN-u1', 60000, 'u1');
      await secrets.set('KEY', 'TOKEN-u2', 60000, 'u2');
      const encoder = new TextEncoder();
      const responses = new Map<string, Response>();
      const producers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
      const signals = new Map<string, AbortSignal>();
      const cancellations: string[] = [];
      const requests: Array<{ path: string; bearer: string | undefined }> = [];
      const responseOne = rendezvous<Response>();
      const responseTwo = rendezvous<Response>();
      const requestedOne = rendezvous<void>();
      const requestedTwo = rendezvous<void>();
      const receivedOne = rendezvous<void>();
      const receivedTwo = rendezvous<void>();
      const abortOne = new AbortController();
      const abortTwo = new AbortController();
      const messagesOne: HttpStreamEvent[] = [];
      const messagesTwo: HttpStreamEvent[] = [];
      const p = createHttpPorts({
        kernel: async () => kernel,
        egress: ['https://api.example.com'],
        secrets,
        resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
        fetch: async (url, init) => {
          const principal = url.pathname === '/u1' ? 'u1' : url.pathname === '/u2' ? 'u2' : undefined;
          if (principal === undefined || init.signal === undefined) throw new Error('unexpected stream request');
          signals.set(principal, init.signal);
          requests.push({ path: url.pathname, bearer: init.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] });
          responses.set(principal, new Response(new ReadableStream<Uint8Array>({
            start(controller) { producers.set(principal, controller); },
            cancel() { cancellations.push(principal); },
          })));
          if (principal === 'u1') {
            requestedOne.release();
            return responseOne.promise;
          }
          requestedTwo.release();
          return responseTwo.promise;
        },
      });
      const streaming = (principal: string): HttpCall => ({ ...call, key: `stream-${principal}`, path: `/${principal}`, request: {
        stream: framing, auth: { scheme: 'bearer', credential: { credential: 'KEY', scope: 'user' } },
      } });
      const one = runHttpCall(p, streaming('u1'), { principal: 'u1', signal: abortOne.signal, onMessage(event) { messagesOne.push(event); receivedOne.release(); } }).then(
        (outcome) => ({ kind: 'outcome' as const, outcome }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      const two = runHttpCall(p, streaming('u2'), { principal: 'u2', signal: abortTwo.signal, onMessage(event) { messagesTwo.push(event); receivedTwo.release(); } }).then(
        (outcome) => ({ kind: 'outcome' as const, outcome }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_resolve, reject) => {
        watchdogTimer = setTimeout(() => { reject(new Error('concurrent stream rendezvous timed out')); }, 2000);
      });
      const frame = (principal: string, data: string): string => framing === 'sse'
        ? `id: ${principal}-id\nevent: ${principal}-event\ndata: ${data}\n\n`
        : `${data}\n`;
      const event = (principal: string, data: string): HttpStreamEvent => ({ data, event: framing === 'sse' ? `${principal}-event` : null, id: framing === 'sse' ? `${principal}-id` : null, key: `stream-${principal}` });
      try {
        await Promise.race([Promise.all([requestedOne.promise, requestedTwo.promise]), watchdog]);
        expect([...requests].sort((left, right) => left.path.localeCompare(right.path))).toEqual([{ path: '/u1', bearer: 'Bearer TOKEN-u1' }, { path: '/u2', bearer: 'Bearer TOKEN-u2' }]);
        const bodyOne = responses.get('u1');
        const bodyTwo = responses.get('u2');
        const producerOne = producers.get('u1');
        const producerTwo = producers.get('u2');
        if (bodyOne === undefined || bodyTwo === undefined || producerOne === undefined || producerTwo === undefined) throw new Error('stream producer is missing');
        responseTwo.release(bodyTwo);
        producerTwo.enqueue(encoder.encode(frame('u2', 'u2-first') + (framing === 'sse' ? 'data: u2-' : 'u2-')));
        await Promise.race([receivedTwo.promise, watchdog]);
        expect(messagesOne).toEqual([]);
        responseOne.release(bodyOne);
        producerOne.enqueue(encoder.encode(frame('u1', 'u1-first') + (framing === 'sse' ? 'data: u1-' : 'u1-')));
        await Promise.race([receivedOne.promise, watchdog]);
        expect(messagesOne).toEqual([event('u1', 'u1-first')]);
        expect(messagesTwo).toEqual([event('u2', 'u2-first')]);
        producerOne.enqueue(encoder.encode(framing === 'sse' ? 'late\n\n' : 'late\n'));
        abortOne.abort();
        const cancelled = await Promise.race([one, watchdog]);
        expect(cancelled.kind).toBe('rejected');
        if (cancelled.kind === 'rejected') expect(cancelled.error).toBeInstanceOf(Error);
        expect(signals.get('u1')?.aborted).toBe(true);
        expect(signals.get('u2')?.aborted).toBe(false);
        expect(cancellations).toEqual(['u1']);
        producerTwo.enqueue(encoder.encode((framing === 'sse' ? 'tail\n\n' : 'tail\n') + frame('u2', 'u2-final')));
        producerTwo.close();
        expect(await Promise.race([two, watchdog])).toMatchObject({ kind: 'outcome', outcome: { ok: { status: 200, body: '', key: 'stream-u2' } } });
        expect(messagesOne).toEqual([event('u1', 'u1-first')]);
        expect(messagesTwo).toEqual([
          event('u2', 'u2-first'),
          { data: 'u2-tail', event: null, id: null, key: 'stream-u2' },
          event('u2', 'u2-final'),
        ]);
        expect(cancellations).toEqual(['u1']);
      } finally {
        clearTimeout(watchdogTimer);
        abortOne.abort();
        abortTwo.abort();
        responseOne.release(responses.get('u1') ?? new Response(null));
        responseTwo.release(responses.get('u2') ?? new Response(null));
        await Promise.all([one, two]);
      }
    }, 5000);
  });

  describe('real-wasm stream/form acceptance', () => {
    const encoder = new TextEncoder();
    const streamKey = 'stream-job';
    const streamCall = (framing: 'sse' | 'json-lines'): HttpCall => ({ ...call, key: streamKey, request: { stream: framing } });
    const byteResponse = (chunks: readonly Uint8Array[]): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });

    const formCases: Array<{ encoding: string; request: JsonObject; body: string }> = [
      { encoding: 'default', request: {}, body: 'field+name=a+b%21%27%28%29*%7E' },
      { encoding: 'html', request: { formEncoding: 'html' }, body: 'field+name=a+b%21%27%28%29*%7E' },
      { encoding: 'rfc3986', request: { formEncoding: 'rfc3986' }, body: 'field%20name=a%20b%21%27%28%29%2A~' },
    ];

    it.each(formCases)('sends exact $encoding form bytes and ordinary query bytes', async ({ request, body }) => {
      const sent: Array<{ url: string; contentType: string | undefined; bytes: number[] }> = [];
      const p = await ports({}, (url, init) => {
        if (init.body === undefined) throw new Error('form body is missing');
        sent.push({
          url,
          contentType: init.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1],
          bytes: Array.from(init.body),
        });
        return new Response('accepted', { status: 201 });
      });
      const formCall: HttpCall = {
        ...call,
        method: 'POST',
        request: { ...request, query: { q: 'a b' }, form: { 'field name': "a b!'()*~" } },
      };
      expect(await runHttpCall(p, formCall)).toMatchObject({ ok: { status: 201, body: 'accepted', key: null } });
      expect(sent).toEqual([{
        url: 'https://api.example.com/search?q=a%20b',
        contentType: 'application/x-www-form-urlencoded',
        bytes: Array.from(encoder.encode(body)),
      }]);
    });

    const frameCases: Array<{ framing: 'sse' | 'json-lines'; chunks: string[]; events: HttpStreamEvent[] }> = [
      {
        framing: 'sse',
        chunks: ['id: s', '1\r', '\nevent: del', 'ta\r\ndata: fi', 'rst\r\ndata: sec', 'ond\r\n\r', '\ndata: ta', 'il'],
        events: [
          { data: 'first\nsecond', event: 'delta', id: 's1', key: streamKey },
          { data: 'tail', event: null, id: null, key: streamKey },
        ],
      },
      {
        framing: 'json-lines',
        chunks: ['{"x":', '1}\r', '\n\n', 'null\n', 'false\n', '{"tail":', '2}'],
        events: [
          { data: '{"x":1}', event: null, id: null, key: streamKey },
          { data: 'null', event: null, id: null, key: streamKey },
          { data: 'false', event: null, id: null, key: streamKey },
          { data: '{"tail":2}', event: null, id: null, key: streamKey },
        ],
      },
    ];

    it.each(frameCases)('frames $framing byte chunks and an unterminated EOF tail in the real kernel', async ({ framing, chunks, events }) => {
      const messages: HttpStreamEvent[] = [];
      const p = await ports({}, () => byteResponse(chunks.map((chunk) => encoder.encode(chunk))));
      expect(await runHttpCall(p, streamCall(framing), { onMessage: (event) => { messages.push(event); } }))
        .toMatchObject({ ok: { status: 200, body: '', key: streamKey } });
      expect(messages).toEqual(events);
    });

    describe.each(['sse', 'json-lines'] as const)('%s', (framing) => {
      it.each(['null body', 'empty readable body'])('emits no events for %s', async (body) => {
        const messages: HttpStreamEvent[] = [];
        const p = await ports({}, () => body === 'null body' ? new Response(null) : byteResponse([]));
        expect(await runHttpCall(p, streamCall(framing), { onMessage: (event) => { messages.push(event); } }))
          .toMatchObject({ ok: { status: 200, body: '', key: streamKey } });
        expect(messages).toEqual([]);
      });

      it('preserves a valid four-byte UTF8 value split over byte chunks at EOF', async () => {
        const messages: HttpStreamEvent[] = [];
        const prefix = framing === 'sse' ? 'data: ' : '';
        const p = await ports({}, () => byteResponse([
          encoder.encode(prefix),
          new Uint8Array([0xf0]),
          new Uint8Array([0x9f]),
          new Uint8Array([0x98]),
          new Uint8Array([0x80]),
        ]));
        expect(await runHttpCall(p, streamCall(framing), { onMessage: (event) => { messages.push(event); } }))
          .toMatchObject({ ok: { status: 200, body: '', key: streamKey } });
        expect(messages).toEqual([{ data: '😀', event: null, id: null, key: streamKey }]);
      });

      it('flushes incomplete trailing UTF8 as one replacement character before EOF framing', async () => {
        const messages: HttpStreamEvent[] = [];
        const prefix = framing === 'sse' ? 'data: tail ' : 'tail ';
        const p = await ports({}, () => byteResponse([encoder.encode(prefix), new Uint8Array([0xf0]), new Uint8Array([0x9f])]));
        expect(await runHttpCall(p, streamCall(framing), { onMessage: (event) => { messages.push(event); } }))
          .toMatchObject({ ok: { status: 200, body: '', key: streamKey } });
        expect(messages).toEqual([{ data: 'tail �', event: null, id: null, key: streamKey }]);
      });

      it('rejects cancellation without late messages when the byte transport completes after abort', async () => {
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let firstMessage: (() => void) | undefined;
        let pendingRead: (() => void) | undefined;
        const firstReceived = new Promise<void>((resolve) => { firstMessage = resolve; });
        const readStarted = new Promise<void>((resolve) => { pendingRead = resolve; });
        let closed = false;
        const frame = (data: string): Uint8Array => encoder.encode(framing === 'sse' ? `data: ${data}\n\n` : `${data}\n`);
        const p = await ports({}, () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(frame('first'));
          },
          pull() { pendingRead?.(); },
        })));
        const controller = new AbortController();
        const messages: HttpStreamEvent[] = [];
        const pending = runHttpCall(p, streamCall(framing), {
          signal: controller.signal,
          onMessage(event) {
            messages.push(event);
            firstMessage?.();
          },
        });
        const settled = pending.then(() => undefined, (error: Error) => error);
        const watchdog = setTimeout(() => {
          controller.abort();
          if (!closed) {
            closed = true;
            streamController?.error(new Error('stream fixture rendezvous timed out'));
          }
        }, 2000);
        try {
          await Promise.race([
            Promise.all([firstReceived, readStarted]),
            settled.then(() => { throw new Error('stream completed before the cancellation rendezvous'); }),
          ]);
          expect(messages).toEqual([{ data: 'first', event: null, id: null, key: streamKey }]);
          controller.abort();
          if (streamController === undefined) throw new Error('stream controller is missing');
          streamController.enqueue(frame('late'));
          streamController.close();
          closed = true;
          expect.soft(await settled).toBeInstanceOf(Error);
          expect(messages).toEqual([{ data: 'first', event: null, id: null, key: streamKey }]);
        } finally {
          clearTimeout(watchdog);
          if (!closed) {
            streamController?.close();
            closed = true;
          }
          await settled;
        }
      }, 5000);

      it.each(['caller abort', 'request timeout'] as const)('settles %s during a pending read before producer release and cancels the stream', async (boundary) => {
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let firstMessage: (() => void) | undefined;
        let pendingRead: (() => void) | undefined;
        const firstReceived = new Promise<void>((resolve) => { firstMessage = resolve; });
        const readStarted = new Promise<void>((resolve) => { pendingRead = resolve; });
        let cancellations = 0;
        let producerReleased = false;
        const frame = (data: string): Uint8Array => encoder.encode(framing === 'sse' ? `data: ${data}\n\n` : `${data}\n`);
        const p = await ports({}, () => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(frame('first'));
          },
          pull() { pendingRead?.(); },
          cancel() { cancellations += 1; },
        })));
        const controller = new AbortController();
        const messages: HttpStreamEvent[] = [];
        const pending = runHttpCall(p, {
          ...streamCall(framing),
          request: { stream: framing, ...(boundary === 'request timeout' ? { timeoutMs: 250 } : {}) },
        }, {
          signal: controller.signal,
          onMessage(event) {
            messages.push(event);
            firstMessage?.();
          },
        });
        const settled = pending.then(
          (outcome) => ({ kind: 'outcome' as const, outcome }),
          (error: Error) => ({ kind: 'rejected' as const, error }),
        );
        let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
        const watchdog = new Promise<never>((_resolve, reject) => {
          watchdogTimer = setTimeout(() => { reject(new Error('pending-read call did not settle before producer release')); }, 1500);
        });
        try {
          await Promise.race([
            Promise.all([firstReceived, readStarted]),
            settled.then(() => { throw new Error('stream completed before the pending-read rendezvous'); }),
            watchdog,
          ]);
          expect(messages).toEqual([{ data: 'first', event: null, id: null, key: streamKey }]);
          if (boundary === 'caller abort') controller.abort();
          const result = await Promise.race([settled, watchdog]);
          expect(producerReleased).toBe(false);
          if (boundary === 'caller abort') {
            expect(result.kind).toBe('rejected');
            if (result.kind === 'rejected') expect(result.error).toBeInstanceOf(Error);
          } else {
            expect(result).toMatchObject({ kind: 'outcome', outcome: { error: { kind: 'timeout', credential: null, key: streamKey } } });
          }
        } finally {
          clearTimeout(watchdogTimer);
          producerReleased = true;
          if (cancellations === 0) {
            if (streamController === undefined) throw new Error('stream controller is missing');
            streamController.enqueue(frame('late'));
            streamController.close();
          }
          await settled;
          expect.soft(cancellations).toBe(1);
          expect.soft(messages).toEqual([{ data: 'first', event: null, id: null, key: streamKey }]);
        }
      }, 5000);

      describe('optional reader cleanup faults', () => {
        it.each(['reply/release sync', 'abort/cancel sync', 'callback/release sync', 'callback/cancel async'] as const)('preserves the primary outcome for %s', async (fault) => {
          const cleanupError = new Error(`cleanup fault: ${fault}`);
          const primaryError = new Error('primary onMessage failure');
          let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
          let realReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let firstMessage: (() => void) | undefined;
          let pendingRead: (() => void) | undefined;
          const firstReceived = new Promise<void>((resolve) => { firstMessage = resolve; });
          const readStarted = new Promise<void>((resolve) => { pendingRead = resolve; });
          let producerClosed = false;
          let cancellations = 0;
          let releases = 0;
          const p = await ports({}, () => {
            const response = new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(encoder.encode(framing === 'sse' ? 'data: first\n\n' : 'first\n'));
                if (fault !== 'abort/cancel sync') {
                  controller.close();
                  producerClosed = true;
                }
              },
              pull() { pendingRead?.(); },
              cancel() { producerClosed = true; },
            }));
            const body = response.body;
            if (body === null) throw new Error('stream body is missing');
            const wrapped: PinnedResponse = {
              status: response.status,
              headers: response.headers,
              arrayBuffer: () => response.arrayBuffer(),
              body: {
                getReader() {
                  const reader = body.getReader();
                  realReader = reader;
                  return {
                    read: () => reader.read(),
                    cancel() {
                      cancellations += 1;
                      const cancelled = reader.cancel();
                      if (fault === 'abort/cancel sync') {
                        void cancelled.catch(() => {});
                        throw cleanupError;
                      }
                      if (fault === 'callback/cancel async') return cancelled.then(() => { throw cleanupError; });
                      return cancelled;
                    },
                    releaseLock() {
                      releases += 1;
                      reader.releaseLock();
                      if (fault === 'reply/release sync' || fault === 'callback/release sync') throw cleanupError;
                    },
                  };
                },
              },
            };
            return wrapped;
          });
          const controller = new AbortController();
          const messages: HttpStreamEvent[] = [];
          const pending = runHttpCall(p, streamCall(framing), {
            signal: controller.signal,
            onMessage(event) {
              messages.push(event);
              firstMessage?.();
              if (fault === 'callback/release sync' || fault === 'callback/cancel async') throw primaryError;
            },
          });
          const settled = pending.then(
            (outcome) => ({ kind: 'outcome' as const, outcome }),
            (error: Error) => ({ kind: 'rejected' as const, error }),
          );
          let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
          const watchdog = new Promise<never>((_resolve, reject) => {
            watchdogTimer = setTimeout(() => { reject(new Error('cleanup fixture did not settle')); }, 1500);
          });
          try {
            if (fault === 'abort/cancel sync') {
              await Promise.race([
                Promise.all([firstReceived, readStarted]),
                settled.then(() => { throw new Error('stream completed before the cleanup cancellation rendezvous'); }),
                watchdog,
              ]);
              controller.abort();
            }
            const result = await Promise.race([settled, watchdog]);
            if (fault === 'reply/release sync') {
              expect.soft(result).toMatchObject({ kind: 'outcome', outcome: { ok: { status: 200, body: '', key: streamKey } } });
            } else if (fault === 'abort/cancel sync') {
              expect.soft(result.kind).toBe('rejected');
              if (result.kind === 'rejected') {
                expect.soft(result.error).toBeInstanceOf(Error);
                expect.soft(result.error).not.toBe(cleanupError);
              }
            } else {
              expect.soft(result).toMatchObject({ kind: 'outcome', outcome: { error: { kind: 'failed', error: primaryError.message, credential: null, key: streamKey } } });
            }
            expect.soft(cancellations).toBe(fault === 'reply/release sync' ? 0 : 1);
            expect.soft(releases).toBe(1);
            expect(messages).toEqual([{ data: 'first', event: null, id: null, key: streamKey }]);
          } finally {
            clearTimeout(watchdogTimer);
            if (!producerClosed) {
              streamController?.close();
              producerClosed = true;
            }
            await settled;
            realReader?.releaseLock();
          }
        }, 5000);
      });
    });
  });
});
