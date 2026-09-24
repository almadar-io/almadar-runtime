/**
 * A leg's `_awaitingInit` tells the host which traits have not run their
 * lifecycle yet, so it holds deliveries to them. A client-only trait's INIT
 * never reaches the host, so listing it made the host hold its delivery
 * forever (G-RUNTIME-012 minimal: HoursTotal rendered `rows: 0`). Only traits
 * whose dispatches post are listed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, Trait } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, type EventTransport } from '../src/index.js';

function schema(): OrbitalSchema {
  const fetcher = (name: string): Trait => ({
    name, linkedEntity: 'Entry', scope: 'instance' as const,
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'Entry', {}]] }] },
  });
  return {
    name: 'awaiting',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: { name: 'Entry', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        fetcher('Fetcher'),
        fetcher('Other'),
        { name: 'Viewer', linkedEntity: 'Entry', scope: 'instance' as const,
          stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: 'x' }]] }] } },
      ],
    }],
  };
}

describe('_awaitingInit on a leg', () => {
  it('lists awaiting traits that post, never a client-only one', async () => {
    const full = buildTraitIndex(schema().orbitals);
    expect(full.byName.get('Viewer')?.dispatchMode).toBe('hybridClientOnly');
    const store = createMemoryCircuitStore([...full.byName.values()].map((e) => e.traitDef));
    const sent: OrbitalEventRequest[] = [];
    const transport: EventTransport = {
      register: async () => ({ success: true, carriesCircuitState: false }),
      unregister: async () => {},
      send: vi.fn(async (_orbital: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
        sent.push(request);
        return { success: true, transitioned: true, states: {}, emittedEvents: [] };
      }),
    };
    const kernel = createClientKernel({ orbitalName: 'Main', traitIndex: full, fullTraitIndex: full, store, carriesCircuitState: false, transport });
    store.mount.mounting(['Fetcher', 'Other', 'Viewer']);
    await kernel.dispatch({ event: 'INIT', targetTrait: 'Fetcher' });
    const awaiting = sent[0]?.payload?.['_awaitingInit'];
    expect(awaiting).toEqual(['Other']);
  });
});
