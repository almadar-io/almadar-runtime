/**
 * Nested composed refs (ledger (i)).
 *
 * `resolveTraitRefString`'s imported branch used to reach `findTraitInOrbital`,
 * whose "reference with name" arm did nothing — so a trait entry that is
 * itself a REF (an atom re-exporting a sibling's trait under its own name,
 * e.g. `std-note`'s `NoteSubpages = Related.traits.RelatedItemList`) resolved
 * to nothing, and any consumer naming it through a THIRD alias
 * (`std-notes`'s `PageAtom.traits.NoteSubpages`) failed with
 * `Trait "NoteSubpages" not found in imported orbital "PageAtom"`.
 * `resolveTraitEntry` (shared with `pullSiblingTraits`' sibling pull, which
 * already solved this shape) fixes both the synthetic two-level case here
 * and the real `std-notes.orb` corpus case below.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { OrbitalDefinition, OrbitalSchema, Orbital, TraitRef } from '@almadar/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_DIR = path.join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry');
const hasCorpus = existsSync(REGISTRY_DIR);

// Three levels: `Organism` (the top-level consumer) -> `PageAtom` (an
// intermediate atom whose OWN trait is a REF, never inline) -> `Base` (the
// std atom that actually owns the inline trait body).
function baseOrbital(): Orbital {
  return {
    name: 'BaseOrbital',
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'RecordItemDetail',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

// `MidTrait` is declared as a REF inside `PageAtom`'s OWN trait list — the
// exact shape `findTraitEntryInOrbital`'s ref arm returns, and the shape
// `findTraitInOrbital`'s dead "reference with name" branch used to reach.
function midOrbital(): Orbital {
  return {
    name: 'MidOrbital',
    uses: [{ from: './base.orb', as: 'Base' }],
    entity: { name: 'MidItem', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{ ref: 'Base.traits.RecordItemDetail', name: 'MidTrait' }],
    pages: [],
  };
}

function makeNestedLoader(): SchemaLoader {
  const base = baseOrbital();
  const mid = midOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './base.orb') {
        return { success: true, data: { orbital: base, sourcePath: './base.orb', importPath } };
      }
      if (importPath === './mid.orb') {
        return { success: true, data: { orbital: mid, sourcePath: './mid.orb', importPath } };
      }
      return { success: false, error: `unexpected import path: ${importPath}` };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

describe('ReferenceResolver — nested composed trait refs (ledger (i))', () => {
  it('resolves a trait named through a THIRD alias whose own entry is itself a ref one level deeper', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeNestedLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Organism',
      uses: [{ from: './mid.orb', as: 'PageAtom' }],
      entity: { name: 'OrganismEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: ['PageAtom.traits.MidTrait'],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const midTrait = result.data.traits.find((rt) => rt.trait.name === 'MidTrait');
    expect(midTrait).toBeDefined();
    expect(midTrait!.trait.stateMachine?.transitions).toHaveLength(1);
  });

  it('resolves the same shape when the outer reference is a `{ref, ...}` object with call-site overrides', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeNestedLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Organism',
      uses: [{ from: './mid.orb', as: 'PageAtom' }],
      entity: { name: 'OrganismEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{ ref: 'PageAtom.traits.MidTrait', name: 'Renamed' }],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.traits.find((rt) => rt.trait.name === 'Renamed')).toBeDefined();
  });
});

describe.skipIf(!hasCorpus)('ReferenceResolver — nested composed trait refs: real std-notes.orb corpus case', () => {
  it('preprocessSchema succeeds on std-notes.orb and resolves the nested NoteSubpages ref in NoteOrbital', async () => {
    const stdNotesPath = path.join(
      REPO_ROOT,
      'packages/almadar-behaviors/behaviors/registry/app/organisms/std-notes.orb',
    );
    const fs = await import('node:fs/promises');
    const schema = JSON.parse(await fs.readFile(stdNotesPath, 'utf8')) as OrbitalSchema;

    const result = await preprocessSchema(schema, {
      basePath: path.join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: path.join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const noteOrbital = result.data.schema.orbitals.find((o) => o.name === 'NoteOrbital');
    expect(noteOrbital).toBeDefined();
    // The property under test is that the third-alias ref resolves — never a
    // trait count, which moves whenever a composed std atom changes shape.
    const subpages = noteOrbital!.traits.find(
      (t): t is Extract<TraitRef, { ref: string }> =>
        typeof t === 'object' && t !== null && 'ref' in t && t.ref === 'NoteSubpages',
    );
    expect(subpages).toBeDefined();
    expect(subpages !== undefined && '_resolved' in subpages && subpages._resolved !== undefined).toBe(true);
    for (const entry of noteOrbital!.traits) {
      if (typeof entry === 'object' && entry !== null && 'ref' in entry) {
        expect('_resolved' in entry && entry._resolved !== undefined, `unresolved ref ${entry.ref}`).toBe(true);
      }
    }
  });
});
