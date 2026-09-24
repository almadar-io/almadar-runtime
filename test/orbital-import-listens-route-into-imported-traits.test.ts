/**
 * Twin of orbital-compiler `import_listens_*`: an orbital import's
 * `listens { Source.EVENT -> Target.TRIGGER }` appends a declared route to the
 * materialized imported trait. project-friday hands ProjectLifecycle's create
 * and BudgetLifecycle's CONSUME_HOURS / ROLL_OVER into imported traits this way;
 * without the route they reach nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { buildTraitIndex, collectListenerTargets } from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const PF = 'packages/almadar-behaviors/behaviors/registry/project-friday/organisms/project-friday.orb';
const OPTS = {
  basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
  stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
  allowOutsideBasePath: true,
};

function pf(): OrbitalSchema {
  return JSON.parse(readFileSync(join(REPO_ROOT, PF), 'utf-8')) as OrbitalSchema;
}

describe('orbital import listens', () => {
  it.each([
    ['ProjectLifecycle', 'PROJECT_CREATE_REQUESTED', 'ProjectOrbitalProjectPersistor:PROJECT_CREATE_REQUESTED'],
    ['BudgetLifecycle', 'CONSUME_HOURS', 'BudgetOrbitalBudgetHoursLifecycle:CONSUME_HOURS'],
    ['BudgetLifecycle', 'ROLL_OVER', 'BudgetOrbitalBudgetHoursLifecycle:ROLL_OVER'],
  ])('%s.%s reaches %s', async (trait, event, expected) => {
    const res = await preprocessSchema(pf(), OPTS);
    if (!res.success) throw new Error(res.errors.join('; '));
    const index = buildTraitIndex(res.data.schema.orbitals);
    const e = index.byName.get(trait);
    if (!e) throw new Error(`no ${trait}`);
    const targets = collectListenerTargets(index, {
      orbital: e.orbitalName,
      trait,
      ...(e.orbitalId !== undefined ? { orbitalId: e.orbitalId } : {}),
      ...(e.irTrait.id !== undefined ? { traitId: e.irTrait.id } : {}),
    }, event, {}).map((t) => `${t.listenerTrait}:${t.triggers}`);
    expect(targets).toContain(expected);
  });

  it('a target outside the imported set refuses resolution', async () => {
    const schema = pf();
    const project = schema.orbitals.find((o) => o.name === 'ProjectOrbital');
    const ref = project?.reference;
    if (!ref || !ref.listens) throw new Error('PF ProjectOrbital import listens missing');
    project.reference = { ...ref, listens: [{ ...ref.listens[0], trait: 'NoSuchTrait' }] };
    const res = await preprocessSchema(schema, OPTS);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errors.join('\n')).toContain('ORB_O_LISTEN_TARGET_UNKNOWN');
  });
});
