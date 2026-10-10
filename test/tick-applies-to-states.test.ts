// A tick's `appliesTo` lists the trait states it runs in; absent or empty runs it in every state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import type { OrbitalSchema, Trait } from '@almadar/core';

function schema(): OrbitalSchema {
  const trait = (name: string, event: string, appliesTo: string[] | undefined): Trait => ({
    name,
    scope: 'instance' as const,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }, { name: 'running' }],
      events: [{ key: 'INIT', name: 'INIT' }, { key: 'START', name: 'START' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
        { from: 'idle', to: 'running', event: 'START', effects: [] },
      ],
    },
    ticks: [
      {
        name: 'beat',
        interval: 10,
        runsInBackground: true,
        ...(appliesTo ? { appliesTo } : {}),
        effects: [['emit', event, {}]],
      },
    ],
    emits: [{ event }],
  });
  return {
    name: 'applies-to-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Board',
        pages: [],
        entity: { name: 'Cell', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [
          trait('InRunning', 'RUNNING_PULSE', ['running']),
          trait('InIdle', 'IDLE_PULSE', ['idle']),
          trait('Everywhere', 'ANY_PULSE', undefined),
          trait('EmptyList', 'EMPTY_PULSE', []),
          trait('ByEntityId', 'ID_PULSE', ['singleton']),
        ],
      },
    ],
  };
}

describe('tick appliesTo is a list of trait states', () => {
  let pending: Map<number, (ts: number) => void>;
  let nextHandle: number;
  const now = { value: 0 };
  let runtime: OrbitalServerRuntime;
  let pulses: string[];

  beforeEach(async () => {
    pending = new Map();
    nextHandle = 1;
    now.value = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
      const handle = nextHandle++;
      pending.set(handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => pending.delete(handle));
    runtime = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await runtime.register(schema());
    pulses = [];
    runtime.getEventBus().onAny((e) => pulses.push(e.type));
    frame(0);
  });

  afterEach(() => {
    runtime.unregisterAll();
    vi.unstubAllGlobals();
  });

  function frame(deltaMs: number): void {
    now.value += deltaMs;
    const due = [...pending.values()];
    pending.clear();
    for (const cb of due) cb(now.value);
  }

  async function run(n: number): Promise<Record<string, number>> {
    pulses.length = 0;
    for (let i = 0; i < n; i++) frame(15);
    await new Promise((r) => setTimeout(r, 20));
    const count = (type: string): number => pulses.filter((e) => e === type).length;
    return {
      running: count('RUNNING_PULSE'),
      idle: count('IDLE_PULSE'),
      any: count('ANY_PULSE'),
      empty: count('EMPTY_PULSE'),
      id: count('ID_PULSE'),
    };
  }

  const start = (trait: string) => runtime.processOrbitalEvent('Board', { event: 'START', targetTrait: trait });

  it('runs only in a listed state', async () => {
    const before = await run(2);
    expect(before.running).toBe(0);
    expect(before.idle).toBe(2);
  });

  it('starts once the trait enters a listed state and stops when it leaves the other', async () => {
    await start('InRunning');
    await start('InIdle');
    const after = await run(2);
    expect(after.running).toBe(2);
    expect(after.idle).toBe(0);
  });

  it('control: an absent or empty list runs in every state', async () => {
    await start('Everywhere');
    await start('EmptyList');
    const after = await run(2);
    expect(after.any).toBe(2);
    expect(after.empty).toBe(2);
  });

  it('an entity id in the list no longer admits the tick', async () => {
    expect((await run(3)).id).toBe(0);
  });
});
