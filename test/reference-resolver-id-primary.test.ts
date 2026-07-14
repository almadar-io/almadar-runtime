import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { OrbitalDefinition, Orbital, TraitId } from '@almadar/core';

// W3b/W3c-JS: the id->node index must let a trait ref carrying a valid
// `refId` resolve to the correct trait even when its `ref` name string is
// stale/wrong, while a ref with only a name (no id, or an unindexed id)
// still falls back to the existing name match unchanged.
describe('ReferenceResolver — id-primary trait resolution', () => {
  const importedOrbital: Orbital = {
    name: 'Atoms',
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        id: 'trait_atoms_realtrait' as TraitId,
        name: 'RealTrait',
        linkedEntity: 'Item',
        category: 'interaction',
        stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
      },
    ],
    pages: [],
  };

  function makeLoader(): SchemaLoader {
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital() {
        return {
          success: true,
          data: { orbital: importedOrbital, sourcePath: './atoms.orb', importPath: 'Atoms' },
        };
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

  function makeOrbital(traitRef: OrbitalDefinition['traits'][number]): OrbitalDefinition {
    return {
      name: 'Consumer',
      uses: [{ from: './atoms.orb', as: 'Atoms' }],
      entity: { name: 'ConsumerEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [traitRef],
      pages: [],
    };
  }

  it('resolves via refId even when the name string is stale', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = makeOrbital({
      ref: 'Atoms.traits.StaleWrongName',
      refId: 'trait_atoms_realtrait' as TraitId,
    });

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.traits).toHaveLength(1);
      expect(result.data.traits[0].trait.name).toBe('RealTrait');
    }
  });

  it('still resolves via name when no id is present (fallback path preserved)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = makeOrbital('Atoms.traits.RealTrait');

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.traits).toHaveLength(1);
      expect(result.data.traits[0].trait.name).toBe('RealTrait');
    }
  });
});
