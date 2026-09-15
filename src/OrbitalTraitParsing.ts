/**
 * OrbitalTraitParsing — turn a resolved `OrbitalSchema.traits` array into the
 * `TraitDefinition[]` shape `processEvent` (`StateMachineCore.ts`) consumes.
 *
 * Extracted from `OrbitalServerRuntime.register()` (the trait-unwrap +
 * config-by-trait block) so a SECOND consumer — a stateless, per-request
 * transition handler that never instantiates the full stateful
 * `OrbitalServerRuntime` — can reuse the exact same parsing instead of a
 * second copy. `register()` now calls this too; behavior is unchanged.
 *
 * @packageDocumentation
 */
import {
  isInlineTrait,
  isEntityCall,
  normalizeCallSiteConfigToValues,
  type Entity,
  type OrbitalDefinition,
  type Trait,
  type TraitConfig,
} from "@almadar/core";
import type { TraitDefinition } from "./types.js";

export interface ParsedOrbitalTraits {
  /** Inline (unwrapped) traits, ready for `processEvent`. */
  traits: TraitDefinition[];
  /** The same traits at IR level (`@almadar/core` `Trait`) — `registered.traits`'s shape, kept for callers that need more than states/transitions/listens (e.g. `stateMachine.events` for payload validation). */
  inlineTraits: Trait[];
  /** Call-site `config` block per resolved trait name, from `uses` refs. */
  configByTrait: Map<string, TraitConfig>;
  /** The orbital's entity, resolved from a string ref / `EntityCall` / inline `Entity`. */
  entity: Entity;
}

/**
 * Parse `orbital.traits` (already-resolved — no `uses` left to expand) into
 * `TraitDefinition[]` + the call-site config map, and resolve `orbital.entity`
 * to a concrete `Entity`. Pure — no I/O, no instance state.
 */
export function parseOrbitalTraits(orbital: OrbitalDefinition): ParsedOrbitalTraits {
  // A composed trait (`X = Atom.traits.T`) arrives as a ref-wrapper
  // `{ ref, name?, config?, linkedEntity?, _resolved: Trait }` — unwrap it
  // while capturing its call-site `config`, keyed by the resolved trait
  // name, so effects can read `@config.X`.
  const configByTrait = new Map<string, TraitConfig>();
  const unwrapped = (orbital.traits || []).map((t) => {
    if (t && typeof t === "object" && "ref" in t && "_resolved" in t) {
      const wrapper = t as { _resolved: Trait; config?: TraitConfig };
      const inner = wrapper._resolved;
      const normalizedConfig = normalizeCallSiteConfigToValues(wrapper.config);
      if (normalizedConfig && inner?.name) {
        configByTrait.set(inner.name, normalizedConfig);
      }
      return inner;
    }
    return t;
  });
  const inlineTraits = unwrapped.filter(isInlineTrait);
  const traits: TraitDefinition[] = inlineTraits.map((t: Trait) => {
    const sm = t.stateMachine;
    return {
      ...(t.id !== undefined ? { id: t.id } : {}),
      name: t.name,
      states: (sm?.states || []) as TraitDefinition["states"],
      transitions: (sm?.transitions || []) as TraitDefinition["transitions"],
      listens: t.listens,
    };
  });

  const entityRef = orbital.entity;
  let entity: Entity;
  if (typeof entityRef === "string") {
    entity = { name: entityRef, fields: [] };
  } else if (isEntityCall(entityRef)) {
    const fallbackName = entityRef.name ?? entityRef.extends.replace(/\.entity$/, "");
    entity = {
      name: fallbackName,
      fields: entityRef.fields ?? [],
      ...(entityRef.persistence ? { persistence: entityRef.persistence } : {}),
      ...(entityRef.collection ? { collection: entityRef.collection } : {}),
    };
  } else {
    entity = entityRef;
  }

  return { traits, inlineTraits, configByTrait, entity };
}
