/**
 * Pure config-default extraction — kept OUT of `OrbitalServerRuntime.ts` so the
 * package index can re-export it without dragging that module's node-only
 * imports (`module`/`createRequire`, the external loader) into a browser bundle.
 * This file has zero node dependencies (types only, from `@almadar/core`).
 */
import type { TraitConfig, TraitConfigValue, DeclaredTraitConfig } from '@almadar/core';

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
