/**
 * Registration-mutation bracket — the resolve window between
 * `unregisterAll()` and `register()` (G-RUNTIME-039).
 *
 * The catalog's swap is three steps: `rt.unregisterAll()` →
 * `await resolveOrbForLoad(...)` (file resolve + inline/compose — real time
 * for a big organism) → `rt.register(...)`. The G-RUNTIME-038 epoch fix
 * covers the `register()` call itself, but the epoch marker stamped by
 * `unregisterAll()` resolves as soon as the PREVIOUS mutation completes —
 * nothing ties it to the upcoming registration. Any dispatch that lands in
 * the resolve window finds an empty map and an already-resolved epoch, and
 * 404s `Orbital not found: <X>` even though the requested orbital is about
 * to register. Same shape at `/api/catalog/select`, `/api/catalog/reload`,
 * `/api/schema/load`, and both rabit-bridge re-register sites.
 *
 * The contract pinned here: the WHOLE swap must run inside
 * `withRegistrationMutation` — a dispatch mid-swap then awaits the completed
 * swap and resolves against the new app. The unbracketed negative control
 * proves the window is real at the primitive level (the marker alone does
 * NOT close it), which is why the bracket — not host-side timing luck — is
 * the required call shape.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** InMemoryPersistence with a real-time delay on `create` — models the
 *  seconds a big organism's per-orbital instance seeding spends awaiting
 *  the persistence layer, so the first swap occupies real time. */
function slowPersistence(delayMs: number): InMemoryPersistence {
  const inner = new InMemoryPersistence();
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create') {
        return async (...args: unknown[]) => {
          await tick(delayMs);
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
        name: 'JournalOrbital',
        entity: { name: 'Journal', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [mk('JournalHome')],
        pages: [],
      },
    ],
  };
}

describe('OrbitalServerRuntime — registration-mutation bracket', () => {
  it('negative control: the unbracketed unregister→resolve→register window still 404s', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'real', debug: false, persistence: new InMemoryPersistence() });
    await rt.register(oldAppSchema());

    // The exact host sequence WITHOUT the bracket: unregister, then the
    // resolve step occupies real time BEFORE register() is even invoked.
    rt.unregisterAll();
    const swap = (async () => {
      await tick(50); // models resolveOrbForLoad latency
      await rt.register(accountingSchema());
    })();
    const response = await rt.processOrbitalEvent('JournalOrbital', {
      event: 'INIT',
      targetTrait: 'JournalHome',
    });
    await swap;

    // The hole, pinned: the unregisterAll marker resolved early, so the
    // dispatch 404s while the registration it needed was milliseconds away.
    expect(response.success).toBe(false);
    expect(response.error).toBe('Orbital not found: JournalOrbital');
  });

  it('a dispatch landing in the resolve window is served when the swap is bracketed', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'real', debug: false, persistence: new InMemoryPersistence() });
    await rt.register(oldAppSchema());

    // The bracketed swap: the epoch stays pending for the WHOLE callback, so
    // the mid-window dispatch below awaits the completed registration.
    const swap = rt.withRegistrationMutation(async () => {
      rt.unregisterAll();
      await tick(50); // models resolveOrbForLoad latency
      await rt.register(accountingSchema());
    });
    const response = await rt.processOrbitalEvent('JournalOrbital', {
      event: 'INIT',
      targetTrait: 'JournalHome',
    });
    await swap;

    expect(response.error).toBeUndefined();
    expect(response.success).toBe(true);
    expect(response.transitioned).toBe(true);
    expect(response.states['JournalHome']).toBe('idle');
  });

  it('concurrent swap brackets serialize — the second swap starts only after the first fully completes', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'real', debug: false, persistence: slowPersistence(50) });
    await rt.register(oldAppSchema());

    // Two hosts swapping at once (e.g. a catalog select racing a preview
    // remount's /register). Unserialized, the second callback interleaves
    // with the first's slow doRegister — its unregisterAll() clears the map
    // mid-register and the two schemas mix.
    let firstFinished = false;
    let secondSawFirstFinished: boolean | null = null;
    const first = rt.withRegistrationMutation(async () => {
      rt.unregisterAll();
      await rt.register(accountingSchema()); // slow: seeds through slowPersistence
      firstFinished = true;
    });
    const second = rt.withRegistrationMutation(async () => {
      secondSawFirstFinished = firstFinished;
      rt.unregisterAll();
      await rt.register(oldAppSchema());
    });
    await Promise.all([first, second]);

    expect(secondSawFirstFinished).toBe(true);
    // The survivor is exactly the second app.
    expect(rt.listOrbitals()).toEqual(['OldOrbital']);
  });

  it('a failed swap releases the epoch — later dispatches get the honest 404, and the next register is not wedged', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'real', debug: false, persistence: new InMemoryPersistence() });
    await rt.register(oldAppSchema());

    const failed = rt.withRegistrationMutation(async () => {
      rt.unregisterAll();
      await tick(10);
      throw new Error('resolve failed');
    });
    await expect(failed).rejects.toThrow('resolve failed');

    // Epoch released: an unknown orbital 404s immediately (does not hang)…
    const response = await rt.processOrbitalEvent('JournalOrbital', { event: 'INIT' });
    expect(response.success).toBe(false);
    expect(response.error).toBe('Orbital not found: JournalOrbital');

    // …and the queue is not wedged — the next swap registers cleanly.
    await rt.withRegistrationMutation(async () => {
      rt.unregisterAll();
      await rt.register(accountingSchema());
    });
    const after = await rt.processOrbitalEvent('JournalOrbital', {
      event: 'INIT',
      targetTrait: 'JournalHome',
    });
    expect(after.success).toBe(true);
    expect(after.transitioned).toBe(true);
  });
});
