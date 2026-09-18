/**
 * `OrbitalServerRuntime.processOrbitalEvent` — Fix A: same-trait
 * fetch->emit->self-apply cascade completion (the STATEFUL server path).
 *
 * Mirrors the shape confirmed live via `orbital_play` against
 * `std-time-tracking.lolo`'s `TimesheetDashboardHoursAggregator`: `INIT` does
 * `(fetch Entity {emit: {success: Loaded}})`, and a SEPARATE arm
 * `Loaded -> newState` applies `(set @entity.X ...)` using the fetched data.
 * Before this fix, `sendEvent` computed exactly one hop and `executeEffects`
 * ran once — `SourceLoaded` fired with real fetched data but the aggregator's
 * own `(set @entity.total ...)` arm never ran, and the manager's own tracked
 * state stayed frozen one hop behind. This is the twin of
 * `packages/almadar-playground-runtime/__tests__/transition-handler.test.ts`'s
 * `TraitAggregatesOnFetch` case, but driven through the STATEFUL,
 * manager-backed path instead of the stateless per-request one.
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/PersistenceAdapter.js';
import type { OrbitalSchema, EventPayload } from '@almadar/core';

function aggregatorSchema(): OrbitalSchema {
  return {
    name: 'cascade-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'SourceOrbital',
        pages: [],
        entity: {
          name: 'SourceRow',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', primaryKey: true },
            { name: 'amount', type: 'number', default: 0 },
          ],
        },
        traits: [],
      },
      {
        name: 'AggregatorOrbital',
        pages: [],
        entity: {
          name: 'AggregateResult',
          persistence: 'runtime',
          fields: [
            { name: 'id', type: 'string', primaryKey: true },
            { name: 'total', type: 'number', default: 0 },
          ],
        },
        traits: [
          {
            name: 'TraitAggregatesOnFetch',
            scope: 'instance',
            linkedEntity: 'AggregateResult',
            stateMachine: {
              // Three DISTINCT states (not a same-state self-loop) so the
              // test also proves the manager's OWN tracked state advances
              // past hop 1 — `CHECK_TOTAL` below only has an arm from
              // 'ready', so it would silently fail to fire if
              // `setCascadeFinalState` weren't called after the cascade.
              states: [
                { name: 'idle', isInitial: true },
                { name: 'loading' },
                { name: 'ready' },
              ],
              events: [
                { key: 'INIT', name: 'INIT' },
                { key: 'SourceLoaded', name: 'SourceLoaded' },
                { key: 'CHECK_TOTAL', name: 'CHECK_TOTAL' },
              ],
              transitions: [
                {
                  from: 'idle', to: 'loading', event: 'INIT',
                  effects: [['fetch', 'SourceRow', { emit: { success: 'SourceLoaded' } }]],
                },
                {
                  from: 'loading', to: 'ready', event: 'SourceLoaded',
                  effects: [['set', '@entity.total', ['array/sum', '@payload.data', 'amount']]],
                },
                {
                  from: 'ready', to: 'ready', event: 'CHECK_TOTAL',
                  effects: [['emit', 'CHECK_RESULT', { total: '@entity.total' }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function setup() {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(aggregatorSchema());
  await runtime.persistence.create('SourceRow', { amount: 10 });
  await runtime.persistence.create('SourceRow', { amount: 20 });
  await runtime.persistence.create('SourceRow', { amount: 30 });
  return runtime;
}

describe('OrbitalServerRuntime.processOrbitalEvent — Fix A: same-trait cascade', () => {
  it('completes fetch->emit->self-apply within ONE dispatch, not just the first hop', async () => {
    const runtime = await setup();
    const result = await runtime.processOrbitalEvent('AggregatorOrbital', { event: 'INIT' });

    expect(result.success).toBe(true);
    const sourceLoaded = result.emittedEvents.find((e) => e.event === 'SourceLoaded');
    expect(sourceLoaded).toBeDefined();
    expect((sourceLoaded?.payload as EventPayload | undefined)?.totalCount).toBe(3);

    // The state machine landed on 'ready' (hop 2's target), not 'loading'
    // (hop 1's target) — proves the cascade actually ran the second arm,
    // not just the fetch.
    expect(result.states['TraitAggregatesOnFetch']).toBe('ready');
  });

  it('stamps the consumed SourceLoaded event dispatched:true so a mounted client does not re-apply it', async () => {
    const runtime = await setup();
    const result = await runtime.processOrbitalEvent('AggregatorOrbital', { event: 'INIT' });

    const sourceLoaded = result.emittedEvents.find((e) => e.event === 'SourceLoaded');
    expect(sourceLoaded?.source?.dispatched).toBe(true);
  });

  it('the manager\'s OWN tracked state advances past hop 1 — a LATER request sees "ready", not "loading"', async () => {
    const runtime = await setup();
    await runtime.processOrbitalEvent('AggregatorOrbital', { event: 'INIT' });

    // CHECK_TOTAL only has an arm from 'ready'. If `sendEvent`'s own hop-1
    // commit ('loading') were left uncorrected after the cascade advanced
    // the trait further, this second, independent request would find no
    // matching transition and CHECK_RESULT would never fire.
    const check = await runtime.processOrbitalEvent('AggregatorOrbital', { event: 'CHECK_TOTAL' });
    expect(check.transitioned).toBe(true);
    const checkResult = check.emittedEvents.find((e) => e.event === 'CHECK_RESULT');
    expect((checkResult?.payload as EventPayload | undefined)?.total).toBe(60);
  });
});
