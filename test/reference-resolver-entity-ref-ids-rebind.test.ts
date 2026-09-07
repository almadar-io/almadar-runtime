/**
 * `entityRefIds` (V4 leverage-ids side-map) must never survive a call-site
 * `linkedEntity` rebind carrying the ATOM's own stale id — the class of bug
 * found via the compiled path's `orbital_import_disjoint.lolo` id-integrity
 * gate (`ORB_ID_UNKNOWN_REF` on `entityRefIds[...]`) and confirmed live in
 * `std-crm`'s `PipelineAppLayout = AppShell.traits.AppLayout ->
 * PipelineDeal`, which kept `entityRefIds: { AppLayoutData: <AppShell's own
 * standalone id> }` verbatim post-rebind — foreign to any schema this trait
 * composes into.
 *
 * C1-J5: `applyLinkedEntityRename` now threads `ReferenceResolver.
 * entityIdsInScope` (schema-wide, grown by `noteResolvedEntityIds` as each
 * orbital resolves) to its call sites, so the compiled path's twin
 * (`stale_entity_rebind_subs` + `rewrite_entity_ref_ids` in
 * `orbital-compiler`, threaded a consumer-scope `entity_ids` map through
 * `apply_overrides_to_trait`) is no longer a two-path gap: the rebound key
 * is REFRESHED to the rebind target's own id when it is already known in
 * scope, and — matching Rust's own `unwrap_or(old_id)` fallback — keeps the
 * stale id under the renamed key when the target's id is not yet known,
 * rather than guessing or silently dropping the entry.
 */

import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition } from '@almadar/core';
import { asEntityId } from '@almadar/core';

// The atom: its OWN entity is "AtomEntity", and its one trait's `entityRefIds`
// side-map ties the bare `AtomEntity` token to the atom's OWN (standalone)
// id — exactly the shape `orbital_core::stamp` produces.
function atomOrbital(): Orbital {
  return {
    name: 'AtomOrbital',
    entity: { name: 'AtomEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'AtomTrait',
        scope: 'instance',
        linkedEntity: 'AtomEntity',
        linkedEntityId: asEntityId('ent_ATOM00000000000000000000'),
        entityRefIds: { AtomEntity: asEntityId('ent_ATOM00000000000000000000') },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'AtomEntity']] }],
        },
      },
    ],
    pages: [],
  };
}

function makeAtomLoader(): SchemaLoader {
  const atom = atomOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './atom.orb') {
        return { success: true, data: { orbital: atom, sourcePath: './atom.orb', importPath } };
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

describe('applyLinkedEntityRename refreshes the entityRefIds entry on rebind', () => {
  it('rebinding the atom to a different consumer entity REFRESHES the entityRefIds key to the consumer id, when known', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeAtomLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Consumer',
      uses: [{ from: './atom.orb', as: 'Atom' }],
      entity: {
        name: 'ConsumerEntity',
        persistence: 'persistent',
        // Stamped like every real registry entity — `entityIdsInScope`
        // reads THIS orbital's own declared primary before its traits
        // compose (matches the compiled path's `collect_orbital_entity_ids`
        // timing), so the rebind below can refresh, not merely drop.
        id: asEntityId('ent_CNSM0000000000000000000'),
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      traits: [{ ref: 'Atom.traits.AtomTrait', linkedEntity: 'ConsumerEntity' }],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const rebound = result.data.traits.find((rt) => rt.trait.name === 'AtomTrait');
    expect(rebound).toBeDefined();
    const trait = rebound!.trait;
    expect(trait.linkedEntity).toBe('ConsumerEntity');
    // The body token itself rebinds correctly (pre-existing behavior).
    const effects = trait.stateMachine?.transitions[0]?.effects;
    expect(JSON.stringify(effects)).toContain('ConsumerEntity');
    // The stale ATOM-scoped side-map key must be gone...
    expect(trait.entityRefIds?.AtomEntity).toBeUndefined();
    // ...renamed to the rebind target, carrying the CONSUMER's own id —
    // never the atom's foreign one.
    expect(trait.entityRefIds?.ConsumerEntity).toBe('ent_CNSM0000000000000000000');
  });

  it('rebinding to a consumer entity whose id is not yet known in scope keeps the stale id under the renamed key (Rust parity fallback)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeAtomLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Consumer',
      uses: [{ from: './atom.orb', as: 'Atom' }],
      // No `id` — an entity `entityIdsInScope` cannot resolve. Matches the
      // compiled path's own `entity_ids.get(name).unwrap_or(old_id)`
      // fallback: rename the key, but never invent or drop an id no scope
      // actually knows.
      entity: { name: 'ConsumerEntity', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{ ref: 'Atom.traits.AtomTrait', linkedEntity: 'ConsumerEntity' }],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const rebound = result.data.traits.find((rt) => rt.trait.name === 'AtomTrait');
    const trait = rebound!.trait;
    expect(trait.entityRefIds?.AtomEntity).toBeUndefined();
    expect(trait.entityRefIds?.ConsumerEntity).toBe('ent_ATOM00000000000000000000');
  });

  it('leaves entityRefIds untouched when no rebind is requested (no-op path)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeAtomLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Consumer',
      uses: [{ from: './atom.orb', as: 'Atom' }],
      entity: { name: 'ConsumerEntity', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{ ref: 'Atom.traits.AtomTrait' }],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const passthrough = result.data.traits.find((rt) => rt.trait.name === 'AtomTrait');
    expect(passthrough!.trait.entityRefIds).toEqual({ AtomEntity: 'ent_ATOM00000000000000000000' });
  });
});
