import { describe, it, expect } from 'vitest';
import { schemaToIR } from '../src/resolver/schema-to-ir.js';
import type { OrbitalSchema } from '@almadar/core';

// V4-W4 surface 3: page trait bindings must resolve id-primary. A page ref
// carrying a valid `refId` resolves the (possibly renamed) inline trait by
// stable id even when the ref's name string is stale — the name-seam the
// factory rewriter used to paper over. Name-only refs still fall back to name.
describe('schemaToIR — page trait binding id-primary resolution', () => {
  function makeSchema(pageTraitRef: unknown): OrbitalSchema {
    return {
      name: 'App',
      version: '1.0.0',
      orbitals: [
        {
          name: 'Feature',
          entity: {
            name: 'Item',
            persistence: 'runtime',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [
            {
              id: 'trait_feature_real',
              name: 'RealTrait',
              linkedEntity: 'Item',
              category: 'interaction',
              stateMachine: {
                states: [{ name: 'idle', isInitial: true }],
                events: [{ key: 'GO', name: 'GO' }],
                transitions: [{ from: 'idle', to: 'idle', event: 'GO', effects: [] }],
              },
            },
          ],
          pages: [
            {
              name: 'Home',
              path: '/home',
              traits: [pageTraitRef],
            },
          ],
        },
      ],
      // eslint-disable-next-line almadar/no-record-string-unknown -- test schema literal
    } as unknown as OrbitalSchema;
  }

  it('resolves the page binding via refId when the ref name is stale', () => {
    const ir = schemaToIR(makeSchema({ ref: 'StaleWrongName', refId: 'trait_feature_real' }), {
      noCache: true,
    });
    const page = ir.pages.get('Home');
    expect(page).toBeDefined();
    expect(page!.traits).toHaveLength(1);
    // Bound to the real (id-matched) trait, not an empty library placeholder.
    expect(page!.traits[0].trait.name).toBe('RealTrait');
    expect(page!.traits[0].trait.events.map((e) => e.key)).toContain('GO');
  });

  it('still resolves by name when the ref carries no refId (fallback preserved)', () => {
    const ir = schemaToIR(makeSchema({ ref: 'RealTrait' }), { noCache: true });
    const page = ir.pages.get('Home');
    expect(page).toBeDefined();
    expect(page!.traits[0].trait.name).toBe('RealTrait');
    expect(page!.traits[0].trait.events.map((e) => e.key)).toContain('GO');
  });
});
