/**
 * Registration-swap race — "Orbital not found: <X>" on catalog clicks.
 *
 * Observed 2026-09-23 on the catalog (runtime-verify --catalog, stateful
 * path): clicking an organism SOMETIMES left the page dead with a burst of
 *
 *   { success: false, transitioned: false, states: {},
 *     emittedEvents: [], error: "Orbital not found: JournalOrbital" }
 *
 * Small/single-orbital organisms (std-api-gateway) always load; big
 * multi-orbital ones (std-accounting) load intermittently.
 *
 * Mechanism: the catalog's `/api/catalog/select` handler performs the app
 * swap as `rt.unregisterAll(); await rt.register(schema)` — and registration
 * is SLOW (per-orbital entity seeding awaits the persistence adapter, and
 * orbitals register SEQUENTIALLY, first-to-last). Any event for a
 * not-yet-registered orbital arriving during the swap used to hit
 * `processOrbitalEvent`'s immediate `this.orbitals.get(name)` miss and 404
 * with the observed error — even though the very registration that would
 * serve it was already in flight. The race window is wide for a big organism
 * (seconds) and effectively zero for a single-orbital one, matching the
 * intermittent-vs-always split. (`BrowserPlayground`'s in-process transport
 * already gates dispatches on `registrationReady` — an ad-hoc fix for this
 * exact race at ONE host; nothing protected the HTTP hosts.)
 *
 * The contract pinned here: while ANY registration mutation (register or
 * unregisterAll) is in flight, an event for a missing orbital AWAITS that
 * mutation and is then served from the fresh map — it 404s only when no
 * mutation could produce the orbital.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

/** InMemoryPersistence with a real-time delay on `create` — models the
 *  seconds a big organism's per-orbital instance seeding spends awaiting the
 *  persistence layer, widening the swap window far enough to hit
 *  deterministically. */
function slowPersistence(delayMs: number): InMemoryPersistence {
  const inner = new InMemoryPersistence();
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as InMemoryPersistence;
}

function oldAppSchema(): OrbitalSchema {
  return {
    name: 'OldApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'OldOrbital',
        entity: { name: 'OldItem', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'OldHome',
            scope: 'instance',
            linkedEntity: 'OldItem',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['set', '@entity.booted', true]] }],
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

function accountingSchema(): OrbitalSchema {
  const mk = (name: string): Trait => ({
    name,
    scope: 'instance' as const,
    linkedEntity: 'Journal',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['set', '@entity.booted', true]] }],
    },
  });
  return {
    name: 'AccountingApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'LedgerOrbital',
        // Instance seeding forces `await persistence.create(...)` per row —
        // with the slow adapter this orbital's registration occupies real
        // time, so the loop hasn't reached JournalOrbital yet when the
        // event below arrives.
        entity: {
          name: 'Ledger',
          persistence: 'persistent',
          fields: [{ name: 'id', type: 'string' }],
          instances: [{ id: 'seed-1' }],
        },
        traits: [mk('LedgerHome')],
        pages: [],
      },
      {
        name: 'JournalOrbital',
        entity: { name: 'Journal', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [mk('JournalHome')],
        pages: [],
      },
    ],
  };
}

describe('OrbitalServerRuntime — registration-swap race', () => {
  it('an event for a later orbital arriving mid-swap is served, not 404ed', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'real', debug: false, persistence: slowPersistence(50) });
    await rt.register(oldAppSchema());

    // The exact /api/catalog/select sequence — swap without awaiting the
    // new registration, then a client event for the SECOND orbital lands.
    rt.unregisterAll();
    const swap = rt.register(accountingSchema());
    const response = await rt.processOrbitalEvent('JournalOrbital', {
      event: 'INIT',
      targetTrait: 'JournalHome',
    });
    await swap;

    // Pre-fix this was the observed payload:
    //   { success: false, …, error: 'Orbital not found: JournalOrbital' }
    expect(response.error).toBeUndefined();
    expect(response.success).toBe(true);
    expect(response.transitioned).toBe(true);
    expect(response.states['JournalHome']).toBe('idle');
  });

  it('an event for an orbital NO registration could produce still 404s', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'real', debug: false, persistence: slowPersistence(10) });
    const swap = rt.register(accountingSchema());
    const response = await rt.processOrbitalEvent('NoSuchOrbital', { event: 'INIT' });
    await swap;

    expect(response.success).toBe(false);
    expect(response.error).toBe('Orbital not found: NoSuchOrbital');
  });
});
