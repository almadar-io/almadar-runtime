/**
 * A listener reached by a dispatch's own fan-out keeps what its transition
 * wrote: one dispatch on Source emits PING, Listener (another trait, its own
 * runtime frame) hears it and sets a field — the frame holds it afterwards,
 * even when a later trait of the same cascade on the same entity (Viewer,
 * which only renders) ran effects without writing that field.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(listenerPersists: boolean): OrbitalSchema {
  return {
    name: 'FanoutFrameApp',
    orbitals: [{
      name: 'FanoutOrbital',
      pages: [],
      entity: { name: 'Clock', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'ticks', type: 'number', default: 0 }] },
      traits: [
        { name: 'Source', scope: 'instance', linkedEntity: 'Clock', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [
          { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
          { from: 'idle', to: 'idle', event: 'STEP', effects: [['set', '@entity.ticks', ['+', '@entity.ticks', 1]], ['emit', 'PING', { name: 'Nina' }]] },
        ] } },
        { name: 'Listener', scope: 'instance', linkedEntity: 'Order',
          listens: [{ event: 'PING', source: { kind: 'trait', trait: 'Source' }, triggers: 'NAMED' }],
          stateMachine: { states: [{ name: 'empty', isInitial: true }, { name: 'named' }], events: [], transitions: [
            { from: 'empty', to: 'empty', event: 'INIT', effects: [['set', '@entity.name', '']] },
            { from: 'empty', to: 'named', event: 'NAMED', effects: [['set', '@entity.name', '@payload.name'], ['emit', 'NAME_SET', { name: '@payload.name' }]] },
            ...(listenerPersists ? [{ from: 'named', to: 'named', event: 'SAVE', effects: [['persist', 'create', 'Order', '@entity']] }] : []),
          ] } },
        { name: 'Viewer', scope: 'instance', linkedEntity: 'Order',
          listens: [{ event: 'NAME_SET', source: { kind: 'trait', trait: 'Listener' }, triggers: 'SHOW' }],
          stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
            { from: 'idle', to: 'idle', event: 'SHOW', effects: [['render-ui', 'main', { type: 'typography', content: '@payload.name' }]] },
          ] } },
      ],
    }, {
      name: 'OrderOrbital',
      pages: [],
      entity: { name: 'Order', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string', default: '' }] },
      traits: [],
    }],
  } as OrbitalSchema;
}

async function setup(listenerPersists: boolean) {
  const s = schema(listenerPersists);
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(s);
  const transport = createInProcessTransport(async (o: string, r: OrbitalEventRequest): Promise<OrbitalEventResponse> => runtime.processOrbitalEvent(o, r));
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({ orbitalName: 'FanoutOrbital', traitIndex, store, transport, carriesCircuitState: false });
  await kernel.dispatchMount([{ trait: 'Source', event: 'INIT' }, { trait: 'Listener', event: 'INIT' }, { trait: 'Viewer', event: 'INIT' }]);
  const frameOf = (trait: string) => store.frames.get(traitIndex.byName.get(trait)?.frameKey ?? trait);
  return { kernel, store, frameOf };
}

describe('client kernel — a fan-out listener keeps its frame writes', () => {
  for (const listenerPersists of [false, true]) {
    it(`listener ${listenerPersists ? 'with' : 'without'} a server effect`, async () => {
      const { kernel, store, frameOf } = await setup(listenerPersists);
      await kernel.dispatch({ event: 'STEP', targetTrait: 'Source' });
      expect(store.manager.getState('Listener')?.currentState).toBe('named');
      expect(frameOf('Listener')?.name).toBe('Nina');
      expect(frameOf('Viewer')?.name).toBe('Nina');
      expect(frameOf('Source')?.ticks).toBe(1);
    });
  }

  it('control: a field the later trait does write is the later value', async () => {
    const { kernel, frameOf } = await setup(false);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Source' });
    expect(frameOf('Source')?.ticks).toBe(1);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Source' });
    expect(frameOf('Source')?.ticks).toBe(2);
  });
});
