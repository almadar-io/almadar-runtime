/**
 * almadar.io invoices demo: a desk that runs its own browser-store fetch AND
 * emits an open event a browser-stored detail listens to. The desk's leg masks
 * the detail's delivery (the client relays it), so the detail's fetch has to go
 * to the browser store as its own continuation — as it already does when the
 * seed delegates nothing.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait, TypedEffect } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import {
  buildTraitIndex,
  createClientKernel,
  createLocalStoreTransport,
  createMemoryCircuitStore,
  createResidenceTransport,
} from '../src/index.js';

function schema(deskFetches: boolean): OrbitalSchema {
  const deskEffects: TypedEffect[] = [
    ...(deskFetches ? [['fetch', 'Task', { emit: { success: 'LISTED' } }] satisfies TypedEffect] : []),
    ['emit', 'OPEN', { id: 'demo-1' }],
  ];
  const desk: Trait = {
    name: 'Desk', linkedEntity: 'Task', scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [
        { from: 'idle', to: 'idle', event: 'GO', effects: deskEffects },
        { from: 'idle', to: 'idle', event: 'LISTED', effects: [] },
      ] },
  };
  const detail: Trait = {
    name: 'Detail', linkedEntity: 'Task', scope: 'instance',
    listens: [{ event: 'OPEN', source: { kind: 'trait', trait: 'Desk' }, triggers: 'SHOW', payloadMapping: { id: '@payload.id' } }],
    stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'loading' }, { name: 'shown' }], events: [],
      transitions: [
        { from: 'idle', to: 'loading', event: 'SHOW', effects: [['fetch', 'Task', { id: '@payload.id', emit: { success: 'LOADED' } }]] },
        { from: 'loading', to: 'shown', event: 'LOADED', effects: [] },
      ] },
  };
  return {
    name: 'demo',
    version: '1.0.0',
    orbitals: [{
      name: 'Demo',
      pages: [],
      entity: { name: 'Task', persistence: 'persistent', collection: 'tasks', local: true,
        fields: [{ name: 'id', type: 'string' }, { name: 'stage', type: 'string' }] },
      traits: [desk, detail],
    }],
  };
}

async function detailStateAfterGo(deskFetches: boolean): Promise<string | undefined> {
  const s = schema(deskFetches);
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const browser = new InMemoryPersistence();
  await browser.create('Task', { id: 'demo-1', stage: 'todo' });
  const local = createLocalStoreTransport({ traitIndex, store, persistence: browser, clientRelays: true });
  const kernel = createClientKernel({
    orbitalName: 'Demo', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false,
    transport: createResidenceTransport({ local, traitIndex }),
  });
  await kernel.dispatch({ event: 'GO', targetTrait: 'Desk' });
  return store.manager.getState('Detail')?.currentState;
}

describe('a delegating seed that reaches a browser-stored listener', () => {
  it('the listener\'s fetch still runs in the browser store', async () => {
    expect(await detailStateAfterGo(true)).toBe('shown');
  });

  it('control: a seed with no data effect of its own', async () => {
    expect(await detailStateAfterGo(false)).toBe('shown');
  });
});
