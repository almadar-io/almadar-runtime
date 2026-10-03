/**
 * Twin of orbital-core `tests/client_residence.rs`: a data effect on a
 * browser-stored entity (`[persistent: x, local]`) is client work, so a trait
 * whose data is all browser-stored dispatches client-only.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition, OrbitalEntity, TypedEffect } from '@almadar/core';
import { browserLegEvents, buildTraitIndex } from '../src/traits/trait-index';

function orbital(entity: Omit<OrbitalEntity, 'fields'>, effects: TypedEffect[]): OrbitalDefinition {
  return {
    name: 'Books',
    entity: { fields: [{ name: 'id', type: 'string', required: true }], ...entity },
    traits: [{
      name: 'Browse', linkedEntity: entity.name, category: 'interaction', scope: 'collection',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [{ key: 'INIT', name: 'INIT' }],
        transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects }] },
    }],
    pages: [],
  };
}

const modeOf = (o: OrbitalDefinition) => buildTraitIndex([o]).byName.get('Browse')?.dispatchMode;

describe('dispatch mode follows where the data lives', () => {
  it('a trait on a browser-stored entity fetching it is client-only', () => {
    expect(modeOf(orbital({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true }, [['fetch', 'Invoice', {}]]))).toBe('hybridClientOnly');
  });

  it('control: the same trait on a server-stored entity awaits the server', () => {
    expect(modeOf(orbital({ name: 'Invoice', persistence: 'persistent', collection: 'invoices' }, [['fetch', 'Invoice', {}]]))).toBe('persistedAwaited');
  });

  it('control: a runtime entity fetching its own rows stays optimistic (rows are server per-session)', () => {
    expect(modeOf(orbital({ name: 'Scene', persistence: 'runtime' }, [['fetch', 'Scene', {}]]))).toBe('runtimeOptimistic');
  });

  it('a browser-stored entity trait calling a service is optimistic', () => {
    expect(modeOf(orbital({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true }, [['call-service', 'llm', 'call', {}]]))).toBe('runtimeOptimistic');
  });
});

describe('browserLegEvents (twin of orbital-core browser_leg_events)', () => {
  const stores = (entityType: string) => entityType === 'LocalInvoice';
  const traitDef = buildTraitIndex([{
    name: 'Books',
    entity: { name: 'LocalInvoice', persistence: 'persistent', collection: 'invoices', local: true, fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{
      name: 'Books', linkedEntity: 'LocalInvoice', category: 'interaction', scope: 'collection',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: ['LOAD', 'ADD', 'SYNC', 'CHARGE', 'NEVER'].map((key) => ({ key, name: key })),
        transitions: [
          { from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'LocalInvoice', {}]] },
          { from: 'idle', to: 'idle', event: 'ADD', effects: [['persist', 'create', 'LocalInvoice', {}]] },
          { from: 'idle', to: 'idle', event: 'SYNC', effects: [['fetch', 'Invoice', {}]] },
          { from: 'idle', to: 'idle', event: 'CHARGE', effects: [['call-service', 'billing', 'charge', {}]] },
          { from: 'idle', to: 'idle', event: 'NEVER', guard: false, effects: [['fetch', 'LocalInvoice', {}]] },
        ],
      },
    }],
    pages: [],
  }]).byName.get('Books')!.traitDef;

  it('the browser leg events are the ones whose data lives in the browser', () => {
    expect([...browserLegEvents(traitDef, stores)].sort()).toEqual(['ADD', 'LOAD']);
  });

  it('control: with no browser-stored entity no event takes a browser leg', () => {
    expect(browserLegEvents(traitDef, () => false).size).toBe(0);
  });
});
