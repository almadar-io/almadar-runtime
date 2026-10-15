/**
 * persist update/delete under a declared @update/@delete policy, one fixture (`@almadar-io/parity`
 * `fixtures/effect-codes/persist-guard-codes.json`, mirrored into `test/baked/`), run on a capable adapter (the
 * policy rides the write as its guard) and on a plain one (the policy is read-then-checked): identical results.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, OrbitalSchema, PersistenceAdapter, ServerEffectResult, UserContext } from '@almadar/core';
import { InMemoryPersistence, MockPersistenceAdapter } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

interface Case {
  name: string;
  event: string;
  payload: Record<string, string>;
  user?: UserContext;
  expect: { success: boolean; code?: ServerEffectResult['code']; denied?: true };
}
interface Vector {
  schema: OrbitalSchema;
  cases: Case[];
}

const vector: Vector = JSON.parse(readFileSync(join(import.meta.dirname, 'baked', 'effect-codes', 'persist-guard-codes.json'), 'utf8'));

const plain = (inner: PersistenceAdapter): PersistenceAdapter => ({
  create: (t, d) => inner.create(t, d),
  update: (t, id, d) => inner.update(t, id, d),
  delete: (t, id) => inner.delete(t, id),
  getById: (t, id) => inner.getById(t, id),
  list: (t) => inner.list(t),
});

const stores: Record<string, () => PersistenceAdapter> = {
  'capable memory': () => new InMemoryPersistence(),
  'capable mock': () => new MockPersistenceAdapter({ seed: 1 }),
  'plain memory': () => plain(new InMemoryPersistence()),
};

describe.each(Object.keys(stores))('persist guard codes (%s)', (name) => {
  it.each(vector.cases)('$name', async (c) => {
    const persistence = stores[name]();
    const runtime = new OrbitalServerRuntime({ persistence, mode: name === 'capable mock' ? 'mock' : 'real', debug: false });
    await runtime.register(vector.schema);
    if (name !== 'capable mock') {
      const rows: EntityRow[] = [{ id: 'd1', title: 'one', owner: 'u1' }, { id: 'd2', title: 'two', owner: 'u2' }];
      for (const row of rows) await persistence.create('Doc', { ...row });
    }
    const response = await runtime.processOrbitalEvent('Docs', { event: c.event, targetTrait: 'Editor', payload: c.payload, ...(c.user ? { user: c.user } : {}) });
    const result = response.effectResults?.find((r) => r.effect === 'persist');
    expect(result?.success).toBe(c.expect.success);
    expect(result?.code).toBe(c.expect.code);
    expect(result?.denied).toBe(c.expect.denied);
  });
});
