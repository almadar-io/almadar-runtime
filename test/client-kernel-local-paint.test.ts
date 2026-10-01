/**
 * Paint-local-first: a posted dispatch hands its locally-evaluated response to
 * `onLocal` BEFORE the server leg resolves, so a transition's own render-ui
 * (e.g. its loading skeleton) can paint at zero latency; the outcome then
 * carries only the server's share of the effects.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'PaintApp',
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
                {
                  from: 'idle',
                  to: 'loading',
                  event: 'INIT',
                  effects: [
                    ['render-ui', 'main', { type: 'skeleton', variant: 'table' }],
                    ['fetch', 'Item', { emit: { success: 'LOADED' } }],
                  ],
                },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

async function setup(withTransport: boolean) {
  const s = schema();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(s);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let settled = false;
  const transport = createInProcessTransport(async (orbitalName: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    await gate;
    const response = await runtime.processOrbitalEvent(orbitalName, request);
    settled = true;
    return response;
  });
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({
    orbitalName: 'ItemOrbital',
    traitIndex,
    store,
    carriesCircuitState: false,
    ...(withTransport ? { transport } : {}),
  });
  return { kernel, release, isSettled: () => settled };
}

const renderTargets = (effects: OrbitalEventResponse['clientEffects']) =>
  (effects ?? []).filter((e) => e[0] === 'render-ui').map((e) => e[1]);

describe('createClientKernel — paint local first', () => {
  it('onLocal receives the transition\'s own render-ui before the server leg resolves', async () => {
    const { kernel, release, isSettled } = await setup(true);
    const seen: Array<{ settledAtPaint: boolean; targets: string[] }> = [];
    const done = kernel.dispatch({ event: 'INIT', targetTrait: 'ItemBrowse' }, {
      onLocal: (local) => seen.push({ settledAtPaint: isSettled(), targets: renderTargets(local.clientEffects).map(String) }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ settledAtPaint: false, targets: ['main'] }]);
    release();
    const outcome = await done;
    expect(outcome.localPainted).toBe(true);
    // the skeleton was painted locally — the server's share must not repaint it
    expect((outcome.serverEffects?.clientEffects ?? []).length).toBe((outcome.response.clientEffects ?? []).length - 1);
  });

  it('control: a dispatch without hooks reports nothing painted', async () => {
    const { kernel, release } = await setup(true);
    release();
    const outcome = await kernel.dispatch({ event: 'INIT', targetTrait: 'ItemBrowse' });
    expect(outcome.localPainted).toBeUndefined();
    expect(outcome.serverEffects).toBeUndefined();
  });

  it('edge: an offline kernel (no transport) never calls onLocal — the response is already final', async () => {
    const { kernel } = await setup(false);
    let called = false;
    const outcome = await kernel.dispatch({ event: 'INIT', targetTrait: 'ItemBrowse' }, { onLocal: () => { called = true; } });
    expect(called).toBe(false);
    expect(outcome.localPainted).toBeUndefined();
    expect(renderTargets(outcome.response.clientEffects)).toEqual(['main']);
  });
});
