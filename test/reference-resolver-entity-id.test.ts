import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { OrbitalDefinition, EntityId, Trait, Effect } from '@almadar/core';

// W4-B2: a trait's entity-name tokens (linkedEntity + positional fetch/persist
// args + render-ui `entity` prop) resolve by the `entityRefIds` side-map
// (name → stable entity id) against the id->node index. When the entity
// DECLARATION was renamed (Product → Item) but the token + side-map key keep the
// OLD name, the reader resolves via id and rewrites the token to the current
// (renamed) entity name. With no side-map, the token is left untouched.

function makeOrbital(trait: Trait): OrbitalDefinition {
  return {
    name: 'Shop',
    // The entity was renamed Product -> Item; its stable id is unchanged.
    entity: {
      id: 'ent_item' as EntityId,
      name: 'Item',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [trait],
    pages: [],
  };
}

function traitWithStaleTokens(entityRefIds?: Record<string, EntityId>): Trait {
  return {
    name: 'ProductBrowse',
    scope: 'collection',
    // Stale token — still names the pre-rename entity "Product".
    linkedEntity: 'Product',
    ...(entityRefIds ? { entityRefIds } : {}),
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'LOAD',
          effects: [
            ['fetch', 'Product'],
            ['persist', 'create', 'Product', '@payload.data'],
            ['render-ui', 'main', { type: 'data-grid', entity: 'Product' }],
          ] as Effect[],
        },
      ],
    },
  } as Trait;
}

function fetchArg(trait: Trait): unknown {
  const effects = trait.stateMachine?.transitions[0].effects as unknown[][];
  const fetchEffect = effects.find((e) => e[0] === 'fetch');
  return fetchEffect?.[1];
}
function persistEntity(trait: Trait): unknown {
  const effects = trait.stateMachine?.transitions[0].effects as unknown[][];
  const persistEffect = effects.find((e) => e[0] === 'persist');
  return persistEffect?.[2];
}
function renderUiEntity(trait: Trait): unknown {
  const effects = trait.stateMachine?.transitions[0].effects as unknown[][];
  const renderEffect = effects.find((e) => e[0] === 'render-ui');
  return (renderEffect?.[2] as { entity?: unknown })?.entity;
}

describe('ReferenceResolver — id-primary entity-token resolution', () => {
  it('resolves stale entity tokens to the renamed declaration via the entityRefIds side-map', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', skipExternalLoading: true });
    const orbital = makeOrbital(
      traitWithStaleTokens({ Product: 'ent_item' as EntityId }),
    );

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.traits[0].trait;
      expect(t.linkedEntity).toBe('Item');
      expect(fetchArg(t)).toBe('Item');
      expect(persistEntity(t)).toBe('Item');
      expect(renderUiEntity(t)).toBe('Item');
    }
  });

  it('leaves entity tokens untouched when no side-map is present (name fallback)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', skipExternalLoading: true });
    const orbital = makeOrbital(traitWithStaleTokens(undefined));

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.traits[0].trait;
      expect(t.linkedEntity).toBe('Product');
      expect(fetchArg(t)).toBe('Product');
      expect(persistEntity(t)).toBe('Product');
      expect(renderUiEntity(t)).toBe('Product');
    }
  });
});
