/**
 * Entity-field auto-merge — GAP-AGB-MOLECULE-ENTITY-CONTRACT twin (C1-J9).
 *
 * `resolveOrbitalTypeParamSentinels` substitutes `@entity`/`$<TypeParam>`
 * payload sentinels by reading the trait's bound entity's OWN field list.
 * Before this fix the JS resolver never ran Rust's "Auto-merge imported
 * entity fields" pass (`orbital-compiler/src/phases/inline/mod.rs`, ~line
 * 1044 — `merge_imported_entity_fields`) at all, so a composed atom's
 * `@intrinsic` fields never landed on the consumer's primary entity, and a
 * sentinel substituted against that entity silently dropped them — the
 * exact divergence the standing corpus parity test
 * (`sentinel-resolution-typeargs-corpus-parity.test.ts`) caught on
 * `std-wiki`'s `WikiPublishApproval` and `std-cicd-pipeline`'s
 * `DeploymentApproval`.
 *
 * This is the synthetic, from-scratch repro: a consumer entity with its own
 * DECLARED fields composes an atom (via an explicit `-> Entity` rebind,
 * mirroring `std-wiki`'s `WikiDoc = RecordDetail.traits.RecordItemDetail ->
 * WikiPage`) whose OWN bound entity carries one `@intrinsic`-marked field
 * the consumer never declares. The merge must add that field to the
 * consumer's entity, and a `@entity` sentinel on a SEPARATE trait of the
 * SAME orbital must see it in its substituted `properties` — proving the
 * sentinel pass reads the entity AFTER the merge, not before it.
 *
 * RED without `mergeImportedEntityFieldsIntoOrbital`/`boundTraitOrbitalBinding`
 * (`reference-resolver.ts`): the intrinsic field is simply absent from both
 * the resolved entity and the substituted payload's `properties`. GREEN
 * with them.
 */
import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition } from '@almadar/core';

/** The composed atom: bound to its OWN placeholder entity `Widget`, which
 * carries a field the consumer already declares (`id`) and one
 * `@intrinsic`-marked field it does NOT (`state`) — mirrors
 * `std-record-detail`'s `RecordItem.loadedRow`. */
function widgetAtomOrbital(): Orbital {
  return {
    name: 'WidgetOrbital',
    entity: {
      name: 'Widget',
      persistence: 'runtime',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'state', type: 'string', intrinsic: true, default: '' },
      ],
    },
    traits: [
      {
        name: 'WidgetTrait',
        scope: 'instance',
        linkedEntity: 'Widget',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Initialize' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

function makeLoader(): SchemaLoader {
  const widget = widgetAtomOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './widget.orb') {
        return { success: true, data: { orbital: widget, sourcePath: './widget.orb', importPath } };
      }
      return { success: false, error: `unexpected import path: ${importPath}` };
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

/** Consumer: its OWN entity `Order` (declares `id`+`total`, NOT `state`),
 * composing `Widget.traits.WidgetTrait -> Order` (explicit rebind, full
 * field-contract merge) alongside a second, unrelated trait carrying an
 * `@entity` payload sentinel bound to that SAME `Order` — the substituted
 * `properties` must reflect the merge the first trait triggered. */
function consumerOrbital(): OrbitalDefinition {
  return {
    name: 'ConsumerOrbital',
    uses: [{ from: './widget.orb', as: 'Widget' }],
    entity: {
      name: 'Order',
      persistence: 'persistent',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'total', type: 'number' },
      ],
    },
    traits: [
      { ref: 'Widget.traits.WidgetTrait', name: 'OrderWidget', linkedEntity: 'Order' },
      {
        name: 'OrderSentinel',
        scope: 'instance',
        linkedEntity: 'Order',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [
            { key: 'INIT', name: 'Initialize' },
            { key: 'LOADED', name: 'Loaded', payloadSchema: [{ name: 'row', type: '@entity' }] },
          ],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
            { from: 'idle', to: 'idle', event: 'LOADED', effects: [] },
          ],
        },
      },
    ],
    pages: [],
  };
}

describe('entity-field auto-merge — GAP-AGB-MOLECULE-ENTITY-CONTRACT (C1-J9)', () => {
  it("a composed atom's @intrinsic field lands on the consumer entity, and a @entity sentinel elsewhere sees it", async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital();
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The merge landed on the consumer's own primary entity.
    expect(result.data.entity.fields.map((f) => f.name).sort()).toEqual(['id', 'state', 'total']);

    // A @entity sentinel elsewhere on the SAME orbital substitutes against
    // the ALREADY-merged entity — the intrinsic field is in `properties`.
    const sentinelTrait = result.data.traits.find((rt) => rt.trait.name === 'OrderSentinel');
    const field = sentinelTrait?.trait.stateMachine?.events
      ?.find((e) => e.key === 'LOADED')
      ?.payloadSchema?.find((f) => f.name === 'row');
    expect(field?.type).toBe('object');
    expect(field?.entity).toBe('Order');
    expect(field?.properties?.map((p) => p.name).sort()).toEqual(['id', 'state', 'total']);
  });
});
