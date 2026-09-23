/**
 * `ServerBridge` (the class) converged onto `EventTransport` for its HTTP
 * request/response leg — P5, `docs/Almadar_Runtime_Stateless_Stateful_PLAN.md`
 * §4.2/§4.3 ("Two `ServerBridge`s" → one owner each in `@almadar/runtime").
 * Asserts the class still posts the same wire shape it always did; the
 * transport underneath is exercised directly in `event-transport.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EventPayload } from '@almadar/core';
import type { EventListener, IEventBus, Unsubscribe } from '../src/types.js';
import { createServerBridge } from '../src/server/ServerBridge.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubEventBus(): IEventBus {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    emit(type: string, payload?: EventPayload) {
      for (const listener of listeners.get(type) ?? []) listener({ type, payload, timestamp: Date.now() });
    },
    on(type: string, listener: EventListener): Unsubscribe {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      listeners.set(type, set);
      return () => listeners.get(type)?.delete(listener);
    },
    onAny(listener: EventListener): Unsubscribe {
      return this.on('*', listener);
    },
    hasListeners(type: string): boolean {
      return (listeners.get(type)?.size ?? 0) > 0;
    },
    getRegisteredEvents(): string[] {
      return [...listeners.keys()];
    },
    clear(): void {
      listeners.clear();
    },
  };
}

describe('ServerBridge (class) via EventTransport', () => {
  it('sendEvent POSTs an OrbitalEventRequest to <serverUrl>/<orbital>/events and returns the response fields', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ success: true, transitioned: true, states: { Cart: 'open' }, emittedEvents: [{ event: 'ADDED' }] }),
    );
    const bridge = createServerBridge({ eventBus: stubEventBus(), serverUrl: 'https://api.test/api/orbitals', fetch: fetchMock });

    const result = await bridge.sendEvent('ShoppingCart', 'ADD_ITEM', { qty: 1 });

    expect(result).toEqual({ success: true, states: { Cart: 'open' }, emittedEvents: [{ event: 'ADDED' }], error: undefined });
    const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(String(call[0])).toBe('https://api.test/api/orbitals/ShoppingCart/events');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ event: 'ADD_ITEM', payload: { qty: 1 } });
  });

  it('forwardEvents dispatch through the same transport and put server-emitted events on the client bus', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ success: true, emittedEvents: [{ event: 'ORDER_ACCEPTED', payload: { id: 42 } }] }),
    );
    const eventBus = stubEventBus();
    const received: Array<{ type: string; payload: unknown }> = [];
    eventBus.on('SERVER:ORDER_ACCEPTED', (e) => received.push({ type: e.type, payload: e.payload }));

    const bridge = createServerBridge({
      eventBus,
      serverUrl: 'https://api.test/api/orbitals',
      targetOrbital: 'Orders',
      forwardEvents: ['ORDER_PLACED'],
      fetch: fetchMock,
    });
    bridge.connect();
    eventBus.emit('ORDER_PLACED', { id: 42 });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ type: 'SERVER:ORDER_ACCEPTED', payload: { id: 42 } });
    const call = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit?];
    expect(String(call[0])).toBe('https://api.test/api/orbitals/Orders/events');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ event: 'ORDER_PLACED', payload: { id: 42 } });
  });
});
