/**
 * Project Friday, stateless topology: on /admin/finance/transactions, choosing
 * a type filter refetched the browse list, but clearing it did not. CLEAR_FILTERS
 * emits FILTER from the server leg; the server fanned it to the browse list at
 * its initial state (`loading`, no REFETCH_FILTER arm) instead of the client's
 * (`browsing`), so the unfiltered refetch was rejected. Normal organisms work;
 * Project Friday's traits come in through whole-orbital imports.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import { DEFAULT_VIEWER, getTraitName } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import {
  buildTraitIndex,
  createClientKernel,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  evaluateOrbitalEvent,
  StateMachineManager,
  type IndexedTrait,
  type TraitIndex,
} from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const PF_ORB = join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/project-friday/organisms/project-friday.orb');
const FILTER = 'FinanceTransactionOrbitalTransactionFilter';
const BROWSE = 'FinanceTransactionOrbitalTransactionBrowseList';

function restrict(full: TraitIndex, names: ReadonlySet<string>): TraitIndex {
  const byName = new Map<string, IndexedTrait>();
  for (const [name, entry] of full.byName) if (names.has(name)) byName.set(name, entry);
  return { byName, allEntities: full.allEntities, orbitals: full.orbitals };
}

describe.skipIf(!existsSync(PF_ORB))('project-friday transactions filter, stateless', () => {
  it('clearing the type filter refetches the browse list unfiltered', async () => {
    const raw = JSON.parse(readFileSync(PF_ORB, 'utf-8')) as OrbitalSchema;
    const resolved = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    if (!resolved.success) throw new Error(resolved.errors.join('; '));
    const schema = resolved.data.schema;
    const persistence = new MockPersistenceAdapter({ ownerId: DEFAULT_VIEWER.id });
    // The hosted store's mock seed; every event then runs on a fresh per-request host.
    const seeder = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
    await seeder.register(schema);
    const user = seeder.getDefaultUser();

    const full = buildTraitIndex(schema.orbitals);
    const page = schema.orbitals.flatMap((o) => o.pages ?? []).find((p) => typeof p === 'object' && p.path === '/admin/finance/transactions');
    const pageTraits = typeof page === 'object' ? (page.traits ?? []).map((t) => (typeof t === 'object' && 'ref' in t ? t.ref : getTraitName(t))) : [];
    const traitIndex = restrict(full, new Set(pageTraits));
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({
      orbitalName: 'FinanceTransactionOrbital',
      traitIndex,
      fullTraitIndex: full,
      store,
      carriesCircuitState: true,
      transport: createInProcessTransport(async (_orbital, request) => {
        const manager = new StateMachineManager([...full.byName.values()].map((e) => e.traitDef));
        const frames = new Map<string, EntityRow>();
        return evaluateOrbitalEvent(
          { traitIndex: full, manager, persistence, frames, runtimeRowSentinel: true, ...(user !== undefined ? { user } : {}), runEffects: createIndexStageRunner({ traitIndex: full, persistence, frames, manager, schema }) },
          request,
        );
      }, { carriesCircuitState: true }),
    });

    const loaded = (emitted: ReadonlyArray<{ event: string; payload?: { data?: unknown } }>) =>
      emitted.filter((e) => e.event === 'BrowseItemLoaded').map((e) => (Array.isArray(e.payload?.data) ? e.payload.data.length : -1));
    let total: number | undefined;
    for (const t of pageTraits) {
      const r = await kernel.dispatch({ event: 'INIT', targetTrait: t });
      total ??= loaded(r.response.emittedEvents ?? [])[0];
    }
    const stateOf = (t: string) => store.manager.getState(t)?.currentState;
    expect(stateOf(BROWSE)).toBe('browsing');

    const filtered = await kernel.dispatch({ event: 'FILTER', targetTrait: FILTER, payload: { field: 'type', value: 'expense' } });
    const cleared = await kernel.dispatch({ event: 'CLEAR_FILTERS', targetTrait: FILTER });
    expect(loaded(filtered.response.emittedEvents ?? []).every((n) => n < (total ?? 0))).toBe(true);
    expect(total).toBeGreaterThan(0);
    expect(loaded(cleared.response.emittedEvents ?? [])).toContain(total);
    expect(stateOf(BROWSE)).toBe('browsing');
  }, 120_000);
});
