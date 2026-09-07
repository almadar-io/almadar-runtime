/**
 * `extend { … }` — ADD fields to an orbital-reference's primary entity
 * (C1-L-J). Self-contained (unlike `extend_fields.json`'s shared fixture,
 * whose upstream also exercises the PRE-EXISTING `ORB_O_ENTITY_UNMAPPED`
 * hard-refuse — reported separately, not an `extend {}` concern) so these
 * three rules are provable in isolation: append after `fields {}` renames,
 * relation-typed added field resolves its target in the CONSUMER scope, and
 * a name collision refuses with `ORB_O_EXTEND_FIELD_COLLISION`.
 */
import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, Entity, Trait, TraitRef } from '@almadar/core';
import { asEntityId } from '@almadar/core';

function upstreamOrbital(): Orbital {
  return {
    name: 'MainOrbital',
    entity: {
      name: 'Widget',
      persistence: 'persistent',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [],
    pages: [],
  };
}

function makeLoader(): SchemaLoader {
  const upstream = upstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './main.orb') {
        return { success: true, data: { orbital: upstream, orbitals: [upstream], sourcePath: './main.orb', importPath } };
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

function isInlineEntityRef(e: OrbitalDefinition['entity']): e is Entity {
  return typeof e === 'object' && !('extends' in e) && !('ref' in (e as object));
}

describe('ReferenceResolver — orbital-reference `extend {}` (C1-L-J)', () => {
  it('appends an extend field after fields {} renames, resolving a relation target in the CONSUMER scope', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'App',
      orbitals: [
        {
          name: 'Local',
          entity: 'Up.orbitals.MainOrbital.entity',
          reference: {
            ref: 'Up.orbitals.MainOrbital',
            fields: { id: 'localId' },
            extend: [
              { name: 'overtimeHours', type: 'number', default: 0 },
              { name: 'workspaceId', type: 'relation', relation: { entity: 'Workspace', cardinality: 'one' } },
            ],
          },
          traits: [],
          pages: [],
          uses: [{ as: 'Up', from: './main.orb' }],
        },
        {
          name: 'WorkspaceOwner',
          entity: {
            name: 'Workspace',
            id: asEntityId('ent_CONSUMERWORKSPACE00000'),
            persistence: 'persistent',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [],
          pages: [],
        },
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const local = result.data.find((o) => o.name === 'Local');
    expect(local).toBeDefined();
    if (!local || !isInlineEntityRef(local.entity)) return;

    // fields {} rename survives.
    expect(local.entity.fields.find((f) => f.name === 'id')).toBeUndefined();
    expect(local.entity.fields.find((f) => f.name === 'localId')).toBeDefined();

    // extend appended, scalar field untouched.
    const overtime = local.entity.fields.find((f) => f.name === 'overtimeHours');
    expect(overtime).toBeDefined();
    expect(overtime?.type).toBe('number');
    expect(overtime?.type === 'number' ? overtime.default : undefined).toBe(0);

    // relation-typed extend field resolves its entityId in the CONSUMER scope.
    const workspaceId = local.entity.fields.find((f) => f.name === 'workspaceId');
    expect(workspaceId).toBeDefined();
    expect(workspaceId?.type === 'relation' ? workspaceId.relation.entity : undefined).toBe('Workspace');
    expect(workspaceId?.type === 'relation' ? workspaceId.relation.entityId : undefined).toBe(
      asEntityId('ent_CONSUMERWORKSPACE00000'),
    );
  });

  it('refuses an extend field whose name collides with the upstream primary (post-rename) — ORB_O_EXTEND_FIELD_COLLISION', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'App',
      orbitals: [
        {
          name: 'Local',
          entity: 'Up.orbitals.MainOrbital.entity',
          reference: {
            ref: 'Up.orbitals.MainOrbital',
            extend: [{ name: 'id', type: 'string' }],
          },
          traits: [],
          pages: [],
          uses: [{ as: 'Up', from: './main.orb' }],
        },
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.includes('ORB_O_EXTEND_FIELD_COLLISION'))).toBe(true);
  });

  it('refuses an extend field whose name collides with a fields {} rename TARGET', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'App',
      orbitals: [
        {
          name: 'Local',
          entity: 'Up.orbitals.MainOrbital.entity',
          reference: {
            ref: 'Up.orbitals.MainOrbital',
            fields: { id: 'localId' },
            extend: [{ name: 'localId', type: 'string' }],
          },
          traits: [],
          pages: [],
          uses: [{ as: 'Up', from: './main.orb' }],
        },
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.includes('ORB_O_EXTEND_FIELD_COLLISION'))).toBe(true);
  });
});

/**
 * G4 (`Almadar_Compiler_Gaps.md` §82): a two-hop import — a leaf atom whose
 * `ItemUpdated` emit is the bare `type X = Event Item` alias form
 * (`payloadEntity: "Item"`), composed into a middle "organism" via a PLAIN
 * trait reference (§8, the exact `trait TimeEntryLog = TimeEntry.traits.
 * TimeEntryLog {}` shape `std-time-tracking.lolo` uses — no override at
 * that hop), then imported WHOLE by a top-level consumer via an orbital
 * reference (§8b) that both renames a field (`hourlyRate` -> `billRate`)
 * and `extend {}`s a new one (`workspaceId`). The payload must mirror the
 * FINAL materialized entity, not the atom's frozen original shape.
 */
describe('ReferenceResolver — entity-shaped emit payload tracks fields{}/extend{} through a two-hop import (G4)', () => {
  function g4Atom(): Orbital {
    return {
      name: 'ItemAtomOrbital',
      entity: {
        name: 'Item',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'hourlyRate', type: 'number' },
        ],
      },
      traits: [
        {
          name: 'ItemLog',
          linkedEntity: 'Item',
          category: 'interaction',
          scope: 'collection',
          emits: [
            {
              event: 'ItemUpdated',
              payloadEntity: 'Item',
              payloadSchema: [
                { name: 'id', type: 'string', required: true },
                { name: 'hourlyRate', type: 'number' },
              ],
            },
          ],
          stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
        },
      ],
      pages: [],
    };
  }

  function g4Organism(): Orbital {
    return {
      name: 'ItemOrganismOrbital',
      uses: [{ as: 'Atom', from: './g4-atom.orb' }],
      entity: {
        name: 'Item',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'hourlyRate', type: 'number' },
        ],
      },
      traits: [{ ref: 'Atom.traits.ItemLog' }],
      pages: [],
    };
  }

  function makeG4Loader(): SchemaLoader {
    const atom = g4Atom();
    const organism = g4Organism();
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital(importPath: string) {
        if (importPath === './g4-atom.orb') {
          return { success: true, data: { orbital: atom, orbitals: [atom], sourcePath: importPath, importPath } };
        }
        if (importPath === './g4-organism.orb') {
          return { success: true, data: { orbital: organism, orbitals: [organism], sourcePath: importPath, importPath } };
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

  it('recomputes the entity-shaped ItemUpdated payload from the materialized entity (renamed field + extend field)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG4Loader() });
    const schema: OrbitalSchema = {
      name: 'App',
      orbitals: [
        {
          name: 'Consumer',
          entity: 'Organism.orbitals.ItemOrganismOrbital.entity',
          reference: {
            ref: 'Organism.orbitals.ItemOrganismOrbital',
            fields: { hourlyRate: 'billRate' },
            extend: [{ name: 'workspaceId', type: 'string', default: '' }],
          },
          traits: [],
          pages: [],
          uses: [{ as: 'Organism', from: './g4-organism.orb' }],
        },
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const consumer = result.data.find((o) => o.name === 'Consumer');
    expect(consumer).toBeDefined();
    if (!consumer) return;

    function isInlineTraitRef(t: TraitRef): t is Trait {
      return typeof t === 'object' && 'name' in t && 'stateMachine' in t;
    }
    const itemLog = consumer.traits.find((t) => isInlineTraitRef(t) && t.name.endsWith('ItemLog'));
    expect(itemLog).toBeDefined();
    if (!itemLog || !isInlineTraitRef(itemLog)) return;
    const emit = itemLog.emits?.find((e) => e.event === 'ItemUpdated');
    expect(emit).toBeDefined();

    const names = emit?.payloadSchema?.map((f) => f.name);
    expect(names).toEqual(['id', 'billRate', 'workspaceId']);

    if (!isInlineEntityRef(consumer.entity)) throw new Error('entity must be materialized inline');
    const entityFieldNames = consumer.entity.fields.map((f) => f.name);
    expect(names).toEqual(entityFieldNames);
  });
});
