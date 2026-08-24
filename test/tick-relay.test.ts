/**
 * tick-relay.test.ts — T6 coalesced snapshot relay (docs/Almadar_Tick_Loop.md §3a).
 *
 * A tick-stamped dispatch is a latest-state broadcast: the server processes it
 * normally but relays it to OTHER clients through the live-broadcast sink
 * coalesced newest-per-(clientId, orbital, event) on the
 * `tickRelayIntervalMs` cadence — never 1:1 with emissions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { LiveBroadcastItem } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

function tickSchema(): OrbitalSchema {
  return {
    name: 'tick-relay-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'GameOrbital',
        pages: [],
        entity: {
          name: 'Player',
          fields: [{ name: 'id', type: 'string', required: true }],
        },
        traits: [
          {
            name: 'mover',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'MOVED', name: 'MOVED' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'MOVED', effects: [] }],
            },
          } as never,
        ],
      },
    ],
  } as unknown as OrbitalSchema;
}

describe('OrbitalServerRuntime — tick broadcast relay (T6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const runtime = new OrbitalServerRuntime({ debug: false, tickRelayIntervalMs: 50 });
    await runtime.register(tickSchema());
    const items: LiveBroadcastItem[] = [];
    runtime.setLiveBroadcastSink((item) => items.push(item));
    return { runtime, items };
  }

  it('coalesces rapid same-key tick dispatches to the newest payload per flush', async () => {
    const { runtime, items } = await setup();
    await runtime.processOrbitalEvent('GameOrbital', {
      event: 'MOVED', payload: { x: 1 }, clientId: 'tab-a', tick: 'gameTick', sourceTrait: 'mover',
    });
    await runtime.processOrbitalEvent('GameOrbital', {
      event: 'MOVED', payload: { x: 2 }, clientId: 'tab-a', tick: 'gameTick', sourceTrait: 'mover',
    });
    vi.advanceTimersByTime(50);
    expect(items).toHaveLength(1);
    expect(items[0].payload).toEqual({ x: 2 });
    expect(items[0].source).toEqual({ orbital: 'GameOrbital', trait: 'mover', tick: 'gameTick' });
    expect(items[0].originClientId).toBe('tab-a');
  });

  it('relays different clients independently', async () => {
    const { runtime, items } = await setup();
    await runtime.processOrbitalEvent('GameOrbital', {
      event: 'MOVED', payload: { x: 1 }, clientId: 'tab-a', tick: 'gameTick', sourceTrait: 'mover',
    });
    await runtime.processOrbitalEvent('GameOrbital', {
      event: 'MOVED', payload: { x: 9 }, clientId: 'tab-b', tick: 'gameTick', sourceTrait: 'mover',
    });
    vi.advanceTimersByTime(50);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.originClientId).sort()).toEqual(['tab-a', 'tab-b']);
  });

  it('flushes once per interval, not once per emission', async () => {
    const { runtime, items } = await setup();
    for (let i = 0; i < 5; i++) {
      await runtime.processOrbitalEvent('GameOrbital', {
        event: 'MOVED', payload: { x: i }, clientId: 'tab-a', tick: 'gameTick', sourceTrait: 'mover',
      });
      vi.advanceTimersByTime(50);
    }
    expect(items).toHaveLength(5);
    expect(items[4].payload).toEqual({ x: 4 });
  });

  it('does not relay non-tick dispatches through the tick path', async () => {
    const { runtime, items } = await setup();
    await runtime.processOrbitalEvent('GameOrbital', {
      event: 'MOVED', payload: { x: 1 }, clientId: 'tab-a',
    });
    vi.advanceTimersByTime(200);
    expect(items).toHaveLength(0);
  });
});
