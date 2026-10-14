/**
 * `ServerEffectResult.code` on a persist update/delete: `no-row-key` when no row key resolves,
 * `not-found` when the keyed row is absent. One fixture, read by this suite and by orbital-core's
 * `tests/persist_effect_codes.rs` (canonical source `@almadar-io/parity` `fixtures/effect-codes`,
 * mirrored into `test/baked/`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema, ServerEffectResult } from '@almadar/core';
import { InMemoryPersistence, MockPersistenceAdapter } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

interface Case {
  name: string;
  event: string;
  payload: Record<string, string>;
  expect: { success: boolean; code?: ServerEffectResult['code'] };
}
interface Vector {
  schema: OrbitalSchema;
  cases: Case[];
}

const vector: Vector = JSON.parse(readFileSync(join(import.meta.dirname, 'baked', 'effect-codes', 'persist-codes.json'), 'utf8'));

async function persistResult(c: Case, mode: 'real' | 'mock'): Promise<ServerEffectResult | undefined> {
  const persistence = mode === 'mock' ? new MockPersistenceAdapter({ seed: 1 }) : new InMemoryPersistence();
  const runtime = new OrbitalServerRuntime({ persistence, mode, debug: false });
  await runtime.register(vector.schema);
  const response = await runtime.processOrbitalEvent('Notes', { event: c.event, targetTrait: 'Editor', payload: c.payload });
  return response.effectResults?.find((r) => r.effect === 'persist');
}

describe.each(['real', 'mock'] as const)('persist effect codes (%s persistence)', (mode) => {
  it.each(vector.cases)('$name', async (c) => {
    const result = await persistResult(c, mode);
    expect(result?.success).toBe(c.expect.success);
    expect(result?.code).toBe(c.expect.code);
  });
});
