/**
 * G-RUNTIME-045: std-storefront's shop stats (`StorefrontShelf`, a std-stats
 * trait fed by `StorefrontCatalog.BrowseItemLoaded -> ITEMS_LOADED`) must show
 * the loaded catalog's counts after mount, on both topologies — the stateless
 * host painted the INIT zeros.
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
const ORB = join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/marketing/organisms/std-storefront.orb');

function restrict(full: TraitIndex, names: ReadonlySet<string>): TraitIndex {
  const byName = new Map<string, IndexedTrait>();
  for (const [name, entry] of full.byName) if (names.has(name)) byName.set(name, entry);
  return { byName, allEntities: full.allEntities, orbitals: full.orbitals };
}

describe.skipIf(!existsSync(ORB)).each(['stateful', 'stateless'] as const)('storefront shop stats (%s)', (topology) => {
  it('the Products card holds the catalog count after mount', async () => {
    const raw = JSON.parse(readFileSync(ORB, 'utf-8')) as OrbitalSchema;
    const resolved = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    if (!resolved.success) throw new Error(resolved.errors.join('; '));
    const schema = resolved.data.schema;
    const persistence = new MockPersistenceAdapter({ ownerId: DEFAULT_VIEWER.id });
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
    await runtime.register(schema);
    const total = (await persistence.list('Product')).length;
    expect(total).toBeGreaterThan(0);

    const full = buildTraitIndex(schema.orbitals);
    const orbital = schema.orbitals.find((o) => (o.pages ?? []).some((p) => typeof p === 'object' && p.path === '/'));
    const page = orbital?.pages?.find((p) => typeof p === 'object' && p.path === '/');
    const pageTraits = typeof page === 'object' ? (page.traits ?? []).map((t) => (typeof t === 'object' && 'ref' in t ? t.ref : getTraitName(t))) : [];
    const traitIndex = restrict(full, new Set(pageTraits));
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const transport = topology === 'stateful'
      ? createInProcessTransport((o, request) => runtime.processOrbitalEvent(o, request))
      : createInProcessTransport(async (_o, request) => {
        const manager = new StateMachineManager([...full.byName.values()].map((e) => e.traitDef));
        const frames = new Map<string, EntityRow>();
        return evaluateOrbitalEvent(
          { traitIndex: full, manager, persistence, frames, runtimeRowSentinel: true, runEffects: createIndexStageRunner({ traitIndex: full, persistence, frames, manager, schema }) },
          request,
        );
      }, { carriesCircuitState: true });
    const kernel = createClientKernel({
      orbitalName: orbital?.name ?? '',
      traitIndex,
      fullTraitIndex: full,
      store,
      carriesCircuitState: topology === 'stateless',
      transport,
    });
    // As the UI hook does: the page's traits enter the mount, then each runs INIT in order.
    store.mount.mounting(pageTraits);
    for (const t of pageTraits) await kernel.dispatch({ event: 'INIT', targetTrait: t });

    const shelf = traitIndex.byName.get('StorefrontShelf');
    const cards = store.frames.get(shelf?.frameKey ?? 'StorefrontShelf')?.['cards'];
    let productsValue: unknown;
    for (const c of Array.isArray(cards) ? cards : []) {
      if (typeof c === 'object' && c !== null && !Array.isArray(c) && !(c instanceof Date) && c['label'] === 'Products') productsValue = c['value'];
    }
    expect(productsValue).toBe(total);
  }, 120_000);
});
