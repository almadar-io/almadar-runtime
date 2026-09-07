/**
 * (B) order-free `entities {}` mapping across TWO sibling reference-form
 * orbitals in the SAME consumer schema: import 1's `entities {}` names an
 * out-of-orbital primary onto import 2's OWN materialized entity — legal
 * regardless of orbital ORDER, since `consumerEntityIdsOf` must include
 * every reference-form orbital's materialized primary BEFORE the per-orbital
 * flatten loop runs, not just already-inline ones. Mirrors the compiled
 * path's `entities_map_onto_a_sibling_reference_form_orbitals_materialized_entity_is_order_free`
 * (`orbital-compiler/tests/orbital_import_validation.rs`) — the approved
 * Project Friday shape (`TimesheetOrbital`'s `entities { ApprovalRequest:
 * ApprovalRequest }` targeting `ApprovalRequestOrbital`'s own materialized
 * entity, declared LATER in the schema).
 */

import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, Entity, EntityRef, Trait } from '@almadar/core';
import { isEntityReferenceAny } from '@almadar/core';

function isInlineEntityRef(e: EntityRef): e is Entity {
  return !isEntityReferenceAny(e);
}

/** `MainA`'s entity `AItem` relates to `BItem`, an OUT-OF-ORBITAL entity
 *  that is `MainB`'s own PRIMARY (mapping is REQUIRED — `ORB_O_ENTITY_UNMAPPED`
 *  if left unmapped, not an aux-only auto-clone). Also carries a positional
 *  `fetch`/`ref`-shaped body token naming `BItem` so the rewrite is provable
 *  beyond the relation field. */
function mainAOrbital(): Orbital {
  return {
    name: 'MainA',
    entity: {
      name: 'AItem',
      persistence: 'persistent',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'bId', type: 'relation', relation: { entity: 'BItem', cardinality: 'one' } },
      ],
    },
    traits: [
      {
        name: 'AItemFetcher',
        scope: 'instance',
        linkedEntity: 'AItem',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'LOAD', name: 'Load' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'BItem', {}]] }],
        },
      },
    ],
    pages: [],
  };
}

function mainBOrbital(): Orbital {
  return {
    name: 'MainB',
    entity: {
      name: 'BItem',
      persistence: 'persistent',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [],
    pages: [],
  };
}

function makeLoader(orbitals: Orbital[]): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './up.orb') {
        return {
          success: true,
          data: { orbital: orbitals[0], orbitals, sourcePath: './up.orb', importPath },
        };
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

/** `ImportA` (processed FIRST, since orbitals resolve in schema order) maps
 *  out-of-orbital `BItem` onto `LocalB` — `ImportB`'s OWN materialized
 *  primary, declared SECOND. The order-free fix under test. */
function importAOrbital(): OrbitalDefinition {
  return {
    name: 'ImportA',
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: 'Up.orbitals.MainA.entity',
    reference: { ref: 'Up.orbitals.MainA', entities: { BItem: 'LocalB' } },
    traits: [],
    pages: [],
  };
}

function importBOrbital(): OrbitalDefinition {
  return {
    name: 'ImportB',
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: 'Up.orbitals.MainB.entity',
    reference: { ref: 'Up.orbitals.MainB', entity: 'LocalB' },
    traits: [],
    pages: [],
  };
}

describe('ReferenceResolver — order-free `entities {}` mapping across sibling reference-form orbitals (B)', () => {
  it('ImportA maps onto ImportB\'s materialized entity even though ImportB resolves SECOND', async () => {
    const resolver = new ReferenceResolver({
      basePath: '.',
      loader: makeLoader([mainAOrbital(), mainBOrbital()]),
    });
    const schema: OrbitalSchema = {
      name: 'ConsumerApp',
      orbitals: [importAOrbital(), importBOrbital()],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const importA = result.data.find((o) => o.name === 'ImportA');
    const importB = result.data.find((o) => o.name === 'ImportB');
    expect(importA).toBeDefined();
    expect(importB).toBeDefined();

    expect(isInlineEntityRef(importB!.entity)).toBe(true);
    const bEntity = importB!.entity as Entity;
    expect(bEntity.name).toBe('LocalB');
    expect(bEntity.id).toBeTruthy();

    // The relation field on ImportA's materialized primary must retarget to
    // "LocalB" with LocalB's OWN id — not a fresh/foreign id, and not left
    // unmapped.
    expect(isInlineEntityRef(importA!.entity)).toBe(true);
    const aEntity = importA!.entity as Entity;
    const relField = aEntity.fields.find((f) => f.name === 'bId');
    expect(relField).toBeDefined();
    expect(relField?.type === 'relation' ? relField.relation.entity : undefined).toBe('LocalB');
    expect(relField?.type === 'relation' ? relField.relation.entityId : undefined).toBe(bEntity.id);

    // The `["fetch", "BItem", …]` positional token must also retarget.
    const fetcher = importA!.traits.find(
      (t): t is Trait => typeof t !== 'string' && 'stateMachine' in t && t.name === 'ImportAAItemFetcher',
    );
    expect(fetcher).toBeDefined();
    const blob = JSON.stringify(fetcher?.stateMachine?.transitions);
    expect(blob).toContain('"LocalB"');
    expect(blob).not.toContain('"BItem"');
  });
});
