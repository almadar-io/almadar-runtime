/**
 * The one TypeScript half of the `http` effect: the host side that moves the bytes the Rust request builder
 * (`@almadar/kernel`, wasm) produced. Both the kernel host (`host.ts`) and the interpreter (`EffectExecutor`)
 * call it; nothing here builds a request, frames a stream or shapes a payload — the wasm exports do.
 */
import { credentialStatusConnected, credentialStorageKey, resolveCredentialStatusIdentity, isJsonObject, type CredentialPayload, type HttpCall, type HttpFailurePayload, type HttpOAuthFailureCode, type HttpOAuthFailureReason, type HttpStreamEvent, type JsonObject, type JsonValue, type RuntimeValue } from '@almadar/core';
import { deliverBeacon, type BeaconDeliveryPorts } from './beacon-port.js';
import { getEffectiveCredentialStore, getModeControl, resolveCredentialRef } from '../host/credentials/scope.js';
import type { CredentialStore } from '../host/credentials/store.js';
import { untilAborted } from '../effects/in-flight-calls.js';
import { decodeHttpRequest, decodeOAuthAsk } from './decode.js';
import type { HttpBody, HttpFailureWire, HttpRequestWire, HttpResponseWire, IoRequestWire } from './wire.js';
import type { OAuthAsk, OAuthReply } from '@almadar/core/kernel-wire';

/**
 * The pure half of `oauth-authorize` (`@almadar/kernel` `oauthAuthorizePlan` / `oauthAuthorizeBuild` / `oauthFailure`);
 * a kernel build without them cannot run the effect.
 */
export interface OAuthAuthorizeKernel {
  /** Parses the client and options: `{ plan, clientId: { name, scope }, issuer, metadata }`; throws the effect's failure message. */
  oauthAuthorizePlan(clientJson: string, optionsJson: string): string;
  /** `{ ok: { authUrl, state, grant } }`, `{ failure: OAuthEffectFailurePayload }` or `{ refused: string }`. */
  oauthAuthorizeBuild(planJson: string, clientId: string, metadataJson: string, stateBase64: string, verifierBase64: string): string;
  /** The mock backend's `{ authUrl, state, grant }` from a plan and the drawn state bytes. */
  oauthAuthorizeMockBuild(planJson: string, stateBase64: string): string;
  /** The failure payload `{ error, code, reason }` of a closed reason. */
  oauthFailure(reason: string): string;
}

/** The `@almadar/kernel` module-level exports the `http` effect uses; each takes and returns JSON text. */
export interface HttpKernel extends Partial<OAuthAuthorizeKernel> {
  httpDriverStart(callJson: string, egressJson: string): string;
  httpDriverResume(driverJson: string, answerJson: string): string;
  isPublicAddress(ip: string): boolean;
  /** Frames a chunk of a stream (`{ events, carry }`); each event carries `key`. The call's driver is not needed. */
  frameStream(framing: StreamFramingWire, key: string | null, chunk: string, carry: string): string;
  /** The events the unterminated tail in `carry` makes at end of body. */
  frameStreamFinish(framing: StreamFramingWire, key: string | null, carry: string): string;
  /** Releases what the kernel holds for a call that ends before its final step (cancelled, aborted, thrown). */
  httpDriverDrop(driverJson: string): void;
}

export type StreamFramingWire = Extract<IoRequestWire, { kind: 'httpStream' }>['framing'];

/** How a stream's body is framed, and the key each framed event echoes. */
export interface StreamFrame {
  framing: StreamFramingWire;
  key: string | null;
}

/**
 * The host's secret store: a credential NAME in, its value out; `set` keeps a minted value (an OAuth2 token) for `ttlMs`.
 * `principal` is the signed-in user's id for a user-scoped credential (the kernel sets it from the dispatch's `@user`,
 * never the program); absent, the credential is app-wide.
 */
export interface HttpSecrets {
  get(name: string, principal?: string): Promise<string | undefined>;
  /** `ttlMs` of 0 forgets the value. */
  set(name: string, value: string, ttlMs: number, principal?: string): Promise<void>;
  /** Replace the stored credential with `value`, durably (a rotated refresh token). A host without one cannot rotate. */
  rotate?(name: string, value: string, principal?: string): Promise<void>;
  /** Drop the credential, the minted value and the stored one. */
  forget(name: string, principal?: string): Promise<void>;
  /** Keep `value` as the credential until it is forgotten, creating it when absent (an OAuth connection's tokens): unlike `rotate` it needs no existing entry. `label` is a non-secret account name stored beside it, never the value. */
  persist?(name: string, value: string, principal?: string, label?: string): Promise<void>;
  /** The non-secret account label stored beside the credential; absent when its row carries none. */
  label?(name: string, principal?: string): Promise<string | undefined>;
  /** Keep a one-use value (a pending OAuth grant) where every instance of the deployment can take it: the credential store's adapter when it shares one-use values, else the minted tier. */
  hold?(name: string, value: string, ttlMs: number, principal?: string): Promise<void>;
  /** Remove and return a held or minted value in one step, the single read of a one-use value. */
  take?(name: string, principal?: string): Promise<string | undefined>;
  /** Whether `persist` keeps a value on this host. */
  durable?(): Promise<boolean>;
}

/** The credential-store key of one user's credential. */
export function userCredentialKey(principal: string, name: string): string {
  return credentialStorageKey({ name, principal });
}

/** Where a host name points: its addresses, and whether the name already is one. */
export interface ResolvedHost {
  literal: boolean;
  addresses: readonly string[];
}

export interface PinnedInit {
  method: string;
  headers: Array<[string, string]>;
  body?: Uint8Array<ArrayBuffer>;
  redirect: 'manual';
  signal?: AbortSignal;
}

/** The part of a fetch response the exchange reads. */
export interface PinnedResponse {
  status: number;
  headers: { entries(): IterableIterator<[string, string]> };
  body: { getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?(): Promise<void>;
    releaseLock?(): void;
  } } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Fetch with the connection pinned to `address`, the one that was checked (no resolve-then-connect race). */
export type PinnedFetch = (url: URL, init: PinnedInit, address: string) => Promise<PinnedResponse>;

/** CSPRNG output: `bytes` random bytes. */
export type RandomSource = (bytes: number) => Uint8Array;

/**
 * The host's raw credential store and mode flag, answered to the kernel's `credentialStore*` and `credentialMode*`
 * asks. It decides nothing: the role gate, the declared-name check, the masking and the mode check are the kernel's.
 */
export interface CredentialAdminPort {
  /** Whether the store can encrypt and the service and name of every stored row; `null` when the host holds no store. */
  list(): Promise<{ enabled: boolean; entries: Array<{ service: string; name: string }> } | null>;
  /** The stored value of credential `name`, from the store only. */
  read(name: string): Promise<string | null>;
  write(service: string, name: string, value: string): Promise<void>;
  /** Whether a stored row existed. */
  remove(name: string): Promise<boolean>;
  rotate(): Promise<{ rotated: number; alreadyCurrent: number; unreadable: number }>;
  /** The mode flag; `null` when the host keeps none. */
  mode(): Promise<string | null>;
  /** Switch the flag; the host may refuse. The mode in force afterwards. */
  setMode(mode: string): Promise<string>;
}

export interface HttpPorts {
  kernel: () => Promise<HttpKernel>;
  /** The host CSPRNG `random-bytes` and the driver's `Random` ask draw from. */
  random: RandomSource;
  /** The program's declared `egress` origins. */
  egress: readonly string[];
  secrets: HttpSecrets;
  /** The credential store and mode flag the credential administration effects ask; absent, those asks fail unavailable. */
  credentials?: CredentialAdminPort;
  fetch: PinnedFetch;
  /** Looks a host up for the public-address check; `null` where the host cannot resolve a name (a browser). */
  resolve: ((host: string) => Promise<ResolvedHost>) | null;
  /** The host's beacon queue and keepalive fetch; absent, a `browser/beacon` call fails `unavailable`. */
  beacon?: BeaconDeliveryPorts;
  /** What an `oauth-client` call and the OAuth effects persist; absent, they fail `store-unavailable`. */
  oauth?: OAuthPort;
}

export interface HttpPortsOptions {
  kernel: () => Promise<HttpKernel>;
  random?: RandomSource;
  egress: readonly string[];
  secrets?: HttpSecrets;
  /** Defaults to the installed credential store and mode flag. */
  credentials?: CredentialAdminPort;
  fetch?: PinnedFetch;
  resolve?: (host: string) => Promise<ResolvedHost>;
  /** What `oauth-client` calls and the OAuth effects persist; absent, they fail `store-unavailable`. */
  oauth?: OAuthPort;
}

export interface BrowserHttpPortsOptions {
  kernel: () => Promise<HttpKernel>;
  /** The program's declared `egress` origins. */
  egress: readonly string[];
  /** Defaults to the global `fetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<PinnedResponse & Response>;
  /** Defaults to `navigator.sendBeacon` (text/plain Blob) when the page has one, and the global `fetch`. */
  beacon?: BeaconDeliveryPorts;
}

/**
 * What an OAuth flow asks its host to keep (pending grants, connections, the subject index, discovered metadata,
 * the clock). `principal` is the dispatch's signed-in user, set by the kernel and never by the program.
 */
export interface OAuthPort {
  answer(ask: OAuthAsk, principal: string | undefined): Promise<OAuthReply>;
}

/** The loud, coded error for a host that gave the `http` effect no ports. */
export class HttpUnavailableError extends Error {
  readonly code = 'HTTP_KERNEL_UNAVAILABLE';
  constructor(detail: string) {
    super(`HTTP_KERNEL_UNAVAILABLE: ${detail}`);
  }
}

/** A failed `http` effect: its payload is what the `emit.failure` route carries. */
export class HttpEffectFailure extends Error {
  constructor(readonly payload: HttpFailurePayload) {
    super(payload.error);
  }
}

/** The service label a kernel-persisted credential (an OAuth connection) carries in the credential store. */
const PERSISTED_SERVICE = 'kernel';

/** Where the secrets' durable credentials live: the store a host installed, and how a name resolves through it. */
export interface HttpSecretsHost {
  store(): Promise<CredentialStore | null>;
  resolve(name: string, principal: string | undefined): Promise<string | undefined>;
}

/** The credential store the host installed, with its environment fallback. */
const installedSecretsHost: HttpSecretsHost = {
  async store() {
    return getEffectiveCredentialStore();
  },
  async resolve(name, principal) {
    return resolveCredentialRef(name, undefined, principal);
  },
};

/** In-process secrets: minted values with an expiry, then the credential store the host holds (by default the one the host installed). */
export function createHttpSecrets(now: () => number = Date.now, host: HttpSecretsHost = installedSecretsHost): HttpSecrets {
  type Minted = Map<string, { value: string; expiresAt: number }>;
  const environmentMinted: Minted = new Map();
  const storeMinted = new WeakMap<CredentialStore, Minted>();
  const cacheFor = (store: CredentialStore | null): Minted => {
    if (store === null) return environmentMinted;
    const held = storeMinted.get(store);
    if (held !== undefined) return held;
    const cache: Minted = new Map();
    storeMinted.set(store, cache);
    return cache;
  };
  const slot = (name: string, principal: string | undefined): string => credentialStorageKey({ name, ...(principal !== undefined ? { principal } : {}) });
  return {
    async get(name, principal) {
      const minted = cacheFor(await host.store());
      const key = slot(name, principal);
      const held = minted.get(key);
      if (held !== undefined) {
        if (held.expiresAt > now()) return held.value;
        minted.delete(key);
      }
      return host.resolve(name, principal);
    },
    async set(name, value, ttlMs, principal) {
      const minted = cacheFor(await host.store());
      const key = slot(name, principal);
      if (ttlMs <= 0) minted.delete(key);
      else minted.set(key, { value, expiresAt: now() + ttlMs });
    },
    async rotate(name, value, principal) {
      const store = await host.store();
      if (store === null) throw new Error('this host keeps no credential store to rotate into');
      const stored = store.entries(principal).find((entry) => entry.envVar === name);
      if (stored === undefined) throw new Error(`credential ${name} is not in the credential store`);
      cacheFor(store).delete(slot(name, principal));
      await store.set(stored.service, name, value, principal);
    },
    async persist(name, value, principal, label) {
      const store = await host.store();
      if (store === null || !store.enabled) throw new Error('this host keeps no credential store to persist into');
      cacheFor(store).delete(slot(name, principal));
      await store.set(PERSISTED_SERVICE, name, value, principal, label);
    },
    async hold(name, value, ttlMs, principal) {
      const store = await host.store();
      const minted = cacheFor(store);
      const key = slot(name, principal);
      if (store !== null && store.sharesDerived) {
        minted.delete(key);
        if (ttlMs > 0) await store.holdDerived(name, value, now() + ttlMs, principal);
        return;
      }
      if (ttlMs <= 0) minted.delete(key);
      else minted.set(key, { value, expiresAt: now() + ttlMs });
    },
    async take(name, principal) {
      const store = await host.store();
      if (store !== null && store.sharesDerived) {
        const shared = await store.takeDerived(name, principal, now());
        if (shared !== undefined) return shared;
      }
      const minted = cacheFor(store);
      const key = slot(name, principal);
      const held = minted.get(key);
      if (held === undefined) return undefined;
      minted.delete(key);
      return held.expiresAt > now() ? held.value : undefined;
    },
    async label(name, principal) {
      return (await host.store())?.label(name, principal);
    },
    async durable() {
      const store = await host.store();
      return store !== null && store.enabled;
    },
    async forget(name, principal) {
      const store = await host.store();
      const minted = cacheFor(store);
      const key = slot(name, principal);
      minted.delete(key);
      await store?.remove(name, principal);
    },
  };
}

/** The credential store and mode flag the host installed, as the kernel's raw asks. */
export function createCredentialAdminPort(): CredentialAdminPort {
  return {
    async list() {
      const store = getEffectiveCredentialStore();
      if (store === null) return null;
      return { enabled: store.enabled, entries: store.entries().map((entry) => ({ service: entry.service, name: entry.envVar })) };
    },
    async read(name) {
      return getEffectiveCredentialStore()?.resolve(name) ?? null;
    },
    async write(service, name, value) {
      const store = getEffectiveCredentialStore();
      if (store === null) throw new Error('this host keeps no credential store');
      await store.set(service, name, value);
    },
    async remove(name) {
      const store = getEffectiveCredentialStore();
      if (store === null) throw new Error('this host keeps no credential store');
      return store.remove(name);
    },
    async rotate() {
      const store = getEffectiveCredentialStore();
      if (store === null) throw new Error('this host keeps no credential store');
      return store.rotate();
    },
    async mode() {
      return getModeControl()?.mode ?? null;
    },
    async setMode(mode) {
      const control = getModeControl();
      if (control === null) throw new Error('No integration manager is installed on this host');
      if (mode !== 'mock' && mode !== 'real') throw new Error(`mode must be "mock" or "real", got "${mode}"`);
      control.setMode(mode);
      return control.mode;
    },
  };
}

/** Bytes from the platform CSPRNG. */
export const systemRandom: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

/** The most bytes one `random-bytes` may ask for (the kernel's `RANDOM_BYTES_MAX`). */
export const RANDOM_BYTES_MAX = 1024;

function binary(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** Standard padded base64 (the wire form of a `Random` answer). */
export function base64Standard(bytes: Uint8Array): string {
  return btoa(binary(bytes));
}

/** URL-safe base64 without padding (the `random-bytes` value; the kernel's `codec::base64url_encode`). */
export function base64Url(bytes: Uint8Array): string {
  return base64Standard(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * `random-bytes`: the success payload for `bytes` drawn from the host CSPRNG; a bad count or key is the effect's
 * failure. A keyed call echoes its `key` beside the `value`.
 */
export function randomBytesPayload(ports: Pick<HttpPorts, 'random'>, bytes: RuntimeValue | undefined, key?: RuntimeValue): { value: string; key?: string } {
  if (key !== undefined && (typeof key !== 'string' || key === '')) {
    throw new Error(`call key must evaluate to a non-empty string, got ${String(key)}`);
  }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > RANDOM_BYTES_MAX) {
    throw new Error(`random-bytes: the byte count must be an integer from 1 to ${RANDOM_BYTES_MAX}, got ${String(bytes)}`);
  }
  const value = base64Url(ports.random(bytes));
  return key === undefined ? { value } : { value, key };
}

function signedIn(head: string, principal: string | undefined): string {
  if (principal === undefined) throw new Error(`${head}: nobody is signed in`);
  return principal;
}

function credentialName(head: string, credential: RuntimeValue | undefined): string {
  if (typeof credential !== 'string') throw new Error(`${head}: the credential must be a secret knob's name`);
  return credential;
}

/** `credential-status`: a bare name selects the viewer; an explicit slot selects its declared scope. */
export async function credentialStatusPayload(
  ports: Pick<HttpPorts, 'secrets'>,
  credential: RuntimeValue | undefined,
  principal: string | undefined,
): Promise<CredentialPayload> {
  const identity = resolveCredentialStatusIdentity(credential, principal);
  const connected = credentialStatusConnected(await ports.secrets.get(identity.name, identity.principal), identity.principal);
  const label = connected ? ((await ports.secrets.label?.(identity.name, identity.principal)) ?? '') : '';
  return { connected, label };
}

/** `credential-forget`: drops the signed-in viewer's credential; `{ connected: false }`. */
export async function credentialForgetPayload(
  ports: Pick<HttpPorts, 'secrets'>,
  credential: RuntimeValue | undefined,
  principal: string | undefined,
): Promise<{ connected: false; label: string }> {
  const who = signedIn('credential-forget', principal);
  const name = credentialName('credential-forget', credential);
  await ports.secrets.forget(name, who);
  return { connected: false, label: '' };
}

async function systemResolve(host: string): Promise<ResolvedHost> {
  const { isIP } = await import('node:net');
  if (isIP(host) !== 0) return { literal: true, addresses: [host] };
  const { lookup } = await import('node:dns/promises');
  const found = await lookup(host, { all: true });
  return { literal: false, addresses: found.map((entry) => entry.address) };
}

const pinnedFetch: PinnedFetch = async (url, init, address) => {
  const { pinnedFetchNode } = await import('./pinned-fetch-node.js');
  return pinnedFetchNode(url, init, address);
};

export function createHttpPorts(options: HttpPortsOptions): HttpPorts {
  return {
    kernel: options.kernel,
    random: options.random ?? systemRandom,
    egress: options.egress,
    secrets: options.secrets ?? createHttpSecrets(),
    credentials: options.credentials ?? createCredentialAdminPort(),
    fetch: options.fetch ?? pinnedFetch,
    resolve: options.resolve ?? systemResolve,
    ...(options.oauth !== undefined ? { oauth: options.oauth } : {}),
  };
}

/** A browser holds no credential: a keyless call never asks for one, and a keyed call must not reach a browser. */
const browserSecrets: HttpSecrets = {
  async get(name) {
    throw new Error(`credential ${name} is not available in a browser`);
  },
  async set(name) {
    throw new Error(`credential ${name} cannot be stored in a browser`);
  },
  async forget(name) {
    throw new Error(`credential ${name} cannot be forgotten in a browser`);
  },
};

/**
 * Ports for a client-site `http` (a call with no `auth`): the same kernel driver and exchange as the server,
 * over the browser's `fetch`. A browser cannot resolve a name or pin a connection, so there is no
 * public-address check; the program's `egress` (the driver refuses any other origin) and the browser's own
 * CORS rules bound what the call reaches.
 */
export function createBrowserHttpPorts(options: BrowserHttpPortsOptions): HttpPorts {
  const browserFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    kernel: options.kernel,
    random: systemRandom,
    egress: options.egress,
    secrets: browserSecrets,
    fetch: (url, init) => browserFetch(url.href, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: init.redirect, ...(init.signal !== undefined ? { signal: init.signal } : {}) }),
    resolve: null,
    beacon: options.beacon ?? browserBeaconPorts(),
  };
}

/** The page's own beacon queue (when it has one) and `fetch`. */
function browserBeaconPorts(): BeaconDeliveryPorts {
  const hasQueue = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
  return {
    ...(hasQueue ? { queue: (url: string, text: string): boolean => navigator.sendBeacon(url, new Blob([text], { type: 'text/plain' })) } : {}),
    fetch: async (url, init) => ({ status: (await fetch(url, init)).status }),
  };
}

/** What one exchange came to; a cancelled exchange is the caller's abort signal, never an outcome. */
export type Exchange =
  | { kind: 'reply'; response: HttpResponseWire }
  | { kind: 'failure'; failure: HttpFailureWire };

function parsed(json: string): JsonValue {
  return JSON.parse(json);
}

function record(value: JsonValue, what: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${what} is not an object`);
  return value;
}

function bodyBytes(body: HttpBody): Uint8Array<ArrayBuffer> | undefined {
  switch (body.kind) {
    case 'empty':
      return undefined;
    case 'text':
      return new TextEncoder().encode(body.text);
    case 'base64':
      return Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0));
  }
}

function wireBody(bytes: Uint8Array): HttpBody {
  if (bytes.length === 0) return { kind: 'empty' };
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { kind: 'base64', data: btoa(binary) };
  }
}

function refusal(message: string): Exchange {
  return { kind: 'failure', failure: { kind: 'refused', message } };
}

/** The address a request may be sent to (the one every check passed), or the refusal. */
async function checkedAddress(ports: HttpPorts, kernel: HttpKernel, url: URL): Promise<{ address: string } | { refused: string }> {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (ports.resolve === null) return { address: host };
  const resolved = await ports.resolve(host);
  const [first] = resolved.addresses;
  if (first === undefined) return { refused: `${host} resolves to no address` };
  if (resolved.literal && ports.egress.includes(url.origin)) return { address: first };
  const closed = resolved.addresses.find((address) => !kernel.isPublicAddress(address));
  if (closed !== undefined) return { refused: `${host} resolves to ${closed}, which is not a public address` };
  return { address: first };
}

/**
 * Send one built request. `signal` is the caller's cancel: when it aborts, this rejects (the keyed-call
 * registry reads that as a cancel). A timeout or a transport error is an outcome, not a throw.
 */
async function dispatch(
  ports: HttpPorts,
  request: HttpRequestWire,
  signal: AbortSignal | undefined,
  read: (response: PinnedResponse, signal: AbortSignal | undefined) => Promise<Exchange>,
): Promise<Exchange> {
  const kernel = await ports.kernel();
  signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return refusal(`${request.url} is not a URL`);
  }
  const timeout = request.timeoutMs !== undefined ? AbortSignal.timeout(request.timeoutMs) : undefined;
  const signals = [signal, timeout].filter((s): s is AbortSignal => s !== undefined);
  const operationSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  const body = bodyBytes(request.body);
  try {
    const lookup = checkedAddress(ports, kernel, url);
    const checked = operationSignal !== undefined ? await untilAborted(operationSignal, lookup) : await lookup;
    operationSignal?.throwIfAborted();
    if ('refused' in checked) return refusal(checked.refused);
    const response = await ports.fetch(url, {
      method: request.method,
      headers: request.headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
      ...(operationSignal !== undefined ? { signal: operationSignal } : {}),
    }, checked.address);
    operationSignal?.throwIfAborted();
    return await read(response, operationSignal);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (timeout?.aborted === true) return { kind: 'failure', failure: { kind: 'timedOut' } };
    return { kind: 'failure', failure: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } };
  }
}

function headerPairs(response: PinnedResponse): Array<[string, string]> {
  return Array.from(response.headers.entries());
}

async function waitForHttpDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (!Number.isFinite(delayMs) || !Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error('http delayMs must be a nonnegative whole number');
  }
  signal?.throwIfAborted();
  let remaining = delayMs;
  while (remaining > 0) {
    signal?.throwIfAborted();
    const duration = Math.min(remaining, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, duration);
      function onAbort(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.reason ?? new Error('The call was cancelled'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    remaining -= duration;
  }
}

/** Send one built request after its requested retry delay and read the whole reply. */
export async function sendHttp(ports: HttpPorts, request: HttpRequestWire, signal?: AbortSignal, delayMs = 0): Promise<Exchange> {
  await waitForHttpDelay(delayMs, signal);
  return dispatch(ports, request, signal, async (response) => ({
    kind: 'reply',
    response: { status: response.status, headers: headerPairs(response), body: wireBody(new Uint8Array(await response.arrayBuffer())) },
  }));
}

function streamEvent(value: JsonValue): HttpStreamEvent {
  const event = record(value, 'a stream event');
  const { data, event: name, id, key } = event;
  if (typeof data !== 'string' || (name !== null && typeof name !== 'string') || (id !== null && typeof id !== 'string') || (key !== null && typeof key !== 'string')) {
    throw new Error('a stream event is malformed');
  }
  return { data, event: name, id, key };
}

/**
 * Send one built request and hand each framed event of the body to `onEvent` as it arrives; the reply that
 * ends the exchange carries an empty body. Framing, and the `key` each event echoes, are the kernel's
 * (`frameStream`, `frameStreamFinish`) over the ask's `framing` and `key`.
 */
export function streamHttp(
  ports: HttpPorts,
  request: HttpRequestWire,
  stream: StreamFrame,
  onEvent: (event: HttpStreamEvent) => void,
  signal?: AbortSignal,
): Promise<Exchange> {
  return dispatch(ports, request, signal, async (response, readSignal) => {
    const kernel = await ports.kernel();
    readSignal?.throwIfAborted();
    const decoder = new TextDecoder();
    let carry = '';
    const publish = (chunk: string): void => {
      readSignal?.throwIfAborted();
      const framed = record(parsed(kernel.frameStream(stream.framing, stream.key, chunk, carry)), 'frameStream result');
      const { events, carry: rest } = framed;
      if (!Array.isArray(events) || typeof rest !== 'string') throw new Error('frameStream result is malformed');
      carry = rest;
      for (const event of events) {
        readSignal?.throwIfAborted();
        onEvent(streamEvent(event));
      }
    };
    const reader = response.body?.getReader();
    let completed = false;
    try {
      if (reader !== undefined) {
        for (;;) {
          const pending = reader.read();
          const next = readSignal !== undefined ? await untilAborted(readSignal, pending) : await pending;
          readSignal?.throwIfAborted();
          if (next.done) break;
          publish(decoder.decode(next.value, { stream: true }));
        }
      }
      const tail = decoder.decode();
      if (tail !== '') publish(tail);
      readSignal?.throwIfAborted();
      const flushed = parsed(kernel.frameStreamFinish(stream.framing, stream.key, carry));
      if (!Array.isArray(flushed)) throw new Error('frameStreamFinish result is malformed');
      for (const event of flushed) {
        readSignal?.throwIfAborted();
        onEvent(streamEvent(event));
      }
      readSignal?.throwIfAborted();
      completed = true;
      return { kind: 'reply', response: { status: response.status, headers: headerPairs(response), body: { kind: 'empty' } } };
    } finally {
      if (!completed) {
        // Reader cleanup must not replace the cancellation or transport outcome.
        void Promise.resolve().then(() => reader?.cancel?.()).catch(() => undefined);
      }
      void Promise.resolve().then(() => reader?.releaseLock?.()).catch(() => undefined);
    }
  });
}

/** How a host took one beacon, as the driver's `beacon` answer carries it; a fetch that threw is a failure. */
export type BeaconSettled = { ok: { via: 'queue' } | { via: 'fetch'; status: number } | { via: 'unavailable'; message: string } } | { error: { kind: 'failed'; message: string } };

const BEACON_UNAVAILABLE = 'browser/beacon: this host has no beacon port';

/**
 * Hand one built beacon request to the host's beacon port. Cancelling stops the wait only: the queue and the
 * fetch the browser already has are never aborted, and a late completion is dropped.
 */
export async function sendBeaconRequest(ports: HttpPorts, request: HttpRequestWire, signal?: AbortSignal): Promise<BeaconSettled> {
  if (ports.beacon === undefined) return { ok: { via: 'unavailable', message: BEACON_UNAVAILABLE } };
  if (request.body.kind !== 'text') throw new Error('a beacon request carries a text body');
  signal?.throwIfAborted();
  const delivery = deliverBeacon(request.url, request.body.text, ports.beacon).then((taken): BeaconSettled =>
    taken.via === 'fetch' && taken.status === null
      ? { error: { kind: 'failed', message: 'the beacon fetch failed' } }
      : { ok: taken.via === 'queue' ? { via: 'queue' } : { via: 'fetch', status: taken.status ?? 0 } });
  return signal !== undefined ? untilAborted(signal, delivery) : delivery;
}

export type { HttpCall } from '@almadar/core';

export type HttpOutcome = { ok: JsonValue } | { error: HttpFailurePayload };

export interface HttpRunOptions {
  signal?: AbortSignal;
  /** The dispatch's signed-in user id: whose credential a `scope: "user"` ask names (never set by the program). */
  principal?: string | undefined;
  /** Receives each framed event of a `stream` call. */
  onMessage?: (event: HttpStreamEvent) => void;
}

export { decodeOAuthAsk };

export function isOAuthCode(value: JsonValue | undefined): value is HttpOAuthFailureCode {
  return value === 'AUTH_ERROR' || value === 'VALIDATION_ERROR' || value === 'NOT_CONFIGURED' || value === 'SERVICE_ERROR' || value === 'NETWORK_ERROR';
}

export function isOAuthReason(value: JsonValue | undefined): value is HttpOAuthFailureReason {
  switch (value) {
    case 'state-unknown': case 'state-expired': case 'subject-mismatch': case 'provider-mismatch': case 'not-signed-in':
    case 'store-unavailable': case 'metadata-invalid': case 'response-invalid': case 'token-rejected':
    case 'userinfo-mismatch': case 'unconfigured-client':
      return true;
    default:
      return false;
  }
}

/** The failure of a call whose host has no port for what it needs. */
export function unavailableFailure(error: string, key: string | null): HttpFailurePayload {
  return { error, kind: 'unavailable', key, credential: null, phase: null, grantStatus: null, grantBody: null, code: null, reason: null };
}

function decodeFailurePayload(value: JsonValue): HttpFailurePayload {
  const payload = record(value, 'a failure payload');
  const { error, kind, key, credential, phase, grantStatus, grantBody, code, reason } = payload;
  const malformed = (): never => {
    throw new Error('a failure payload is malformed');
  };
  if (typeof error !== 'string' || (key !== null && typeof key !== 'string')) return malformed();
  if (phase !== null && phase !== 'grant' && phase !== 'request') return malformed();
  if (grantStatus !== null && typeof grantStatus !== 'number') return malformed();
  if (grantBody !== null && typeof grantBody !== 'string') return malformed();
  if (kind === 'oauth') {
    if (credential !== null || phase !== null || grantStatus !== null || grantBody !== null) return malformed();
    if (!isOAuthCode(code) || !isOAuthReason(reason)) return malformed();
    return { ...payload, error, kind, key, credential, phase, grantStatus, grantBody, code, reason };
  }
  if (code !== null || reason !== null) return malformed();
  if (kind === 'unconfigured' && typeof credential === 'string') {
    return { ...payload, error, kind, key, credential, phase, grantStatus, grantBody, code, reason };
  }
  if ((kind === 'timeout' || kind === 'failed' || kind === 'refused' || kind === 'unavailable') && credential === null) {
    return { ...payload, error, kind, key, credential, phase, grantStatus, grantBody, code, reason };
  }
  return malformed();
}

function failureAnswer(failure: HttpFailureWire): JsonValue {
  switch (failure.kind) {
    case 'timedOut':
      return { kind: 'timedOut' };
    case 'failed':
    case 'refused':
      return { kind: failure.kind, message: failure.message };
  }
}

function exchangeAnswer(exchange: Exchange): JsonValue {
  return { kind: 'http', result: exchange.kind === 'reply' ? { ok: { ...exchange.response } } : { error: failureAnswer(exchange.failure) } };
}

function settledAnswer(kind: 'secret' | 'secretSet' | 'secretRotate' | 'random', outcome: { ok: string | null } | { error: string }): JsonValue {
  return { kind, result: outcome };
}

/** The reply the port answered, checked to be one of the closed reply variants. */
export function checkOAuthReply(reply: OAuthReply): OAuthReply {
  switch (reply.reply) {
    case 'done': case 'flag': case 'taken': case 'row': case 'subject': case 'metadata': case 'millis': case 'mockToken': case 'code':
      return reply;
  }
}

const OAUTH_UNAVAILABLE = 'this host keeps no OAuth state';

async function oauthAnswer(ports: HttpPorts, ask: OAuthAsk, principal: string | undefined): Promise<JsonValue> {
  if (ports.oauth === undefined) return { kind: 'oauth', result: { error: OAUTH_UNAVAILABLE } };
  try {
    return { kind: 'oauth', result: { ok: checkOAuthReply(await ports.oauth.answer(ask, principal)) } };
  } catch (error) {
    return { kind: 'oauth', result: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Whose credential an ask names: the app's (`undefined`) or, for `scope: "user"`, the dispatch's signed-in user. */
function askOwner(ask: JsonObject, principal: string | undefined): { owner: string | undefined } | { error: string } {
  if (ask.scope === undefined || ask.scope === 'app') return { owner: undefined };
  if (ask.scope !== 'user') throw new Error(`driver ask "${String(ask.kind)}" has an unknown scope`);
  return principal === undefined ? { error: 'nobody is signed in' } : { owner: principal };
}

async function answerAsk(ports: HttpPorts, ask: JsonObject, key: string | null, options: HttpRunOptions): Promise<JsonValue> {
  const { kind } = ask;
  switch (kind) {
    case 'secret': {
      if (typeof ask.name !== 'string') throw new Error('driver ask "secret" has no name');
      const who = askOwner(ask, options.principal);
      if ('error' in who) return settledAnswer('secret', who);
      try {
        return settledAnswer('secret', { ok: (await ports.secrets.get(ask.name, who.owner)) ?? null });
      } catch (error) {
        return settledAnswer('secret', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    case 'secretSet': {
      if (typeof ask.name !== 'string' || typeof ask.value !== 'string' || typeof ask.ttlMs !== 'number') throw new Error('driver ask "secretSet" is malformed');
      const who = askOwner(ask, options.principal);
      if ('error' in who) return settledAnswer('secretSet', who);
      try {
        await ports.secrets.set(ask.name, ask.value, ask.ttlMs, who.owner);
        return settledAnswer('secretSet', { ok: null });
      } catch (error) {
        return settledAnswer('secretSet', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    case 'secretRotate': {
      if (typeof ask.name !== 'string' || typeof ask.value !== 'string') throw new Error('driver ask "secretRotate" is malformed');
      const who = askOwner(ask, options.principal);
      if ('error' in who) return settledAnswer('secretRotate', who);
      try {
        if (ports.secrets.rotate === undefined) throw new Error('this host keeps no rotatable credentials');
        await ports.secrets.rotate(ask.name, ask.value, who.owner);
        return settledAnswer('secretRotate', { ok: null });
      } catch (error) {
        return settledAnswer('secretRotate', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    case 'oauth':
      return oauthAnswer(ports, decodeOAuthAsk(ask.ask), options.principal);
    case 'random': {
      if (typeof ask.bytes !== 'number' || !Number.isInteger(ask.bytes) || ask.bytes < 0) throw new Error('driver ask "random" is malformed');
      try {
        return settledAnswer('random', { ok: base64Standard(ports.random(ask.bytes)) });
      } catch (error) {
        return settledAnswer('random', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    case 'http': {
      const delayMs = ask.delayMs;
      if (delayMs !== undefined && typeof delayMs !== 'number') throw new Error('driver ask "http" has a malformed delayMs');
      return exchangeAnswer(await sendHttp(ports, decodeHttpRequest(askRequest(ask)), options.signal, delayMs));
    }
    case 'beacon': {
      return { kind: 'beacon', result: await sendBeaconRequest(ports, decodeHttpRequest(askRequest(ask)), options.signal) };
    }
    case 'httpStream': {
      const framing = ask.framing;
      if (framing !== 'sse' && framing !== 'jsonLines') throw new Error('driver ask "httpStream" has an unknown framing');
      const onEvent = options.onMessage ?? ((): void => undefined);
      return exchangeAnswer(await streamHttp(ports, decodeHttpRequest(askRequest(ask)), { framing, key }, onEvent, options.signal));
    }
    default:
      throw new Error(`driver asked for unknown "${String(kind)}"`);
  }
}

function askRequest(ask: JsonObject): JsonValue {
  const request = ask.request;
  if (request === undefined) throw new Error(`driver ask "${String(ask.kind)}" has no request`);
  return request;
}

/**
 * One `http` effect, driven by the kernel's step machine (`httpDriverStart`/`httpDriverResume`): every ask
 * (credential, token store, request, stream) is answered here and nothing else is decided in TypeScript.
 */
export async function runHttpCall(ports: HttpPorts, call: HttpCall, options: HttpRunOptions = {}): Promise<HttpOutcome> {
  if (call.delivery === 'beacon' && ports.beacon === undefined) return { error: unavailableFailure(BEACON_UNAVAILABLE, call.key ?? null) };
  const kernel = await ports.kernel();
  const key = call.key ?? null;
  const started = options.principal !== undefined ? { ...call, principal: options.principal } : call;
  let progress = record(parsed(kernel.httpDriverStart(JSON.stringify(started), JSON.stringify(ports.egress))), 'httpDriverStart result');
  for (;;) {
    const step = record(progress.step ?? null, 'the driver step');
    if (step.kind === 'done') {
      const result = record(step.result ?? null, 'the driver result');
      if (result.ok !== undefined) return { ok: result.ok };
      if (result.error !== undefined) return { error: decodeFailurePayload(result.error) };
      throw new Error('the driver finished with neither ok nor error');
    }
    if (step.kind !== 'ask') throw new Error(`the driver step "${String(step.kind)}" is unknown`);
    const driver = JSON.stringify(progress.driver ?? null);
    try {
      const answer = await answerAsk(ports, record(step.ask ?? null, 'the driver ask'), key, options);
      progress = record(parsed(kernel.httpDriverResume(driver, JSON.stringify(answer))), 'httpDriverResume result');
    } catch (error) {
      kernel.httpDriverDrop(driver);
      throw error;
    }
  }
}
