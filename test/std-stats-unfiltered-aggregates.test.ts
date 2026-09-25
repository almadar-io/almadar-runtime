/**
 * std-stats reads a metric's optional `filter` as `(object/get @metric filter
 * true)`; a metric without one must aggregate every row, not count 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { buildTraitIndex, createIndexStageRunner, evaluateOrbitalEvent, InMemoryPersistence, StateMachineManager } from '../src/index.js';

const R = join(__dirname, '..', '..', '..');

async function cardsFor(metrics: ReadonlyArray<Record<string, string | ReadonlyArray<string | boolean>>>) {
  const raw = JSON.parse(readFileSync(join(R, 'packages/almadar-std/behaviors/registry/ui/core/atoms/std-stats.orb'), 'utf-8')) as OrbitalSchema;
  const r = await preprocessSchema(raw, { basePath: join(R, 'packages/almadar-std'), stdLibPath: join(R, 'packages/almadar-std'), allowOutsideBasePath: true });
  if (!r.success) throw new Error(r.errors.join('; '));
  const s = r.data.schema;
  const traitIndex = buildTraitIndex(s.orbitals, { StatsItemStats: { metrics: [...metrics] } });
  const persistence = new InMemoryPersistence();
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const frames = new Map<string, EntityRow>();
  const deps = { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) };
  await evaluateOrbitalEvent(deps, { event: 'INIT', targetTrait: 'StatsItemStats' });
  const res = await evaluateOrbitalEvent(deps, {
    event: 'ITEMS_LOADED',
    targetTrait: 'StatsItemStats',
    payload: { data: [{ id: 'a', v: 2, on: true }, { id: 'b', v: 4, on: false }, { id: 'c', v: 6, on: true }] },
  });
  const cards = res.entityByTrait?.['StatsItemStats']?.['cards'];
  return Array.isArray(cards)
    ? cards.map((c) => (typeof c === 'object' && c !== null && !Array.isArray(c) && !(c instanceof Date) ? c['value'] : undefined))
    : [];
}

describe('std-stats metrics without a filter', () => {
  it('count / sum / avg aggregate every row', async () => {
    expect(await cardsFor([
      { label: 'Count', aggregation: 'count' },
      { label: 'Sum', aggregation: 'sum', field: 'v' },
      { label: 'Avg', aggregation: 'avg', field: 'v' },
    ])).toEqual([3, 12, 4]);
  });

  it('control: a lambda filter still narrows the rows', async () => {
    expect(await cardsFor([
      { label: 'On', aggregation: 'count', filter: ['fn', 'row', '@row.on'] },
    ])).toEqual([2]);
  });
});
