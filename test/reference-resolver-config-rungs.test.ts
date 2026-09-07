import { describe, it, expect } from 'vitest';
import { ReferenceResolver, resolveSchema } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { OrbitalDefinition, OrbitalSchema, Orbital, Trait } from '@almadar/core';

// W2-J2: the runtime twin of the compiler's `forwarded_sibling_config` three-
// rung chain (§4.5) — a pulled sibling's `@config.<knob>` forward resolves
// against its embedder, then the trait's owning orbital's declared `config
// {}`, then the schema's. Only `pullSiblingTraits`' sibling-pull path
// exercises this; a sibling is materialised once per embedder, and the
// forward is left unresolved (still the literal `@config.<knob>` string)
// when no rung declares the knob.

// `Owner` embeds `@trait.Sibling` in a render-ui effect; `Sibling` forwards
// its `fields` knob to whoever embeds it.
function ownerTrait(ownConfig?: Trait['config']): Trait {
  return {
    name: 'Owner',
    scope: 'instance',
    ...(ownConfig ? { config: ownConfig } : {}),
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Sibling'] }]],
        },
      ],
    },
  };
}

function siblingTrait(): Trait {
  return {
    name: 'Sibling',
    scope: 'instance',
    config: {
      fields: { type: '[string]', default: '@config.fields' },
    },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

function importedOrbital(ownerConfig?: Trait['config']): Orbital {
  return {
    name: 'Atoms',
    entity: {
      name: 'Item',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [ownerTrait(ownerConfig), siblingTrait()],
    pages: [],
  };
}

function makeLoader(atoms: Orbital): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital() {
      return {
        success: true,
        data: { orbital: atoms, sourcePath: './atoms.orb', importPath: 'Atoms' },
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

function consumerOrbital(config?: OrbitalDefinition['config']): OrbitalDefinition {
  return {
    name: 'Consumer',
    uses: [{ from: './atoms.orb', as: 'Atoms' }],
    entity: {
      name: 'ConsumerEntity',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: ['Atoms.traits.Owner'],
    pages: [],
    ...(config ? { config } : {}),
  };
}

function findSibling(traits: { trait: Trait }[]): Trait {
  const found = traits.find((t) => t.trait.name === 'Sibling');
  if (!found) throw new Error('Sibling was not pulled');
  return found.trait;
}

describe('ReferenceResolver — forwarded sibling config rungs (§4.5)', () => {
  it('resolves from the owning orbital\'s declared config when the embedder does not declare the knob', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(importedOrbital()) });
    const orbital = consumerOrbital({ fields: { type: '[string]', default: ['a', 'b'] } });

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sibling = findSibling(result.data.traits);
    expect(sibling.config!.fields.default).toEqual(['a', 'b']);
  });

  it('falls through to the schema config when neither the embedder nor the orbital declares the knob', async () => {
    const resolver = new ReferenceResolver({
      basePath: '.',
      loader: makeLoader(importedOrbital()),
      schemaConfig: { fields: { type: '[string]', default: ['from-schema'] } },
    });
    const orbital = consumerOrbital();

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sibling = findSibling(result.data.traits);
    expect(sibling.config!.fields.default).toEqual(['from-schema']);
  });

  it('lets the embedder win over both the orbital and the schema', async () => {
    const embedderConfig = { fields: { type: '[string]', default: ['from-embedder'] } };
    const resolver = new ReferenceResolver({
      basePath: '.',
      loader: makeLoader(importedOrbital(embedderConfig)),
      schemaConfig: { fields: { type: '[string]', default: ['from-schema'] } },
    });
    const orbital = consumerOrbital({ fields: { type: '[string]', default: ['from-orbital'] } });

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sibling = findSibling(result.data.traits);
    expect(sibling.config!.fields.default).toEqual(['from-embedder']);
  });

  it('leaves the forward unresolved when no rung declares the knob', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(importedOrbital()) });
    const orbital = consumerOrbital();

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sibling = findSibling(result.data.traits);
    expect(sibling.config!.fields.default).toBe('@config.fields');
  });

  it('reaches the schema rung end-to-end through resolveSchema', async () => {
    const schema: OrbitalSchema = {
      name: 'Schema',
      orbitals: [consumerOrbital()],
      config: { fields: { type: '[string]', default: ['schema-e2e'] } },
    };

    const result = await resolveSchema(schema, {
      basePath: '.',
      loader: makeLoader(importedOrbital()),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sibling = findSibling(result.data[0].traits);
    expect(sibling.config!.fields.default).toEqual(['schema-e2e']);
  });
});

// Ledger (n)-JS: a hoisted forward may pass through SEVERAL pulled traits
// that themselves declare no knob at all before landing on a value three-plus
// levels up — the single direct-embedder rung the tests above exercise is
// not enough. `Feed` (the top-level declared trait) embeds `Stack8`, which
// embeds `Stack5`, which embeds `Typography4`; only `Feed` declares `title`.
// `pullSiblingTraits`' `parentOf` map + `embedderChain` walk the ancestor
// chain past the two knob-less rungs to reach it.
function feedTrait(): Trait {
  return {
    name: 'Feed',
    scope: 'instance',
    config: { title: { type: 'string', default: 'Feed Title' } },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Stack8'] }]],
        },
      ],
    },
  };
}

function stack8Trait(): Trait {
  return {
    name: 'Stack8',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Stack5'] }]],
        },
      ],
    },
  };
}

function stack5Trait(): Trait {
  return {
    name: 'Stack5',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Typography4'] }]],
        },
      ],
    },
  };
}

function typography4Trait(): Trait {
  return {
    name: 'Typography4',
    scope: 'instance',
    config: { content: { type: 'string', default: '@config.title' } },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

function hoistedChainOrbital(): Orbital {
  return {
    name: 'Atoms',
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [feedTrait(), stack8Trait(), stack5Trait(), typography4Trait()],
    pages: [],
  };
}

function feedConsumerOrbital(): OrbitalDefinition {
  return {
    name: 'Consumer',
    uses: [{ from: './atoms.orb', as: 'Atoms' }],
    entity: { name: 'ConsumerEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: ['Atoms.traits.Feed'],
    pages: [],
  };
}

function findPulled(traits: { trait: Trait }[], name: string): Trait {
  const found = traits.find((t) => t.trait.name === name);
  if (!found) throw new Error(`${name} was not pulled`);
  return found.trait;
}

describe('ReferenceResolver — three-deep hoisted config forward (ledger (n)-JS)', () => {
  it('resolves through two knob-less rungs to the declared value three levels up the pull chain', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader(hoistedChainOrbital()) });

    const result = await resolver.resolve(feedConsumerOrbital());

    expect(result.success).toBe(true);
    if (!result.success) return;
    const typography = findPulled(result.data.traits, 'Typography4');
    expect(typography.config!.content.default).toBe('Feed Title');
    // Sanity: the two intermediate rungs really do declare nothing for
    // `title` — this exercises the chain walk, not a single-rung shortcut.
    expect(findPulled(result.data.traits, 'Stack8').config).toBeUndefined();
    expect(findPulled(result.data.traits, 'Stack5').config).toBeUndefined();
  });
});
