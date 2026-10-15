/**
 * EXEC-FETCH-1: a fetch with no `orderBy` is ordered by `createdAt` ascending, a row without one last, ties by id,
 * on a capable adapter (one `queryPage`) and on a plain one (list, then the same order in process). Runs on both
 * engines: the kernel config (`vitest.engine-kernel.config.ts`) swaps `OrbitalServerRuntime`. Rust twin:
 * `orbital-core` `effects::executor::tests::fetch_option_evaluation::without_order_by_the_default_order_is_created_at_then_id`.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EntityRow, OrbitalEventResponse, OrbitalSchema, PersistenceAdapter } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const emit = { emit: { success: 'LOADED', failure: 'FAILED' } };

const schema: OrbitalSchema = {
  name: 'default-order',
  version: '1.0.0',
  orbitals: [{
    name: 'Main',
    pages: [],
    entity: {
      name: 'Note',
      persistence: 'persistent',
      collection: 'notes',
      fields: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'title', type: 'string' }],
    },
    traits: [{
      name: 'Notes',
      scope: 'instance',
      linkedEntity: 'Note',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: ['ALL', 'WINDOW', 'BY_ID_DESC', 'LOADED', 'FAILED'].map((e) => ({ key: e, name: e })),
        transitions: [
          { from: 'idle', to: 'idle', event: 'ALL', effects: [['fetch', 'Note', emit]] },
          { from: 'idle', to: 'idle', event: 'WINDOW', effects: [['fetch', 'Note', { offset: 1, limit: 2, ...emit }]] },
          { from: 'idle', to: 'idle', event: 'BY_ID_DESC', effects: [['fetch', 'Note', { orderBy: 'id:desc', ...emit }]] },
          { from: 'idle', to: 'idle', event: 'LOADED' },
          { from: 'idle', to: 'idle', event: 'FAILED' },
        ],
      },
    }],
  }],
};

const ROWS: EntityRow[] = [
  { id: 'a', title: 'a', createdAt: '2026-03-02T00:00:00.000Z' },
  { id: 'b', title: 'b' },
  { id: 'c', title: 'c', createdAt: '2026-03-01T00:00:00.000Z' },
  { id: 'd', title: 'd', createdAt: '2026-03-02T00:00:00.000Z' },
];

const plain = (inner: PersistenceAdapter): PersistenceAdapter => ({
  create: (t, d) => inner.create(t, d),
  update: (t, id, d) => inner.update(t, id, d),
  delete: (t, id) => inner.delete(t, id),
  getById: (t, id) => inner.getById(t, id),
  list: (t) => inner.list(t),
});

async function load(wrap: (m: InMemoryPersistence) => PersistenceAdapter, event: string): Promise<{ ids: string[]; total: number }> {
  const memory = new InMemoryPersistence();
  for (const row of ROWS) await memory.create('Note', { ...row });
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: wrap(memory), debug: false });
  await runtime.register(schema);
  const response: OrbitalEventResponse = await runtime.processOrbitalEvent('Main', { event, targetTrait: 'Notes', payload: {} });
  expect(response.success).toBe(true);
  const loaded = response.emittedEvents.find((e) => e.event === 'LOADED');
  const data = loaded?.payload?.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return { ids: rows.map((r) => String((r as EntityRow).id)), total: Number(loaded?.payload?.totalCount) };
}

describe.each([
  ['a capable adapter', (m: InMemoryPersistence): PersistenceAdapter => m],
  ['a plain adapter', plain],
])('an unordered fetch on %s', (_name, wrap) => {
  it('is createdAt ascending, a row without a stamp last, ties by id', async () => {
    expect(await load(wrap, 'ALL')).toEqual({ ids: ['c', 'a', 'd', 'b'], total: 4 });
  });
  it('windows that order, the total counting every match', async () => {
    expect(await load(wrap, 'WINDOW')).toEqual({ ids: ['a', 'd'], total: 4 });
  });
  it('control: an authored orderBy replaces the default', async () => {
    expect(await load(wrap, 'BY_ID_DESC')).toEqual({ ids: ['d', 'c', 'b', 'a'], total: 4 });
  });
});
