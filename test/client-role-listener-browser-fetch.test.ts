/**
 * almadar.io helpdesk demo "the queue never updates": a tour step makes the
 * desk write a browser-stored ticket and emit TICKETS_CHANGED; the queue
 * listens and refetches. The fold ran that listener locally with a collector
 * that posts nothing, so the refetch never reached the browser store. A
 * listener whose triggered event reads or writes browser-stored rows takes
 * the full client path, like the trait's own continuations.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalSchema, Trait } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import {
  buildTraitIndex,
  createClientKernel,
  createLocalStoreTransport,
  createMemoryCircuitStore,
  createResidenceTransport,
  type EventTransport,
} from '../src/index.js';

function schema(queueListens: boolean): OrbitalSchema {
  const tour: Trait = {
    name: 'Tour', linkedEntity: 'Scene', scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [{ from: 'idle', to: 'idle', event: 'STEP', effects: [['emit', 'TOUR_STEP', {}]] }] },
  };
  const desk: Trait = {
    name: 'Desk', linkedEntity: 'Ticket', scope: 'instance',
    listens: [{ event: 'TOUR_STEP', source: { kind: 'trait', trait: 'Tour' }, triggers: 'ARRIVE' }],
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [{ from: 'idle', to: 'idle', event: 'ARRIVE', effects: [['persist', 'update', 'Ticket', { id: 't-2', lane: 'inbox' }, { emit: { success: 'CHANGED' } }]] }] },
  };
  const queue: Trait = {
    name: 'Queue', linkedEntity: 'Ticket', scope: 'collection',
    ...(queueListens ? { listens: [{ event: 'CHANGED', source: { kind: 'trait', trait: 'Desk' }, triggers: 'REFRESH' }] } : {}),
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [
        { from: 'idle', to: 'idle', event: 'REFRESH', effects: [['fetch', 'Ticket', { emit: { success: 'LOADED' } }]] },
        { from: 'idle', to: 'idle', event: 'LOADED', effects: [
          ['set', '@entity.inbox', ['array/len', ['array/filter', '@payload.data', ['fn', 'r', ['=', '@r.lane', 'inbox']]]]],
          ['render-ui', 'main', { type: 'typography', content: 'loaded' }],
        ] },
      ] },
  };
  return {
    name: 'desk',
    version: '1.0.0',
    orbitals: [{
      name: 'Desk',
      pages: [],
      entity: { name: 'Ticket', persistence: 'persistent', collection: 'tickets', local: true,
        fields: [{ name: 'id', type: 'string' }, { name: 'lane', type: 'string' }, { name: 'inbox', type: 'number' }] },
      auxiliaryEntities: [{ name: 'Scene', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] }],
      traits: [tour, desk, queue],
    }],
  };
}

async function setup(queueListens: boolean) {
  const s = schema(queueListens);
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const browser = new InMemoryPersistence();
  await browser.create('Ticket', { id: 't-1', lane: 'inbox' });
  await browser.create('Ticket', { id: 't-2', lane: 'incoming' });
  const local = createLocalStoreTransport({ traitIndex, store, persistence: browser, clientRelays: true });
  const sentLocal: OrbitalEventRequest[] = [];
  const recordingLocal: EventTransport = { ...local, send: async (o, r) => { sentLocal.push(r); return local.send(o, r); } };
  const kernel = createClientKernel({
    orbitalName: 'Desk', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false,
    transport: createResidenceTransport({ local: recordingLocal, traitIndex }),
  });
  return { kernel, store, sentLocal, frameKey: traitIndex.byName.get('Queue')?.frameKey ?? 'Queue' };
}

describe('a listener that refetches browser-stored rows after a cascaded write', () => {
  it('reaches the browser store and sees the new row', async () => {
    const { kernel, store, sentLocal, frameKey } = await setup(true);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour' });
    expect(sentLocal.map((r) => `${r.targetTrait}:${r.event}`)).toContain('Queue:REFRESH');
    expect(store.frames.get(frameKey)?.['inbox']).toBe(2);
  });

  it('the refetched render reaches the caller, attributed to the queue', async () => {
    const { kernel } = await setup(true);
    const result = await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour' });
    expect((result.response.clientEffectsByTrait ?? []).some((e) => e.traitName === 'Queue' && e.effect[0] === 'render-ui')).toBe(true);
  });

  it('on a tick lane, the posted cascade\'s renders come back once the post settles', async () => {
    const { kernel } = await setup(true);
    const outcome = await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour', tick: 'transportTick' });
    expect((outcome.response.clientEffectsByTrait ?? []).some((e) => e.traitName === 'Queue')).toBe(false);
    const settled = await outcome.tickSettled;
    expect((settled?.clientEffectsByTrait ?? []).some((e) => e.traitName === 'Queue' && e.effect[0] === 'render-ui')).toBe(true);
  });

  it('control: with no listen the queue is never asked to refetch', async () => {
    const { kernel, sentLocal } = await setup(false);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour' });
    expect(sentLocal.map((r) => `${r.targetTrait}:${r.event}`)).not.toContain('Queue:REFRESH');
  });
});
