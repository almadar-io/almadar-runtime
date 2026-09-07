/**
 * §B4-R5: a §8 trait-form reference (`Alias.traits.X`) resolves the
 * REFERENCED trait's own `@config.<knob>` forwards, not just its call-site
 * overrides. When the knob is native to the orbital that DECLARES the
 * trait (an orbital-level knob, e.g. `TimesheetPanelOrbital.config.
 * browseColumns` forwarded by its inline `TimesheetBrowseList.config.
 * columns`), the consumer's own rungs (embedders, `orbital.config`,
 * `schema.config`) never see it — before this fix the forward survived
 * `preprocessSchema` unresolved and the compiled path's dangling-ref
 * validator fired naming a knob no trait in the consumer's referrer chain
 * declares. Rust twin: `trait_ref_home_orbital_config.rs`.
 *
 * Fixture: `HomeOrbital` declares one app-level knob (`appName`, on the
 * imported FILE) and one orbital-level knob (`browseColumns`, on
 * `HomeOrbital` itself); its inline trait `BrowseList` forwards both under
 * DIFFERENT config keys (`columns`/`subtitle`) — the general JSX-hoisted
 * shape, not a same-name coincidence. Three consumers import ONLY the
 * trait (`Home.traits.BrowseList`), never the orbital.
 */
import { describe, it, expect } from 'vitest';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedOrbital, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, Trait, TraitRef, UseDeclaration } from '@almadar/core';

function homeOrbital(): Orbital {
  return {
    name: 'HomeOrbital',
    config: {
      browseColumns: { type: 'unknown', default: ['upstreamCol'] },
    },
    entity: { name: 'HomeItem', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'BrowseList',
        linkedEntity: 'HomeItem',
        scope: 'instance',
        config: {
          columns: { type: 'unknown', default: '@config.browseColumns' },
          subtitle: { type: 'string', default: '@config.appName' },
        },
        stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
      },
    ],
    pages: [],
  };
}

/** The upstream file's own app-level `config {}` — `appName` only, folded
 *  with the consumer's `uses { config }` override by the resolver itself
 *  (`foldUseConfigOverride`), matching what a real `SchemaLoader` returns. */
function homeSchemaConfig() {
  return { appName: { type: 'string', default: 'Upstream App' } };
}

function makeHomeLoader(): SchemaLoader {
  const home = homeOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string): Promise<LoadResult<LoadedOrbital>> {
      if (importPath !== './home.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: {
          orbital: home,
          orbitals: [home],
          schemaConfig: homeSchemaConfig(),
          sourcePath: './home.orb',
          importPath,
        },
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

function consumerSchema(use: UseDeclaration, orbitalConfig?: Orbital['config']): OrbitalSchema {
  const orbital: OrbitalDefinition = {
    name: 'ConsumerOrbital',
    uses: [use],
    ...(orbitalConfig ? { config: orbitalConfig } : {}),
    entity: {
      name: 'ConsumerItem',
      persistence: 'persistent',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [{ ref: 'Home.traits.BrowseList', name: 'Local', linkedEntity: 'ConsumerItem' }],
    pages: [],
  };
  return { name: 'ConsumerApp', orbitals: [orbital] };
}

/**
 * `preprocessSchema` packages a resolved entry with a call-site override as
 * `{ ref: <localName>, config, _resolved }` (no top-level `name` — the
 * ORIGINAL `ref` string is overwritten with the post-resolution local name)
 * and an entry without one as the plain inline `Trait` (`.name` directly) —
 * same contract `reference-resolver-ref-entry-forward.test.ts`'s
 * `findTraitRefByName` checks.
 */
function findLocalTrait(traits: readonly TraitRef[]): Exclude<TraitRef, string> | undefined {
  for (const t of traits) {
    if (typeof t === 'string') continue;
    if ('stateMachine' in t) {
      if (t.name === 'Local') return t;
      continue;
    }
    const refObj = t as { ref: string };
    if (refObj.ref === 'Local') return t;
  }
  return undefined;
}

/**
 * The FULLY resolved trait's own declared config — `preprocessSchema`
 * (`UsesIntegration.ts`) puts a call-site-config-or-linkedEntity entry's
 * resolved `Trait` under `_resolved`, not the entry's top-level `config`
 * (that key holds the CALL-SITE's own override, empty here — this fixture's
 * `Local` entry supplies `linkedEntity` but no `config` override at all).
 */
function resolvedConfigOf(traitRef: Exclude<TraitRef, string> | undefined) {
  if (!traitRef) return undefined;
  if ('stateMachine' in traitRef) return (traitRef as Trait).config;
  const withResolved = traitRef as { _resolved?: Trait };
  return withResolved._resolved?.config;
}

describe('ReferenceResolver — trait-form reference resolves forwards against the home orbital (B4-R5)', () => {
  it('resolves both forwards through the home orbital/app config when the consumer declares nothing', async () => {
    const schema = consumerSchema({ from: './home.orb', as: 'Home' });
    const result = await preprocessSchema(schema, { basePath: '.', loader: makeHomeLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const orbital = result.data.schema.orbitals.find((o) => o.name === 'ConsumerOrbital');
    expect(orbital).toBeDefined();
    if (!orbital) return;

    const local = findLocalTrait(orbital.traits);
    expect(local).toBeDefined();
    const columns = resolvedConfigOf(local)?.columns;
    const subtitle = resolvedConfigOf(local)?.subtitle;
    expect(columns && typeof columns === 'object' && 'default' in columns ? columns.default : columns).toEqual([
      'upstreamCol',
    ]);
    expect(columns && typeof columns === 'object' && 'forwardedFrom' in columns ? columns.forwardedFrom : undefined).toBe(
      '@config.browseColumns',
    );
    expect(subtitle && typeof subtitle === 'object' && 'default' in subtitle ? subtitle.default : subtitle).toBe(
      'Upstream App',
    );
  });

  it("prefers the consumer's own orbital-level declaration over the home orbital's", async () => {
    const schema = consumerSchema(
      { from: './home.orb', as: 'Home' },
      { browseColumns: { type: 'unknown', default: ['consumerCol'] } },
    );
    const result = await preprocessSchema(schema, { basePath: '.', loader: makeHomeLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const orbital = result.data.schema.orbitals.find((o) => o.name === 'ConsumerOrbital');
    expect(orbital).toBeDefined();
    if (!orbital) return;

    const local = findLocalTrait(orbital.traits);
    const columns = resolvedConfigOf(local)?.columns;
    expect(columns && typeof columns === 'object' && 'default' in columns ? columns.default : columns).toEqual([
      'consumerCol',
    ]);
  });

  it('honors the `uses { config { appName } }` override of an upstream app knob', async () => {
    const schema = consumerSchema({
      from: './home.orb',
      as: 'Home',
      config: { appName: { type: 'string', default: 'Override App' } },
    });
    const result = await preprocessSchema(schema, { basePath: '.', loader: makeHomeLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const orbital = result.data.schema.orbitals.find((o) => o.name === 'ConsumerOrbital');
    expect(orbital).toBeDefined();
    if (!orbital) return;

    const local = findLocalTrait(orbital.traits);
    const subtitle = resolvedConfigOf(local)?.subtitle;
    expect(subtitle && typeof subtitle === 'object' && 'default' in subtitle ? subtitle.default : subtitle).toBe(
      'Override App',
    );

    // browseColumns has no consumer-side declaration at all in this
    // fixture, so it must still fall through to HomeOrbital's default — the
    // override rung is additive, not a replacement for the whole chain.
    const columns = resolvedConfigOf(local)?.columns;
    expect(columns && typeof columns === 'object' && 'default' in columns ? columns.default : columns).toEqual([
      'upstreamCol',
    ]);
  });
});
