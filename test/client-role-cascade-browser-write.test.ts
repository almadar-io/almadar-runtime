/**
 * almadar.io board demo "cards never move": a client-only tour (its scene is a
 * `[runtime]` entity) emits a step; the board, bound to a browser-stored
 * entity, listens and runs `persist update`. The browser store relays nothing
 * (`clientRelays`, the client already fanned out), so replaying the tour's
 * step there never reached the board and the write was lost. The board's
 * write goes to the browser store as its own request, with its own event.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, Trait } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import {
  buildTraitIndex,
  createClientKernel,
  createLocalStoreTransport,
  createMemoryCircuitStore,
  createResidenceTransport,
  type EventTransport,
} from '../src/index.js';

function schema(boardStoredInBrowser: boolean): OrbitalSchema {
  const tour: Trait = {
    name: 'Tour', linkedEntity: 'Scene', scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [{ from: 'idle', to: 'idle', event: 'STEP', effects: [['emit', 'TOUR_STEP', { event: '@payload.event' }]] }] },
  };
  const board: Trait = {
    name: 'Board', linkedEntity: 'Task', scope: 'collection',
    listens: [
      { event: 'TOUR_STEP', source: { kind: 'trait', trait: 'Tour' }, triggers: 'MOVE', guard: ['=', '@payload.event', 'FINISH'], payloadMapping: { id: 'demo-1', stage: 'done' } },
      { event: 'TOUR_STEP', source: { kind: 'trait', trait: 'Tour' }, triggers: 'MOVE', guard: ['=', '@payload.event', 'START'], payloadMapping: { id: 'demo-1', stage: 'doing' } },
    ],
    stateMachine: { states: [{ name: 'viewing', isInitial: true }], events: [],
      transitions: [{ from: 'viewing', to: 'viewing', event: 'MOVE', effects: [['persist', 'update', 'Task', { id: '@payload.id', stage: '@payload.stage' }]] }] },
  };
  return {
    name: 'demo',
    version: '1.0.0',
    orbitals: [{
      name: 'Demo',
      pages: [],
      entity: { name: 'Task', persistence: 'persistent', ...(boardStoredInBrowser ? { collection: 'tasks', local: true } : {}),
        fields: [{ name: 'id', type: 'string' }, { name: 'stage', type: 'string' }] },
      auxiliaryEntities: [{ name: 'Scene', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] }],
      traits: [tour, board],
    }],
  };
}

async function setup(boardStoredInBrowser: boolean) {
  const s = schema(boardStoredInBrowser);
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const browser = new InMemoryPersistence();
  await browser.create('Task', { id: 'demo-1', stage: 'todo' });
  const serverSent: OrbitalEventRequest[] = [];
  const remote: EventTransport = {
    register: async () => ({ success: true, carriesCircuitState: false }),
    unregister: async () => {},
    send: vi.fn(async (_o: string, request: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
      serverSent.push(request);
      return { success: true, transitioned: true, states: {}, emittedEvents: [] };
    }),
  };
  const local = createLocalStoreTransport({ traitIndex, store, persistence: browser, clientRelays: true });
  const kernel = createClientKernel({
    orbitalName: 'Demo', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false,
    transport: createResidenceTransport({ local, remote, traitIndex }),
  });
  return { kernel, browser, serverSent };
}

describe('a client-only step that drives a browser-stored board', () => {
  it('the board\'s write lands in the browser store, and only the matching listen fires', async () => {
    const { kernel, browser, serverSent } = await setup(true);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour', payload: { event: 'FINISH' } });
    expect((await browser.getById('Task', 'demo-1'))?.['stage']).toBe('done');
    expect(serverSent).toEqual([]);
  });

  it('control: a step no listen matches writes nothing', async () => {
    const { kernel, browser, serverSent } = await setup(true);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour', payload: { event: 'NOTHING' } });
    expect((await browser.getById('Task', 'demo-1'))?.['stage']).toBe('todo');
    expect(serverSent).toEqual([]);
  });

  it('control: a board over server data still sends its write to the server', async () => {
    const { kernel, serverSent } = await setup(false);
    await kernel.dispatch({ event: 'STEP', targetTrait: 'Tour', payload: { event: 'FINISH' } });
    expect(serverSent.length).toBeGreaterThan(0);
  });
});
