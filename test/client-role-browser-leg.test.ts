/**
 * A client-only seed over browser-stored data (`[persistent: x, local]`) still
 * owes a leg: its `fetch`/`persist` runs in the browser store, not in the hook.
 * Twin of the compiled hook's `__LEG_EVENTS` gate.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalId, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createMemoryCircuitStore, dispatchWithServerLeg, openBrowserStoreTransport, postServerLeg, type ClientRoleOpts } from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'browser-leg',
    version: '1.0.0',
    orbitals: [{
      name: 'Books',
      id: 'orb_books' as OrbitalId,
      pages: [],
      entity: {
        name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true,
        fields: [{ name: 'id', type: 'string' }, { name: 'note', type: 'string' }],
        instances: [{ id: 'INV-1', note: 'first' }],
      },
      traits: [{
        name: 'InvoiceList',
        linkedEntity: 'Invoice',
        scope: 'collection',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'shown' }],
          events: [],
          transitions: [
            { from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'Invoice', { emit: { success: 'LOADED' } }]] },
            { from: 'idle', to: 'shown', event: 'LOADED', effects: [['render-ui', 'main', { type: 'data-grid', entity: '@payload.data' }]] },
            { from: 'idle', to: 'idle', event: 'NOTE', effects: [['set', '@entity.note', '@payload.value']] },
          ],
        },
      }],
    }],
  };
}

function host(): ClientRoleOpts {
  const traitIndex = buildTraitIndex(schema().orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return { orbitalName: 'Books', traitIndex, store, carriesCircuitState: true };
}

describe('client-only seed over browser-stored data', () => {
  it('a browser-leg event produces its leg', async () => {
    const dispatch = await dispatchWithServerLeg(host(), { event: 'LOAD', targetTrait: 'InvoiceList' });
    expect(dispatch.mode).toBe('hybridClientOnly');
    expect(dispatch.serverLeg?.event).toBe('LOAD');
  });

  it('control: an event with no data effect stays client-only', async () => {
    const dispatch = await dispatchWithServerLeg(host(), { event: 'NOTE', targetTrait: 'InvoiceList', payload: { value: 'x' } });
    expect(dispatch.serverLeg).toBeUndefined();
  });

  it('the fold runs the client-only trait\'s own unconsumed emit here', async () => {
    const opts = host();
    const transport = await openBrowserStoreTransport({ databaseName: `fold-${Math.random()}`, schema: schema(), clientRelays: true });
    const dispatch = await dispatchWithServerLeg(opts, { event: 'LOAD', targetTrait: 'InvoiceList' });
    const presented = await postServerLeg(transport, 'Books', dispatch, opts.store, opts);
    expect(opts.store.manager.getState('InvoiceList')?.currentState).toBe('shown');
    expect(JSON.stringify(presented.clientEffects ?? [])).toContain('INV-1');
  });
});
