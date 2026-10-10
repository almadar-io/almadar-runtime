/**
 * almadar.io home, invoices row: on mount the list's browser-store fetch lands, the desk hears
 * it and emits OPEN, and the detail (browser-stored) fetches the invoice by id. That cascade
 * runs while the mount response is folded, and the detail's fetch must still reach the store.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import {
  buildTraitIndex,
  createClientKernel,
  createLocalStoreTransport,
  createMemoryCircuitStore,
  createResidenceTransport,
} from '../src/index.js';

function schema(deskOpens: boolean): OrbitalSchema {
  const list: Trait = {
    name: 'List', linkedEntity: 'Invoice', scope: 'collection',
    stateMachine: { states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }], events: [],
      transitions: [
        { from: 'loading', to: 'loading', event: 'INIT', effects: [['fetch', 'Invoice', { emit: { success: 'LISTED' } }]] },
        { from: 'loading', to: 'browsing', event: 'LISTED', effects: [] },
      ] },
  };
  const desk: Trait = {
    name: 'Desk', linkedEntity: 'Invoice', scope: 'instance',
    listens: [{ event: 'LISTED', source: { kind: 'trait', trait: 'List' }, triggers: 'READY' }],
    stateMachine: { states: [{ name: 'booting', isInitial: true }, { name: 'idle' }], events: [],
      transitions: [
        { from: 'booting', to: 'booting', event: 'INIT', effects: [] },
        { from: 'booting', to: 'idle', event: 'READY', effects: deskOpens ? [['emit', 'OPEN', { id: 'inv-1' }]] : [] },
      ] },
  };
  const detail: Trait = {
    name: 'Detail', linkedEntity: 'Invoice', scope: 'instance',
    listens: [{ event: 'OPEN', source: { kind: 'trait', trait: 'Desk' }, triggers: 'SHOW', payloadMapping: { id: '@payload.id' } }],
    stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'loading' }, { name: 'shown' }], events: [],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
        { from: 'idle', to: 'loading', event: 'SHOW', effects: [['fetch', 'Invoice', { id: '@payload.id', emit: { success: 'LOADED' } }]] },
        { from: 'loading', to: 'shown', event: 'LOADED', effects: [] },
      ] },
  };
  return {
    name: 'demo', version: '1.0.0',
    orbitals: [{
      name: 'Billing', pages: [],
      entity: { name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, fields: [{ name: 'id', type: 'string' }] },
      traits: [list, desk, detail],
    }],
  };
}

async function detailAfterMount(deskOpens: boolean): Promise<string | undefined> {
  const s = schema(deskOpens);
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const browser = new InMemoryPersistence();
  await browser.create('Invoice', { id: 'inv-1' });
  const local = createLocalStoreTransport({ traitIndex, store, persistence: browser, clientRelays: true });
  const kernel = createClientKernel({
    orbitalName: 'Billing', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false,
    transport: createResidenceTransport({ local, traitIndex }),
  });
  await kernel.dispatchMount([{ trait: 'List', event: 'INIT' }, { trait: 'Desk', event: 'INIT' }, { trait: 'Detail', event: 'INIT' }]);
  return store.manager.getState('Detail')?.currentState;
}

describe('a mount whose folded response cascades into a browser-stored fetch', () => {
  it('the detail opened by the cascade loads its record', async () => {
    expect(await detailAfterMount(true)).toBe('shown');
  });

  it('control: with no open the detail stays idle', async () => {
    expect(await detailAfterMount(false)).toBe('idle');
  });
});
