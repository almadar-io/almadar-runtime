/**
 * Payload-field `entity` marker rename (B4-C's `PayloadField.entity` /
 * `EventPayloadField.entity` — stamped when an entity-typed payload field,
 * scalar or array-of-entity, is flattened into `type: "object"`/`"[object]"`
 * + `properties`). Every entity-rename surface must rewrite it or a composed
 * trait rebound to another entity keeps describing its OWN payload as the
 * atom's original entity — found on the real registry `std-notes.orb`:
 * `NoteDelete` (`Confirmation.traits.ConfirmActionConfirmation -> Note`)
 * resolved with `DELETE.payloadSchema[row].entity === "ConfirmAction"`
 * instead of `"Note"`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, Event, TraitRef } from '@almadar/core';
import { asEntityId } from '@almadar/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_DIR = path.join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry');
const hasCorpus = existsSync(REGISTRY_DIR);

function payloadEntityOf(events: readonly Event[] | undefined, eventKey: string, fieldName: string): string | undefined {
  const event = events?.find((e) => e.key === eventKey);
  const field = event?.payloadSchema?.find((f) => f.name === fieldName);
  return field?.entity;
}

describe('ReferenceResolver — payload-field entity marker rename: linkedEntity rebind', () => {
  function confirmationOrbital(): Orbital {
    return {
      name: 'ConfirmationOrbital',
      entity: { name: 'ConfirmAction', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        {
          name: 'ConfirmActionConfirmation',
          scope: 'instance',
          linkedEntity: 'ConfirmAction',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [
              {
                key: 'DELETE',
                name: 'Delete',
                payloadSchema: [
                  { name: 'id', type: 'string', required: true },
                  {
                    name: 'row',
                    type: 'object',
                    entity: 'ConfirmAction',
                    properties: [{ name: 'id', type: 'string' }],
                  },
                ],
              },
            ],
            transitions: [{ from: 'idle', to: 'idle', event: 'DELETE', effects: [] }],
          },
        },
      ],
      pages: [],
    };
  }

  function makeLoader(): SchemaLoader {
    const confirmation = confirmationOrbital();
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital(importPath: string) {
        if (importPath === './confirmation.orb') {
          return { success: true, data: { orbital: confirmation, sourcePath: './confirmation.orb', importPath } };
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

  it('rewrites the `-> Entity` rebound trait\'s payload `entity` marker (std-notes-shaped: ConfirmAction -> Note)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital: OrbitalDefinition = {
      name: 'NoteOrbital',
      uses: [{ from: './confirmation.orb', as: 'Confirmation' }],
      entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{ ref: 'Confirmation.traits.ConfirmActionConfirmation', name: 'NoteDelete', linkedEntity: 'Note' }],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const noteDelete = result.data.traits.find((rt) => rt.trait.name === 'NoteDelete');
    expect(noteDelete).toBeDefined();
    expect(payloadEntityOf(noteDelete?.trait.stateMachine?.events, 'DELETE', 'row')).toBe('Note');
  });
});

describe('ReferenceResolver — payload-field entity marker rename: pulled-sibling splice (prefixed)', () => {
  function atomOrbital(atomName: string, entityName: string): Orbital {
    return {
      name: `${atomName}Orbital`,
      entity: { name: entityName, persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        {
          name: `Owner${atomName}`,
          scope: 'instance',
          linkedEntity: entityName,
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'OPEN', name: 'Open' }],
            transitions: [
              {
                from: 'idle',
                to: 'idle',
                event: 'OPEN',
                effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Sibling'] }]],
              },
            ],
          },
        },
        {
          name: 'Sibling',
          scope: 'instance',
          linkedEntity: entityName,
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [
              {
                key: 'CONFIRM',
                name: 'Confirm',
                payloadSchema: [
                  { name: 'row', type: 'object', entity: entityName, properties: [{ name: 'id', type: 'string' }] },
                ],
              },
            ],
            transitions: [{ from: 'idle', to: 'idle', event: 'CONFIRM', effects: [] }],
          },
        },
      ],
      pages: [],
    };
  }

  function makeLoader(): SchemaLoader {
    const atomA = atomOrbital('A', 'AtomAItem');
    const atomB = atomOrbital('B', 'AtomBItem');
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital(importPath: string) {
        if (importPath === './atomA.orb') {
          return { success: true, data: { orbital: atomA, sourcePath: './atomA.orb', importPath } };
        }
        if (importPath === './atomB.orb') {
          return { success: true, data: { orbital: atomB, sourcePath: './atomB.orb', importPath } };
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

  it('rewrites the payload `entity` marker on a PREFIXED (collision-spliced) pulled sibling', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    // Two owners, from two different upstream atoms, each embedding a
    // bare `@trait.Sibling` — neither declares "Sibling" explicitly, so
    // one of the two collides and gets prefixed. `pullSiblingTraits` drains
    // its worklist LIFO (`work.pop()`, C1-J8 — JS twin of Rust's own
    // `worklist.pop()`, `orbital-compiler/src/phases/inline/trait.rs:2026`,
    // verified against the compiled path's actual `orbital resolve` output):
    // the LAST-pushed top-level seed pops FIRST, so `WidgetOwnerB`'s pull
    // (pushed second, since `WidgetOwnerB` is declared after `WidgetOwnerA`
    // in `traits[]`) drains first and keeps the bare name; `WidgetOwnerA`'s
    // collides second and gets prefixed to `WidgetOwnerASibling`.
    const orbital: OrbitalDefinition = {
      name: 'WidgetOrbital',
      uses: [
        { from: './atomA.orb', as: 'AtomA' },
        { from: './atomB.orb', as: 'AtomB' },
      ],
      entity: { name: 'Widget', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        { ref: 'AtomA.traits.OwnerA', name: 'WidgetOwnerA', linkedEntity: 'Widget' },
        { ref: 'AtomB.traits.OwnerB', name: 'WidgetOwnerB', linkedEntity: 'Widget' },
      ],
      pages: [],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const prefixed = result.data.traits.find((rt) => rt.trait.name === 'WidgetOwnerASibling');
    expect(prefixed).toBeDefined();
    expect(payloadEntityOf(prefixed?.trait.stateMachine?.events, 'CONFIRM', 'row')).toBe('Widget');
    const unprefixed = result.data.traits.find((rt) => rt.trait.name === 'Sibling');
    expect(unprefixed).toBeDefined();
    expect(payloadEntityOf(unprefixed?.trait.stateMachine?.events, 'CONFIRM', 'row')).toBe('Widget');
  });
});

describe('ReferenceResolver — payload-field entity marker rename: orbital import `entities {}` retarget', () => {
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
      traits: [
        {
          name: 'Fetcher',
          scope: 'instance',
          linkedEntity: 'Widget',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [
              {
                key: 'LOAD',
                name: 'Load',
                payloadSchema: [
                  { name: 'row', type: 'object', entity: 'Other', properties: [{ name: 'id', type: 'string' }] },
                ],
              },
            ],
            transitions: [{ from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'Other', {}]] }],
          },
        },
      ],
      pages: [],
    };
  }

  function otherPrimaryOrbital(): Orbital {
    return {
      name: 'OtherOwnerOrbital',
      entity: { name: 'Other', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [],
    };
  }

  function makeLoader(): SchemaLoader {
    const main = mainOrbital();
    const otherOwner = otherPrimaryOrbital();
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital(importPath: string) {
        if (importPath === './up.orb') {
          return {
            success: true,
            data: { orbital: main, orbitals: [main, otherOwner], sourcePath: './up.orb', importPath },
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

  function findTraitRefByName(traits: readonly TraitRef[], name: string): Exclude<TraitRef, string> | undefined {
    for (const t of traits) {
      if (typeof t === 'string') continue;
      if ('stateMachine' in t) {
        if (t.name === name) return t;
        continue;
      }
      const refObj = t as { ref: string; name?: string };
      if (refObj.ref === name) return t;
    }
    return undefined;
  }

  it('rewrites a payload `entity` marker retargeted through `entities {}` to the consumer\'s real entity', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'ConsumerApp',
      orbitals: [
        {
          name: 'Local',
          uses: [{ from: './up.orb', as: 'Up' }],
          entity: 'Up.orbitals.MainOrbital.entity',
          reference: { ref: 'Up.orbitals.MainOrbital', entities: { Other: 'ConsumerOther' } },
          traits: [],
          pages: [],
        },
        {
          name: 'ConsumerOtherOwner',
          entity: { id: asEntityId('ent_CONSUMEROTHERID00000000'), name: 'ConsumerOther', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
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
    const fetcher = local ? findTraitRefByName(local.traits, 'LocalFetcher') : undefined;
    expect(fetcher).toBeDefined();
    const trait = fetcher && 'stateMachine' in fetcher ? fetcher : undefined;
    expect(payloadEntityOf(trait?.stateMachine?.events, 'LOAD', 'row')).toBe('ConsumerOther');
  });
});

describe.skipIf(!hasCorpus)('ReferenceResolver — payload-field entity marker rename: real registry corpus', () => {
  it('preprocessSchema on std-notes.orb resolves NoteDelete\'s DELETE.payloadSchema[row].entity to "Note"', async () => {
    const schemaPath = path.join(
      REPO_ROOT,
      'packages/almadar-behaviors/behaviors/registry/app/organisms/std-notes.orb',
    );
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as OrbitalSchema;

    const result = await preprocessSchema(schema, {
      basePath: path.join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: path.join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    let found: Exclude<TraitRef, string> | undefined;
    for (const orbital of result.data.schema.orbitals) {
      for (const t of orbital.traits) {
        if (typeof t === 'string') continue;
        if ('stateMachine' in t) {
          if (t.name === 'NoteDelete') {
            found = t;
            break;
          }
          continue;
        }
        const refObj = t as { ref: string; _resolved?: Exclude<TraitRef, string> };
        if (refObj.ref === 'NoteDelete') {
          found = refObj._resolved ?? t;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBeDefined();
    const events = found && 'stateMachine' in found ? found.stateMachine?.events : undefined;
    expect(payloadEntityOf(events, 'DELETE', 'row')).toBe('Note');
  });
});
