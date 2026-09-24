// Runtime Spec Clause 8.3: a server tick fires only while a client has its trait mounted, unless it runs in the background.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { UNMOUNT_EVENT } from '../src/traits/StateMachineCore.js';
import type { OrbitalSchema, Trait } from '@almadar/core';

function schema(): OrbitalSchema {
  const trait = (name: string, event: string, runsInBackground: boolean): Trait => ({
    name,
    scope: 'instance' as const,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'INIT' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
    },
    ticks: [{ name: 'beat', interval: 10, ...(runsInBackground ? { runsInBackground } : {}), effects: [['emit', event, {}]] }],
    emits: [{ event }],
  });
  return {
    name: 'mount-scope-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Board',
        pages: [],
        entity: { name: 'Cell', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [trait('Scoped', 'SCOPED_PULSE', false), trait('Background', 'BG_PULSE', true)],
      },
    ],
  };
}

describe('server ticks are mount-scoped unless background', () => {
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

  /** Advance `n` full intervals and report how many times each tick fired. */
  async function run(n: number): Promise<{ scoped: number; background: number }> {
    pulses.length = 0;
    for (let i = 0; i < n; i++) frame(15);
    await new Promise((r) => setTimeout(r, 20));
    return {
      scoped: pulses.filter((e) => e === 'SCOPED_PULSE').length,
      background: pulses.filter((e) => e === 'BG_PULSE').length,
    };
  }

  const mount = (clientId: string) => runtime.processOrbitalEvent('Board', { event: 'INIT', targetTrait: 'Scoped', clientId });
  const unmount = (clientId: string) => runtime.processOrbitalEvent('Board', { event: UNMOUNT_EVENT, targetTrait: 'Scoped', clientId });

  it('an unmounted trait\'s tick stays paused while a background tick keeps running', async () => {
    const fired = await run(3);
    expect(fired.scoped).toBe(0);
    expect(fired.background).toBe(3);
  });

  it('mounting starts the tick and unmounting pauses it again', async () => {
    await mount('tab-a');
    expect(runtime.isTraitMounted('Board', 'Scoped')).toBe(true);
    expect((await run(2)).scoped).toBe(2);
    const response = await unmount('tab-a');
    expect(response).toMatchObject({ success: true, transitioned: false });
    expect((await run(2)).scoped).toBe(0);
  });

  it('keeps firing while any client still has the trait mounted', async () => {
    await mount('tab-a');
    await mount('tab-b');
    await unmount('tab-a');
    expect((await run(2)).scoped).toBe(2);
    await unmount('tab-b');
    expect((await run(2)).scoped).toBe(0);
  });

  it('a client that mounts twice is still one mount', async () => {
    await mount('tab-a');
    await mount('tab-a');
    await unmount('tab-a');
    expect(runtime.isTraitMounted('Board', 'Scoped')).toBe(false);
  });

  it('a disconnected client releases its mounts', async () => {
    await mount('tab-a');
    runtime.releaseClient('tab-a');
    expect((await run(2)).scoped).toBe(0);
  });

  it('remounting resumes without a burst of missed firings', async () => {
    await run(5);
    await mount('tab-a');
    expect((await run(1)).scoped).toBe(1);
  });

  it('an app swap forgets every mount', async () => {
    await mount('tab-a');
    runtime.unregisterAll();
    await runtime.register(schema());
    frame(0);
    expect(runtime.isTraitMounted('Board', 'Scoped')).toBe(false);
  });
});
