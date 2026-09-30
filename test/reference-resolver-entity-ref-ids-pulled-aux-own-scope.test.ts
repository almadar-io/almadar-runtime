/**
 * A no-rebind atom pull surfaces the atom's OWN bound entity as an
 * auxiliary of the pulling orbital (Gap #22). The pulled trait's
 * `entityRefIds` must carry THAT id — the one this orbital's own aux list
 * carries — even when a DIFFERENT orbital of the same schema declares an
 * entity with the same NAME under another id (std-api-gateway:
 * `GatewayUserOrbital`'s local `AuditEntry` vs `RouteOrbital`'s pull of
 * `Audit.traits.AuditCaptureListener`). Twin of Rust's `seen_aux_names`,
 * pre-seeded with only the orbital's OWN primary + declared aux, and of
 * `entity_ids.extend(collect_orbital_entity_ids(orbital))`.
 */

import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition } from '@almadar/core';
import { asEntityId } from '@almadar/core';

const ATOM_ID = 'ent_ATOM00000000000000000000';
const SIBLING_ID = 'ent_SIBL00000000000000000000';
const OWN_ID = 'ent_OWN000000000000000000000';

const idField = { name: 'id', type: 'string', required: true } as const;

function atomOrbital(): Orbital {
  return {
    name: 'AtomOrbital',
    entity: { name: 'Shared', persistence: 'persistent', collection: 'shared', id: asEntityId(ATOM_ID), fields: [idField] },
    traits: [
      {
        name: 'AtomTrait',
        scope: 'instance',
        linkedEntity: 'Shared',
        linkedEntityId: asEntityId(ATOM_ID),
        entityRefIds: { Shared: asEntityId(ATOM_ID) },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'Shared']] }],
        },
      },
    ],
    pages: [],
  };
}

function loader(): SchemaLoader {
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
    clearCache() {},
    getCacheStats() {
      return { size: 0 };
    },
  };
}

function sibling(): OrbitalDefinition {
  return {
    name: 'Sibling',
    entity: { name: 'SiblingPrimary', persistence: 'persistent', id: asEntityId('ent_SPRI0000000000000000000'), fields: [idField] },
    auxiliaryEntities: [{ name: 'Shared', persistence: 'persistent', collection: 'shared', id: asEntityId(SIBLING_ID), fields: [idField] }],
    traits: [],
    pages: [],
  };
}

function consumer(withOwnShared: boolean): OrbitalDefinition {
  return {
    name: 'Consumer',
    uses: [{ from: './atom.orb', as: 'Atom' }],
    entity: { name: 'ConsumerPrimary', persistence: 'persistent', id: asEntityId('ent_CPRI0000000000000000000'), fields: [idField] },
    ...(withOwnShared
      ? { auxiliaryEntities: [{ name: 'Shared', persistence: 'persistent' as const, collection: 'shared', id: asEntityId(OWN_ID), fields: [idField] }] }
      : {}),
    traits: [{ ref: 'Atom.traits.AtomTrait' }],
    pages: [],
  };
}

async function resolveConsumer(withOwnShared: boolean) {
  const resolver = new ReferenceResolver({ basePath: '.', loader: loader() });
  const c = consumer(withOwnShared);
  resolver.seedSchemaEntityIds([c, sibling()]);
  const result = await resolver.resolve(c);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('resolve failed');
  const trait = result.data.traits.find((rt) => rt.trait.name === 'AtomTrait')!.trait;
  return { trait, aux: result.data.auxiliaryEntities ?? [] };
}

describe('no-rebind pull: entityRefIds follows the pulling orbital\'s own aux, not a sibling orbital\'s same-named entity', () => {
  it('carries the atom\'s id (the id of this orbital\'s pulled aux) over a sibling orbital\'s same-named declaration', async () => {
    const { trait, aux } = await resolveConsumer(false);
    expect(aux.find((e) => e.name === 'Shared')?.id).toBe(ATOM_ID);
    expect(trait.entityRefIds?.Shared).toBe(ATOM_ID);
  });

  it('control: an orbital that DECLARES its own same-named aux keeps its own id', async () => {
    const { trait } = await resolveConsumer(true);
    expect(trait.entityRefIds?.Shared).toBe(OWN_ID);
  });
});
