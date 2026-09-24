/**
 * G-RUNTIME-042 — std-time-tracking /reports on the stateful topology: once
 * the client sends its mounted set (`_activeTraits`), the server leaves the
 * on-page listeners (the stat tiles re-INITing on the aggregators' loads) to
 * the client's response fold. The fold's local re-run must render the value
 * the server-side aggregator computed — Active Employees > 0, Total Hours > 0.
 */
import { getTraitName } from '@almadar/core';
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import {
  buildTraitIndex,
  createClientKernel,
  createInProcessTransport,
  createMemoryCircuitStore,
  type IndexedTrait,
  type TraitIndex,
} from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const TT_ORB = join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/organisms/std-time-tracking.orb');

function restrict(full: TraitIndex, names: ReadonlySet<string>): TraitIndex {
  const byName = new Map<string, IndexedTrait>();
  for (const [name, entry] of full.byName) if (names.has(name)) byName.set(name, entry);
  return { byName, allEntities: full.allEntities, orbitals: full.orbitals };
}

describe.skipIf(!existsSync(TT_ORB))('stateful fold of mounted listeners (std-time-tracking /reports)', () => {
  it('the stat tiles and the billable chart render the aggregated values', async () => {
    const raw = JSON.parse(readFileSync(TT_ORB, 'utf-8')) as OrbitalSchema;
    const resolved = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    if (!resolved.success) throw new Error(resolved.errors.join('; '));
    const s = resolved.data.schema;
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(s);

    const full = buildTraitIndex(s.orbitals);
    const page = s.orbitals.flatMap((o) => o.pages ?? []).find((p) => typeof p === 'object' && p.path === '/reports');
    const pageTraits = typeof page === 'object' ? (page.traits ?? []).map((t) => (typeof t === 'object' && 'ref' in t ? t.ref : getTraitName(t))) : [];
    const traitIndex = restrict(full, new Set(pageTraits));
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({
      orbitalName: traitIndex.byName.get(pageTraits[0] ?? '')?.orbitalName ?? '',
      traitIndex,
      fullTraitIndex: full,
      store,
      carriesCircuitState: false,
      transport: createInProcessTransport((orbital, request) => runtime.processOrbitalEvent(orbital, request)),
    });

    const lastPattern = new Map<string, Record<string, unknown>>();
    for (const t of pageTraits) {
      const { response } = await kernel.dispatch({ event: 'INIT', targetTrait: t });
      for (const { traitName, effect } of response.clientEffectsByTrait ?? []) {
        const pattern = effect[0] === 'render-ui' ? effect[2] : undefined;
        if (pattern !== null && typeof pattern === 'object' && !Array.isArray(pattern)) lastPattern.set(traitName, pattern as Record<string, unknown>);
      }
    }
    // A client-only trait's render defers `@entity.*` bindings to the UI, which
    // resolves them against the trait's frame; resolve the same way here.
    const shown = (trait: string, prop: string) => {
      const value = lastPattern.get(trait)?.[prop];
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'expression' in value) {
        const expr = value.expression;
        const frameKey = traitIndex.byName.get(trait)?.frameKey;
        if (typeof expr === 'string' && expr.startsWith('@entity.') && frameKey !== undefined) {
          return store.frames.get(frameKey)?.[expr.slice('@entity.'.length)];
        }
      }
      return value;
    };
    expect(Number(shown('TimesheetStatTotalHours', 'value'))).toBeGreaterThan(0);
    expect(Number(shown('TimesheetStatBillableHours', 'value'))).toBeGreaterThan(0);
    const chart = shown('TimeEntryBillableBreakdown', 'data');
    expect(Array.isArray(chart) && chart.length > 0).toBe(true);
  }, 120_000);
});
