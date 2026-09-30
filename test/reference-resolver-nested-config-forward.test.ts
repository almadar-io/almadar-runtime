/**
 * G-CROSS-024: a `@config.<knob>` token NESTED in a `{ref}` entry's call-site
 * config value (`metrics[].target`) resolves along the same embedder →
 * orbital → app chain as a whole-string forward — the JS twin of Rust's
 * `substitute_nested_forwards` (`phases/inline/trait.rs`). A token naming
 * the composed atom's OWN knob stays a live read; one no rung declares stays
 * as written.
 */

import { describe, it, expect } from 'vitest';

import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Orbital, OrbitalSchema, TraitRef } from '@almadar/core';
import { normalizeCallSiteConfigToValues } from '@almadar/core';

function statsOrbital(): Orbital {
  return {
    name: 'StatsOrbital',
    entity: { name: 'StatsItem', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'StatsRender',
        scope: 'instance',
        config: { metrics: { type: 'unknown' }, title: { type: 'string', default: 'Stats' } },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

function loader(): SchemaLoader {
  const stats = statsOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      return { success: true, data: { orbital: stats, sourcePath: './stats.orb', importPath } };
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

function schema(): OrbitalSchema {
  return {
    name: 'DashboardApp',
    config: { weeklyWinTarget: { type: 'number', default: 2 } },
    orbitals: [
      {
        name: 'DashboardOrbital',
        uses: [{ from: './stats.orb', as: 'Stats' }],
        entity: { name: 'Deal', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [
          {
            ref: 'Stats.traits.StatsRender',
            name: 'WeeklyStats',
            config: {
              metrics: {
                type: 'unknown',
                default: [
                  { label: 'Wins', target: '@config.weeklyWinTarget' },
                  { label: 'Heading', text: '@config.title' },
                  { label: 'Missing', target: '@config.nobodyDeclares' },
                ],
              },
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

function find(traits: readonly TraitRef[], name: string): Exclude<TraitRef, string> | undefined {
  for (const t of traits) {
    if (typeof t === 'string') continue;
    if ('stateMachine' in t ? t.name === name : (t as { ref: string }).ref === name) return t;
  }
  return undefined;
}

describe('ReferenceResolver — nested @config forwards in a {ref} call-site override (G-CROSS-024)', () => {
  it('folds an app knob nested in the value, keeps own-knob and unknown tokens', async () => {
    const result = await preprocessSchema(schema(), { basePath: '.', loader: loader() });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const orbital = result.data.schema.orbitals.find((o) => o.name === 'DashboardOrbital');
    const stats = orbital && find(orbital.traits, 'WeeklyStats');
    expect(stats).toBeDefined();
    const values = normalizeCallSiteConfigToValues(stats?.config);
    expect(values?.metrics).toEqual([
      { label: 'Wins', target: 2 },
      { label: 'Heading', text: '@config.title' },
      { label: 'Missing', target: '@config.nobodyDeclares' },
    ]);
  });
});
