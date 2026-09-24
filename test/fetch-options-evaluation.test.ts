// Fetch id/limit/offset are expressions evaluated at execution; twin of orbital-core executor `fetch_option_evaluation`.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { EntityRow, EventPayload, OrbitalSchema, SExpr } from '@almadar/core';

type FetchOptions = Record<string, SExpr>;

function schema(options: FetchOptions): OrbitalSchema {
  return {
    name: 'fetch-options-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Rows',
        pages: [],
        entity: {
          name: 'Row',
          persistence: 'persistent',
          fields: [
            { name: 'id', type: 'string', primaryKey: true },
            { name: 'n', type: 'number', default: 0 },
          ],
        },
        traits: [
          {
            name: 'RowBrowse',
            scope: 'instance',
            linkedEntity: 'Row',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'GO', name: 'GO' }],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'GO',
                  effects: [['fetch', 'Row', { ...options, emit: { success: 'ROWS_LOADED', failure: 'ROWS_FAILED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

type Outcome = { ok: true; ids: string[] } | { ok: false };

async function run(options: FetchOptions, payload: EventPayload = {}): Promise<Outcome> {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(schema(options));
  for (let i = 0; i < 5; i++) await runtime.persistence.create('Row', { id: `r${i}`, n: i });
  const response = await runtime.processOrbitalEvent('Rows', { event: 'GO', payload });
  const loaded = response.emittedEvents.find((e) => e.event === 'ROWS_LOADED');
  const failed = response.emittedEvents.find((e) => e.event === 'ROWS_FAILED');
  expect(Boolean(loaded) !== Boolean(failed)).toBe(true);
  if (failed) return { ok: false };
  const data = loaded?.payload?.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return { ok: true, ids: rows.map((row) => String((row as EntityRow).id)) };
}

function count(outcome: Outcome): number {
  expect(outcome.ok).toBe(true);
  return outcome.ok ? outcome.ids.length : -1;
}

describe('fetch option evaluation', () => {
  it('applies a literal limit', async () => {
    expect(count(await run({ limit: 2 }))).toBe(2);
  });

  it('applies payload-bound limit and offset', async () => {
    expect(count(await run({ limit: '@payload.limit', offset: '@payload.offset' }, { limit: 2, offset: 4 }))).toBe(1);
  });

  it('evaluates an expression limit on both branches', async () => {
    expect(count(await run({ limit: ['or', '@payload.limit', 3] }))).toBe(3);
    expect(count(await run({ limit: ['or', '@payload.limit', 3] }, { limit: 1 }))).toBe(1);
  });

  it('treats a non-positive or non-numeric limit as no limit', async () => {
    for (const limit of [0, -1, 'abc', '@payload.missing'] as const) {
      expect(count(await run({ limit }))).toBe(5);
    }
  });

  it('returns nothing for an offset past the end', async () => {
    expect(count(await run({ offset: 9 }))).toBe(0);
  });

  it('fetches one row for an expression id, not the collection', async () => {
    expect(await run({ id: ['object/get', '@payload', 'rowId'] }, { rowId: 'r3' })).toEqual({ ok: true, ids: ['r3'] });
  });

  it('fails an expression id that resolves to a non-id', async () => {
    expect(await run({ id: ['object/get', '@payload', 'rowId'] }, { rowId: true })).toEqual({ ok: false });
  });

  it('fails a by-id miss instead of succeeding empty', async () => {
    expect(await run({ id: '@payload.rowId' }, { rowId: 'zz' })).toEqual({ ok: false });
  });

  it('fails an unresolved id binding instead of widening to the collection', async () => {
    expect(await run({ id: '@payload.nope' })).toEqual({ ok: false });
  });
});
