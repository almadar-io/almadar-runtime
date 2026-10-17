import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { isJsonObject, type JsonObject, type JsonValue } from '@almadar/core';
import { createHttpPorts, createHttpSecrets, runHttpCall, type HttpCall, type HttpKernel, type HttpSecrets, type PinnedFetch, type PinnedInit, type PinnedResponse } from '../src/kernel/http-exchange.js';
import { loadHttpKernel } from '../src/kernel/load-node.js';
import { KERNEL_DIR } from './helpers/kernel-module.js';

const schemes = ['token-exchange', 'oauth2-client', 'jwt-bearer'] as const;
type Scheme = typeof schemes[number];
const principal = 'g216-user';
const tokenUrl = 'https://auth.example.com/token';
const accessToken = 'G216_ACCESS_TOKEN';
let actualKernel: HttpKernel;
let serviceAccount: string;
let privateKey: string;

function object(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isJsonObject(value)) throw new Error('expected a canonical JSON object');
  return value;
}

function auth(scheme: Scheme, grantRequest?: JsonValue): JsonObject {
  let value: JsonObject;
  if (scheme === 'token-exchange') {
    value = {
      scheme, tokenUrl, body: { json: { username: { credential: 'G216_USER' }, password: { credential: 'G216_PASS' }, device: 'web', n: 7 } },
      accessField: 'token', expiresField: 'ttl', expiresMarginMs: 1000,
      storeAs: { name: 'g216:session', scope: 'user' },
    };
  } else if (scheme === 'oauth2-client') {
    value = { scheme, tokenUrl, clientId: 'G216_ID', clientSecret: 'G216_SECRET', scope: 'read write' };
  } else {
    value = {
      scheme, tokenUrl, key: { credential: 'G216_ACCOUNT', scope: 'user' }, alg: 'ES256',
      claims: { scope: 'calendar', aud: tokenUrl, iat: 1000, exp: 4600 },
      storeAs: { name: 'g216:jwt', scope: 'user' }, expiresMarginMs: 300000,
    };
  }
  if (grantRequest !== undefined) value.grantRequest = grantRequest;
  return value;
}

function call(scheme: Scheme, grantRequest?: JsonValue, resource: JsonObject = {}): HttpCall {
  return { method: 'POST', origin: 'https://api.example.com', path: '/resource', key: 'grant-job', nowMs: 1000000,
    request: { auth: auth(scheme, grantRequest), ...resource } };
}

function tokenReply(token = accessToken): Response {
  return new Response(JSON.stringify({ token, ttl: 60, access_token: token, expires_in: 3600 }));
}

async function fixture(fetchImpl: PinnedFetch = async (url) => url.origin === 'https://auth.example.com' ? tokenReply() : new Response('resource')) {
  const asks: JsonObject[] = [];
  const snapshots: string[] = [];
  const answers: JsonObject[] = [];
  const writes: Array<{ name: string; value: string; ttlMs: number; owner: string | undefined }> = [];
  const record = (json: string): string => {
    const parsed: JsonValue = JSON.parse(json);
    const progress = object(parsed);
    snapshots.push(JSON.stringify(progress.driver ?? null));
    const step = object(progress.step);
    if (step.kind === 'ask') asks.push(object(step.ask));
    return json;
  };
  const kernel: HttpKernel = {
    httpDriverStart: (input, egress) => record(actualKernel.httpDriverStart(input, egress)),
    httpDriverResume(driver, answer) {
      const parsed: JsonValue = JSON.parse(answer);
      answers.push(object(parsed));
      return record(actualKernel.httpDriverResume(driver, answer));
    },
    httpDriverDrop: (driver) => actualKernel.httpDriverDrop(driver),
    isPublicAddress: (ip) => actualKernel.isPublicAddress(ip),
    frameStream: (framing, key, chunk, carry) => actualKernel.frameStream(framing, key, chunk, carry),
    frameStreamFinish: (framing, key, carry) => actualKernel.frameStreamFinish(framing, key, carry),
  };
  const store = createHttpSecrets(() => 1000);
  for (const [name, value] of Object.entries({ G216_USER: 'alice', G216_PASS: 's3cret', G216_ID: 'client-1', G216_SECRET: 'shh' })) {
    await store.set(name, value, 86400000);
  }
  await store.set('G216_ACCOUNT', serviceAccount, 86400000, principal);
  const secrets: HttpSecrets = {
    get: (name, owner) => store.get(name, owner),
    async set(name, value, ttlMs, owner) {
      writes.push({ name, value, ttlMs, owner });
      await store.set(name, value, ttlMs, owner);
    },
    forget: (name, owner) => store.forget(name, owner),
  };
  let sends = 0;
  const ports = createHttpPorts({ kernel: async () => kernel, secrets,
    egress: ['https://api.example.com', 'https://auth.example.com'],
    resolve: async () => ({ literal: false, addresses: ['93.184.216.34'] }),
    fetch: async (url, init, address) => { sends += 1; return fetchImpl(url, init, address); },
  });
  return { ports, asks, snapshots, answers, writes, store, sends: () => sends };
}

function requests(asks: readonly JsonObject[]) {
  return asks.filter((ask) => ask.kind === 'http').map((ask) => ({ request: object(ask.request), delayMs: ask.delayMs }));
}

function header(request: JsonObject, name: string): string | undefined {
  if (!Array.isArray(request.headers)) throw new Error('HTTP headers are missing');
  for (const pair of request.headers) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw new Error('HTTP header pair is malformed');
    if (pair[0].toLowerCase() === name.toLowerCase()) return pair[1];
  }
  return undefined;
}

function requestText(request: JsonObject): string {
  const body = object(request.body);
  if (body.kind !== 'text' || typeof body.text !== 'string') throw new Error('expected an evaluated text request body');
  return body.text;
}

type Answer = { kind: 'status'; status: number } | { kind: 'failed' } | { kind: 'timeout' };

async function respond(answer: Answer, init: PinnedInit): Promise<PinnedResponse> {
  if (answer.kind === 'failed') throw new Error('synthetic connection reset');
  if (answer.kind === 'timeout') {
    const signal = init.signal;
    if (signal === undefined) throw new Error('grant timeout did not reach the transport');
    return new Promise<PinnedResponse>((_resolve, reject) => {
      const abort = () => { reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
  const response = new Response('synthetic vendor response');
  return { status: answer.status, headers: response.headers, body: response.body, arrayBuffer: () => response.arrayBuffer() };
}

function assertPrivateSnapshots(snapshots: readonly string[]) {
  for (const snapshot of snapshots) {
    for (const secret of ['alice', 's3cret', privateKey, serviceAccount, 'private-g216@example.invalid', accessToken]) expect(snapshot).not.toContain(secret);
  }
}

describe.skipIf(KERNEL_DIR === undefined)('grantRequest on the real wasm HTTP driver', () => {
  beforeAll(async () => {
    if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
    actualKernel = await loadHttpKernel(KERNEL_DIR);
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    privateKey = pair.privateKey;
    serviceAccount = JSON.stringify({ client_email: 'private-g216@example.invalid', private_key: privateKey });
  });

  describe.each(schemes)('%s', (scheme) => {
    const controls: Array<{ name: string; grantRequest?: JsonValue; deadline: number | undefined; configured: boolean }> = [
      { name: 'omitted old default', deadline: undefined, configured: false },
      { name: 'empty defaults', grantRequest: {}, deadline: undefined, configured: false },
      { name: 'explicit null deadline', grantRequest: { timeoutMs: null }, deadline: undefined, configured: false },
      { name: 'configured grant headers and deadline', grantRequest: { timeoutMs: 15000, headers: { 'X-Zeta': 'first', 'x-alpha': 'second', 'X-Middle': 'third' } }, deadline: 15000, configured: true },
    ];
    it.each(controls)('isolates $name from resource options', async ({ grantRequest, deadline, configured }) => {
      const f = await fixture();
      expect(await runHttpCall(f.ports, call(scheme, grantRequest, {
        text: 'resource bytes', timeoutMs: 20000, headers: { 'X-Resource': 'resource-only', 'Content-Type': 'resource/type' },
        retry: { max: 1, on: ['5xx'], backoffMs: 7 },
      }), { principal })).toMatchObject({ ok: { body: 'resource', key: 'grant-job' } });
      const http = requests(f.asks);
      expect(http).toHaveLength(2);
      const grant = http[0]?.request;
      const resource = http[1]?.request;
      if (grant === undefined || resource === undefined) throw new Error('grant/resource asks are missing');
      expect(grant.timeoutMs).toBe(deadline);
      expect(header(grant, 'X-Resource')).toBeUndefined();
      expect(header(grant, 'Content-Type')).toBe(scheme === 'token-exchange' ? 'application/json' : 'application/x-www-form-urlencoded');
      const grantHeaders = grant.headers;
      if (!Array.isArray(grantHeaders)) throw new Error('grant headers are missing');
      const authored = grantHeaders.filter((pair) => {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw new Error('grant header pair is malformed');
        return pair[0].toLowerCase() !== 'authorization' && pair[0].toLowerCase() !== 'content-type';
      });
      expect(authored).toEqual(configured ? [['X-Zeta', 'first'], ['x-alpha', 'second'], ['X-Middle', 'third']] : []);
      expect(header(grant, 'Authorization')).toBe(scheme === 'oauth2-client' ? 'Basic Y2xpZW50LTE6c2ho' : undefined);
      for (const [name, count] of [['authorization', scheme === 'oauth2-client' ? 1 : 0], ['content-type', 1]] as const) {
        expect(grantHeaders.filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === name)).toHaveLength(count);
      }
      expect(resource.timeoutMs).toBe(20000);
      expect(header(resource, 'X-Resource')).toBe('resource-only');
      expect(header(resource, 'X-Zeta')).toBeUndefined();
      expect(header(resource, 'Authorization')).toBe(`Bearer ${accessToken}`);
      expect(f.writes).toHaveLength(1);
      assertPrivateSnapshots(f.snapshots);
    });

    it('accepts an explicit zero grant deadline without inheriting the resource deadline', async () => {
      const f = await fixture();
      const outcome = await runHttpCall(f.ports, call(scheme, { timeoutMs: 0 }, { timeoutMs: 20000 }), { principal });
      const grant = requests(f.asks)[0]?.request;
      expect(grant?.timeoutMs).toBe(0);
      if ('error' in outcome) expect(outcome.error.kind).toBe('timeout');
      else expect(outcome).toMatchObject({ ok: { body: 'resource' } });
    });

    it('never inherits outer retry when grantRequest is omitted', async () => {
      const f = await fixture(async () => new Response('grant failed', { status: 503 }));
      expect(await runHttpCall(f.ports, call(scheme, undefined, { retry: { max: 2, on: ['5xx'], backoffMs: 3 } }), { principal }))
        .toMatchObject({ error: { kind: 'failed', key: 'grant-job' } });
      expect(f.sends()).toBe(1);
      expect(f.writes).toEqual([]);
      expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual([undefined]);
    });

    it('retries exact evaluated grant bytes with the explicit mixed schedule and no early token write/resource', async () => {
      const sequence: Answer[] = [{ kind: 'status', status: 503 }, { kind: 'failed' }, { kind: 'status', status: 408 }];
      let grants = 0;
      let resources = 0;
      let writes = () => 0;
      const f = await fixture(async (url, init) => {
        if (url.origin !== 'https://auth.example.com') { resources += 1; return new Response('resource'); }
        expect(writes()).toBe(0);
        expect(resources).toBe(0);
        const answer = sequence[grants];
        grants += 1;
        return answer === undefined ? tokenReply() : respond(answer, init);
      });
      writes = () => f.writes.length;
      expect(await runHttpCall(f.ports, call(scheme, {
        headers: { 'X-Grant': 'grant-only' }, timeoutMs: 15000,
        retry: { max: 3, on: ['1xx', '408', '5xx', '429', 'failed', 'timeout'], noResponseMax: 2, scheduleMs: [100, 500, 1500] },
      }, { timeoutMs: 20000, headers: { 'X-Resource': 'resource-only' } }), { principal }))
        .toMatchObject({ ok: { body: 'resource' } });
      const http = requests(f.asks);
      expect(http.map(({ delayMs }) => delayMs)).toEqual([undefined, 100, 500, 1500, undefined]);
      const first = http[0]?.request;
      if (first === undefined) throw new Error('initial grant is missing');
      for (const retry of http.filter(({ request }) => request.url === tokenUrl)) expect(retry.request).toEqual(first);
      expect(header(first, 'X-Grant')).toBe('grant-only');
      expect(first.timeoutMs).toBe(15000);
      expect(grants).toBe(4);
      expect(resources).toBe(1);
      expect(f.writes).toHaveLength(1);
      expect(f.asks.filter((ask) => ask.kind === 'secret')).toHaveLength(scheme === 'jwt-bearer' ? 2 : 3);
      if (scheme === 'jwt-bearer') {
        const assertion = new URLSearchParams(requestText(first)).get('assertion');
        if (assertion === null) throw new Error('JWT assertion is missing');
        const payloadPart = assertion.split('.')[1];
        if (payloadPart === undefined) throw new Error('JWT assertion payload is missing');
        const payload: JsonValue = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
        expect(payload).toMatchObject({ iss: 'private-g216@example.invalid', iat: 1000, exp: 4600, aud: tokenUrl });
      } else {
        expect(requestText(first)).toBe(scheme === 'token-exchange'
          ? '{"username":"alice","password":"s3cret","device":"web","n":7}'
          : 'grant_type=client_credentials&scope=read+write');
      }
      assertPrivateSnapshots(f.snapshots);
    });

    const budgetCases: Array<{ name: string; answers: Answer[]; success: boolean; kind: string; delays: Array<number | undefined> }> = [
      { name: 'status then failed then timeout exhausts shared index', answers: [{ kind: 'status', status: 503 }, { kind: 'failed' }, { kind: 'timeout' }], success: false, kind: 'timeout', delays: [undefined, 3, 4] },
      { name: 'failed then timeout then failed exhausts shared index', answers: [{ kind: 'failed' }, { kind: 'timeout' }, { kind: 'failed' }], success: false, kind: 'failed', delays: [undefined, 3, 4] },
      { name: 'two failures still allow the final status retry', answers: [{ kind: 'failed' }, { kind: 'failed' }, { kind: 'status', status: 503 }], success: true, kind: '', delays: [undefined, 3, 4, 5, undefined] },
    ];
    it.each(budgetCases)('$name', async ({ answers, success, kind, delays }) => {
      let grants = 0;
      let resources = 0;
      const f = await fixture(async (url, init) => {
        if (url.origin !== 'https://auth.example.com') { resources += 1; return new Response('resource'); }
        const answer = answers[grants];
        grants += 1;
        return answer === undefined ? tokenReply() : respond(answer, init);
      });
      const outcome = await runHttpCall(f.ports, call(scheme, { timeoutMs: 10,
        retry: { max: 3, on: ['5xx', 'failed', 'timeout'], noResponseMax: 2, scheduleMs: [3, 4, 5] },
      }), { principal });
      expect(outcome).toMatchObject(success ? { ok: { body: 'resource' } } : { error: { kind, key: 'grant-job' } });
      expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual(delays);
      expect(grants).toBe(success ? 4 : 3);
      expect(resources).toBe(success ? 1 : 0);
      expect(f.writes).toHaveLength(success ? 1 : 0);
    });

    it.each([undefined, 2])('retains the full transport retry budget with noResponseMax=%s', async (maximum) => {
      let grants = 0;
      const f = await fixture(async (url) => {
        if (url.origin !== 'https://auth.example.com') return new Response('resource');
        grants += 1;
        if (grants <= 2) throw new Error('synthetic connection reset');
        return tokenReply();
      });
      const retry: JsonObject = { max: 2, on: ['failed'], scheduleMs: [3, 4] };
      if (maximum !== undefined) retry.noResponseMax = maximum;
      expect(await runHttpCall(f.ports, call(scheme, { retry }), { principal })).toMatchObject({ ok: { body: 'resource' } });
      expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual([undefined, 3, 4, undefined]);
    });

    it.each(['failed', 'status'] as const)('zero noResponseMax preserves only eligible status retries: %s', async (mode) => {
      let grants = 0;
      const f = await fixture(async (url) => {
        if (url.origin !== 'https://auth.example.com') return new Response('resource');
        grants += 1;
        if (mode === 'failed') throw new Error('synthetic connection reset');
        return grants === 1 ? new Response('retry', { status: 503 }) : tokenReply();
      });
      const outcome = await runHttpCall(f.ports, call(scheme, {
        retry: { max: 1, on: ['failed', '5xx'], noResponseMax: 0, scheduleMs: [3] },
      }), { principal });
      expect(outcome).toMatchObject(mode === 'failed' ? { error: { kind: 'failed' } } : { ok: { body: 'resource' } });
      expect(grants).toBe(mode === 'failed' ? 1 : 2);
      expect(f.writes).toHaveLength(mode === 'failed' ? 0 : 1);
    });

    it('keeps grant and resource retry attempt indexes independent', async () => {
      let grants = 0;
      let resources = 0;
      const f = await fixture(async (url) => {
        if (url.origin === 'https://auth.example.com') {
          grants += 1;
          return grants <= 2 ? new Response('retry', { status: 503 }) : tokenReply();
        }
        resources += 1;
        return new Response('exhausted resource', { status: 503 });
      });
      expect(await runHttpCall(f.ports, call(scheme, { retry: { max: 2, on: ['5xx'], backoffMs: 3 } }, {
        retry: { max: 1, on: ['5xx'], backoffMs: 7 },
      }), { principal })).toMatchObject({ ok: { status: 503, body: 'exhausted resource' } });
      expect(grants).toBe(3);
      expect(resources).toBe(2);
      expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual([undefined, 3, 6, undefined, 7]);
    });

    it('never inherits grant options on uncached or cached resource calls', async () => {
      let grants = 0;
      let resources = 0;
      const f = await fixture(async (url) => {
        if (url.origin === 'https://auth.example.com') { grants += 1; return tokenReply(); }
        resources += 1;
        return new Response('resource reply', { status: 503 });
      });
      const input = call(scheme, { headers: { 'X-Grant': 'grant-only' }, timeoutMs: 15000,
        retry: { max: 1, on: ['5xx'], scheduleMs: [3] } });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await runHttpCall(f.ports, input, { principal })).toMatchObject({ ok: { status: 503 } });
      }
      expect(grants).toBe(1);
      expect(resources).toBe(2);
      expect(f.writes).toHaveLength(1);
      const resourceAsks = requests(f.asks).filter(({ request }) => request.url !== tokenUrl);
      expect(resourceAsks).toHaveLength(2);
      for (const { request, delayMs } of resourceAsks) {
        expect(request.timeoutMs).toBeUndefined();
        expect(header(request, 'X-Grant')).toBeUndefined();
        expect(delayMs).toBeUndefined();
      }
    });

    it('does not classify deliberate grant cancellation as a retryable transport failure', async () => {
      const controller = new AbortController();
      const f = await fixture(async () => {
        controller.abort();
        return new Response('late failed grant', { status: 503 });
      });
      await expect(runHttpCall(f.ports, call(scheme, {
        retry: { max: 3, on: ['5xx', 'failed', 'timeout'], scheduleMs: [3, 4, 5] },
      }), { principal, signal: controller.signal })).rejects.toBeInstanceOf(Error);
      expect(f.sends()).toBe(1);
      expect(f.writes).toEqual([]);
      expect(requests(f.asks)).toHaveLength(1);
    });

    it('refuses malformed closed grant options and headers without a send or token write', async () => {
      const invalidHeaders: JsonValue[] = [{ Authorization: 'literal' }, { aUtHoRiZaTiOn: 'literal' }, { 'Content-Type': 'literal' }, { 'cOnTeNt-TyPe': 'literal' },
        { 'X Bad': 'value' }, { 'X:Bad': 'value' }, { '': 'value' }, { 'X-Test': 'first\r\nInjected: second' },
        { 'X-Test': 'line\nline' }, { 'X-Test': 'nul\u0000value' }, { 'X-Test': 5 }, { 'X-Test': true }, { 'X-Test': null },
        { 'X-Test': { credential: 'G216_PASS' } }, { 'X-Test': ['secret', 'G216_PASS'] }, ['X-Test', 'value']];
      const invalid: JsonValue[] = [null, 3, [], 'request', { extra: true }, { json: {} }, { query: {} },
        { timeoutMs: -1 }, { timeoutMs: 0.5 }, { timeoutMs: '15000' }, { timeoutMs: true }, { timeoutMs: [] }, { timeoutMs: {} },
        { headers: null }, { retry: null },
        ...invalidHeaders.map((headers) => ({ headers })),
      ];
      for (const options of invalid) {
        const f = await fixture();
        const outcome = await runHttpCall(f.ports, call(scheme, options), { principal });
        expect(outcome, JSON.stringify(options)).toMatchObject({ error: { kind: 'refused', credential: null, key: 'grant-job' } });
        expect(f.sends()).toBe(0);
        expect(f.writes).toEqual([]);
        expect(JSON.stringify(outcome)).not.toContain('s3cret');
      }
    });
  });

  it.each([...schemes, 'resource'] as const)('refuses malformed shared retry policies on %s without sending', async (target) => {
    const invalid: JsonValue[] = [
      { max: 1, on: ['5xx'] }, { max: 1, on: ['5xx'], backoffMs: 1, scheduleMs: [1] },
      { max: 1, on: ['5xx'], backoffMs: null, scheduleMs: [1] }, { max: 1, on: ['5xx'], scheduleMs: [] },
      { max: 1, on: ['5xx'], scheduleMs: [1, 2] }, { max: 2, on: ['5xx'], scheduleMs: [1] },
      ...[-1, 0.5, null, '1'].map((delay) => ({ max: 1, on: ['5xx'], scheduleMs: [delay] })),
      ...[null, 1, {}, true].map((scheduleMs) => ({ max: 1, on: ['5xx'], scheduleMs })),
      ...[-1, 0.5].map((backoffMs) => ({ max: 1, on: ['5xx'], backoffMs })),
      ...[-1, 0.5, 2, null, '0', false, [], {}].map((noResponseMax) => ({ max: 1, on: ['5xx'], backoffMs: 1, noResponseMax })),
      { max: 0, on: ['5xx'], scheduleMs: [] }, { max: 1.5, on: ['5xx'], scheduleMs: [1] },
      { max: 4294967296, on: ['5xx'], backoffMs: 1 }, { max: 1, on: [], scheduleMs: [1] },
      { max: 1, on: ['4xx'], scheduleMs: [1] }, { max: 1, on: ['FAILED'], scheduleMs: [1] },
      { max: 1, on: [408], scheduleMs: [1] }, { max: 1, on: ['failed'], scheduleMs: [1], extra: true },
    ];
    for (const retry of invalid) {
      const f = await fixture();
      const input: HttpCall = target === 'resource'
        ? { method: 'POST', origin: 'https://api.example.com', path: '/resource', key: 'grant-job', request: { retry } }
        : call(target, { retry });
      expect(await runHttpCall(f.ports, input, { principal }), JSON.stringify(retry))
        .toMatchObject({ error: { kind: 'refused', key: 'grant-job' } });
      expect(f.sends()).toBe(0);
      expect(f.writes).toEqual([]);
    }
  });

  const statusCases: Array<{ tag: string; status: number; retry: boolean }> = [
    { tag: '1xx', status: 99, retry: false }, { tag: '1xx', status: 100, retry: true }, { tag: '1xx', status: 199, retry: true }, { tag: '1xx', status: 200, retry: false },
    { tag: '408', status: 407, retry: false }, { tag: '408', status: 408, retry: true }, { tag: '408', status: 409, retry: false },
    { tag: '5xx', status: 499, retry: false }, { tag: '5xx', status: 500, retry: true }, { tag: '5xx', status: 599, retry: true }, { tag: '5xx', status: 600, retry: false },
    { tag: '429', status: 428, retry: false }, { tag: '429', status: 429, retry: true }, { tag: '429', status: 430, retry: false },
  ];
  describe.each(['grant', 'resource'] as const)('exact retry status boundary: %s', (target) => {
    it.each(statusCases)('$tag matches status=$status iff retry=$retry', async ({ tag, status, retry }) => {
      let attempts = 0;
      const f = await fixture(async (url, init) => {
        if (target === 'grant' && url.origin !== 'https://auth.example.com') return new Response('resource');
        attempts += 1;
        return respond({ kind: 'status', status }, init);
      });
      const policy: JsonObject = { max: 1, on: [tag], backoffMs: 1 };
      const input: HttpCall = target === 'grant' ? call('token-exchange', { retry: policy })
        : { method: 'POST', origin: 'https://api.example.com', path: '/resource', request: { retry: policy } };
      const outcome = await runHttpCall(f.ports, input, { principal });
      expect(attempts).toBe(retry ? 2 : 1);
      expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual(retry ? [undefined, 1] : [undefined]);
      if (target === 'grant') expect(outcome).toMatchObject({ error: { kind: 'failed' } });
      else expect(outcome).toMatchObject({ ok: { status } });
    });
  });

  it('shares the no-response attempt index on ordinary resource retries', async () => {
    const sequence: Answer[] = [{ kind: 'status', status: 503 }, { kind: 'failed' }, { kind: 'timeout' }];
    let sends = 0;
    const f = await fixture(async (_url, init) => {
      const answer = sequence[sends];
      sends += 1;
      if (answer === undefined) throw new Error('unexpected resource retry');
      return respond(answer, init);
    });
    expect(await runHttpCall(f.ports, {
      method: 'POST', origin: 'https://api.example.com', path: '/resource', key: 'grant-job',
      request: { timeoutMs: 10, retry: { max: 3, on: ['5xx', 'failed', 'timeout'], scheduleMs: [3, 4, 5], noResponseMax: 2 } },
    })).toMatchObject({ error: { kind: 'timeout', key: 'grant-job' } });
    expect(sends).toBe(3);
    expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual([undefined, 3, 4]);
  });

  it('old-policy delayed revival retains the second timeout delay after reacquiring its credential', () => {
    const input: HttpCall = {
      method: 'POST', origin: 'https://api.example.com', path: '/resource', key: 'revived-resource',
      request: { auth: { scheme: 'bearer', credential: 'G216_REVIVAL_TOKEN' }, retry: { max: 2, on: ['timeout'], backoffMs: 10 } },
    };
    const parseProgress = (json: string): JsonObject => {
      const parsed: JsonValue = JSON.parse(json);
      return object(parsed);
    };
    let progress = parseProgress(actualKernel.httpDriverStart(JSON.stringify(input), JSON.stringify(['https://api.example.com'])));
    const resume = (answer: JsonObject): void => {
      progress = parseProgress(actualKernel.httpDriverResume(JSON.stringify(progress.driver ?? null), JSON.stringify(answer)));
    };
    const ask = (): JsonObject => object(object(progress.step).ask);
    const timeout: JsonObject = { kind: 'http', result: { error: { kind: 'timedOut' } } };
    const credential: JsonObject = { kind: 'secret', result: { ok: 'private-revival-token' } };
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      expect(ask()).toMatchObject({ kind: 'secret', name: 'G216_REVIVAL_TOKEN' });
      resume(credential);
      expect(ask()).toMatchObject({ kind: 'http' });
      expect(ask().delayMs).toBeUndefined();
      resume(timeout);
      expect(ask()).toMatchObject({ kind: 'http', delayMs: 10 });
      const saved = JSON.stringify(progress.driver ?? null);
      expect(saved).not.toContain('private-revival-token');
      actualKernel.httpDriverDrop(saved);
      resume(timeout);
      expect(ask()).toMatchObject({ kind: 'secret', name: 'G216_REVIVAL_TOKEN' });
      resume(credential);
      console.info('OLD_POLICY_DELAYED_REVIVAL', {
        sha256: createHash('sha256').update(JSON.stringify(progress)).digest('hex'),
        kind: ask().kind,
        delayMs: ask().delayMs,
      });
      expect(JSON.stringify(diagnostic.mock.calls).includes('private-revival-token')).toBe(false);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith('OLD_POLICY_DELAYED_REVIVAL', {
        sha256: createHash('sha256').update(JSON.stringify(progress)).digest('hex'),
        kind: 'http',
        delayMs: 20,
      });
      expect(ask()).toMatchObject({ kind: 'http', delayMs: 20 });
    } finally {
      diagnostic.mockRestore();
      actualKernel.httpDriverDrop(JSON.stringify(progress.driver ?? null));
    }
  });

  it.each([503, 401])('refresh starts a fresh grant budget without resetting spent resource retries: final %s', async (finalStatus) => {
    let grants = 0;
    let resources = 0;
    const f = await fixture(async (url) => {
      if (url.origin === 'https://auth.example.com') {
        grants += 1;
        return grants % 2 === 1 ? new Response('grant retry', { status: 503 }) : tokenReply(grants === 2 ? 'OLD' : 'NEW');
      }
      resources += 1;
      return new Response('resource response', { status: resources === 1 ? 503 : resources === 2 ? 401 : finalStatus });
    });
    expect(await runHttpCall(f.ports, call('token-exchange', { retry: { max: 1, on: ['5xx'], scheduleMs: [3] } }, {
      auth: { ...auth('token-exchange', { retry: { max: 1, on: ['5xx'], scheduleMs: [3] } }), onUnauthorized: 'refresh' },
      retry: { max: 1, on: ['5xx'], scheduleMs: [7] },
    }), { principal })).toMatchObject({ ok: { status: finalStatus } });
    expect(grants).toBe(4);
    expect(resources).toBe(3);
    expect(f.writes.map(({ value }) => value)).toEqual(['OLD', 'NEW']);
    expect(requests(f.asks).map(({ delayMs }) => delayMs)).toEqual([undefined, 3, undefined, 7, undefined, 3, undefined]);
    expect(requests(f.asks).filter(({ request }) => request.url !== tokenUrl).map(({ request }) => header(request, 'Authorization')))
      .toEqual(['Bearer OLD', 'Bearer OLD', 'Bearer NEW']);
  });
});
