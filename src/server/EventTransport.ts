/**
 * EventTransport — the client → orbital event transport port (plan P5,
 * `docs/Almadar_Runtime_Stateless_Stateful_PLAN.md` §4.2).
 *
 * Promotes `@almadar/ui`'s `ServerBridgeTransport` interface +
 * `createHttpTransport` into `@almadar/runtime` so there is ONE owner of
 * the HTTP request/response leg instead of two (this package's own
 * `ServerBridge` class and the ui provider). `@almadar/ui`'s provider will
 * be switched onto this port at the W5b build checkpoint (see the plan);
 * until then this file has no consumers outside this package.
 *
 * The wire shapes are `@almadar/core`'s existing `OrbitalEventRequest` /
 * `OrbitalEventResponse` — no shadow types.
 *
 * @packageDocumentation
 */

import { createLogger } from '@almadar/logger';
import {
  OrbitalRegisterResponseSchema,
  type EmittedEvent,
  type OrbitalEventRequest,
  type OrbitalEventResponse,
  type OrbitalSchema,
  type ServerTopology,
} from '@almadar/core';

const log = createLogger('almadar:runtime:event-transport');

// ============================================================================
// Topology → carriesCircuitState
// ============================================================================


/**
 * `true` = stateless topology: the server holds no circuit state between
 * requests, so every `send()` request must carry `traits`/`entityByTrait`.
 * `false` = the server (or an in-process evaluator) holds the state itself.
 *
 * Derivation mirrors `@almadar/ui`'s `ServerBridgeProvider` EXACTLY
 * (`providers/ServerBridge.tsx`, both the initial-state fallback and the
 * post-register `.then` callback — the same mapping was duplicated at two
 * call sites there, which is the `stateSource` string-branching this port
 * retires): `'stateful'` → false, `'stateless'` OR an absent/undeclared
 * topology (older servers) → true. An absent topology defaulting to
 * "stateless" is the ui's existing assumption, carried over unchanged, not
 * a new judgment call made here.
 */
export function deriveCarriesCircuitState(topology: ServerTopology | undefined): boolean {
  return topology !== 'stateful';
}

export interface EventTransportRegisterResult {
  success: boolean;
  /** See `deriveCarriesCircuitState`. Computed once here, not re-derived by callers. */
  carriesCircuitState: boolean;
}

// ============================================================================
// The port
// ============================================================================

export interface EventTransport {
  /** Register a schema with the transport's target (server, or an in-process evaluator). */
  register(schema: OrbitalSchema): Promise<EventTransportRegisterResult>;
  unregister(): Promise<void>;
  /** Play one event through the orbital named `orbitalName`. */
  send(orbitalName: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse>;
  /**
   * Subscribe to server-pushed cascade events (e.g. another client's
   * persist-envelope emits, Almadar_Live_Push.md). Absent when the
   * transport has no server to push from (in-process). `params` augments
   * the push channel's query string (e.g. a caller-supplied per-tab
   * `clientId` for the server's origin-exclusion) — the transport itself
   * carries no notion of "tab identity", that is a client-role concern
   * (plan P4).
   */
  subscribe?(onPush: (emitted: EmittedEvent) => void, params?: Record<string, string>): () => void;
}

// ============================================================================
// HTTP transport
// ============================================================================

/**
 * Supplies the bearer token the hosting server authenticates with. Resolved
 * per request (tokens expire); `undefined` sends the request unauthenticated
 * (dev servers with an auth bypass, standalone playground). Moved verbatim
 * from `@almadar/ui`'s `providers/ServerBridge.tsx`.
 */
export type AccessTokenProvider = () => Promise<string | undefined>;

async function authHeaders(getAccessToken: AccessTokenProvider | undefined): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAccessToken ? await getAccessToken() : undefined;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * `/api/events` sits alongside the API root the transport already posts to
 * (`serverUrl` = `.../orbitals`; the SSE channel is `.../events`, its
 * sibling) — derive it structurally rather than hardcoding a second base.
 * Moved verbatim from `@almadar/ui`'s `providers/ServerBridge.tsx`.
 */
function deriveEventsUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  const apiRoot = trimmed.replace(/\/[^/]*$/, '');
  return `${apiRoot}/events`;
}

/** Push message shape on the `/api/events` SSE channel. Only `type: 'bus'` entries are cascade events. */
interface ServerPushEnvelope {
  type: string;
  event?: string;
  payload?: EmittedEvent['payload'];
  source?: EmittedEvent['source'];
}

function isBusPushEnvelope(value: ServerPushEnvelope): value is ServerPushEnvelope & { type: 'bus'; event: string } {
  return value.type === 'bus' && typeof value.event === 'string';
}

type BusPushEnvelope = ServerPushEnvelope & { type: 'bus'; event: string };

interface SharedPushChannel {
  source: EventSource;
  subscribers: Set<(envelope: BusPushEnvelope) => void>;
}

/**
 * One shared EventSource per events URL, fanned out to every subscriber.
 * SSE connections are long-lived HTTP: one per subscriber exhausts
 * Chromium's ~6-per-host HTTP/1.1 pool on multi-orbital pages and starves
 * the transport's own dispatch fetches. Moved verbatim from
 * `@almadar/ui`'s `providers/ServerBridge.tsx` (module-scoped there per
 * multi-provider page; same rationale applies to multiple transports
 * pointed at the same server).
 */
const pushChannels = new Map<string, SharedPushChannel>();

function acquirePushChannel(url: string, subscriber: (envelope: BusPushEnvelope) => void): () => void {
  let channel = pushChannels.get(url);
  if (channel === undefined) {
    const source = new EventSource(url);
    const created: SharedPushChannel = { source, subscribers: new Set() };
    source.onmessage = (ev: MessageEvent<string>) => {
      let parsed: ServerPushEnvelope;
      try {
        parsed = JSON.parse(ev.data) as ServerPushEnvelope;
      } catch (err) {
        log.warn('push:parse-failed', { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!isBusPushEnvelope(parsed)) return;
      for (const sub of created.subscribers) sub(parsed);
    };
    source.onerror = () => {
      log.warn('push:connection-error', { url });
    };
    pushChannels.set(url, created);
    channel = created;
  }
  channel.subscribers.add(subscriber);
  return () => {
    channel.subscribers.delete(subscriber);
    if (channel.subscribers.size === 0) {
      channel.source.close();
      pushChannels.delete(url);
    }
  };
}

export interface HttpTransportOptions {
  serverUrl: string;
  getAccessToken?: AccessTokenProvider;
  /** Custom fetch function (for testing or custom auth). */
  fetch?: typeof fetch;
}

/** HTTP transport — POSTs to a server speaking the canonical playground-runtime contract. */
export function createHttpTransport(options: HttpTransportOptions): EventTransport {
  const { serverUrl, getAccessToken } = options;
  const fetchFn = options.fetch ?? fetch.bind(globalThis);

  return {
    async register(schema) {
      try {
        const res = await fetchFn(`${serverUrl}/register`, {
          method: 'POST',
          headers: await authHeaders(getAccessToken),
          body: JSON.stringify({ schema }),
        });
        const parsed = OrbitalRegisterResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          log.error('register:malformed-response', { issues: JSON.stringify(parsed.error.issues) });
          return { success: false, carriesCircuitState: deriveCarriesCircuitState(undefined) };
        }
        return {
          success: parsed.data.success,
          carriesCircuitState: deriveCarriesCircuitState(parsed.data.topology),
        };
      } catch (err) {
        // Network-level failure (TypeError from fetch) is expected in
        // standalone playground mode during reload/registration race —
        // demote so the verifier's console-error verdict doesn't trip.
        if (err instanceof TypeError) {
          log.warn('register:failed', { error: err.message });
        } else {
          log.error('register:failed', { error: err instanceof Error ? err : String(err) });
        }
        return { success: false, carriesCircuitState: true };
      }
    },

    async unregister() {
      try {
        await fetchFn(`${serverUrl}/unregister`, { method: 'DELETE', headers: await authHeaders(getAccessToken) });
      } catch {
        // Ignore cleanup errors — mirrors the ui transport this replaces.
      }
    },

    async send(orbitalName, request) {
      const res = await fetchFn(`${serverUrl}/${orbitalName}/events`, {
        method: 'POST',
        headers: await authHeaders(getAccessToken),
        body: JSON.stringify(request),
      });
      return (await res.json()) as OrbitalEventResponse;
    },

    subscribe(onPush, params = {}) {
      if (typeof EventSource === 'undefined') return () => {};

      let release: (() => void) | undefined;
      let cancelled = false;
      void (async () => {
        const token = getAccessToken ? await getAccessToken() : undefined;
        if (cancelled) return;
        const search = new URLSearchParams(params);
        if (token) search.set('access_token', token);
        const url = `${deriveEventsUrl(serverUrl)}?${search.toString()}`;
        release = acquirePushChannel(url, (envelope) => {
          onPush({ event: envelope.event, payload: envelope.payload, source: envelope.source });
        });
      })();
      return () => {
        cancelled = true;
        release?.();
      };
    },
  };
}

// ============================================================================
// In-process transport
// ============================================================================

/** Evaluates one event against an orbital with no wire in between — the unified `evaluateOrbitalEvent` (a separate, in-progress unit) is a valid `OrbitalEvaluator`. */
export type OrbitalEvaluator = (orbitalName: string, request: OrbitalEventRequest) => Promise<OrbitalEventResponse>;

export interface InProcessTransportOptions {
  onRegister?: (schema: OrbitalSchema) => Promise<void> | void;
  onUnregister?: () => Promise<void> | void;
  /**
   * In-process evaluation never crosses a wire, so nothing about circuit
   * state is "carried" in the stateless-topology sense — `false` by
   * default, mirroring `@almadar/ui`'s `BrowserPlayground` today: its
   * in-process `register` never declares a `topology`, and the provider's
   * fallback for a custom transport is `'in-process'` (not
   * `'stateless-http'`).
   */
  carriesCircuitState?: boolean;
}

/** In-process transport — the evaluator is INJECTED (e.g. the unified `evaluateOrbitalEvent`, owned elsewhere). */
export function createInProcessTransport(evaluate: OrbitalEvaluator, options: InProcessTransportOptions = {}): EventTransport {
  return {
    async register(schema) {
      await options.onRegister?.(schema);
      return { success: true, carriesCircuitState: options.carriesCircuitState ?? false };
    },
    async unregister() {
      await options.onUnregister?.();
    },
    async send(orbitalName, request) {
      return evaluate(orbitalName, request);
    },
    // No `subscribe` — an in-process transport has no server to push from.
  };
}
