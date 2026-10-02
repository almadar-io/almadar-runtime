/**
 * Mount in one round trip: `dispatchMount` is ONE FIFO entry that runs every
 * seed's local arm, paints each before anything is sent, posts one `mount`
 * leg and folds once. Posts (never local arms or paints) wait for the
 * transport's topology.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, TypedEffect } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport, type ClientKernelOpts } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  const loading = (label: string): TypedEffect => ['render-ui', 'main', { type: 'skeleton', variant: 'text', content: label }];
  return {
    name: 'MountApp',
    orbitals: [{
      name: 'PageOrbital',
      pages: [],
      entity: { name: 'Item', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        { name: 'List', scope: 'instance', linkedEntity: 'Item', stateMachine: { states: [{ name: 'loading', isInitial: true }, { name: 'ready' }], events: [], transitions: [
          { from: 'loading', to: 'loading', event: 'INIT', effects: [['fetch', 'Item', { emit: { success: 'LOADED' } }], loading('list')] },
          { from: 'loading', to: 'ready', event: 'LOADED', effects: [] },
        ] } },
        { name: 'Stats', scope: 'instance', linkedEntity: 'Item', stateMachine: { states: [{ name: 'loading', isInitial: true }], events: [], transitions: [
          { from: 'loading', to: 'loading', event: 'LOAD', effects: [['fetch', 'Item', {}], loading('stats')] },
        ] } },
        { name: 'Title', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [
          { from: 'idle', to: 'idle', event: 'INIT', effects: [loading('title')] },
          { from: 'idle', to: 'idle', event: 'RENAME', effects: [['fetch', 'Item', {}]] },
        ] } },
      ],
    }],
  };
}

async function setup(opts: { carriesCircuitState?: boolean; topology?: ClientKernelOpts['topology']; fail?: boolean } = {}) {
  const s = schema();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(s);
  const sent: OrbitalEventRequest[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const transport = createInProcessTransport(async (orbitalName: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    sent.push(request);
    await gate;
    if (opts.fail === true) throw new Error('network down');
    return runtime.processOrbitalEvent(orbitalName, request);
  });
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({
    orbitalName: 'PageOrbital', traitIndex, store, transport,
    carriesCircuitState: opts.carriesCircuitState ?? true,
    ...(opts.topology !== undefined ? { topology: opts.topology } : {}),
  });
  return { kernel, store, sent, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('client kernel — mount in one round trip', () => {
  it('paints every seed before one mount leg is sent, and marks each server-backed seed awaiting', async () => {
    const { kernel, store, sent, release } = await setup();
    const painted: string[] = [];
    const done = kernel.dispatchMount(
      [{ trait: 'List', event: 'INIT' }, { trait: 'Stats', event: 'LOAD' }, { trait: 'Title', event: 'INIT' }],
      { onLocal: (trait) => painted.push(trait) },
    );
    await tick();
    expect(painted).toEqual(['List', 'Stats', 'Title']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.mount).toEqual([{ trait: 'List', event: 'INIT' }, { trait: 'Stats', event: 'LOAD' }]);
    expect(store.awaiting.list().map((a) => a.trait).sort()).toEqual(['List', 'Stats']);
    release();
    const outcome = await done;
    expect(outcome.posted).toBe(true);
    expect(store.awaiting.list()).toEqual([]);
    expect(store.manager.getState('List')?.currentState).toBe('ready');
  });

  it('control: a mount whose seeds need no server posts nothing', async () => {
    const { kernel, sent } = await setup();
    const outcome = await kernel.dispatchMount([{ trait: 'Title', event: 'INIT' }]);
    expect(sent).toHaveLength(0);
    expect(outcome.posted).toBe(false);
  });

  it('a failed mount leg clears awaiting and rejects', async () => {
    const { kernel, store, release } = await setup({ fail: true });
    const done = kernel.dispatchMount([{ trait: 'List', event: 'INIT' }]);
    await tick();
    release();
    await expect(done).rejects.toThrow('network down');
    expect(store.awaiting.list()).toEqual([]);
  });

  it('a command queued after the mount runs after the mount folds', async () => {
    const { kernel, sent, release } = await setup();
    const mount = kernel.dispatchMount([{ trait: 'List', event: 'INIT' }]);
    const rename = kernel.dispatch({ event: 'RENAME', targetTrait: 'Title' });
    await tick();
    expect(sent.map((r) => r.event)).toEqual(['INIT']);
    release();
    await mount;
    await rename;
    expect(sent.map((r) => r.event)).toEqual(['INIT', 'RENAME']);
  });

  it('a pending topology holds the post, never the paint; the leg is shaped by the confirmed topology', async () => {
    let confirm: (t: { carriesCircuitState: boolean }) => void = () => undefined;
    const topology = new Promise<{ carriesCircuitState: boolean }>((r) => { confirm = r; });
    const { kernel, sent, release } = await setup({ carriesCircuitState: true, topology });
    const painted: string[] = [];
    const done = kernel.dispatchMount([{ trait: 'List', event: 'INIT' }], { onLocal: (trait) => painted.push(trait) });
    await tick();
    expect(painted).toEqual(['List']);
    expect(sent).toHaveLength(0);
    confirm({ carriesCircuitState: false });
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.traits).toBeUndefined();
    release();
    await done;
  });

  it('a single dispatch paints before a pending topology resolves', async () => {
    let confirm: (t: { carriesCircuitState: boolean }) => void = () => undefined;
    const topology = new Promise<{ carriesCircuitState: boolean }>((r) => { confirm = r; });
    const { kernel, sent, release } = await setup({ topology });
    let painted = false;
    const done = kernel.dispatch({ event: 'INIT', targetTrait: 'List' }, { onLocal: () => { painted = true; } });
    await tick();
    expect(painted).toBe(true);
    expect(sent).toHaveLength(0);
    confirm({ carriesCircuitState: true });
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.traits).toBeDefined();
    release();
    expect((await done).localPainted).toBe(true);
  });
});
