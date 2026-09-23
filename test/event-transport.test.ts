/**
 * EventTransport (P5, `docs/Almadar_Runtime_Stateless_Stateful_PLAN.md`
 * §4.2) — the promoted HTTP/in-process transport port. Mirrors
 * `@almadar/ui`'s `providers/ServerBridge.tsx` test coverage
 * (`test/server-bridge-auth.test.tsx`) at the transport-port level, without
 * React.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import {
  createHttpTransport,
  createInProcessTransport,
  deriveCarriesCircuitState,
} from '../src/server/EventTransport.js';

const schema: OrbitalSchema = { name: 'Probe', orbitals: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function headerOf(call: [RequestInfo | URL, RequestInit?], name: string): string | null {
  return new Headers(call[1]?.headers).get(name);
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('deriveCarriesCircuitState', () => {
  it('stateful topology carries no circuit state', () => {
    expect(deriveCarriesCircuitState('stateful')).toBe(false);
  });
  it('stateless topology carries circuit state', () => {
    expect(deriveCarriesCircuitState('stateless')).toBe(true);
  });
  it('absent/undeclared topology defaults to stateless (mirrors ServerBridgeProvider today)', () => {
    expect(deriveCarriesCircuitState(undefined)).toBe(true);
  });
});

describe('createHttpTransport', () => {
  let fetchMock: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ success: true }));
  });

  it('register posts the schema and derives carriesCircuitState from the response topology', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, topology: 'stateless' }));
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    const result = await transport.register(schema);

    expect(result).toEqual({ success: true, carriesCircuitState: true });
    const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(String(call[0])).toBe('https://api.test/api/orbitals/register');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ schema });
  });

  it('a stateful topology derives carriesCircuitState: false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, topology: 'stateful' }));
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    const result = await transport.register(schema);

    expect(result.carriesCircuitState).toBe(false);
  });

  it('an absent topology (older/unmodified server) defaults carriesCircuitState to true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    const result = await transport.register(schema);

    expect(result.carriesCircuitState).toBe(true);
  });

  it('send POSTs the exact OrbitalEventRequest to <serverUrl>/<orbital>/events and returns the response verbatim', async () => {
    const response: OrbitalEventResponse = {
      success: true,
      transitioned: true,
      states: { Cart: 'open' },
      emittedEvents: [{ event: 'ADDED', payload: { qty: 1 } }],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(response));
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    const request: OrbitalEventRequest = { event: 'ADD_ITEM', payload: { qty: 1 }, traits: [{ trait: 'Cart', from: 'idle' }] };
    const result = await transport.send('ShoppingCart', request);

    expect(result).toEqual(response);
    const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(String(call[0])).toBe('https://api.test/api/orbitals/ShoppingCart/events');
    expect(call[1]?.method).toBe('POST');
    expect(JSON.parse(String(call[1]?.body))).toEqual(request);
  });

  it('attaches the bearer token on register, unregister and send', async () => {
    const getAccessToken = vi.fn(async () => 'id-token-1');
    const transport = createHttpTransport({
      serverUrl: 'https://api.test/api/orbitals',
      fetch: fetchMock,
      getAccessToken,
    });

    await transport.register(schema);
    await transport.send('ShoppingCart', { event: 'PING' });
    await transport.unregister();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>) {
      expect(headerOf(call, 'Authorization')).toBe('Bearer id-token-1');
    }
  });

  it('sends no Authorization header without a token provider', async () => {
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    await transport.send('ShoppingCart', { event: 'PING' });

    const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(headerOf(call, 'Authorization')).toBeNull();
  });

  it('a network failure on register is caught and reported as a failed, assumed-stateless result', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    const result = await transport.register(schema);

    expect(result).toEqual({ success: false, carriesCircuitState: true });
  });
});

describe('createHttpTransport push subscribe', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the sibling /events channel with the caller-supplied params and the access token', async () => {
    const getAccessToken = vi.fn(async () => 'id-token-1');
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals', getAccessToken });
    const onPush = vi.fn();

    const unsubscribe = transport.subscribe!(onPush, { clientId: 'tab-1' });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const url = new URL(FakeEventSource.instances[0].url);
    expect(url.pathname).toBe('/api/events');
    expect(url.searchParams.get('clientId')).toBe('tab-1');
    expect(url.searchParams.get('access_token')).toBe('id-token-1');

    unsubscribe();
  });

  it('delivers a bus-type push message to onPush as an EmittedEvent and ignores non-bus messages', async () => {
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals' });
    const onPush = vi.fn();

    // Distinct `clientId` per test — `acquirePushChannel` shares one
    // EventSource per exact URL (incl. query string), so two tests using
    // an identical URL would silently reuse a channel a prior test never
    // unsubscribed.
    const unsubscribe = transport.subscribe!(onPush, { clientId: 'test-bus-message' });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    source.emit({ type: 'reload' });
    source.emit({ type: 'bus', event: 'ITEM_ADDED', payload: { qty: 2 }, source: { trait: 'Cart' } });

    expect(onPush).toHaveBeenCalledTimes(1);
    expect(onPush).toHaveBeenCalledWith({ event: 'ITEM_ADDED', payload: { qty: 2 }, source: { trait: 'Cart' } });
    unsubscribe();
  });

  it('closes the EventSource once the last subscriber unsubscribes', async () => {
    const transport = createHttpTransport({ serverUrl: 'https://api.test/api/orbitals' });
    const unsubscribeA = transport.subscribe!(vi.fn(), { clientId: 'test-close-on-last-unsubscribe' });
    const unsubscribeB = transport.subscribe!(vi.fn(), { clientId: 'test-close-on-last-unsubscribe' });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    unsubscribeA();
    expect(source.closed).toBe(false);
    unsubscribeB();
    expect(source.closed).toBe(true);
  });
});

describe('createInProcessTransport', () => {
  it('send delegates to the injected evaluator with the orbital name and request', async () => {
    const response: OrbitalEventResponse = { success: true, transitioned: true, states: {}, emittedEvents: [] };
    const evaluate = vi.fn(async () => response);
    const transport = createInProcessTransport(evaluate);

    const request: OrbitalEventRequest = { event: 'INIT' };
    const result = await transport.send('Probe', request);

    expect(evaluate).toHaveBeenCalledWith('Probe', request);
    expect(result).toBe(response);
  });

  it('register calls the injected onRegister hook and defaults carriesCircuitState to false', async () => {
    const onRegister = vi.fn();
    const transport = createInProcessTransport(vi.fn(), { onRegister });

    const result = await transport.register(schema);

    expect(onRegister).toHaveBeenCalledWith(schema);
    expect(result).toEqual({ success: true, carriesCircuitState: false });
  });

  it('unregister calls the injected onUnregister hook', async () => {
    const onUnregister = vi.fn();
    const transport = createInProcessTransport(vi.fn(), { onUnregister });

    await transport.unregister();

    expect(onUnregister).toHaveBeenCalledTimes(1);
  });

  it('has no subscribe leg — no server to push from', () => {
    const transport = createInProcessTransport(vi.fn());
    expect(transport.subscribe).toBeUndefined();
  });

  it('carriesCircuitState is overridable', async () => {
    const transport = createInProcessTransport(vi.fn(), { carriesCircuitState: true });
    const result = await transport.register(schema);
    expect(result.carriesCircuitState).toBe(true);
  });
});
