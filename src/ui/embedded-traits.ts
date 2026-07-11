/**
 * Embed-aware slot routing — static analysis pass.
 *
 * Walks every trait's `transitions[].effects` looking for `render-ui`
 * patterns whose tree contains `@trait.<Name>` string literals. Returns
 * the flat set of trait names that are referenced this way by some
 * sibling layout.
 *
 * Used by `<OrbPreview>` to route `applyServerEffects` — when an
 * embedded trait's render-ui effect arrives, the runtime updates that
 * trait's per-trait sidecar (`traitIndexRef`) only and skips the slot
 * write. The sibling layout owns the slot and embeds the trait's frame
 * via `<TraitFrame>`. Mirrors the compiled-path codegen which inlines
 * the atom views as JSX inside the layout's pattern, never having them
 * write a shared slot.
 *
 * The walker is a structural twin of
 * `packages/almadar-runtime/src/resolver/reference-resolver.ts`'s
 * `renameEventsInRenderUiConfig` — same recursive pattern shape, just
 * collecting `@trait.X` substrings instead of renaming events.
 *
 * @packageDocumentation
 */
import type { OrbitalDefinition, OrbitalSchema, ResolvedTrait, SExpr, SExprAtom, Trait, TraitRef, Transition, TraitTick } from '@almadar/core';

const TRAIT_BINDING_PREFIX = '@trait.';

export function collectTraitRefsFromValue(value: SExpr, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.startsWith(TRAIT_BINDING_PREFIX)) {
      const rest = value.slice(TRAIT_BINDING_PREFIX.length);
      const dot = rest.indexOf('.');
      const traitName = dot === -1 ? rest : rest.slice(0, dot);
      if (traitName.length > 0) into.add(traitName);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTraitRefsFromValue(item, into);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as SExprAtom & Record<string, SExpr>)) {
      collectTraitRefsFromValue(v, into);
    }
  }
}

export function collectTraitRefsFromEffects(
  effects: readonly SExpr[] | undefined,
  into: Set<string>,
): void {
  if (!effects) return;
  for (const effect of effects) {
    if (!Array.isArray(effect)) continue;
    if (effect[0] === 'render-ui' && effect.length >= 3) {
      collectTraitRefsFromValue(effect[2], into);
      continue;
    }
    for (let i = 1; i < effect.length; i++) {
      const arg = effect[i];
      if (Array.isArray(arg)) collectTraitRefsFromEffects([arg], into);
      else collectTraitRefsFromValue(arg, into);
    }
  }
}

export function collectTraitRefsFromResolvedTrait(trait: ResolvedTrait): Set<string> {
  const out = new Set<string>();
  for (const transition of trait.transitions ?? []) {
    collectTraitRefsFromEffects(transition.effects, out);
  }
  for (const tick of trait.ticks ?? []) {
    collectTraitRefsFromEffects(tick.effects, out);
  }
  return out;
}

export function collectEmbeddedTraits(schema: OrbitalSchema | undefined | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!schema?.orbitals) return out;
  for (const orbital of schema.orbitals as OrbitalDefinition[]) {
    const traits: TraitRef[] = orbital.traits;
    if (!Array.isArray(traits)) continue;
    for (const traitRef of traits) {
      if (!traitRef || typeof traitRef !== 'object') continue;
      const resolved = (traitRef as TraitRef & { _resolved?: Trait })._resolved;
      const target: Trait = (resolved && typeof resolved === 'object') ? resolved : traitRef as Trait;
      // The wrapper's OWN `config` (call-site overrides, e.g. a SimpleGrid's
      // `children: [@trait.A, @trait.B, ...]`) is where composition actually
      // places `@trait.X` refs — `_resolved.config` is the atom's own
      // declared config SCHEMA (defaults like a Typography atom's generic
      // "Sample content" placeholder), never the resolved call-site value.
      // Scanning only `target.config` (== `_resolved.config` for wrapper
      // refs) missed every `@trait.X` nested inside a sibling's call-site
      // config, leaving those traits out of the embedded set so their own
      // `render-ui` write landed in the shared slot instead of the
      // per-trait sidecar.
      if (typeof traitRef !== 'string' && 'config' in traitRef && traitRef.config) {
        collectTraitRefsFromValue(traitRef.config, out);
      }
      if (target.config) {
        collectTraitRefsFromValue(target.config, out);
      }
      const transitions: Transition[] | undefined = target.stateMachine?.transitions;
      if (!Array.isArray(transitions)) continue;
      for (const t of transitions) {
        collectTraitRefsFromEffects(t.effects as SExpr[] | undefined, out);
      }
      collectTraitRefsFromEffects(target.initialEffects as SExpr[] | undefined, out);
      const ticks: TraitTick[] | undefined = target.ticks;
      if (Array.isArray(ticks)) {
        for (const tick of ticks) {
          collectTraitRefsFromEffects(tick.effects as SExpr[] | undefined, out);
        }
      }
    }
  }
  return out;
}
