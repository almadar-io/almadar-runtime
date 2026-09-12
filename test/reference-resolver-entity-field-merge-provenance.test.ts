/**
 * Entity-field auto-merge — `mergedFrom` provenance.
 *
 * `mergeImportedEntityFields` (`reference-resolver.ts`) auto-merges an
 * imported atom's own entity fields onto the host entity on a rebind. A
 * merged field's `required: true` is the ATOM's own write contract, never
 * the host writer's — so every field the merge ADDS must carry `mergedFrom:
 * <importedEntity.name>`, and a field the host already declared itself must
 * carry no `mergedFrom` even when the atom also declares a field of that
 * name (the host's own declaration wins and is never touched by the merge).
 *
 * Mirrors `reference-resolver-entity-field-merge.test.ts`'s fixture shape
 * (an explicit `-> Entity` rebind), but the composed atom's added field is
 * an ordinary REQUIRED field (not `@intrinsic`) — the shape that broke the
 * chat composer's `persist create` (std-browse's `BrowseItem { name! }`
 * rebound onto `ChatMessage`).
 */
import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition } from '@almadar/core';

/** The composed atom: bound to its OWN entity `BrowseItem`, which declares a
 *  REQUIRED field the consumer does not (`name`). */
function browseAtomOrbital(): Orbital {
  return {
    name: 'BrowseOrbital',
    entity: {
      name: 'BrowseItem',
      persistence: 'runtime',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
      ],
    },
    traits: [
      {
        name: 'BrowseTrait',
        scope: 'instance',
        linkedEntity: 'BrowseItem',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Initialize' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

function makeLoader(): SchemaLoader {
  const browse = browseAtomOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
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

/** Consumer: its OWN entity `ChatMessage` (declares `id`+`content`, NOT
 *  `name`), composing `Browse.traits.BrowseTrait -> ChatMessage` (explicit
 *  rebind, full field-contract merge). */
function consumerOrbital(): OrbitalDefinition {
  return {
    name: 'ChatOrbital',
    uses: [{ from: './browse.orb', as: 'Browse' }],
    entity: {
      name: 'ChatMessage',
      persistence: 'persistent',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'content', type: 'string', required: true },
      ],
    },
    traits: [
      { ref: 'Browse.traits.BrowseTrait', name: 'ChatBrowse', linkedEntity: 'ChatMessage' },
    ],
    pages: [],
  };
}

describe('entity-field auto-merge — mergedFrom provenance', () => {
  it("stamps mergedFrom on a field the merge adds, and leaves the host's own fields untouched", async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital();
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const fields = result.data.entity.fields;
    expect(fields.map((f) => f.name).sort()).toEqual(['content', 'id', 'name']);

    const content = fields.find((f) => f.name === 'content');
    const id = fields.find((f) => f.name === 'id');
    const name = fields.find((f) => f.name === 'name');

    expect(content?.mergedFrom).toBeUndefined();
    expect(id?.mergedFrom).toBeUndefined();
    expect(name?.required).toBe(true);
    expect(name?.mergedFrom).toBe('BrowseItem');
  });
});
