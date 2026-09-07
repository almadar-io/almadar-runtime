/**
 * C1-J5: schema-wide entity-id visibility across a schema's OWN orbitals,
 * resolved sequentially. JS twin of the compiled path's `consumer_entity_ids`
 * (`orbital-compiler/src/phases/inline/mod.rs`), which is built once, then
 * `.extend(collect_orbital_entity_ids(orbital))`-ed after EACH orbital
 * inlines — so a later orbital's `-> Entity` rebind can recover an id an
 * EARLIER orbital's no-rebind sibling pull already established for that
 * entity NAME.
 *
 * Found live in `std-api-gateway`: `RouteOrbital`'s no-rebind `Audit.traits.
 * AuditCaptureListener` pull establishes `AuditEntry`'s id (the Audit atom's
 * OWN id, carried in verbatim); `GatewayUserOrbital`, declared LATER in the
 * same file, rebinds `Browse.traits.BrowseItemBrowse -> AuditEntry`. Before
 * this fix, `ReferenceResolver.resolve()` had no schema-wide id map at all,
 * so the rebind's `entityRefIds` side-map either carried the Browse atom's
 * OWN (foreign) id forward under the renamed key, or (pre-C1-R3-era) dropped
 * it — never the real, already-established `AuditEntry` id. This test
 * mirrors that exact shape with two synthetic atoms.
 */

import { describe, it, expect } from 'vitest';
import { resolveSchema } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalSchema } from '@almadar/core';
import { asEntityId } from '@almadar/core';

const AUDIT_ENTRY_ID = asEntityId('ent_AUDIT00000000000000000A');
const BROWSE_RECORD_ID = asEntityId('ent_BROWS00000000000000000B');

// The "Audit" atom: its own entity is "AuditEntry"; `AuditCaptureListener`'s
// `entityRefIds` side-map ties the bare `AuditEntry` token to the atom's OWN
// stamped id — exactly the shape `orbital_core::stamp` produces.
function auditAtomOrbital(): Orbital {
  return {
    name: 'AuditAtomOrbital',
    entity: {
      name: 'AuditEntry',
      persistence: 'persistent',
      id: AUDIT_ENTRY_ID,
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [
      {
        name: 'AuditCaptureListener',
        scope: 'instance',
        linkedEntity: 'AuditEntry',
        linkedEntityId: AUDIT_ENTRY_ID,
        entityRefIds: { AuditEntry: AUDIT_ENTRY_ID },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'AuditEntry']] }],
        },
      },
    ],
    pages: [],
  };
}

// The "Browse" atom: its own entity is "BrowseRecord" — a DIFFERENT name and
// id than "AuditEntry". `BrowseItemBrowse`'s `entityRefIds` ties the bare
// `BrowseRecord` token to the Browse atom's OWN (foreign, unrelated) id.
function browseAtomOrbital(): Orbital {
  return {
    name: 'BrowseAtomOrbital',
    entity: {
      name: 'BrowseRecord',
      persistence: 'runtime',
      id: BROWSE_RECORD_ID,
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [
      {
        name: 'BrowseItemBrowse',
        scope: 'instance',
        linkedEntity: 'BrowseRecord',
        linkedEntityId: BROWSE_RECORD_ID,
        entityRefIds: { BrowseRecord: BROWSE_RECORD_ID },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'BrowseRecord']] }],
        },
      },
    ],
    pages: [],
  };
}

function makeLoader(): SchemaLoader {
  const audit = auditAtomOrbital();
  const browse = browseAtomOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './audit.orb') {
        return { success: true, data: { orbital: audit, sourcePath: './audit.orb', importPath } };
      }
      if (importPath === './browse.orb') {
        return { success: true, data: { orbital: browse, sourcePath: './browse.orb', importPath } };
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

describe('ReferenceResolver — schema-wide entity-id visibility across sequentially-resolved orbitals', () => {
  it("a later orbital's rebind recovers the id an earlier orbital's no-rebind sibling pull already established for that entity name", async () => {
    const schema: OrbitalSchema = {
      name: 'GatewaySchema',
      orbitals: [
        {
          // Resolved FIRST — pulls `AuditEntry` (the Audit atom's OWN
          // entity, no `-> Entity` rebind) into its own `auxiliaryEntities`.
          name: 'RouteOrbital',
          uses: [{ from: './audit.orb', as: 'Audit' }],
          entity: {
            name: 'Route',
            persistence: 'persistent',
            id: asEntityId('ent_ROUTE0000000000000000RT'),
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [{ ref: 'Audit.traits.AuditCaptureListener' }],
          pages: [],
        },
        {
          // Resolved SECOND — rebinds the Browse atom's trait onto
          // `AuditEntry`, a name it never declares itself.
          name: 'GatewayUserOrbital',
          uses: [{ from: './browse.orb', as: 'Browse' }],
          entity: {
            name: 'GatewayUser',
            persistence: 'persistent',
            id: asEntityId('ent_GWUSR000000000000000GU'),
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [{ ref: 'Browse.traits.BrowseItemBrowse', linkedEntity: 'AuditEntry' }],
          pages: [],
        },
      ],
    };

    const result = await resolveSchema(schema, { basePath: '.', loader: makeLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const [routeResolved, gatewayUserResolved] = result.data;

    // Sanity: RouteOrbital's no-rebind pull surfaced `AuditEntry` with the
    // Audit atom's OWN id.
    const auditAux = routeResolved.auxiliaryEntities?.find((e) => e.name === 'AuditEntry');
    expect(auditAux?.id).toBe(AUDIT_ENTRY_ID);

    // GatewayUserOrbital's rebound trait must carry `entityRefIds` keyed by
    // the REBIND TARGET name (`AuditEntry`), holding the id RouteOrbital
    // already established for it — never the Browse atom's own foreign id,
    // and never dropped.
    const rebound = gatewayUserResolved.traits.find((rt) => rt.trait.name === 'BrowseItemBrowse');
    expect(rebound).toBeDefined();
    const trait = rebound!.trait;
    expect(trait.linkedEntity).toBe('AuditEntry');
    expect(trait.entityRefIds?.BrowseRecord).toBeUndefined();
    expect(trait.entityRefIds?.AuditEntry).toBe(AUDIT_ENTRY_ID);
  });
});
