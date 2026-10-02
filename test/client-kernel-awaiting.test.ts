/**
 * Awaiting-server contract: a non-local trait is awaiting from its server leg's
 * send until the fold (or error), keyed by the transition its local run took;
 * local/hybrid traits and tick legs never are. Slots read this to draw the
 * predicted skeleton while the server renders.
 */
import { describe, it, expect } from 'vitest';
import type { AwaitingTrait, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'AwaitApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'ItemOrbital',
        entity: { name: 'Item', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'ItemBrowse',
            scope: 'instance',
            linkedEntity: 'Item',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'loading' }],
              events: [],
              transitions: [
                { from: 'idle', to: 'loading', event: 'INIT', effects: [['fetch', 'Item', { emit: { success: 'LOADED' } }]] },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

async function setup(opts: { fail?: boolean } = {}) {
  const s = schema();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(s);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const transport = createInProcessTransport(async (orbitalName: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    await gate;
    if (opts.fail) throw new Error('network down');
    return runtime.processOrbitalEvent(orbitalName, request);
  });
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({ orbitalName: 'ItemOrbital', traitIndex, store, carriesCircuitState: true, transport });
  return { kernel, store, release };
}

describe('awaiting-server contract', () => {
  it('a server-backed trait is awaiting from leg send until the fold, keyed by its own transition', async () => {
    const { kernel, store, release } = await setup();
    const seen: Array<AwaitingTrait | undefined> = [];
    const unsub = store.awaiting.subscribe('ItemBrowse', () => seen.push(store.awaiting.get('ItemBrowse')));
    const done = kernel.dispatch({ event: 'INIT', targetTrait: 'ItemBrowse' });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.awaiting.get('ItemBrowse')).toEqual({ trait: 'ItemBrowse', event: 'INIT', from: 'idle' });
    release();
    await done;
    expect(store.awaiting.get('ItemBrowse')).toBeUndefined();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    unsub();
  });

  it('a failed leg clears awaiting (never a stuck skeleton)', async () => {
    const { kernel, store, release } = await setup({ fail: true });
    const done = kernel.dispatch({ event: 'INIT', targetTrait: 'ItemBrowse' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.awaiting.get('ItemBrowse')).toBeDefined();
    release();
    await done;
    expect(store.awaiting.get('ItemBrowse')).toBeUndefined();
  });

  it('control: an offline kernel (no transport) never marks anything awaiting', async () => {
    const s = schema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({ orbitalName: 'ItemOrbital', traitIndex, store, carriesCircuitState: true });
    let marked = false;
    store.awaiting.subscribe('ItemBrowse', () => { marked = true; });
    await kernel.dispatch({ event: 'INIT', targetTrait: 'ItemBrowse' });
    expect(marked).toBe(false);
  });
});
