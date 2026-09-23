/**
 * trait-index — build the per-trait evaluation index ONE time, for every
 * execution path.
 *
 * The index is the composition's view of a resolved schema: for each
 * trait, its flat `TraitDefinition` (the shape `processEvent` consumes),
 * its IR-level trait (payload schemas, `emits` contracts), its RESOLVED
 * linked entity (a trait's `linkedEntity` can name another orbital's
 * primary or an auxiliary entity — resolved against every orbital's
 * entities, never stubbed silently), its merged config (declared schema
 * defaults ⊕ call-site `uses` override), its host orbital's name + V4 id
 * (emit stamping), and its entity-frame key (the `$shared::<entity>`
 * group key `OrbitalServerRuntime.sharedFieldKey` computes, resolved here
 * ONCE from the entity declaration's own `shared` flag instead of
 * re-walking per lookup).
 *
 * Consumers: the unified `evaluateOrbitalEvent` composition (both the
 * stateful server's session view and the stateless per-request handler's
 * compiled-behavior cache). Pure — no I/O, no instance state.
 *
 * @packageDocumentation
 */
import {
  orbitalInlineEntities,
  type BusEventSource,
  type Entity,
  type OrbitalDefinition,
  type Trait,
  type TraitConfig,
} from '@almadar/core';
import { createLogger } from '@almadar/logger';
import { collectDeclaredConfigDefaults } from './config-defaults.js';
import { findEntityAmongOrbitals, parseOrbitalTraits } from './OrbitalTraitParsing.js';
import type { TraitDefinition } from './types.js';

const traitIndexLog = createLogger('almadar:runtime:trait-index');

/** One trait's fully-resolved evaluation entry. */
export interface IndexedTrait {
  /** Flat shape `processEvent`/`runTraitCascade` consume. */
  traitDef: TraitDefinition;
  /** IR-level trait — `stateMachine.events[].payloadSchema`, `emits[]`. */
  irTrait: Trait;
  /** The trait's RESOLVED linked entity (cross-orbital/auxiliary aware). */
  entity: Entity;
  /** Declared schema defaults ⊕ call-site `uses` override. */
  config?: TraitConfig;
  /** Host orbital's declared name (emit stamping, bus keys). */
  orbitalName: string;
  /** Host orbital's V4 id (emit stamping), when the schema carries one. */
  orbitalId?: BusEventSource['orbitalId'];
  /**
   * The entity-frame key: `$shared::<entityName>` when the linked entity
   * is declared `[shared]` (every trait bound to it shares ONE frame —
   * `OrbitalServerRuntime.sharedFieldKey`'s rule, resolved once from the
   * entity declaration itself), else the trait's own name.
   */
  frameKey: string;
  /** The linked entity's declared `shared` flag (render-binding deferral). */
  isSharedEntity: boolean;
}

export interface TraitIndex {
  byName: Map<string, IndexedTrait>;
  /** Every orbital's primary + auxiliary entities (persistence routing, entity lookups). */
  allEntities: Entity[];
  /** The source orbitals with their resolved primary entities — the
   *  `registeredOrbitals` view the effect stage's relation/entity-def
   *  walks consume. */
  orbitals: Array<{ schema: OrbitalDefinition; entity: Entity }>;
}

/**
 * Build the trait index from a RESOLVED schema's orbitals (no `uses`
 * left to expand — the compiler's inline phase already ran). Pure derived
 * data: safe to cache per schema (the stateless deployment caches one
 * index per catalog behavior; the stateful server builds one per
 * registered orbital set).
 */
export function buildTraitIndex(orbitals: readonly OrbitalDefinition[]): TraitIndex {
  const parsed = orbitals.map((orbital) => ({ orbital, parsed: parseOrbitalTraits(orbital) }));
  const allEntities = parsed.flatMap(({ orbital }) => orbitalInlineEntities(orbital));
  const orbitalsView = parsed.map(({ orbital, parsed: p }) => ({ schema: orbital, entity: p.entity }));
  const byName = new Map<string, IndexedTrait>();

  for (const { orbital, parsed: p } of parsed) {
    const { traits, inlineTraits, configByTrait, entity } = p;
    for (let i = 0; i < traits.length; i++) {
      const traitDef = traits[i];
      const irTrait = inlineTraits[i];
      const linkedEntityName = irTrait?.linkedEntity;
      // A trait's own linkedEntity may differ from its host orbital's
      // top-level entity (a composed sub-orbital can bind a different
      // entity, including another orbital's primary or an auxiliary) —
      // resolve against every orbital's entities; only stub (and warn)
      // when genuinely not found anywhere, which indicates a real schema
      // issue rather than the common cross-orbital case.
      let traitEntity = entity;
      if (linkedEntityName && linkedEntityName !== traitEntity.name) {
        const resolved = findEntityAmongOrbitals(allEntities, linkedEntityName);
        if (resolved) {
          traitEntity = resolved;
        } else {
          traitIndexLog.warn('linkedEntity:unresolved', {
            orbital: orbital.name,
            trait: traitDef.name,
            linkedEntityName,
          });
          traitEntity = { name: linkedEntityName, fields: [] as Entity['fields'] };
        }
      }
      const declaredDefaults = collectDeclaredConfigDefaults(irTrait);
      const callSiteOverride = configByTrait.get(traitDef.name);
      const config = declaredDefaults || callSiteOverride
        ? { ...declaredDefaults, ...callSiteOverride }
        : undefined;
      const isShared = traitEntity.shared === true;
      byName.set(traitDef.name, {
        traitDef,
        irTrait: irTrait as Trait,
        entity: traitEntity,
        ...(config !== undefined ? { config } : {}),
        orbitalName: orbital.name,
        ...(orbital.id !== undefined ? { orbitalId: orbital.id as BusEventSource['orbitalId'] } : {}),
        frameKey: isShared ? `$shared::${traitEntity.name}` : traitDef.name,
        isSharedEntity: isShared,
      });
    }
  }
  return { byName, allEntities, orbitals: orbitalsView };
}

/**
 * Build the index for ONE registered-orbital view (the stateful server's
 * session shape): the host orbital's parsed traits plus every other
 * registered orbital's entities for cross-orbital `linkedEntity`
 * resolution. `otherOrbitals` supplies the sibling entity declarations
 * only — their traits are NOT indexed (the state's dispatch set is the
 * host orbital's own traits).
 */
export function buildTraitIndexForOrbital(
  host: OrbitalDefinition,
  otherOrbitals: Iterable<OrbitalDefinition> = [],
): TraitIndex {
  const orbitals = [host, ...otherOrbitals];
  const full = buildTraitIndex(orbitals);
  const hostNames = new Set(parseOrbitalTraits(host).traits.map((t) => t.name));
  const byName = new Map<string, IndexedTrait>();
  for (const [name, entry] of full.byName) {
    if (hostNames.has(name)) byName.set(name, entry);
  }
  return { byName, allEntities: full.allEntities, orbitals: full.orbitals };
}
