/**
 * Trait attribution on the server response wire format.
 *
 * Regression coverage for the `@trait.X` molecule blank-render bug. The
 * server emits `clientEffects[]` (legacy flat shape) AND a per-trait
 * sidecar `clientEffectsByTrait[{ traitName, effect }]` so client-side
 * `<TraitFrame>` lookups can attribute each render-ui to its producing
 * trait. Without this attribution, every embedded atom's render output
 * collides under one index key and `getTraitContent` returns null.
 *
 * Pre-fix shape (flat-only):
 *   clientEffects: [['render-ui', 'main', {...}], ...]
 * Post-fix shape (additive sidecar, both fields present):
 *   clientEffects: [...]              ← legacy consumers untouched
 *   clientEffectsByTrait: [{ traitName: 'AtomA', effect: [...] }, ...]
 */

import { describe, expect, it } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { OrbitalSchema } from '@almadar/core';

// Minimal fixture: one orbital, three traits, each emitting render-ui on INIT.
// Two "atoms" (AtomA, AtomB) share slot 'main' independently; a layout-owner
// (LayoutOwner) also fires INIT. The bug to catch is server-side, so we don't
// need any cross-trait `@trait.X` wiring — only that effects come back tagged
// with the correct producing trait.
const schema = {
  name: 'trait-attribution-fixture',
  orbitals: [
    {
      name: 'AttributionOrbital',
      entity: {
        name: 'Item',
        persistence: 'persistent',
        collection: 'items',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      traits: [
        {
          name: 'AtomA',
          category: 'interaction',
          linkedEntity: 'Item',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'INIT' }],
            transitions: [
              {
                from: 'idle',
                to: 'idle',
                event: 'INIT',
                effects: [['render-ui', 'main', { type: 'typography', content: 'A' }]],
              },
            ],
          },
        },
        {
          name: 'AtomB',
          category: 'interaction',
          linkedEntity: 'Item',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'INIT' }],
            transitions: [
              {
                from: 'idle',
                to: 'idle',
                event: 'INIT',
                effects: [['render-ui', 'sidebar', { type: 'typography', content: 'B' }]],
              },
            ],
          },
        },
        {
          name: 'LayoutOwner',
          category: 'interaction',
          linkedEntity: 'Item',
          stateMachine: {
            states: [{ name: 'composing', isInitial: true }],
            events: [{ key: 'INIT' }],
            transitions: [
              {
                from: 'composing',
                to: 'composing',
                event: 'INIT',
                effects: [
                  [
                    'render-ui',
                    'main',
                    { type: 'stack', children: ['@trait.AtomA', '@trait.AtomB'] },
                  ],
                ],
              },
            ],
          },
        },
      ],
      pages: [
        {
          name: 'AttributionPage',
          path: '/attribution',
          traits: [{ ref: 'LayoutOwner' }, { ref: 'AtomA' }, { ref: 'AtomB' }],
        },
      ],
    },
  ],
};

describe('OrbitalServerRuntime trait attribution', () => {
  it('tags each render-ui effect with its producing trait via clientEffectsByTrait', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await runtime.processOrbitalEvent('AttributionOrbital', {
      event: 'INIT',
      payload: {},
    });

    expect(result.success).toBeTruthy();
    expect(result.clientEffectsByTrait).toBeDefined();

    const tagged = result.clientEffectsByTrait!;
    // Three traits each emit one render-ui on INIT.
    expect(tagged).toHaveLength(3);

    // Every entry carries a real trait name from the orbital — never the
    // sentinel 'server' label that the client used to fall back to.
    const traitNames = tagged.map((e) => e.traitName).sort();
    expect(traitNames).toEqual(['AtomA', 'AtomB', 'LayoutOwner']);

    // The layout-owner's effect must NOT be labeled with an embedded atom's
    // name, and vice versa — that's the attribution we're guarding.
    const layoutEntry = tagged.find((e) => e.traitName === 'LayoutOwner');
    expect(layoutEntry).toBeDefined();
    const layoutPattern = layoutEntry!.effect[2] as { children: unknown[] };
    expect(layoutPattern.children).toEqual(['@trait.AtomA', '@trait.AtomB']);

    const atomAEntry = tagged.find((e) => e.traitName === 'AtomA');
    expect(atomAEntry).toBeDefined();
    expect((atomAEntry!.effect[2] as { content: string }).content).toBe('A');
  });

  it('keeps the legacy flat clientEffects array unchanged for old consumers', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const result = await runtime.processOrbitalEvent('AttributionOrbital', {
      event: 'INIT',
      payload: {},
    });

    expect(result.clientEffects).toBeDefined();
    expect(result.clientEffects).toHaveLength(3);

    for (const eff of result.clientEffects!) {
      const arr = eff as unknown[];
      expect(Array.isArray(arr)).toBe(true);
      expect(arr[0]).toBe('render-ui');
    }

    // Sidecar entries reference the SAME effect arrays (1:1 by index), not copies.
    const flat = result.clientEffects!;
    const tagged = result.clientEffectsByTrait!;
    expect(flat).toHaveLength(tagged.length);
    for (let i = 0; i < flat.length; i++) {
      expect(tagged[i].effect).toBe(flat[i]);
    }
  });

  it('preprocessSchema applies the molecule `name:` override to inlined atoms', async () => {
    // Simulates a std-filtered-list-style molecule that imports an atom
    // and renames it locally (e.g. `SearchResultSearch` -> `FilteredItemSearch`).
    // The rename has to reach the resolved trait's `.name` so that layout
    // patterns referencing `@trait.FilteredItemSearch` find it via
    // getTraitContent. Without it, the trait index keys stay as the
    // atom's original name and the `@trait.X` lookup misses.
    const atomSchema: OrbitalSchema = {
      name: 'atom-schema',
      orbitals: [
        {
          name: 'AtomOrbital',
          entity: {
            name: 'AtomEntity',
            persistence: 'persistent',
            collection: 'atomentities',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [
            {
              name: 'OriginalAtomName',
              linkedEntity: 'AtomEntity',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'INIT' }],
                transitions: [
                  {
                    from: 'idle',
                    to: 'idle',
                    event: 'INIT',
                    effects: [['render-ui', 'main', { type: 'typography', content: 'atom' }]],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const moleculeSchema: OrbitalSchema = {
      name: 'molecule-schema',
      orbitals: [
        {
          name: 'MoleculeOrbital',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `uses` not modeled in OrbitalSchema yet; it's consumed at preprocess time
          uses: [{ from: 'test://atom-schema', as: 'Atom' }],
          entity: {
            name: 'MoleculeEntity',
            persistence: 'persistent',
            collection: 'moleculeentities',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [
            // Molecule's rename: atom's `OriginalAtomName` becomes `LocalRenamedAtom`.
            {
              ref: 'Atom.traits.OriginalAtomName',
              name: 'LocalRenamedAtom',
              linkedEntity: 'MoleculeEntity',
            },
          ],
          pages: [
            { name: 'MoleculePage', path: '/', traits: [{ ref: 'LocalRenamedAtom' }] },
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema shape for test fixture
        } as any,
      ],
    };

    // Minimal loader for the test — just returns the atom schema when asked.
    const loader: SchemaLoader = {
      async load(path: string): Promise<LoadResult<LoadedSchema>> {
        if (path === 'test://atom-schema') {
          return { success: true, data: { schema: atomSchema, sourcePath: path, importPath: path } };
        }
        return { success: false, error: `Unknown path: ${path}` };
      },
      async loadOrbital(path, orbitalName) {
        const s = await this.load(path);
        if (!s.success) return s;
        const orbital = orbitalName
          ? s.data.schema.orbitals.find((o) => o.name === orbitalName)
          : s.data.schema.orbitals[0];
        if (!orbital) return { success: false, error: `Orbital not found: ${orbitalName}` };
        return {
          success: true,
          data: { orbital, sourcePath: s.data.sourcePath, importPath: path },
        };
      },
      resolvePath(path) { return { success: true, data: path }; },
      clearCache() { /* no-op */ },
      getCacheStats() { return { size: 0 }; },
    };

    const result = await preprocessSchema(moleculeSchema, { basePath: '.', loader });
    expect(result.success).toBeTruthy();

    const resolvedTraits = result.data!.schema.orbitals[0].traits!;
    expect(resolvedTraits).toHaveLength(1);

    const first = resolvedTraits[0] as { ref?: string; _resolved?: { name: string } };
    // The wrapper's ref AND the inlined trait's .name must both reflect the rename.
    expect(first.ref).toBe('LocalRenamedAtom');
    expect(first._resolved?.name).toBe('LocalRenamedAtom');
  });

  it('register() unwraps preprocessed ref-traits so their state machines run', async () => {
    // Simulate what `preprocessSchema` produces for a molecule: every trait
    // with a `linkedEntity` or `config` override comes out as
    // `{ ref, linkedEntity, _resolved: <inline Trait> }` rather than a flat
    // inline trait. register() must unwrap `_resolved` so the inlined trait
    // reaches the StateMachineManager. Without the unwrap, every embedded
    // atom in a molecule is silently dropped (see §3.1b).
    const refShapedSchema = {
      name: 'ref-unwrap-fixture',
      orbitals: [
        {
          name: 'UnwrapOrbital',
          entity: {
            name: 'Item',
            persistence: 'persistent',
            collection: 'items',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [
            // Preprocess-output shape: `ref` + `linkedEntity` + `_resolved`.
            {
              ref: 'WrappedAtom',
              linkedEntity: 'Item',
              _resolved: {
                name: 'WrappedAtom',
                category: 'interaction',
                linkedEntity: 'Item',
                stateMachine: {
                  states: [{ name: 'idle', isInitial: true }],
                  events: [{ key: 'INIT' }],
                  transitions: [
                    {
                      from: 'idle',
                      to: 'idle',
                      event: 'INIT',
                      effects: [
                        ['render-ui', 'main', { type: 'typography', content: 'from WrappedAtom' }],
                      ],
                    },
                  ],
                },
              },
            },
          ],
          pages: [
            {
              name: 'UnwrapPage',
              path: '/unwrap',
              traits: [{ ref: 'WrappedAtom' }],
            },
          ],
        },
      ],
    };

    const runtime = new OrbitalServerRuntime({ debug: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture mimics preprocess output shape that isn't part of the public OrbitalSchema type
    await runtime.register(refShapedSchema as any);

    const result = await runtime.processOrbitalEvent('UnwrapOrbital', {
      event: 'INIT',
      payload: {},
    });

    expect(result.success).toBeTruthy();
    // The atom should have fired and produced its render-ui effect — not
    // been dropped by the isInlineTrait filter.
    expect(result.clientEffects).toHaveLength(1);
    expect(result.clientEffectsByTrait?.[0]?.traitName).toBe('WrappedAtom');
    const effect = result.clientEffects![0] as unknown[];
    expect(effect[0]).toBe('render-ui');
    expect((effect[2] as { content: string }).content).toBe('from WrappedAtom');
  });
});
