/**
 * Mount lifecycle on the client fold: a server response that ran a
 * client-only trait's listen before that trait's INIT must not land (its INIT
 * would reset it); the delivery is held and replayed right after INIT. The
 * stateless and stateful hosts both run it early (only the client knows the
 * trait is mounting), so the rule is the client's.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createClientKernel,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  StateMachineManager,
} from '../src/index.js';

const schema = {
  name: 'fold-hold',
  version: '1.0.0',
  orbitals: [{
    name: 'ShopOrbital',
    entity: { name: 'Product', persistence: 'persistent', collection: 'products', fields: [{ name: 'id', type: 'string' }] },
    traits: [
      {
        name: 'Catalog',
        linkedEntity: 'Product',
        emits: [{ event: 'LOADED', scope: 'internal', payloadSchema: [{ name: 'data', type: 'array' }] }],
        stateMachine: {
          states: [{ name: 'loading', isInitial: true }, { name: 'ready' }],
          events: [],
          transitions: [
            { from: 'loading', to: 'loading', event: 'INIT', effects: [['fetch', 'Product', { emit: { success: 'FETCHED' } }]] },
            { from: 'loading', to: 'ready', event: 'FETCHED', effects: [['emit', 'LOADED', { data: '@payload.data' }]] },
          ],
        },
      },
      {
        name: 'Tally',
        linkedEntity: 'Counter',
        listens: [{ event: 'LOADED', source: { kind: 'trait', trait: 'Catalog' }, triggers: 'COUNT' }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [['set', '@entity.count', 0]] },
            { from: 'idle', to: 'idle', event: 'COUNT', effects: [['set', '@entity.count', ['array/len', '@payload.data']]] },
          ],
        },
      },
    ],
    pages: [{ name: 'Shop', path: '/', traits: [{ ref: 'Catalog' }, { ref: 'Tally' }] }],
  }, {
    name: 'CounterOrbital',
    entity: { name: 'Counter', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'count', type: 'number', default: 0 }] },
    traits: [],
    pages: [],
  }],
} as OrbitalSchema;

type Topology = 'stateful' | 'stateless';

async function mountPage(topology: Topology, order: readonly string[], mountFirst: boolean) {
  const persistence = new InMemoryPersistence();
  for (const id of ['p1', 'p2', 'p3']) await persistence.create('Product', { id });
  const traitIndex = buildTraitIndex(schema.orbitals);
  const held = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const heldFrames = new Map<string, EntityRow>();
  const host = async (request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    const manager = topology === 'stateful' ? held : new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frames = topology === 'stateful' ? heldFrames : new Map<string, EntityRow>();
    return evaluateOrbitalEvent(
      { traitIndex, manager, persistence, frames, runtimeRowSentinel: topology === 'stateless', runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema }) },
      request,
    );
  };
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({
    orbitalName: 'ShopOrbital',
    traitIndex,
    store,
    carriesCircuitState: topology === 'stateless',
    transport: createInProcessTransport((_o, request) => host(request), { carriesCircuitState: topology === 'stateless' }),
  });
  if (mountFirst) store.mount.mounting(order);
  for (const trait of order) await kernel.dispatch({ event: 'INIT', targetTrait: trait });
  const tally = traitIndex.byName.get('Tally');
  return { count: store.frames.get(tally?.frameKey ?? 'Tally')?.['count'], mode: tally?.dispatchMode };
}

describe.each(['stateful', 'stateless'] as const)('client fold holds a client-only listener until its INIT (%s)', (topology) => {
  it('the source mounts first: the delivery waits for the listener INIT, then lands', async () => {
    const { count, mode } = await mountPage(topology, ['Catalog', 'Tally'], true);
    expect(mode).toBe('hybridClientOnly');
    expect(count).toBe(3);
  });

  it('control: the listener mounts first and receives the delivery directly', async () => {
    expect((await mountPage(topology, ['Tally', 'Catalog'], true)).count).toBe(3);
  });

  it('edge: a listener that already left the mount (INIT ran earlier) is never held', async () => {
    expect((await mountPage(topology, ['Tally', 'Catalog'], false)).count).toBe(3);
  });
});
