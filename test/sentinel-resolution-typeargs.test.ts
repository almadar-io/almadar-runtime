/**
 * Call-site `typeArgs` (`::`) sentinel substitution (C1-J3, item A).
 *
 * `sentinel-resolution.ts` ported Rust's `resolve_type_param_sentinels` but
 * never wired a trait REFERENCE's own call-site `typeArgs`
 * (`TraitReference.typeArgs`, the `.lolo` `::` form) into the substitution
 * map — only the no-arg Entity-kind default. `reference-resolver.ts` now
 * threads a reference's `typeArgs` onto `ResolvedTrait.typeArgs` at
 * trait-ref resolution (twin of Rust's `trait_def.type_args`), and
 * `resolveTraitTypeParamSentinels` consumes it — a call-site arg wins
 * outright over both the Entity-kind default and the param's own declared
 * default, exactly like `orbital-compiler/phases/inline/rewrite.rs`'s
 * `resolve_type_param_sentinels`.
 *
 * Drives the FULL `ReferenceResolver.resolve()` path (not the sentinel
 * functions in isolation) so the plumbing added in `reference-resolver.ts`
 * — `resolveTraitRefString`/`resolveTraitEntry` capturing `typeArgs` on
 * `ResolvedTrait`, then `resolveOrbitalTypeParamSentinels` reading it back
 * off each entry — is exercised end-to-end, one `ParamSub` kind per case.
 */
import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Event, EventPayloadField, Orbital, OrbitalDefinition, TraitReference } from '@almadar/core';

function payloadOf(events: readonly Event[] | undefined, key: string): Event['payloadSchema'] {
  return events?.find((e) => e.key === key)?.payloadSchema;
}

/** The declaring atom: ONE trait with a single declared type param `p` and
 * one event whose payload carries the `$p` sentinel as a NAMED (non-bare)
 * field, so `flattenBareEntityPayload` never triggers — isolates the
 * `resolveSentinelFields` substitution arms under test. */
function genericAtomOrbital(): Orbital {
  return {
    name: 'GenericOrbital',
    entity: { name: 'GenericThing', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'GenericTrait',
        scope: 'instance',
        linkedEntity: 'GenericThing',
        typeParams: [{ name: 'p', kind: 'Type', default: 'string' }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [
            { key: 'INIT', name: 'Initialize' },
            { key: 'FIRE', name: 'Fire', payloadSchema: [{ name: 'val', type: '$p' }] },
            { key: 'FIRE_MANY', name: 'Fire many', payloadSchema: [{ name: 'vals', type: '[$p]' }] },
            { key: 'FIRE_BARE', name: 'Fire bare', payloadSchema: [{ name: 'value', type: '$p' }] },
          ],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
            { from: 'idle', to: 'idle', event: 'FIRE', effects: [] },
            { from: 'idle', to: 'idle', event: 'FIRE_MANY', effects: [] },
            { from: 'idle', to: 'idle', event: 'FIRE_BARE', effects: [] },
          ],
        },
      },
    ],
    pages: [],
  };
}

function makeLoader(): SchemaLoader {
  const generic = genericAtomOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './generic.orb') {
        return { success: true, data: { orbital: generic, sourcePath: './generic.orb', importPath } };
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

function consumerOrbital(
  traits: TraitReference[],
  types?: Record<string, EventPayloadField[]>,
): OrbitalDefinition {
  return {
    name: 'ConsumerOrbital',
    uses: [{ from: './generic.orb', as: 'Generic' }],
    entity: {
      name: 'Order',
      persistence: 'persistent',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'total', type: 'number' },
      ],
    },
    traits,
    pages: [],
    ...(types ? { types } : {}),
  };
}

describe('sentinel-resolution — call-site typeArgs (C1-J3, item A)', () => {
  it('Scalar sub: typeArgs names a primitive — the sentinel becomes that scalar, no properties/entity', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital([
      { ref: 'Generic.traits.GenericTrait', name: 'ScalarUser', typeArgs: { p: 'number' } },
    ]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'ScalarUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE')?.find((f) => f.name === 'val');
    expect(field).toEqual({ name: 'val', type: 'number' });
  });

  it('Entity sub: typeArgs names a known entity — object + flattened properties + entity marker', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital([
      { ref: 'Generic.traits.GenericTrait', name: 'EntityUser', typeArgs: { p: 'Order' } },
    ]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'EntityUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE')?.find((f) => f.name === 'val');
    expect(field?.type).toBe('object');
    expect(field?.entity).toBe('Order');
    expect(field?.properties?.map((p) => p.name).sort()).toEqual(['id', 'total']);
  });

  it('Struct sub: typeArgs names a `types` alias — object + that shape, no entity marker', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital(
      [{ ref: 'Generic.traits.GenericTrait', name: 'StructUser', typeArgs: { p: 'MoneyShape' } }],
      { MoneyShape: [{ name: 'amount', type: 'number' }, { name: 'currency', type: 'string' }] },
    );
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'StructUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE')?.find((f) => f.name === 'val');
    expect(field?.type).toBe('object');
    expect(field?.entity).toBeUndefined();
    expect(field?.properties?.map((p) => p.name)).toEqual(['amount', 'currency']);
  });

  it('array-sentinel `[$p]` form: typeArgs Entity sub produces `[object]` + properties + entity marker', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital([
      { ref: 'Generic.traits.GenericTrait', name: 'ArrayEntityUser', typeArgs: { p: 'Order' } },
    ]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'ArrayEntityUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE_MANY')?.find((f) => f.name === 'vals');
    expect(field?.type).toBe('[object]');
    expect(field?.entity).toBe('Order');
  });

  it('bare-payload flatten: a sole `value: $p` field with an Entity sub splices the entity fields at the root', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital([
      { ref: 'Generic.traits.GenericTrait', name: 'BareEntityUser', typeArgs: { p: 'Order' } },
    ]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'BareEntityUser');
    const schema = payloadOf(trait?.trait.stateMachine?.events, 'FIRE_BARE');
    expect(schema?.map((f) => f.name).sort()).toEqual(['id', 'total']);
    expect(schema?.some((f) => f.name === 'value')).toBe(false);
  });

  it('typeArgs wins over the param\'s own declared default (Scalar default, call-site Entity arg)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    // GenericTrait's own declared default for `p` is `string` (a Scalar) —
    // the call site overrides it to the Entity `Order`; Entity must win.
    const orbital = consumerOrbital([
      { ref: 'Generic.traits.GenericTrait', name: 'OverrideUser', typeArgs: { p: 'Order' } },
    ]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'OverrideUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE')?.find((f) => f.name === 'val');
    expect(field?.type).toBe('object');
    expect(field?.entity).toBe('Order');
  });

  it('unresolvable typeArgs value on a DECLARED param leaves the sentinel untouched for the validator sweep', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital([
      { ref: 'Generic.traits.GenericTrait', name: 'UnresolvedUser', typeArgs: { p: 'NoSuchTypeAnywhere' } },
    ]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'UnresolvedUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE')?.find((f) => f.name === 'val');
    expect(field).toEqual({ name: 'val', type: '$p' });
  });

  it('no typeArgs at all: falls through to the param\'s own declared default (regression, unaffected by this wave)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital = consumerOrbital([{ ref: 'Generic.traits.GenericTrait', name: 'DefaultUser' }]);
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const trait = result.data.traits.find((rt) => rt.trait.name === 'DefaultUser');
    const field = payloadOf(trait?.trait.stateMachine?.events, 'FIRE')?.find((f) => f.name === 'val');
    expect(field).toEqual({ name: 'val', type: 'string' });
  });
});
