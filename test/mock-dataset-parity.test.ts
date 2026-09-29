/**
 * The JS half of the shared seeded mock-dataset vector (canonical source:
 * `@almadar-io/parity` `fixtures/mock-seed/dataset.seeded.json`, mirrored here and into
 * orbital-core by the pattern-sync bake). The runtime, the compiled apps' `MockDataService`
 * (a facade over this store) and orbital-core's seeder must all produce these rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, OrbitalSchema, UserContext } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

interface DatasetVector {
  schema: OrbitalSchema;
  viewer: UserContext;
  nowMs: number;
  count: number;
  rows: Record<string, EntityRow[]>;
}

const vector: DatasetVector = JSON.parse(readFileSync(join(import.meta.dirname, 'baked', 'mock-seed', 'dataset.seeded.json'), 'utf8'));

async function seeded(viewer: UserContext): Promise<Record<string, EntityRow[]>> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(vector.nowMs);
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, defaultUser: viewer });
  await runtime.register(vector.schema);
  const out: Record<string, EntityRow[]> = {};
  for (const entity of Object.keys(vector.rows)) out[entity] = await runtime.persistence.list(entity);
  return out;
}

afterEach(() => { vi.useRealTimers(); });

describe('seeded mock-dataset parity vector', () => {
  it('reproduces the committed store', async () => {
    expect(vector.count).toBe(6);
    expect(await seeded(vector.viewer)).toEqual(vector.rows);
  });

  it('control: another viewer changes only the owner stamps', async () => {
    const other = await seeded({ ...vector.viewer, id: 'Person Id 5', role: 'agent' });
    expect(other['Tag']).toEqual(vector.rows['Tag']);
    expect(other['Ticket']).not.toEqual(vector.rows['Ticket']);
  });
});
