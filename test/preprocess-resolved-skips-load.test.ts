import { describe, it, expect } from 'vitest';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { OrbitalSchema } from '@almadar/core';

// A schema produced by `orbital resolve` (the canonical Rust resolver) has every
// trait inlined but deliberately keeps `uses` as the import-provenance record.
// preprocessSchema must NOT re-load those imports — re-loading is redundant and
// re-introduces external-loader failures (e.g. std behaviors not found at the
// runtime's lookup paths) even though nothing still references them. This proves
// the load is skipped (loader never touched) and preprocessing succeeds, while
// `uses` stays on the source schema.
describe('preprocessSchema — already-resolved schema skips external loading', () => {
  it('does not re-load `uses` when every trait is inline (uses kept as record)', async () => {
    let touched = false;
    const failLoader: SchemaLoader = {
      async load(): Promise<LoadResult<LoadedSchema>> {
        touched = true;
        return { success: false, error: 'loader should not be called for a resolved schema' };
      },
      async loadOrbital(): Promise<LoadResult<{ orbital: OrbitalSchema['orbitals'][number]; sourcePath?: string; importPath: string }>> {
        touched = true;
        return { success: false, error: 'loader should not be called for a resolved schema' };
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

    const schema: OrbitalSchema = {
      name: 'resolved-app',
      version: '1.0.0',
      orbitals: [
        {
          name: 'AppOrbital',
          // Import record retained even though the trait below is fully inlined.
          uses: [{ from: 'std/behaviors/std-app-layout', as: 'AppShell' }],
          entity: {
            name: 'Item',
            persistence: 'runtime',
            fields: [{ name: 'id', type: 'string', required: true }],
          },
          traits: [
            {
              name: 'ItemView',
              linkedEntity: 'Item',
              category: 'interaction',
              stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
            },
          ],
          pages: [],
        },
      ],
    } as OrbitalSchema;

    const result = await preprocessSchema(schema, { basePath: '.', loader: failLoader });

    expect(touched).toBe(false);
    expect(result.success).toBe(true);
  });
});
