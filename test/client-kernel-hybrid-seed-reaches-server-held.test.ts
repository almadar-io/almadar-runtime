/**
 * On a server that holds circuit state, a client-only seed whose cascade moves
 * a server-held trait keeps that server in step: Source (client-only) emits
 * PING, Listener (has a server effect, so the server holds its state) moves
 * empty -> named. A later SAVE on Listener runs from `named` on the server too.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'HybridSeedApp',
    orbitals: [{
      name: 'HybridOrbital',
      pages: [],
      entity: { name: 'Order', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string', default: '' }] },
      traits: [
        { name: 'Source', scope: 'instance', linkedEntity: 'Order', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [
          { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
          { from: 'idle', to: 'idle', event: 'STEP', effects: [['emit', 'PING', { name: 'Nina' }]] },
        ] } },
        { name: 'Listener', scope: 'instance', linkedEntity: 'Order',
          listens: [{ event: 'PING', source: { kind: 'trait', trait: 'Source' }, triggers: 'NAMED' }],
          stateMachine: { states: [{ name: 'empty', isInitial: true }, { name: 'named' }, { name: 'saved' }], events: [], transitions: [
            { from: 'empty', to: 'empty', event: 'INIT', effects: [] },
            { from: 'empty', to: 'named', event: 'NAMED', effects: [['set', '@entity.name', '@payload.name']] },
            { from: 'named', to: 'saved', event: 'SAVE', guard: ['!=', '@entity.name', ''], effects: [['persist', 'create', 'Order', '@entity']] },
          ] } },
      ],
    }],
  } as OrbitalSchema;
}

async function setup(carriesCircuitState: boolean) {
  const s = schema();
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(s);
  const sent: string[] = [];
  const transport = createInProcessTransport(async (o: string, r: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    sent.push(r.event);
    return runtime.processOrbitalEvent(o, r);
  }, { carriesCircuitState });
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({ orbitalName: 'HybridOrbital', traitIndex, store, transport, carriesCircuitState });
  await kernel.dispatchMount([{ trait: 'Source', event: 'INIT' }, { trait: 'Listener', event: 'INIT' }]);
  return { kernel, store, sent, traitIndex };
}

describe('client kernel — a client-only seed keeps a stateful server in step', () => {
  it('stateful server: the server-held listener the cascade moved accepts the next event from where the client is', async () => {
    const { kernel, store, traitIndex } = await setup(false);
    expect(traitIndex.byName.get('Source')?.dispatchMode).toBe('hybridClientOnly');
    expect(traitIndex.byName.get('Listener')?.dispatchMode).not.toBe('hybridClientOnly');
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Source' });
    expect(store.manager.getState('Listener')?.currentState).toBe('named');
    const saved = await kernel.dispatch({ event: 'SAVE', targetTrait: 'Listener' });
    expect(saved.response.success).toBe(true);
    expect(store.manager.getState('Listener')?.currentState).toBe('saved');
  });

  it('stateless server: the state travels with the SAVE leg, so the seed posts nothing', async () => {
    const { kernel, store, sent } = await setup(true);
    sent.length = 0;
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Source' });
    expect(sent).toEqual([]);
    await kernel.dispatch({ event: 'SAVE', targetTrait: 'Listener' });
    expect(store.manager.getState('Listener')?.currentState).toBe('saved');
  });

  it('control: a client-only seed whose cascade stays client-only posts nothing on a stateful server', async () => {
    const { kernel, sent } = await setup(false);
    sent.length = 0;
    await kernel.dispatch({ event: 'INIT', targetTrait: 'Source' });
    expect(sent).toEqual([]);
  });
});
