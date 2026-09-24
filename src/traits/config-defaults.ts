/**
 * Pure config-default extraction — kept OUT of `OrbitalServerRuntime.ts` so the
 * package index can re-export it without dragging that module's node-only
 * imports (`module`/`createRequire`, the external loader) into a browser bundle.
 * This file has zero node dependencies (types only, from `@almadar/core`).
 */
import type { TraitConfig, TraitConfigValue, DeclaredTraitConfig, Entity, EntityRow, FieldValue, UserContext } from '@almadar/core';
import { getNestedValue } from '@almadar/core';

// `normalizeCallSiteConfigToValues` moved to `@almadar/core` (it only needs
// `isCallSiteConfigDeclaration`, already owned there) so the JS interpreter
// (`@almadar/runtime`) and the render substrate (`@almadar/ui`) share the
// ONE implementation instead of each carrying its own copy. Re-exported here
// for existing `@almadar/runtime` consumers.
export { normalizeCallSiteConfigToValues } from '@almadar/core';

/**
 * Walk a trait's declared `config { }` schema and return the flat
 * `{ key: default, ... }` map. Seeds `@config.X` binding context with the
 * atom's own declared defaults before any call-site override is applied.
 * Mirrors the compiled path's `DEFAULT_<TRAIT>_CONFIG` constant (backend.rs).
 */
export function collectDeclaredConfigDefaults(
  trait: { config?: DeclaredTraitConfig } | undefined,
): TraitConfig | undefined {
  if (!trait) return undefined;
  const schema = trait.config;
  if (!schema || typeof schema !== 'object') return undefined;
  const defaults: Record<string, TraitConfigValue> = {};
  let hasAny = false;
  for (const [key, field] of Object.entries(schema)) {
    if (field && typeof field === 'object' && !Array.isArray(field) && 'default' in field) {
      const def = (field as { default?: TraitConfigValue }).default;
      if (def !== undefined) {
        defaults[key] = def;
        hasAny = true;
      }
    }
  }
  return hasAny ? defaults : undefined;
}

/**
 * Walk an entity's `fields` array and return a flat `{ fieldName: default, … }`
 * map. Seeds the `@entity` binding context with declared field defaults before
 * any explicit `(set @entity.X Y)` effect or fetched persistence data is merged
 * on top. Mirrors `collectDeclaredConfigDefaults` for the entity axis.
 *
 * Precedence (outermost wins): `traitFieldState` (set effects) > `entityData`
 * (persistence row) > returned defaults (declared schema defaults).
 */
export function collectDeclaredEntityDefaults(
  entity: Pick<Entity, 'fields'> | undefined,
): EntityRow | undefined {
  if (!entity) return undefined;
  const defaults: EntityRow = {};
  let hasAny = false;
  for (const field of entity.fields) {
    if (field.name !== undefined && 'default' in field && field.default !== undefined) {
      defaults[field.name] = field.default as FieldValue;
      hasAny = true;
    }
  }
  return hasAny ? defaults : undefined;
}

/**
 * The `@config` binding root for one trait's effects: its DECLARED config
 * defaults, then `resolvedDefaults` (a `@config.X` forward chained through to
 * the embedding trait), then the call-site override (unresolved `@config.X`
 * forwards dropped so they can't clobber a resolved value). A value that IS a
 * `@user.*` binding is resolved one hop against `user` (a missing field
 * becomes '', never the sigil). The one builder both the server effect stage
 * and the client role's effect runner bind through.
 */
export function buildConfigBinding(input: {
  traitDef: { config?: DeclaredTraitConfig } | undefined;
  resolvedDefaults: TraitConfig | undefined;
  callSiteOverride: TraitConfig | undefined;
  user: UserContext | undefined;
}): Record<string, TraitConfigValue> | undefined {
  const declaredDefaults = collectDeclaredConfigDefaults(input.traitDef);
  const callSiteOverride = input.callSiteOverride
    ? Object.fromEntries(
        Object.entries(input.callSiteOverride).filter(
          ([, v]) => !(typeof v === 'string' && v.startsWith('@config.')),
        ),
      )
    : undefined;
  if (!declaredDefaults && !input.resolvedDefaults && !callSiteOverride) return undefined;
  const merged: Record<string, TraitConfigValue> = {
    ...(declaredDefaults ?? {}),
    ...(input.resolvedDefaults ?? {}),
    ...(callSiteOverride ?? {}),
  };
  const USER_FORWARD = /^@user(?:\.[\w]+)+$/;
  const resolved: Record<string, TraitConfigValue> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string' && USER_FORWARD.test(value)) {
      const cur = getNestedValue(input.user, value.slice('@user.'.length));
      resolved[key] = typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? cur : '';
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * The `@entity` binding root for one trait's effects: declared field defaults
 * < the persisted row < the trait's live frame (what earlier `(set @entity.X)`
 * steps wrote). The one merge both the server effect stage and the client
 * role's effect runner bind through, so a cascade's later step sees the
 * earlier step's writes on either path. `undefined` when all three are absent.
 */
export function buildEntityBinding(input: {
  entity: Pick<Entity, 'fields'> | undefined;
  persisted: EntityRow | undefined;
  frame: EntityRow | undefined;
}): EntityRow | undefined {
  const defaults = input.entity !== undefined ? collectDeclaredEntityDefaults(input.entity) : undefined;
  if (!defaults && !input.frame) return input.persisted;
  return { ...(defaults ?? {}), ...(input.persisted ?? {}), ...(input.frame ?? {}) };
}
