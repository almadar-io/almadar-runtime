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
});
