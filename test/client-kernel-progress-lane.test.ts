/**
 * Progress lane: a server-pushed origin message (a running call-service's live
 * `emit.onMessage`) dispatches outside the FIFO, so it is never queued behind
 * the very request that is producing it. Progress dispatches keep their order.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'ProgressApp',
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
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'SLOW', name: 'Slow' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'SLOW', effects: [['fetch', 'Item', { emit: { success: 'LOADED' } }]] }],
            },
          },
        ],
        pages: [],
      },
      {
        name: 'FeedOrbital',
        entity: { name: 'Live', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'last', type: 'string' }] },
        traits: [
          {
            name: 'LiveFeed',
            scope: 'instance',
            linkedEntity: 'Live',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'STEP', name: 'Step', payloadSchema: [{ name: 'label', type: 'string', required: true }] }],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'STEP',
                  effects: [['set', '@entity.last', '@payload.label'], ['render-ui', 'main', { type: 'typography', content: '@payload.label' }]],
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

async function setup() {
  const s = schema();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(s);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const posted: string[] = [];
  const transport = createInProcessTransport(async (orbitalName: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    posted.push(request.event);
    await gate;
    return runtime.processOrbitalEvent(orbitalName, request);
  });
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({ orbitalName: 'ItemOrbital', traitIndex, store, carriesCircuitState: false, transport });
  return { kernel, release, posted };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createClientKernel — progress lane', () => {
  it('a progress dispatch settles while an earlier FIFO request is still in flight', async () => {
    const { kernel, release, posted } = await setup();
    let slowDone = false;
    const slow = kernel.dispatch({ event: 'SLOW', targetTrait: 'ItemBrowse' }).then(() => { slowDone = true; });
    await tick();
    const outcome = await kernel.dispatchProgress({ event: 'STEP', targetTrait: 'LiveFeed', payload: { label: 'step 1' } });
    expect(slowDone).toBe(false);
    expect(outcome.response.clientEffects?.some((e) => e[0] === 'render-ui')).toBe(true);
    expect(posted).toEqual(['SLOW']);
    release();
    await slow;
  });

  it('control: the same event through the FIFO waits for the in-flight request', async () => {
    const { kernel, release } = await setup();
    void kernel.dispatch({ event: 'SLOW', targetTrait: 'ItemBrowse' });
    await tick();
    let stepDone = false;
    const step = kernel.dispatch({ event: 'STEP', targetTrait: 'LiveFeed', payload: { label: 'step 1' } }).then(() => { stepDone = true; });
    await tick();
    expect(stepDone).toBe(false);
    release();
    await step;
    expect(stepDone).toBe(true);
  });

  it('progress dispatches settle in the order they were pushed', async () => {
    const { kernel, release } = await setup();
    void kernel.dispatch({ event: 'SLOW', targetTrait: 'ItemBrowse' });
    await tick();
    const order: string[] = [];
    await Promise.all(['a', 'b', 'c'].map((label) =>
      kernel.dispatchProgress({ event: 'STEP', targetTrait: 'LiveFeed', payload: { label } }).then(() => { order.push(label); }),
    ));
    expect(order).toEqual(['a', 'b', 'c']);
    release();
  });
});
