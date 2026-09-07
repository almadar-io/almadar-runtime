/**
 * (C) gate: the same node assertion run on the Rust `orb resolve` output —
 * every trait's `entityRefIds` key is declared in its orbital (primary or
 * `auxiliaryEntities`) with the matching id, on BOTH imports — must ALSO
 * pass on the pure JS `preprocessSchema` path over the SAME
 * `orbital_import_disjoint.lolo` scratch fixture. The fixture below is the
 * RAW reference-form `.orb` `orb emit orb orbital_import_disjoint.lolo`
 * produces (two bare `orbital X = Crm.orbitals.PipelineOrbital { pages
 * {…} }` imports of `almadar-behaviors/std-crm`'s `PipelineOrbital`,
 * embedded here so the test is self-contained — no external `/tmp`
 * artifact to regenerate).
 *
 * Proves the (C) fix: JS's `pullSiblingTraits` now carries an un-rebound
 * (or cross-alias-rebound) sibling's own bound entity into the pulling
 * orbital's resolved `auxiliaryEntities` (mirroring the compiled path's
 * `pulled_aux_entities`), so `materializeOrbitalRef`'s unconditional
 * `subs`/prefix-rename covers it too — matching Rust's discovery of an
 * alias's reachable entities via `Orbital.auxiliary_entities` mutated
 * in-place by `inline_orbital`.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { Entity, EntityId, OrbitalSchema } from '@almadar/core';
import { asOrbitalId } from '@almadar/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// `orb emit orb orbital_import_disjoint.lolo` output, verbatim (ids are the
// real derived ids from that emit — irrelevant to this test beyond being
// present, since the assertion below only checks internal consistency).
const DISJOINT_RAW_SCHEMA: OrbitalSchema = {
  description:
    'Negative 3: the same upstream orbital imported twice must yield disjoint trait sets and two booting route trees. Uses an orbital that does NOT own its organism\'s [identity] roster (importing an identity owner twice is correctly rejected by ORB_S_IDENTITY_NOT_UNIQUE).',
  ledger: {
    entries: {
      orb_01M1TY3B1DJKEFQSRMY8MS660J: {
        bakedName: 'PipelineA',
        curName: 'PipelineA',
        id: 'orb_01M1TY3B1DJKEFQSRMY8MS660J',
        kind: 'orbital',
        owner: 'workspace',
        renames: [],
      },
      orb_01M1TY3B1DXRHPM7B9C8J3CS4X: {
        bakedName: 'PipelineB',
        curName: 'PipelineB',
        id: 'orb_01M1TY3B1DXRHPM7B9C8J3CS4X',
        kind: 'orbital',
        owner: 'workspace',
        renames: [],
      },
    },
    schemaVersion: 1,
  },
  name: 'scratch-orbital-import-disjoint',
  orbitals: [
    {
      entity: 'Crm.orbitals.PipelineOrbital.entity',
      id: asOrbitalId('orb_01M1TY3B1DJKEFQSRMY8MS660J'),
      name: 'PipelineA',
      reference: { pages: { '/pipeline': '/a-pipeline' }, ref: 'Crm.orbitals.PipelineOrbital' },
      traits: [],
      pages: [],
      uses: [{ as: 'Crm', from: 'almadar-behaviors/std-crm' }],
    },
    {
      entity: 'Crm.orbitals.PipelineOrbital.entity',
      id: asOrbitalId('orb_01M1TY3B1DXRHPM7B9C8J3CS4X'),
      name: 'PipelineB',
      reference: { pages: { '/pipeline': '/b-pipeline' }, ref: 'Crm.orbitals.PipelineOrbital' },
      traits: [],
      pages: [],
      uses: [{ as: 'Crm', from: 'almadar-behaviors/std-crm' }],
    },
  ],
  schemaVersion: 1,
  theme: 'clay-light',
  version: '1.0.0',
};

describe('orbital_import_disjoint.lolo — entityRefIds coverage on the JS path (C)', () => {
  it('every entityRefIds key is declared in its orbital with the matching id, on both imports', async () => {
    const result = await preprocessSchema(DISJOINT_RAW_SCHEMA, {
      basePath: path.join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: path.join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const problems: string[] = [];
    for (const orbital of result.data.schema.orbitals) {
      const declared = new Map<string, EntityId>();
      const addEntity = (e: unknown) => {
        if (e && typeof e === 'object' && 'name' in e && 'id' in e) {
          const rec = e as Entity;
          if (rec.name && rec.id) declared.set(rec.name, rec.id);
        }
      };
      addEntity(orbital.entity);
      for (const aux of orbital.auxiliaryEntities ?? []) addEntity(aux);
      for (const tr of orbital.traits) {
        if (typeof tr === 'string' || !('entityRefIds' in tr) || !tr.entityRefIds) continue;
        for (const [key, id] of Object.entries(tr.entityRefIds)) {
          if (!declared.has(key)) {
            problems.push(
              `orbital ${orbital.name} trait ${tr.name} entityRefIds key "${key}" not declared (id ${id})`,
            );
          } else if (declared.get(key) !== id) {
            problems.push(
              `orbital ${orbital.name} trait ${tr.name} entityRefIds["${key}"]=${id} but declared id is ${declared.get(key)}`,
            );
          }
        }
      }
      // Every kept trait's `linkedEntity` must also be a name this orbital
      // declares (primary or aux) — the un-rebound composed-atom case this
      // fix targets fails HERE first if the carry is missing.
      for (const tr of orbital.traits) {
        if (typeof tr === 'string' || !('stateMachine' in tr)) continue;
        if (tr.linkedEntity !== undefined && !declared.has(tr.linkedEntity)) {
          problems.push(`orbital ${orbital.name} trait ${tr.name} linkedEntity "${tr.linkedEntity}" not declared`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
