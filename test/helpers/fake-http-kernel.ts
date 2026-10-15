import { isJsonObject, type JsonObject, type JsonValue } from '@almadar/core';
import { createHttpPorts, userCredentialKey, type HttpKernel, type RandomSource, type HttpPorts, type HttpSecrets, type PinnedFetch, type PinnedInit, type PinnedResponse, type ResolvedHost } from '../../src/kernel/http-exchange.js';

/**
 * A stand-in for the `@almadar/kernel` exports with the same JSON shapes, for the host-side tests (asks answered,
 * transport, address, cancel). The real driver's decisions (OAuth, pagination, framing) are orbital-core's and are
 * exercised by the ALMADAR_KERNEL_DIR-gated suite.
 */
function parse(json: string): JsonValue {
  return JSON.parse(json);
}

function objectOf(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isJsonObject(value)) throw new Error('not an object');
  return value;
}

function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

export const OAUTH_CACHE = 'oauth2:https://api.example.com/token|ID';
const PRIVATE = /^(127\.|10\.|169\.254\.|0\.0\.0\.0|::1$)/;
const keyOf = (driver: JsonObject): JsonValue => objectOf(driver.call).key ?? null;
const refused = (error: string, key: JsonValue): JsonValue => ({ kind: 'done', result: { error: { error, kind: 'refused', key } } });
const ask = (driver: JsonObject, value: JsonObject): string => JSON.stringify({ driver, step: { kind: 'ask', ask: value } });
const done = (driver: JsonObject | null, step: JsonValue): string => JSON.stringify({ driver, step });

function httpAsk(driver: JsonObject, bearer: string | undefined): string {
  const call = objectOf(driver.call);
  const request = objectOf(call.request);
  const timeoutMs = typeof request.timeoutMs === 'number' ? request.timeoutMs : undefined;
  const wire = {
    method: textOf(call.method),
    url: `${textOf(call.origin)}${textOf(call.path)}`,
    headers: bearer === undefined ? [] : [['Authorization', `Bearer ${bearer}`]],
    body: { kind: 'empty' },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return ask({ ...driver, phase: 'reply', bearer: bearer ?? null }, typeof request.stream === 'string'
    ? { kind: 'httpStream', request: wire, framing: 'sse' }
    : { kind: 'http', request: wire });
}

function authOf(driver: JsonObject): JsonObject | undefined {
  const auth = objectOf(driver.call).request;
  return isJsonObject(auth) && isJsonObject(auth.auth) ? auth.auth : undefined;
}

function resultOf(answer: JsonObject): JsonObject {
  return objectOf(answer.result);
}

export const fakeHttpKernel: HttpKernel = {
  httpDriverStart(callJson, egressJson) {
    const call = objectOf(parse(callJson));
    const egress = parse(egressJson);
    if (!Array.isArray(egress) || !egress.includes(textOf(call.origin))) return done(null, refused(`${textOf(call.origin)} is not in egress`, call.key ?? null));
    const driver: JsonObject = { call, phase: 'start' };
    const auth = authOf(driver);
    if (auth === undefined) return httpAsk(driver, undefined);
    return ask({ ...driver, phase: 'cached' }, { kind: 'secret', name: auth.scheme === 'oauth2-client' ? OAUTH_CACHE : textOf(auth.credential) });
  },
  httpDriverResume(driverJson, answerJson) {
    const driver = objectOf(parse(driverJson));
    const answer = objectOf(parse(answerJson));
    const result = resultOf(answer);
    const auth = authOf(driver);
    switch (driver.phase) {
      case 'cached': {
        const value = result.ok;
        if (typeof value === 'string') return httpAsk(driver, value);
        if (auth?.scheme !== 'oauth2-client') return done(null, refused(`credential ${textOf(auth?.credential)} is missing`, keyOf(driver)));
        const wire = { method: 'POST', url: textOf(auth.tokenUrl), headers: [], body: { kind: 'text', text: 'grant_type=client_credentials' } };
        return ask({ ...driver, phase: 'granted' }, { kind: 'http', request: wire });
      }
      case 'granted': {
        const reply = objectOf(result.ok);
        const body = objectOf(reply.body);
        const token = textOf(body.text);
        return ask({ ...driver, phase: 'stored', token }, { kind: 'secretSet', name: OAUTH_CACHE, value: token, ttlMs: 3600000 });
      }
      case 'stored':
        return httpAsk(driver, textOf(driver.token));
      case 'reply': {
        if (result.error !== undefined) {
          const failure = objectOf(result.error);
          const payload = failure.kind === 'timedOut' ? { error: 'timed out', kind: 'timeout', key: keyOf(driver) } : { error: textOf(failure.message), kind: failure.kind, key: keyOf(driver) };
          return done(null, { kind: 'done', result: { error: payload } });
        }
        const reply = objectOf(result.ok);
        const headers: { [name: string]: string } = {};
        for (const pair of Array.isArray(reply.headers) ? reply.headers : []) if (Array.isArray(pair)) headers[textOf(pair[0]).toLowerCase()] = textOf(pair[1]);
        const body = objectOf(reply.body);
        return done(null, { kind: 'done', result: { ok: { status: reply.status, headers, body: body.kind === 'text' ? textOf(body.text) : '', key: keyOf(driver) } } });
      }
      default:
        throw new Error(`unknown phase ${String(driver.phase)}`);
    }
  },
  isPublicAddress: (ip) => !PRIVATE.test(ip),
  frameStream(_framing, key, chunk, carry) {
    const parts = (carry + chunk).split('\n\n');
    const rest = parts.pop() ?? '';
    return JSON.stringify({ events: parts.map((part) => ({ data: part.replace(/^data: /, ''), event: null, id: null, key })), carry: rest });
  },
  frameStreamFinish: (_framing, key, carry) =>
    JSON.stringify(carry === '' ? [] : [{ data: carry.replace(/^data: /, ''), event: null, id: null, key }]),
  httpDriverDrop(driverJson) {
    dropped.push(driverJson);
  },
};

/** The driver JSON of every call the host dropped before its final step. */
export const dropped: string[] = [];

export function memorySecrets(initial: { [name: string]: string }): HttpSecrets & { held: Map<string, string> } {
  const held = new Map(Object.entries(initial));
  return {
    held,
    async get(name, principal) { return held.get(principal === undefined ? name : userCredentialKey(principal, name)); },
    async set(name, value, ttlMs, principal) {
      const key = principal === undefined ? name : userCredentialKey(principal, name);
      if (ttlMs <= 0) held.delete(key); else held.set(key, value);
    },
    async forget(name, principal) { held.delete(principal === undefined ? name : userCredentialKey(principal, name)); },
  };
}

export type FakeFetch = (url: string, init: PinnedInit, address: string) => Promise<PinnedResponse> | PinnedResponse;

function pinned(response: Response): PinnedResponse {
  return response;
}

export function replying(status: number, body: string, headers: Array<[string, string]> = []): FakeFetch {
  return () => pinned(new Response(body, { status, headers }));
}

/** A fetch that never answers until its signal aborts. */
export function hangingFetch(seen: AbortSignal[] = []): FakeFetch {
  return (_url, init) => new Promise<PinnedResponse>((_resolve, reject) => {
    const { signal } = init;
    if (signal) {
      seen.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')));
    }
  });
}

export interface FakeApp {
  ports: HttpPorts;
  urls: string[];
  /** The address each fetch was pinned to. */
  pinned: string[];
  secrets: ReturnType<typeof memorySecrets>;
}

export function fakeApp(options: {
  egress?: string[];
  secrets?: { [name: string]: string };
  fetch: FakeFetch;
  resolve?: (host: string) => ResolvedHost;
  random?: RandomSource;
}): FakeApp {
  const urls: string[] = [];
  const pins: string[] = [];
  const secrets = memorySecrets(options.secrets ?? {});
  const recording: PinnedFetch = async (url, init, address) => {
    urls.push(url.href);
    pins.push(address);
    return options.fetch(url.href, init, address);
  };
  const ports = createHttpPorts({
    kernel: async () => fakeHttpKernel,
    ...(options.random !== undefined ? { random: options.random } : {}),
    egress: options.egress ?? ['https://api.example.com'],
    secrets,
    fetch: recording,
    resolve: async (host) => (options.resolve ?? (() => ({ literal: false, addresses: ['93.184.216.34'] })))(host),
  });
  return { ports, urls, pinned: pins, secrets };
}
