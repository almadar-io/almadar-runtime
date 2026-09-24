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
  computeTraitDispatchMode,
  isStaticallyFalse,
  orbitalInlineEntities,
  type BusEventSource,
  type DispatchMode,
  type Entity,
  type OrbitalDefinition,
  type SExpr,
  type SExprAtom,
  type Trait,
  type TraitConfig,
  type TraitConfigValue,
} from '@almadar/core';
import { createLogger } from '@almadar/logger';
import { getOperatorRunsOn } from '@almadar/std/registry';
import { collectDeclaredConfigDefaults } from './config-defaults.js';
import { findEntityAmongOrbitals, parseOrbitalTraits } from './OrbitalTraitParsing.js';
import type { TraitDefinition } from '../types.js';

const traitIndexLog = createLogger('almadar:runtime:trait-index');

/**
 * Parse cache: `parseOrbitalTraits`/`orbitalInlineEntities` are pure
 * functions of the schema object, and the stateful host builds a
 * per-orbital view over EVERY registered orbital (catalog servers hold
 * ~1.5k) — without memoization the first event per orbital re-parses the
 * whole registry. Keyed by schema identity: a re-registered orbital is a
 * fresh object and re-parses.
 */
const parseCache = new WeakMap<OrbitalDefinition, { traits: ReturnType<typeof parseOrbitalTraits>; entities: Entity[] }>();

function parseOrbitalCached(orbital: OrbitalDefinition): { traits: ReturnType<typeof parseOrbitalTraits>; entities: Entity[] } {
  let cached = parseCache.get(orbital);
  if (cached === undefined) {
    cached = { traits: parseOrbitalTraits(orbital), entities: orbitalInlineEntities(orbital) };
    parseCache.set(orbital, cached);
  }
  return cached;
}

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
  /** Declared dispatch (`local` flag + `[runtime]` entity) — never inferred from effects. */
  dispatchMode: DispatchMode;
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
 * True when a call-site config value still carries an un-chained
 * `@config.X` forward anywhere in its tree — mirrors `useTraitStateMachine`'s
 * `containsConfigForward` (`buildTraitRenderConfig`), the merge this
 * reproduces: a forward surviving into the call-site layer would clobber the
 * concrete value `configOverridesByTrait` already resolved it to.
 */
function containsConfigForward(value: TraitConfigValue): boolean {
  if (typeof value === 'string') return value.startsWith('@config.');
  if (Array.isArray(value)) return value.some(containsConfigForward);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsConfigForward);
  }
  return false;
}

/**
 * Build the trait index from a RESOLVED schema's orbitals (no `uses`
 * left to expand — the compiler's inline phase already ran). Pure derived
 * data: safe to cache per schema (the stateless deployment caches one
 * index per catalog behavior; the stateful server builds one per
 * registered orbital set).
 *
 * `configOverridesByTrait` is the caller's resolved per-trait config
 * (`useTraitStateMachine`'s `traitConfigsByName` — page-level composed
 * values, already forward-chained to concrete data) merged as the MIDDLE
 * layer of `buildTraitRenderConfig`'s three: declared defaults <
 * `configOverridesByTrait` < call-site `uses` override (forward-stripped) —
 * reproduced here so no ui-side merge remains.
 */
type BindingResolver = (binding: string) => SExprAtom | undefined;

/**
 * True when `expr` calls an effect whose registry site is `server`, at any
 * depth. Fold-aware (twin of orbital-core `sexpr_runs_server_effect`): an
 * `if`/`when` branch whose condition is statically false never runs.
 */
export function runsServerEffect(expr: SExpr, resolve?: BindingResolver): boolean {
  if (Array.isArray(expr)) {
    const head = expr[0];
    if ((head === 'if' || head === 'when') && expr.length >= 3) {
      const thenLive = !isStaticallyFalse(expr[1], resolve);
      if (head === 'if') {
        return (thenLive && runsServerEffect(expr[2], resolve)) || (expr[3] !== undefined && runsServerEffect(expr[3], resolve));
      }
      return thenLive && expr.slice(2).some((e) => runsServerEffect(e, resolve));
    }
    if (typeof head === 'string' && getOperatorRunsOn(head) === 'server') return true;
    return expr.some((e) => runsServerEffect(e, resolve));
  }
  if (expr !== null && typeof expr === 'object') return Object.values(expr).some((e) => runsServerEffect(e, resolve));
  return false;
}

/**
 * Whether a trait's own effects reach the server: any transition, or any
 * client tick (a `[background]` tick runs on the host, not a dispatch). The
 * `touchesServer` fact of the dispatch rule (`computeTraitDispatchMode`).
 */
export function touchesServer(
  traitDef: TraitDefinition,
  irTrait: Pick<Trait, 'ticks'>,
  config?: Readonly<Record<string, TraitConfigValue>>,
): boolean {
  // Config stays a binding in JS guards (Rust inlines it): a scalar knob is a
  // known literal here, anything else stays undecidable.
  const resolve: BindingResolver = (binding) => {
    if (!binding.startsWith('@config.')) return undefined;
    const value = config?.[binding.slice('@config.'.length)];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : undefined;
  };
  return traitDef.transitions.some((t) =>
    !(t.guard !== undefined && isStaticallyFalse(t.guard, resolve)) &&
    (t.effects ?? []).some((e) => runsServerEffect(e, resolve))) ||
    (irTrait.ticks ?? []).some((tick) => tick.runsInBackground !== true && (tick.effects as SExpr[]).some((e) => runsServerEffect(e, resolve)));
}

export function buildTraitIndex(
  orbitals: readonly OrbitalDefinition[],
  configOverridesByTrait?: Readonly<Record<string, TraitConfig>>,
): TraitIndex {
  const parsed = orbitals.map((orbital) => ({ orbital, parsed: parseOrbitalCached(orbital).traits }));
  const allEntities = orbitals.map((orbital) => parseOrbitalCached(orbital).entities).flat();
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
      const resolvedOverride = configOverridesByTrait?.[traitDef.name];
      const rawCallSiteOverride = configByTrait.get(traitDef.name);
      const callSiteOverride = rawCallSiteOverride
        ? (Object.fromEntries(
            Object.entries(rawCallSiteOverride).filter(([, v]) => !containsConfigForward(v)),
          ) as TraitConfig)
        : undefined;
      const config = declaredDefaults || resolvedOverride || callSiteOverride
        ? { ...declaredDefaults, ...resolvedOverride, ...callSiteOverride }
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
        dispatchMode: computeTraitDispatchMode(irTrait, traitEntity, touchesServer(traitDef, irTrait as Trait, config)),
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
  const hostNames = new Set(parseOrbitalCached(host).traits.traits.map((t) => t.name));
  const byName = new Map<string, IndexedTrait>();
  for (const [name, entry] of full.byName) {
    if (hostNames.has(name)) byName.set(name, entry);
  }
  return { byName, allEntities: full.allEntities, orbitals: full.orbitals };
}
