/**
 * Out-of-orbital entity ruling for `orbital X = Alias.orbitals.Y { … }`
 * (coordinator addendum, alongside ledger (n)-JS; Rust twin gets the same
 * ruling). The discriminator is PRIMARY vs AUXILIARY in the upstream, not
 * persistence: an out-of-orbital entity that is the PRIMARY entity of
 * another upstream orbital (e.g. `Employee`) requires `entities {}`. One
 * that appears ONLY as an auxiliary entity anywhere in the upstream
 * (materialized by descent from an atom — e.g. `std-notification-panel`'s
 * PERSISTENT `NotificationRecord`, or a runtime `AppLayoutData`) is CLONED
 * into the import (prefixed, fresh derived id) regardless of its
 * persistence — unless it is `[identity]` (still mapping required, since a
 * roster clone would fork `@user`/role comparisons away from the real
 * shared roster). Two imports of the same upstream produce two disjoint
 * prefixed clones.
 */

import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, EntityPersistence, Entity, EntityRef } from '@almadar/core';
import { isEntityReferenceAny } from '@almadar/core';

/** `OrbitalDefinition.auxiliaryEntities` is `EntityRef[]` (inline `Entity`
 *  or a reference form); every fixture here declares them inline, so this
 *  narrows the type down for assertions instead of casting. */
function isInlineEntityRef(e: EntityRef): e is Entity {
  return !isEntityReferenceAny(e);
}

/** `Widget` relates to `Other` — the relation target `relationTargetsOfEntity`
 *  reads to put `Other` into the imported closure's "referenced" set. */
function mainOrbital(): Orbital {
  return {
    name: 'MainOrbital',
    entity: {
      name: 'Widget',
      persistence: 'persistent',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'otherId', type: 'relation', relation: { entity: 'Other', cardinality: 'one' } },
      ],
    },
    traits: [],
    pages: [],
  };
}

/** A SIBLING orbital of the same upstream alias that declares `Other` ONLY
 *  as an AUXILIARY entity (its own primary is unrelated) — the
 *  `std-notification-panel`-shaped case: an entity materialized by descent
 *  from an atom, owned by no single orbital's record identity. `identity`
 *  marks it as the entity typing the ambient `@user` viewer
 *  (`Entity.identity`) — never safe to clone even when aux-only. */
function auxOwnerOrbital(otherPersistence: EntityPersistence, otherIdentity?: boolean): Orbital {
  return {
    name: 'AuxOwnerOrbital',
    entity: {
      name: 'AuxOwnerPrimary',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    auxiliaryEntities: [
      {
        name: 'Other',
        persistence: otherPersistence,
        ...(otherIdentity ? { identity: true } : {}),
        fields: [{ name: 'id', type: 'string', required: true }],
      },
    ],
    traits: [],
    pages: [],
  };
}

/** A SIBLING orbital of the same upstream alias whose PRIMARY entity IS
 *  `Other` — the primary-entity branch of the ruling, which still requires
 *  `entities {}` regardless of persistence: it is that orbital's own
 *  record identity, a real cross-orbital row. */
function primaryOtherOrbital(persistence: EntityPersistence): Orbital {
  return {
    name: 'PrimaryOtherOrbital',
    entity: {
      name: 'Other',
      persistence,
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [],
    pages: [],
  };
}

function makeLoader(main: Orbital, siblings: Orbital[]): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './up.orb') {
        return {
          success: true,
          data: { orbital: main, orbitals: siblings, sourcePath: './up.orb', importPath },
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

function referenceOrbital(name: string): OrbitalDefinition {
  return {
    name,
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: 'Up.orbitals.MainOrbital.entity',
    reference: { ref: 'Up.orbitals.MainOrbital' },
    traits: [],
    pages: [],
  };
}

describe('ReferenceResolver — orbital import: out-of-orbital entity clone ruling (primary vs aux-only)', () => {
  it('clones a PERSISTENT aux-only out-of-orbital entity into a prefixed aux entity instead of requiring `entities {}`', async () => {
    const main = mainOrbital();
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(main, [main, auxOwnerOrbital('persistent')]) });
    const schema: OrbitalSchema = { name: 'ConsumerApp', orbitals: [referenceOrbital('Local')] };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const local = result.data.find((o) => o.name === 'Local');
    expect(local).toBeDefined();
    const clone = local?.auxiliaryEntities?.find((e): e is Entity => isInlineEntityRef(e) && e.name === 'LocalOther');
    expect(clone).toBeDefined();
    expect(clone?.persistence).toBe('persistent');
  });

  it('still requires an `entities {}` mapping for an aux-only IDENTITY entity (the `@user` roster)', async () => {
    const main = mainOrbital();
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(main, [main, auxOwnerOrbital('runtime', true)]) });
    const schema: OrbitalSchema = { name: 'ConsumerApp', orbitals: [referenceOrbital('Local')] };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.includes('ORB_O_ENTITY_UNMAPPED'))).toBe(true);
  });

  it('still requires an `entities {}` mapping for an entity that is the PRIMARY of another orbital', async () => {
    const main = mainOrbital();
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(main, [main, primaryOtherOrbital('persistent')]) });
    const schema: OrbitalSchema = { name: 'ConsumerApp', orbitals: [referenceOrbital('Local')] };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.includes('ORB_O_ENTITY_UNMAPPED'))).toBe(true);
  });

  it('produces two disjoint prefixed clones for two imports of the same upstream', async () => {
    const main = mainOrbital();
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(main, [main, auxOwnerOrbital('runtime')]) });
    const schema: OrbitalSchema = {
      name: 'ConsumerApp',
      orbitals: [referenceOrbital('PipelineA'), referenceOrbital('PipelineB')],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const pipelineA = result.data.find((o) => o.name === 'PipelineA');
    const pipelineB = result.data.find((o) => o.name === 'PipelineB');
    const cloneA = pipelineA?.auxiliaryEntities?.find((e): e is Entity => isInlineEntityRef(e) && e.name === 'PipelineAOther');
    const cloneB = pipelineB?.auxiliaryEntities?.find((e): e is Entity => isInlineEntityRef(e) && e.name === 'PipelineBOther');
    expect(cloneA).toBeDefined();
    expect(cloneB).toBeDefined();
    expect(cloneA?.id).not.toBe(cloneB?.id);
  });
});
