/**
 * OrbitalServerRuntime — pauseTicks()/resumeTicks()/areTicksPaused()
 * delegation to the private TickScheduler that drives `ticks {}`.
 *
 * Stubs requestAnimationFrame/cancelAnimationFrame the same way
 * tick-scheduler.test.ts does, so the scheduler's rAF loop is
 * deterministically single-steppable instead of racing real timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

function tickSchema(): OrbitalSchema {
  return {
    name: 'pause-ticks-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'GameOrbital',
        pages: [],
        entity: {
          name: 'Player',
          persistence: 'runtime',
          fields: [{ name: 'id', type: 'string', required: true }],
        },
        traits: [
          {
            name: 'mover',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [],
            },
            ticks: [
              {
                name: 'beat',
                interval: 10,
                effects: [['emit', 'PULSE', {}]],
              },
            ],
            emits: [{ event: 'PULSE' }],
          } as never,
        ],
      },
    ],
  } as unknown as OrbitalSchema;
}

describe('OrbitalServerRuntime — pauseTicks/resumeTicks/areTicksPaused', () => {
  let pending: Map<number, (ts: number) => void>;
  let nextHandle: number;

  beforeEach(() => {
    pending = new Map();
    nextHandle = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
      const handle = nextHandle++;
      pending.set(handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      pending.delete(handle);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Advance the fake rAF clock by `deltaMs` and run exactly one queued frame. */
  function tickFrame(deltaMs: number, now: { value: number }): void {
    now.value += deltaMs;
    const due = [...pending.values()];
    pending.clear();
    for (const cb of due) cb(now.value);
  }

  it('areTicksPaused() starts false and flips with pauseTicks()/resumeTicks()', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await runtime.register(tickSchema());

    expect(runtime.areTicksPaused()).toBe(false);
    runtime.pauseTicks();
    expect(runtime.areTicksPaused()).toBe(true);
    runtime.resumeTicks();
    expect(runtime.areTicksPaused()).toBe(false);

    runtime.unregisterAll();
  });

  it('pauseTicks() tears down the scheduler loop; resumeTicks() restarts it', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await runtime.register(tickSchema());
    const now = { value: 0 };

    tickFrame(0, now); // establish the loop
    expect(pending.size).toBe(1);

    runtime.pauseTicks();
    expect(pending.size).toBe(0); // no frame left to advance — ticks can't fire

    runtime.resumeTicks();
    expect(pending.size).toBe(1);

    runtime.unregisterAll();
  });

  it('a tick registered on the runtime stops emitting while paused and resumes after resume', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await runtime.register(tickSchema());
    const now = { value: 0 };
    const pulses: string[] = [];
    runtime.getEventBus().onAny((e) => pulses.push(e.type));
    const settle = () => new Promise((r) => setTimeout(r, 20));

    tickFrame(0, now);
    tickFrame(15, now); // >= 10ms interval — fires
    await settle();
    expect(pulses.filter((e) => e === 'PULSE')).toHaveLength(1);

    runtime.pauseTicks();
    expect(pending.size).toBe(0); // paused: no frame to drive further pulses

    runtime.resumeTicks();
    pulses.length = 0;
    tickFrame(15, now); // first frame after resume just re-establishes phase
    await settle();
    expect(pulses.filter((e) => e === 'PULSE')).toHaveLength(0);
    tickFrame(15, now); // next frame is a full interval past resume — fires once
    await settle();
    expect(pulses.filter((e) => e === 'PULSE')).toHaveLength(1);

    runtime.unregisterAll();
  });
});
