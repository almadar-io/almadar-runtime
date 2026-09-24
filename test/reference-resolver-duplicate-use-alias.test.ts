/**
 * Twin of orbital-compiler `duplicate_use_alias_is_rejected`: one alias
 * declared twice in an orbital's `uses` is an error on both paths (std-iram
 * declared `UiCard` twice and only the runtime refused it).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

function schemaWithUses(uses: { as: string; from: string }[]): OrbitalSchema {
  return {
    name: 'App',
    orbitals: [{
      name: 'ConsumerOrbital',
      uses,
      entity: { name: 'Host', fields: [{ name: 'id', type: 'string' }] },
      traits: [],
      pages: [],
    }],
  } as OrbitalSchema;
}

async function resolve(uses: { as: string; from: string }[]) {
  return preprocessSchema(schemaWithUses(uses), {
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
    allowOutsideBasePath: true,
  });
}

describe('duplicate uses alias', () => {
  it.each([
    [[{ as: 'UiCard', from: 'std/behaviors/ui-card' }, { as: 'UiCard', from: 'std/behaviors/ui-card' }]],
    [[{ as: 'UiCard', from: 'std/behaviors/ui-card' }, { as: 'UiCard', from: 'std/behaviors/ui-box' }]],
  ])('is rejected: %j', async (uses) => {
    const result = await resolve(uses);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join('\n')).toContain('Duplicate import alias: UiCard');
  });

  it('control: one file under two aliases resolves', async () => {
    const result = await resolve([{ as: 'UiCard', from: 'std/behaviors/ui-card' }, { as: 'UiCardToo', from: 'std/behaviors/ui-card' }]);
    expect(result.success, result.success ? '' : result.errors.join('\n')).toBe(true);
  });
});
