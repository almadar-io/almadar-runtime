/**
 * Pure config-default extraction — kept OUT of `OrbitalServerRuntime.ts` so the
 * package index can re-export it without dragging that module's node-only
 * imports (`module`/`createRequire`, the external loader) into a browser bundle.
 * This file has zero node dependencies (types only, from `@almadar/core`).
 */
import type { TraitConfig, TraitConfigValue, DeclaredTraitConfig, Entity, EntityRow, FieldValue, CallSiteConfig } from '@almadar/core';
import { isCallSiteConfigDeclaration } from '@almadar/core';

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
 * Convert a call-site config map into plain runtime values.
 *
 * A `CallSiteConfig` may contain either plain wiring values
 * (`TraitConfigValue`) or annotated `ConfigFieldDeclaration` objects
 * (`{ type, default, label, ... }`). The runtime binding context expects
 * only values, so this helper extracts `.default` from declarations and
 * passes plain values through unchanged. Entries that are not recognized as
 * declarations by `isCallSiteConfigDeclaration` are returned as-is.
 */
export function normalizeCallSiteConfigToValues(
  config: CallSiteConfig | undefined,
): TraitConfig | undefined {
  if (config === undefined) {
    return undefined;
  }

  const out: Record<string, TraitConfigValue> = {};
  let hasAny = false;
  for (const [key, entry] of Object.entries(config)) {
    const value = isCallSiteConfigDeclaration(entry)
      ? entry.default
      : entry;
    if (value !== undefined) {
      out[key] = value;
      hasAny = true;
    }
  }

  return hasAny ? out : undefined;
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
  entity: Entity | undefined,
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
