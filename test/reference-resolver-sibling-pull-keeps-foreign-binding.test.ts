/**
 * G-ORB-042 twin: a rebind (`Atom.traits.Manage -> Membership`) replaces the
 * embedder atom's OWN entity. A sibling it pulls through `@trait.<X>` that is
 * bound to a DIFFERENT entity of the atom (a button's `ButtonItem` view) keeps
 * that binding; a sibling bound to the atom's own entity follows the rebind.
 * Rust: `sibling_rebind` in `orbital-compiler/src/phases/inline/trait.rs`.
 */

import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, Trait, TypedEffect } from '@almadar/core';
import { asEntityId } from '@almadar/core';

const idField = { name: 'id', type: 'string', required: true } as const;

function trait(name: string, linkedEntity: string, embeds: readonly string[]): Trait {
  return {
    name,
    scope: 'instance',
    linkedEntity,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [{
        from: 'idle',
        to: 'idle',
        event: 'INIT',
        effects: [['fetch', linkedEntity], ...embeds.map((e): TypedEffect => ['render-ui', 'main', `@trait.${e}`])],
      }],
    },
  };
}

function atomOrbital(): Orbital {
  return {
    name: 'AtomOrbital',
    entity: { name: 'Sub', persistence: 'persistent', collection: 'subs', id: asEntityId('ent_SUB000000000000000000000'), fields: [idField] },
    auxiliaryEntities: [{ name: 'ButtonItem', persistence: 'runtime', id: asEntityId('ent_BTN000000000000000000000'), fields: [idField] }],
    traits: [
      trait('Manage', 'Sub', ['Keep', 'Row']),
      trait('Keep', 'ButtonItem', []),
      trait('Row', 'Sub', []),
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

async function resolveConsumer(rebind: boolean) {
  const consumer: OrbitalDefinition = {
    name: 'Consumer',
    uses: [{ from: './atom.orb', as: 'Atom' }],
    entity: { name: 'Membership', persistence: 'persistent', id: asEntityId('ent_MEM000000000000000000000'), fields: [idField] },
    traits: [rebind ? { ref: 'Atom.traits.Manage', linkedEntity: 'Membership' } : { ref: 'Atom.traits.Manage' }],
    pages: [],
  };
  const resolver = new ReferenceResolver({ basePath: '.', loader: loader() });
  resolver.seedSchemaEntityIds([consumer]);
  const result = await resolver.resolve(consumer);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error('resolve failed');
  const bound = (name: string) => result.data.traits.find((rt) => rt.trait.name === name)?.trait.linkedEntity;
  return { manage: bound('Manage'), keep: bound('Keep'), row: bound('Row') };
}

describe('sibling pull under a rebind keeps a foreign binding (G-ORB-042)', () => {
  it('a sibling bound to another entity of the atom keeps it', async () => {
    const { manage, keep } = await resolveConsumer(true);
    expect(manage).toBe('Membership');
    expect(keep).toBe('ButtonItem');
  });

  it('control: a sibling bound to the atom\'s own entity follows the rebind', async () => {
    const { row } = await resolveConsumer(true);
    expect(row).toBe('Membership');
  });

  it('control: without a rebind every sibling keeps its own binding', async () => {
    const { manage, keep, row } = await resolveConsumer(false);
    expect([manage, keep, row]).toEqual(['Sub', 'ButtonItem', 'Sub']);
  });
});
