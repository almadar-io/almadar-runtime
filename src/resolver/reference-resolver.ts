/**
 * Reference Resolver
 *
 * Resolves `uses` imports and component references in OrbitalSchema.
 * Handles:
 * - `Alias.entity` entity references
 * - `Alias.traits.TraitName` trait references
 * - `Alias.pages.PageName` page references
 *
 * @packageDocumentation
 */

import type {
  Orbital,
  OrbitalDefinition,
  EntityRef,
  PageRef,
  PageRefObject,
  Entity,
  Event,
  Page,
  Trait,
  TraitRef,
  TraitConfig,
  TraitEventListener,
  OrbitalSchema,
  UseDeclaration,
  PatternConfig,
  TraitId,
  PageId,
  ConfigFieldDeclaration,
} from "@almadar/core";
import {
  isEntityReference,
  isEntityCall,
  isPageReference,
  isPageReferenceString,
  isPageReferenceObject,
  parseEntityRef,
  parsePageRef,
  parseImportedTraitRef,
  isInlineTrait,
  configRefEventKnob,
  resolveConfigRefEventName,
  normalizeCallSiteConfigToValues,
  isReferenceConfigType,
} from "@almadar/core";
import type {
  LoaderOptions,
} from "../loader/external-loader.js";
import type {
  SchemaLoader,
  ImportChainLike,
} from "../loader/schema-loader.js";
import { createLogger } from '@almadar/logger';
import { spliceLambdaTraitRefs, LambdaSpliceError } from "../ui/splice-lambda-traits.js";

const refResolverLog = createLogger("almadar:runtime:ref-resolver");

// ============================================================================
// Types
// ============================================================================

/**
 * A node reachable by id — the id-index entry.
 */
export interface IdIndexEntry {
  kind: "trait" | "entity" | "page" | "event";
  node: Trait | Entity | Page | Event;
}

/**
 * Resolved imports from `uses` declarations.
 */
export interface ResolvedImports {
  /** Map of alias -> loaded orbital */
  orbitals: Map<string, ResolvedImport>;

  /**
   * V4 id->node index spanning the composing orbital's own inline traits /
   * entity / pages PLUS every imported orbital reachable via `uses`. Built
   * once per `resolve()` call so id-carrying refs (`refId`, `linkedEntityId`,
   * `traitRefIds`) can look a node up directly instead of re-walking every
   * imported orbital's arrays by name. Additive only — every existing
   * name-keyed lookup path stays intact and this index is consulted first,
   * falling back to name matching when a ref's id is absent or unindexed.
   */
  idIndex: Map<string, IdIndexEntry>;
}

/**
 * Walk one orbital's own inline nodes (traits / entity / pages) and add any
 * that carry an `id` to the index. Shared between the local composing
 * orbital and every imported orbital so the index spans the whole reachable
 * graph.
 */
function indexOrbitalNodes(orbital: OrbitalDefinition, idIndex: Map<string, IdIndexEntry>): void {
  for (const traitRef of orbital.traits ?? []) {
    if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
      const trait = traitRef as Trait;
      if (trait.id) {
        idIndex.set(trait.id, { kind: "trait", node: trait });
      }
      // Events are first-class (declared in `emits`, dispatched via
      // listens/emits + render-ui event-name props). Index each by its
      // stable id so an `event`-typed config knob's `refId` resolves to the
      // event's current key after a call-site rename.
      for (const ev of trait.stateMachine?.events ?? []) {
        if (ev.id) {
          idIndex.set(ev.id, { kind: "event", node: ev });
        }
      }
    }
  }
  const entityRef = orbital.entity;
  if (
    entityRef &&
    typeof entityRef !== "string" &&
    !("extends" in entityRef) &&
    (entityRef as Entity).id
  ) {
    const entity = entityRef as Entity;
    idIndex.set(entity.id!, { kind: "entity", node: entity });
  }
  for (const pageRef of orbital.pages ?? []) {
    if (typeof pageRef !== "string" && !("ref" in pageRef)) {
      const page = pageRef as Page;
      if (page.id) {
        idIndex.set(page.id, { kind: "page", node: page });
      }
    }
  }
}

/**
 * Build the id->node index spanning the local orbital plus every imported
 * orbital reachable via `uses`. See {@link ResolvedImports.idIndex}.
 */
function buildIdIndex(
  orbital: OrbitalDefinition,
  orbitals: Map<string, ResolvedImport>,
): Map<string, IdIndexEntry> {
  const idIndex = new Map<string, IdIndexEntry>();
  indexOrbitalNodes(orbital, idIndex);
  for (const imported of orbitals.values()) {
    for (const o of importedOrbitals(imported)) indexOrbitalNodes(o, idIndex);
  }
  return idIndex;
}

/**
 * A single resolved import.
 */
export interface ResolvedImport {
  /** The alias used for this import */
  alias: string;

  /** The original import path */
  from: string;

  /** The loaded orbital — the behavior's primary/named orbital. */
  orbital: Orbital;

  /**
   * EVERY orbital of the imported behavior, not just the primary one. A
   * multi-orbital organism keeps its traits and pages spread across all of
   * them, and `Alias.traits.X` carries no orbital segment, so lookups must
   * search the whole list. Mirrors the compiled path's
   * `AliasEntry { orbitals: Vec<Orbital> }` (orbital-compiler
   * `phases/inline/context.rs`), which already resolves this way — without
   * this the runtime silently fails on any trait outside orbital 0.
   */
  orbitals: Orbital[];

  /** Absolute source path */
  sourcePath: string;
}

/**
 * Every orbital of an imported behavior, primary first. Falls back to the
 * single primary for any loader that predates `orbitals`.
 */
function importedOrbitals(imported: ResolvedImport): Orbital[] {
  return imported.orbitals?.length ? imported.orbitals : [imported.orbital];
}

/**
 * Fully resolved orbital with all references expanded.
 */
export interface ResolvedOrbital {
  /** Original orbital name */
  name: string;

  /** Resolved entity (always inline after resolution) */
  entity: Entity;

  /** Whether entity was referenced from an import */
  entitySource?: {
    alias: string;
    persistence: "persistent" | "runtime";
  };

  /** Resolved traits (references expanded) */
  traits: ResolvedTrait[];

  /** Resolved pages (references expanded with path overrides applied) */
  pages: ResolvedPage[];

  /** Resolved imports */
  imports: ResolvedImports;

  /** Original orbital definition */
  original: OrbitalDefinition;
}

/**
 * Resolved trait with source tracking.
 */
export interface ResolvedTrait {
  /** The trait definition */
  trait: Trait;

  /** Source of the trait */
  source:
    | { type: "inline" }
    | { type: "local"; name: string }
    | { type: "imported"; alias: string; traitName: string };

  /** Linked entity for this trait */
  linkedEntity?: string;

  /** Configuration overrides */
  config?: TraitConfig;
}

/**
 * Resolved page with source tracking.
 */
export interface ResolvedPage {
  /** The page definition */
  page: Page;

  /** Source of the page */
  source:
    | { type: "inline" }
    | { type: "imported"; alias: string; pageName: string };

  /** Whether path was overridden */
  pathOverridden: boolean;

  /** Original path before override */
  originalPath?: string;
}

/**
 * Resolution options.
 */
export interface ResolveOptions extends LoaderOptions {
  /** Map of local trait definitions (name -> trait) */
  localTraits?: Map<string, Trait>;

  /** Whether to skip loading external imports (for testing) */
  skipExternalLoading?: boolean;

  /** Custom schema loader instance (optional, defaults to ExternalOrbitalLoader) */
  loader?: SchemaLoader;
}

/**
 * Resolution result.
 */
export type ResolveResult<T> =
  | { success: true; data: T; warnings: string[] }
  | { success: false; errors: string[] };

// ============================================================================
// Call-site event rename
// ============================================================================

/**
 * Recursively rewrite every event-name prop inside a render-ui config
 * tree. These are the user-dispatchable event keys the client renders
 * on buttons / actions / form handlers — they live at arbitrary nesting
 * depth inside a render-ui's second argument and must track the same
 * rename the state machine does, or the button emits the old key into
 * a machine that only knows the new one (dead-click bug).
 *
 * Rewrites:
 *   - `action: "X"` on any pattern (button, chip, floating-action, ...)
 *   - any prop whose key ends in `Event` with a non-binding string value
 *     (`submitEvent`, `cancelEvent`, `selectEvent`, `changeEvent`, ...)
 *   - `actions: [{ event: "X" }]` and `itemActions: [{ event: "X" }]`
 *   - `onX: "EVENT"` handlers
 *
 * Skips anything that looks like a binding (`@config.X`, `@entity.Y`).
 * Recurses into every nested object/array value without hardcoding
 * slot / child field names — traits using `children`, `content`,
 * `leading`, `trailing`, etc. all get covered automatically.
 */
function renameEventsInRenderUiConfig(
  node: PatternConfig | readonly unknown[] | unknown,
  rename: (k: string | undefined) => string | undefined,
): PatternConfig | unknown[] | unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    return node.map((item) => renameEventsInRenderUiConfig(item, rename));
  }
  if (typeof node !== "object") return node;

  // Every PatternConfig variant is a string-indexable object — the
  // discriminated union's `type` field picks which pattern's props
  // apply, but Object.entries returns each prop as [string, PropValue].
  // Mapped output preserves every key by re-spreading the node via a
  // shallow iteration, so we never lose the discriminator or untouched
  // props.
  const obj = node as PatternConfig;
  const next: PatternConfig = { ...obj };
  for (const [key, value] of Object.entries(obj)) {
    if (key === "action" && typeof value === "string" && !value.startsWith("@")) {
      (next as { [k: string]: PatternConfig[keyof PatternConfig] })[key] =
        (rename(value) ?? value) as PatternConfig[keyof PatternConfig];
      continue;
    }
    if (/^on[A-Z]/.test(key) && typeof value === "string" && !value.startsWith("@")) {
      (next as { [k: string]: PatternConfig[keyof PatternConfig] })[key] =
        (rename(value) ?? value) as PatternConfig[keyof PatternConfig];
      continue;
    }
    if (key.endsWith("Event") && typeof value === "string" && !value.startsWith("@")) {
      (next as { [k: string]: PatternConfig[keyof PatternConfig] })[key] =
        (rename(value) ?? value) as PatternConfig[keyof PatternConfig];
      continue;
    }
    if ((key === "actions" || key === "itemActions") && Array.isArray(value)) {
      const rewrittenArray = value.map((entry): unknown => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        // Pattern action entries have a shared minimal contract: `event`
        // (required event key), `label`, `icon`, `variant`. Narrow to
        // that shape for the event rewrite; other keys pass through the
        // spread intact.
        const action = entry as { event?: string; [k: string]: unknown };
        if (typeof action.event === "string" && !action.event.startsWith("@")) {
          return { ...action, event: rename(action.event) ?? action.event };
        }
        return action;
      });
      (next as { [k: string]: unknown })[key] = rewrittenArray;
      continue;
    }
    (next as { [k: string]: unknown })[key] = renameEventsInRenderUiConfig(value, rename);
  }
  return next;
}

/**
 * Rewrite event names inside an effects SExpr array. Walks every
 * `(render-ui slot config)` call and passes the config through
 * {@link renameEventsInRenderUiConfig}. Preserves non-render-ui effects
 * unchanged.
 */
function renameEventsInEffects(
  effects: readonly unknown[],
  rename: (k: string | undefined) => string | undefined,
): unknown[] {
  return effects.map((effect) => {
    if (!Array.isArray(effect)) return effect;
    if (effect[0] === "render-ui" && effect.length >= 3) {
      const slot = effect[1];
      const config = effect[2];
      const nextConfig = renameEventsInRenderUiConfig(config, rename);
      return [effect[0], slot, nextConfig, ...effect.slice(3)];
    }
    return effect;
  });
}

/**
 * Apply a call-site `events: { OLD: NEW, ... }` rename map to a resolved
 * trait's state machine. Rewrites every mention of an old key in:
 *   - `stateMachine.transitions[].event` (the trigger)
 *   - `stateMachine.transitions[].effects[]` render-ui button / action /
 *     itemAction / submitEvent / cancelEvent / onX event-name props
 *   - `stateMachine.events[].key` + `.name` (humanized display)
 *   - `emits[].event`
 *
 * Does NOT rewrite `listens[].event`: those entries reference OTHER traits'
 * events, not this trait's own events, so the rename doesn't apply.
 *
 * Returns the trait unchanged when `renames` is empty or undefined.
 */
/**
 * Walk a render-ui pattern config and rewrite every `entity: "<oldName>"`
 * string to `entity: "<newName>"`. Applied when a molecule pins an
 * imported atom to a different linked entity — the atom declared
 * `entity: "ModalRecord"` on its form-section, but at the ref site the
 * molecule said `linkedEntity: "CartItem"`, so the runtime needs to see
 * `entity: "CartItem"` at render time for schema enrichment
 * (UISlotRenderer looks up `schemaCtx.entities.get(entityName)` to
 * inject field types + enum values for form controls).
 *
 * Without this rewrite, the lookup misses the molecule-level entity and
 * the form renders text inputs for every field — including enum-shaped
 * ones that should be `<Select>`. VG20.
 *
 * Bindings (`@entity.X`, `@payload.X`) are NOT touched; only bare string
 * literals matching `atomLinkedEntity` get rewritten.
 */
/**
 * Entity-name string props inside a render-ui pattern tree. The call-site
 * `linkedEntity` rebind rewrites only `entity`; the id-side-map reader
 * ({@link resolveEntityTokensById}) additionally covers `entityType` and
 * `source` per the V4 entity-token position list.
 */
const REBIND_ENTITY_PROPS: ReadonlySet<string> = new Set(["entity"]);
const ID_ENTITY_PROPS: ReadonlySet<string> = new Set(["entity", "entityType", "source"]);

/**
 * `rename(name)` returns the replacement entity name for `name`, or
 * `undefined` to leave it untouched. Shared by the name-based linkedEntity
 * rebind (`n => n === atomLinked ? linkedEntity : undefined`) and the id
 * side-map reader (a map lookup keyed by the trait's `entityRefIds`).
 */
type EntityRename = (name: string) => string | undefined;

function renameEntityInRenderUiConfig(
  node: PatternConfig | readonly unknown[] | unknown,
  rename: EntityRename,
  props: ReadonlySet<string>,
): PatternConfig | unknown[] | unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    return node.map((item) => renameEntityInRenderUiConfig(item, rename, props));
  }
  if (typeof node !== "object") return node;
  const obj = node as PatternConfig;
  const next: PatternConfig = { ...obj };
  for (const [key, value] of Object.entries(obj)) {
    if (props.has(key) && typeof value === "string") {
      const replaced = rename(value);
      if (replaced !== undefined) {
        (next as { [k: string]: unknown })[key] = replaced;
        continue;
      }
    }
    (next as { [k: string]: unknown })[key] = renameEntityInRenderUiConfig(value, rename, props);
  }
  return next;
}

/**
 * Walk a trait's effects and rewrite entity-name literals to match the
 * call-site's `linkedEntity` override.
 *
 * The previous version only rewrote `(render-ui ...)` config payloads,
 * with a comment claiming "other effects use bindings, not string
 * literals" — which is wrong. Several operators take the entity name
 * as a positional STRING LITERAL argument:
 *
 * - `(fetch <Entity> [options])`               — position 1
 * - `(persist <create|update|delete|clear> <Entity> ...)` — position 2
 * - `(ref <Entity|@binding> [options])`        — position 1 (string-only)
 * - `(deref <Entity|@binding> [options])`      — position 1 (string-only)
 * - `(spawn <Entity> [initialState])`          — position 1
 *
 * Without this rewrite, an inlined std-browse atom rebound via
 * `trait FilteredItemBrowse = Browse.traits.BrowseItemBrowse -> FilteredListItem {}`
 * would still call `MockPersistenceAdapter.list("BrowseItem")` — which
 * returns zero rows because only `FilteredListItem` is registered. The
 * data-grid renders empty even though the molecule looks correct in
 * `.lolo`. The compiled-path codegen handles this in Rust at compile
 * time; the runtime must do the equivalent rewrite at registration
 * time.
 *
 * Wrapper operators (`do`, `atomic`, `if`, `when`, `let`, `async/*`)
 * recurse into nested effects so a `(do (fetch X) ...)` block is
 * rewritten end-to-end.
 */
function renameEntityInEffects(
  effects: readonly unknown[],
  rename: EntityRename,
  props: ReadonlySet<string>,
): unknown[] {
  return effects.map((effect) => renameEntityInEffect(effect, rename, props));
}

/**
 * Operators that take an entity-name string literal as their FIRST
 * positional argument: `(op "<Entity>" ...)`.
 * Source: `@almadar/core/types/effect.ts` (FetchEffect, RefEffect,
 * DerefEffect, SpawnEffect tuple shapes).
 */
const ENTITY_AT_POS_1 = new Set(["fetch", "ref", "deref", "spawn"]);

/**
 * Wrapper operators where ALL positional args (positions ≥ 1) are
 * nested effects. Recurse into every arg. From the typed effect
 * tuples: DoEffect, AtomicEffect, AsyncRaceEffect, AsyncAllEffect,
 * AsyncSequenceEffect.
 */
const ALL_ARGS_ARE_EFFECTS = new Set([
  "do",
  "atomic",
  "async/race",
  "async/all",
  "async/sequence",
]);

/**
 * Wrapper operators where position 1 is something other than an
 * effect (a condition expression, a let-binding list, or an
 * async-timing value), and positions ≥ 2 are nested effects.
 * Skipping position 1 is critical so we don't accidentally rewrite
 * a literal value used as a comparison RHS (e.g. `(if (= @entity.foo
 * "BrowseItem") ...)` — the string "BrowseItem" there is a value
 * being compared, not an entity-name we want to rename).
 *
 * IfEffect / WhenEffect — position 1 is `Expression` (condition).
 * LetEffect — position 1 is `[string, unknown][]` (bindings).
 * AsyncDelay / Debounce / Throttle / Interval — position 1 is duration.
 */
const ARGS_FROM_POS_2_ARE_EFFECTS = new Set([
  "if",
  "when",
  "let",
  "async/delay",
  "async/debounce",
  "async/throttle",
  "async/interval",
]);

function renameEntityInEffect(
  effect: unknown,
  rename: EntityRename,
  props: ReadonlySet<string>,
): unknown {
  if (!Array.isArray(effect) || effect.length === 0) return effect;
  const op = effect[0];
  if (typeof op !== "string") return effect;

  // `(render-ui slot config)` — recurse into the pattern tree config.
  // Bare `entity: "<OldName>"` string-literal props inside the
  // pattern tree get rewritten too.
  if (op === "render-ui" && effect.length >= 3) {
    const [, slot, config, ...rest] = effect;
    const nextConfig = renameEntityInRenderUiConfig(config, rename, props);
    return [op, slot, nextConfig, ...rest];
  }

  // `(persist <op> <Entity> ...)`. Entity at position 2 (after the
  // create/update/delete/clear keyword). Per PersistEffect tuple shape.
  if (op === "persist" && effect.length >= 3 && typeof effect[2] === "string") {
    const replaced = rename(effect[2]);
    if (replaced !== undefined) return [op, effect[1], replaced, ...effect.slice(3)];
  }

  // Operators with the entity name at position 1.
  if (ENTITY_AT_POS_1.has(op) && typeof effect[1] === "string") {
    const replaced = rename(effect[1]);
    if (replaced !== undefined) return [op, replaced, ...effect.slice(2)];
  }

  // Wrappers — recurse into nested effects. Whether to skip position 1
  // depends on the operator's argument structure (see set comments).
  const skipFirstNonEffectArg = ARGS_FROM_POS_2_ARE_EFFECTS.has(op);
  const recurseAll = ALL_ARGS_ARE_EFFECTS.has(op);
  if (recurseAll || skipFirstNonEffectArg) {
    const startIndex = skipFirstNonEffectArg ? 2 : 1;
    return effect.map((arg, i) => {
      if (i < startIndex) return arg;
      if (Array.isArray(arg)) {
        return renameEntityInEffect(arg, rename, props);
      }
      return arg;
    });
  }

  return effect;
}

const TRAIT_EMBED_PREFIX = "@trait.";

/**
 * Rewrite `@trait.<from>` embed roots to `@trait.<to>` anywhere in a value
 * tree. Boundary-checked at `.`/`[` so `@trait.FooBar` is not matched by a
 * `Foo` substitution. JS twin of the compiler's
 * `rewrite_trait_embed_in_sexpr` (`inline/identity_normalize.rs:330`).
 */
function renameTraitEmbedsInValue(node: unknown, subs: ReadonlyMap<string, string>): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") {
    if (!node.startsWith(TRAIT_EMBED_PREFIX)) return node;
    const rest = node.slice(TRAIT_EMBED_PREFIX.length);
    const dot = rest.search(/[.[]/);
    const name = dot === -1 ? rest : rest.slice(0, dot);
    const suffix = dot === -1 ? "" : rest.slice(dot);
    const to = subs.get(name);
    return to === undefined ? node : `${TRAIT_EMBED_PREFIX}${to}${suffix}`;
  }
  if (Array.isArray(node)) return node.map((item) => renameTraitEmbedsInValue(item, subs));
  if (typeof node !== "object") return node;
  const next: { [k: string]: unknown } = {};
  for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
    next[key] = renameTraitEmbedsInValue(value, subs);
  }
  return next;
}

/**
 * Point one trait's `@trait.X` embeds at their disambiguated pull names.
 * Covers transition effects, tick effects AND config-field defaults — the
 * last one carries `std-browse`'s `bodyContent`/`denseBodyContent` trees, so
 * skipping it leaves the embeds pointing at the wrong copy.
 */
function renameTraitEmbeds(trait: Trait, subs: ReadonlyMap<string, string>): Trait {
  if (subs.size === 0) return trait;
  const sm = trait.stateMachine;
  const next: Trait = { ...trait };
  if (sm) {
    next.stateMachine = {
      ...sm,
      transitions: (sm.transitions ?? []).map((t) =>
        t.effects
          ? { ...t, effects: renameTraitEmbedsInValue(t.effects, subs) as typeof t.effects }
          : t,
      ),
    };
  }
  if (trait.ticks) {
    next.ticks = trait.ticks.map((tick) =>
      tick.effects
        ? { ...tick, effects: renameTraitEmbedsInValue(tick.effects, subs) as typeof tick.effects }
        : tick,
    );
  }
  if (trait.config) {
    const nextConfig: { [k: string]: ConfigFieldDeclaration } = {};
    for (const [key, field] of Object.entries(trait.config)) {
      nextConfig[key] =
        field.default === undefined
          ? field
          : {
              ...field,
              default: renameTraitEmbedsInValue(
                field.default,
                subs,
              ) as ConfigFieldDeclaration["default"],
            };
    }
    next.config = nextConfig;
  }
  return next;
}

/**
 * The trait entry an orbital declares under `localName` — inline definition or
 * unresolved `{ref, name, …}` wrapper. `findTraitInOrbital` only ever returns
 * inline definitions; an atom's sub-views are refs (`trait DenseTableView =
 * TableView.traits.TableViewRender -> BrowseItem`), so the sibling pull needs
 * both shapes.
 */
function findTraitEntryInOrbital(
  orbital: Orbital,
  localName: string,
): Exclude<TraitRef, string> | null {
  for (const traitRef of orbital.traits ?? []) {
    if (typeof traitRef === "string") continue;
    if ("stateMachine" in traitRef) {
      if ((traitRef as Trait).name === localName) return traitRef;
      continue;
    }
    if (!("ref" in traitRef)) continue;
    const refObj = traitRef as { ref: string; name?: string };
    const declared = refObj.name ?? parseImportedTraitRef(refObj.ref)?.traitName;
    if (declared === localName) return traitRef;
  }
  return null;
}

/** Every `@trait.X` root name a trait references (effects, ticks, config defaults). */
function traitEmbedNamesOf(trait: Trait): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (!node.startsWith(TRAIT_EMBED_PREFIX)) return;
      const rest = node.slice(TRAIT_EMBED_PREFIX.length);
      const dot = rest.search(/[.[]/);
      const name = dot === -1 ? rest : rest.slice(0, dot);
      if (name.length > 0) found.add(name);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    for (const value of Object.values(node as { [k: string]: unknown })) walk(value);
  };
  for (const t of trait.stateMachine?.transitions ?? []) walk(t.effects);
  for (const tick of trait.ticks ?? []) walk(tick.effects);
  for (const field of Object.values(trait.config ?? {})) walk(field.default);
  return [...found];
}

/**
 * Resolve a pulled sibling's `@config.<knob>` forward defaults against the
 * trait that embeds it — the JS twin of the compiler's
 * `forwarded_sibling_config` (`phases/inline/trait.rs`).
 *
 * `MasterListView = DataList.traits.DataListRender { config { fields:
 * @config.fields } }` inside `std-browse` means "take `fields` from whoever
 * embeds me". The embedder is known at exactly one place, the pull site: a
 * sibling is materialised per embedder, and its own declared default IS the
 * forward string, so without this the knob still reads `@config.fields` at
 * render time, `deferEntityBindings`' hop finds the same token and stops, and
 * a populated list renders blank.
 *
 * Only whole-string forwards resolve here. A `@config.<knob>.<path>` form and
 * a knob the embedder does not declare are left for the binding validator.
 */
function resolveForwardedSiblingConfig(trait: Trait, parent: Trait | undefined): Trait {
  const declared = trait.config;
  const parentDeclared = parent?.config;
  if (!declared || !parentDeclared) return trait;
  let next: Record<string, ConfigFieldDeclaration> | undefined;
  for (const [key, field] of Object.entries(declared)) {
    const forward = field.default;
    if (typeof forward !== "string" || !forward.startsWith("@config.")) continue;
    const knob = forward.slice("@config.".length);
    if (knob.length === 0 || knob.includes(".")) continue;
    const value = parentDeclared[knob]?.default;
    // The embedder forwards the same token upward — its own embedder supplies
    // the value one pull further out.
    if (value === undefined || value === forward) continue;
    next ??= { ...declared };
    next[key] = { ...field, default: value };
  }
  return next ? { ...trait, config: next } : trait;
}

/**
 * Apply a linkedEntity override from a trait-ref call site to an
 * imported atom. When the atom declared `entity: "ModalRecord"` inside
 * its render-ui configs and the ref site supplied
 * `linkedEntity: "CartItem"`, rewrite every such literal so runtime
 * consumers (EntitySchemaContext lookup, DataService collection binding)
 * see the molecule-level entity name. No-op when either argument is
 * missing or when the names match.
 */
function applyLinkedEntityRename(
  trait: Trait,
  linkedEntity: string | undefined,
): Trait {
  const atomLinked = trait.linkedEntity;
  if (!linkedEntity || !atomLinked || linkedEntity === atomLinked) return trait;
  const sm = trait.stateMachine;
  if (!sm) return { ...trait, linkedEntity };
  const rename: EntityRename = (name) => (name === atomLinked ? linkedEntity : undefined);
  const nextTransitions = (sm.transitions ?? []).map((t) => {
    const nextEffects = t.effects
      ? (renameEntityInEffects(
          t.effects as readonly unknown[],
          rename,
          REBIND_ENTITY_PROPS,
        ) as typeof t.effects)
      : t.effects;
    return { ...t, effects: nextEffects };
  });
  // Observability: structured log fires once per call-site rebind so
  // verifier traces show exactly which trait got which entity rewrite.
  // Especially load-bearing for catching the "fetch <OldEntity>" gap
  // that was silently dropping data-grid rows on every embedded atom.
  refResolverLog.info("linkedEntity:rename", {
    trait: trait.name,
    from: atomLinked,
    to: linkedEntity,
    transitionCount: nextTransitions.length,
  });
  return {
    ...trait,
    linkedEntity,
    stateMachine: { ...sm, transitions: nextTransitions },
  } as Trait;
}

/**
 * V4 leverage-ids — id-primary entity-token resolution.
 *
 * A trait's entity-name tokens (`linkedEntity`, positional `fetch`/`ref`/
 * `deref`/`spawn`/`persist` args, and render-ui `entity`/`entityType`/`source`
 * string props) are bare strings carrying the referenced entity's NAME. When
 * the trait carries an `entityRefIds` side-map (`name → stable entity id`),
 * resolve each token by id: look the mapped id up in the id→node index and,
 * if the current entity declaration's name differs from the token (i.e. it was
 * renamed after the side-map was stamped), rewrite the token to the current
 * name. This is what lets the entity name-rewriter be deleted — a renamed
 * entity keeps its id, so the token still resolves to the right declaration.
 *
 * Additive + presence-based: no side-map, an unindexed id, or an id whose
 * entity name already matches the token → the trait passes through untouched
 * and the existing name-based path stays authoritative.
 */
function resolveEntityTokensById(
  trait: Trait,
  idIndex: Map<string, IdIndexEntry>,
): Trait {
  const map = trait.entityRefIds;
  if (!map) return trait;
  const rewrites = new Map<string, string>();
  for (const [tokenName, entityId] of Object.entries(map)) {
    const entry = idIndex.get(entityId);
    if (entry && entry.kind === "entity") {
      const currentName = (entry.node as Entity).name;
      if (currentName && currentName !== tokenName) {
        rewrites.set(tokenName, currentName);
      }
    }
  }
  if (rewrites.size === 0) return trait;

  const rename: EntityRename = (name) => rewrites.get(name);
  const sm = trait.stateMachine;
  const nextTransitions = sm?.transitions
    ? sm.transitions.map((t) => ({
        ...t,
        effects: t.effects
          ? (renameEntityInEffects(
              t.effects as readonly unknown[],
              rename,
              ID_ENTITY_PROPS,
            ) as typeof t.effects)
          : t.effects,
      }))
    : sm?.transitions;
  const nextTicks = trait.ticks
    ? trait.ticks.map((tick) => ({
        ...tick,
        effects: (renameEntityInEffects(
          tick.effects as readonly unknown[],
          rename,
          ID_ENTITY_PROPS,
        ) as typeof tick.effects),
      }))
    : trait.ticks;
  const nextInitial = trait.initialEffects
    ? (renameEntityInEffects(
        trait.initialEffects as readonly unknown[],
        rename,
        ID_ENTITY_PROPS,
      ) as typeof trait.initialEffects)
    : trait.initialEffects;
  const nextLinked =
    trait.linkedEntity !== undefined
      ? (rewrites.get(trait.linkedEntity) ?? trait.linkedEntity)
      : trait.linkedEntity;

  refResolverLog.info("entity-ref:id-resolve", {
    trait: trait.name,
    rewrites: Object.fromEntries(rewrites),
  });

  return {
    ...trait,
    linkedEntity: nextLinked,
    ...(sm ? { stateMachine: { ...sm, transitions: nextTransitions ?? [] } } : {}),
    ...(nextTicks !== undefined ? { ticks: nextTicks } : {}),
    ...(nextInitial !== undefined ? { initialEffects: nextInitial } : {}),
  };
}

/**
 * Map a reference config field's `type` (`"entity" | "trait" | "event"`) to
 * the {@link IdIndexEntry.kind} its `refId` must resolve to. An `IdIndexEntry`
 * whose kind doesn't match is treated the same as a missing index entry —
 * presence-based, not a heuristic guess.
 */
const REFERENCE_CONFIG_TYPE_TO_ID_KIND: Readonly<Record<string, IdIndexEntry["kind"]>> = {
  entity: "entity",
  trait: "trait",
  event: "event",
};

/**
 * V4-W5 leverage-ids — id-primary resolution of REFERENCE-typed config
 * values (`type: "entity" | "trait" | "event"`).
 *
 * A config knob typed `entity`/`trait`/`event` holds a reference NAME
 * (e.g. `targetEntity: "Task"`); the stamp records the referenced node's
 * stable id on the field's `refId`. Resolve each declared field by id
 * against the id->node index and, if the referenced node's CURRENT name
 * differs from the field's declared `default`, rewrite `default` to the
 * current name — the config-value sibling of
 * {@link resolveEntityTokensById}'s entity-name-token rewrite.
 *
 * Additive + presence-based: no `refId`, a non-reference `type`, or an id
 * unindexed / of the wrong kind leaves the field untouched. `entity`/`trait`/
 * `event` are all indexed by id (events per-trait from `stateMachine.events`),
 * resolving to the node's current name (`entity`/`trait`) or key (`event`).
 */
function resolveConfigRefsById(
  trait: Trait,
  idIndex: Map<string, IdIndexEntry>,
): Trait {
  const schema = trait.config;
  if (!schema) return trait;

  let nextSchema: Record<string, ConfigFieldDeclaration> | undefined;
  const rewrites: { key: string; from: ConfigFieldDeclaration["default"]; to: string }[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!field.refId || !isReferenceConfigType(field.type)) continue;
    const expectedKind = REFERENCE_CONFIG_TYPE_TO_ID_KIND[field.type];
    if (!expectedKind) continue;
    const entry = idIndex.get(field.refId);
    if (!entry || entry.kind !== expectedKind) continue;
    const currentName =
      entry.kind === "entity"
        ? (entry.node as Entity).name
        : entry.kind === "event"
          ? (entry.node as Event).key
          : (entry.node as Trait).name;
    if (!currentName) continue;
    // Preserve the authored VALUE FORM: a trait knob default written as the
    // `@trait.X` binding must stay a binding after the name refresh — the
    // render channel (UISlotRenderer's recursive `@trait.X` walk, embed
    // sidecar routing) keys on the prefix, and stripping it turned
    // std-service-email's standalone default form into a dead text leaf
    // (blank boot). Bare-name defaults (`targetEntity: "Task"`) keep the
    // bare form as before.
    const isTraitBinding =
      entry.kind === "trait" &&
      typeof field.default === "string" &&
      field.default.startsWith("@trait.");
    const nextDefault = isTraitBinding ? `@trait.${currentName}` : currentName;
    if (nextDefault === field.default) continue;
    nextSchema ??= { ...schema };
    nextSchema[key] = { ...field, default: nextDefault };
    rewrites.push({ key, from: field.default, to: nextDefault });
  }
  if (!nextSchema) return trait;

  refResolverLog.info("config-ref:id-resolve", {
    trait: trait.name,
    rewrites,
  });

  return { ...trait, config: nextSchema };
}

function applyEventRenames(
  trait: Trait,
  renames?: { [oldKey: string]: string },
): Trait {
  if (!renames || Object.keys(renames).length === 0) return trait;
  const rename = (k: string | undefined): string | undefined =>
    k !== undefined && k in renames ? renames[k] : k;
  const sm = trait.stateMachine;
  if (!sm) return trait;
  const nextTransitions = (sm.transitions ?? []).map((t) => {
    const nextEvent = rename(t.event) ?? t.event;
    const nextEffects = t.effects
      ? (renameEventsInEffects(t.effects as readonly unknown[], rename) as typeof t.effects)
      : t.effects;
    return { ...t, event: nextEvent, effects: nextEffects };
  });
  const nextEvents = (sm.events ?? []).map((e) => {
    const newKey = rename(e.key);
    if (newKey === e.key) return e;
    return { ...e, key: newKey ?? e.key };
  });
  const nextEmits = (trait.emits ?? []).map((em) => {
    if (typeof em === "string") return rename(em) ?? em;
    const newEvent = rename(em.event);
    return newEvent === em.event ? em : { ...em, event: newEvent ?? em.event };
  });
  return {
    ...trait,
    stateMachine: {
      ...sm,
      transitions: nextTransitions,
      events: nextEvents,
    },
    emits: nextEmits,
  } as Trait;
}

/**
 * Resolve `@config.<knob>` emit-name references (Option B) on a trait to
 * their concrete literals. Effective config per instance = the trait's
 * declared config defaults folded under the call-site override — the same
 * precedence the Rust inline phase and OrbitalServerRuntime's binding merge
 * use. Runs BEFORE `applyEventRenames` (renames target RESOLVED names, per
 * the pinned contract). Standalone (no call site) resolves to the declared
 * default. Unresolvable refs (unknown knob / non-string / no default)
 * surface as errors — mirror of the compiler's ORB_EMIT_CONFIG_REF_INVALID.
 */
export function resolveConfigRefEmitNames(
  trait: Trait,
  callSiteConfig?: TraitConfig,
): { trait: Trait; errors: string[] } {
  const emits = trait.emits ?? [];
  const hasRef = emits.some((em) => configRefEventKnob(em.event) !== undefined);
  if (!hasRef) return { trait, errors: [] };

  const effectiveConfig = {
    ...(normalizeCallSiteConfigToValues(trait.config) ?? {}),
    ...(normalizeCallSiteConfigToValues(callSiteConfig) ?? {}),
  };
  const errors: string[] = [];
  const nextEmits = emits.map((em) => {
    if (configRefEventKnob(em.event) === undefined) return em;
    const result = resolveConfigRefEventName(em.event, trait.config, effectiveConfig);
    if (!result.ok) {
      errors.push(
        `Trait "${trait.name}" emits \`${em.event}\` but the reference is invalid (${result.error}): ` +
          `the knob must be a declared string-typed config field with a default.`,
      );
      return em;
    }
    refResolverLog.debug("emit-config-ref:resolved", {
      trait: trait.name,
      ref: em.event,
      resolved: result.value,
    });
    return { ...em, event: result.value };
  });
  return { trait: { ...trait, emits: nextEmits }, errors };
}

// ============================================================================
// Reference Resolver
// ============================================================================

/**
 * ReferenceResolver - Resolves all references in an orbital.
 */
export class ReferenceResolver {
  private loader: SchemaLoader;
  private options: ResolveOptions;
  private localTraits: Map<string, Trait>;
  /** id-keyed mirror of `localTraits`, populated wherever the trait carries an `id`. */
  private localTraitsById: Map<string, Trait> = new Map();

  /** Import scope of each loaded source orbital, keyed by its source path. */
  private sourceImportsCache: Map<string, ResolvedImports> = new Map();

  private loaderInitialized = false;

  constructor(options: ResolveOptions) {
    this.options = options;
    // Use provided loader; filesystem loader will be created lazily if needed
    this.loader = options.loader as SchemaLoader;
    this.localTraits = options.localTraits ?? new Map();
    for (const trait of this.localTraits.values()) {
      if (trait.id) {
        this.localTraitsById.set(trait.id, trait);
      }
    }
  }

  private async ensureLoader(): Promise<void> {
    if (this.loader || this.loaderInitialized) return;
    this.loaderInitialized = true;
    try {
      const { ExternalOrbitalLoader } = await import("../loader/external-loader.js");
      this.loader = new ExternalOrbitalLoader(this.options);
    } catch {
      // Filesystem loader not available (browser environment)
    }
  }

  /**
   * Resolve all references in an orbital.
   */
  async resolve(
    orbital: OrbitalDefinition,
    sourcePath?: string,
    chain?: ImportChainLike
  ): Promise<ResolveResult<ResolvedOrbital>> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const importChain = chain ?? { push: () => null, pop: () => {}, clone() { return this; } } as ImportChainLike;

    // Step 1: Resolve imports.
    //
    // Skip external loading when the orbital is ALREADY fully resolved — i.e.
    // every trait is an inline definition. A schema produced by `orbital
    // resolve` (the canonical Rust resolver) has all trait refs inlined yet
    // deliberately keeps `uses` as the import-provenance record. Re-loading
    // those imports here is redundant and re-introduces external-loader
    // failures (e.g. std behaviors not found at the runtime's lookup paths)
    // even though nothing in the orbital still references them. Skipping the
    // load leaves `uses` intact (no information lost) and makes preprocessing
    // idempotent over an already-resolved schema.
    const traitsList = orbital.traits ?? [];
    const alreadyResolved =
      traitsList.length > 0 && traitsList.every((t) => isInlineTrait(t));
    const importsResult = alreadyResolved
      ? { success: true as const, data: { orbitals: new Map<string, ResolvedImport>(), idIndex: new Map<string, IdIndexEntry>() }, warnings: [] as string[] }
      : await this.resolveImports(orbital.uses ?? [], sourcePath, importChain);
    if (!importsResult.success) {
      return { success: false, errors: importsResult.errors };
    }
    const imports = importsResult.data;
    // W3b: id->node index spanning this orbital's own inline nodes plus every
    // imported orbital. Built once here (post-import-resolution) so every
    // downstream trait/page lookup can consult it before falling back to
    // name matching.
    imports.idIndex = buildIdIndex(orbital, imports.orbitals);

    // Step 2: Resolve entity
    const entityResult = this.resolveEntity(orbital.entity, imports);
    if (!entityResult.success) {
      errors.push(...entityResult.errors);
    }

    // Step 3: Resolve traits
    const traitsResult = this.resolveTraits(orbital.traits, imports);
    if (!traitsResult.success) {
      errors.push(...traitsResult.errors);
    }

    // Step 4: Resolve pages
    const pagesResult = this.resolvePages(orbital.pages, imports);
    if (!pagesResult.success) {
      errors.push(...pagesResult.errors);
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    // At this point all results are successful (errors array is empty)
    // Use type narrowing to access data safely
    if (!entityResult.success || !traitsResult.success || !pagesResult.success) {
      // This should never happen since we checked errors above
      return { success: false, errors: ['Internal error: unexpected failure state'] };
    }

    // Sibling-trait auto-pull. Runs before the id pass so pulled copies get the
    // same entity/config id resolution every declared trait gets.
    const pullErrors = await this.pullSiblingTraits(traitsResult.data, imports, importChain);
    if (pullErrors.length > 0) {
      return { success: false, errors: pullErrors };
    }

    // V4 leverage-ids — resolve each trait's entity-name tokens by the
    // `entityRefIds` side-map (name → stable id) against the id->node index,
    // so a renamed entity still resolves by id. Additive: traits without the
    // side-map pass through untouched (name path stays authoritative). Runs
    // before splice so spliced hosts carry already-id-resolved entity tokens.
    for (const resolvedTrait of traitsResult.data) {
      resolvedTrait.trait = resolveEntityTokensById(resolvedTrait.trait, imports.idIndex);
      resolvedTrait.trait = resolveConfigRefsById(resolvedTrait.trait, imports.idIndex);
    }

    // Lambda-scope splice — JS twin of the compiler's inline `splice_lambda_
    // trait_refs`. Render-only `@trait.X` refs inside a `["fn", …]` render
    // subtree (data-list `renderItem`, etc.) are spliced in place (wrapper
    // config applied), their emits merged onto the host, and the consumed
    // wrapper dropped from traits + pages. Mutates the resolved arrays.
    try {
      spliceLambdaTraitRefs(traitsResult.data, pagesResult.data);
    } catch (e) {
      if (e instanceof LambdaSpliceError) {
        return { success: false, errors: [e.message] };
      }
      throw e;
    }

    return {
      success: true,
      data: {
        name: orbital.name,
        entity: entityResult.data.entity,
        entitySource: entityResult.data.source,
        traits: traitsResult.data,
        pages: pagesResult.data,
        imports,
        original: orbital,
      },
      warnings,
    };
  }

  /**
   * Resolve `uses` declarations to loaded orbitals.
   */
  private async resolveImports(
    uses: UseDeclaration[],
    sourcePath?: string,
    chain?: ImportChainLike
  ): Promise<ResolveResult<ResolvedImports>> {
    const errors: string[] = [];
    const orbitals = new Map<string, ResolvedImport>();

    if (this.options.skipExternalLoading) {
      return {
        success: true,
        data: { orbitals, idIndex: new Map<string, IdIndexEntry>() },
        warnings: ["External loading skipped"],
      };
    }

    for (const use of uses) {
      // Check for duplicate aliases
      if (orbitals.has(use.as)) {
        errors.push(`Duplicate import alias: ${use.as}`);
        continue;
      }

      // Load the orbital
      await this.ensureLoader();
      if (!this.loader) {
        errors.push(`No loader available to resolve import: ${use.from}`);
        continue;
      }
      const loadResult = await this.loader.loadOrbital(
        use.from,
        undefined,
        sourcePath,
        chain
      );

      if (!loadResult.success) {
        errors.push(`Failed to load "${use.from}" as "${use.as}": ${loadResult.error}`);
        continue;
      }

      orbitals.set(use.as, {
        alias: use.as,
        from: use.from,
        orbital: loadResult.data.orbital,
        orbitals: loadResult.data.orbitals ?? [loadResult.data.orbital],
        sourcePath: loadResult.data.sourcePath,
      });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: { orbitals, idIndex: new Map<string, IdIndexEntry>() }, warnings: [] };
  }

  /**
   * Resolve entity reference.
   */
  private resolveEntity(
    entityRef: EntityRef,
    imports: ResolvedImports
  ): ResolveResult<{
    entity: Entity;
    source?: { alias: string; persistence: "persistent" | "runtime" };
  }> {
    // EntityCall (Phase F): synthesize a placeholder Entity from the call shape.
    // Full inlining is the compiler's job; this resolver returns the local view.
    if (isEntityCall(entityRef)) {
      const fallbackName =
        entityRef.name ?? entityRef.extends.replace(/\.entity$/, "");
      return {
        success: true,
        data: {
          entity: {
            name: fallbackName,
            fields: entityRef.fields ?? [],
            ...(entityRef.persistence
              ? { persistence: entityRef.persistence }
              : {}),
            ...(entityRef.collection ? { collection: entityRef.collection } : {}),
          },
        },
        warnings: [],
      };
    }

    // Inline entity
    if (!isEntityReference(entityRef)) {
      return {
        success: true,
        data: { entity: entityRef },
        warnings: [],
      };
    }

    // Reference: "Alias.entity"
    const parsed = parseEntityRef(entityRef);
    if (!parsed) {
      return {
        success: false,
        errors: [`Invalid entity reference format: ${entityRef}. Expected "Alias.entity"`],
      };
    }

    const imported = imports.orbitals.get(parsed.alias);
    if (!imported) {
      return {
        success: false,
        errors: [
          `Unknown import alias in entity reference: ${parsed.alias}. ` +
            `Available aliases: ${Array.from(imports.orbitals.keys()).join(", ") || "none"}`,
        ],
      };
    }

    // Get entity from imported orbital
    const importedEntity = this.getEntityFromOrbital(imported.orbital);
    if (!importedEntity) {
      return {
        success: false,
        errors: [
          `Imported orbital "${parsed.alias}" does not have an inline entity. ` +
            `Entity references cannot be chained.`,
        ],
      };
    }

    // Determine persistence type
    const persistence = importedEntity.persistence ?? "persistent";

    return {
      success: true,
      data: {
        entity: importedEntity,
        source: {
          alias: parsed.alias,
          persistence: persistence as "persistent" | "runtime",
        },
      },
      warnings: [],
    };
  }

  /**
   * Get the entity from an orbital (handling EntityRef).
   */
  private getEntityFromOrbital(orbital: Orbital): Entity | null {
    const entityRef = orbital.entity;
    if (typeof entityRef === "string") {
      // It's a reference - we don't support chained references
      return null;
    }
    if (isEntityCall(entityRef)) {
      // EntityCall form - synthesize a placeholder Entity from the call shape
      const fallbackName =
        entityRef.name ?? entityRef.extends.replace(/\.entity$/, "");
      return {
        name: fallbackName,
        fields: entityRef.fields ?? [],
        ...(entityRef.persistence
          ? { persistence: entityRef.persistence }
          : {}),
        ...(entityRef.collection ? { collection: entityRef.collection } : {}),
      };
    }
    return entityRef;
  }

  /**
   * Resolve trait references.
   */
  private resolveTraits(
    traitRefs: TraitRef[],
    imports: ResolvedImports
  ): ResolveResult<ResolvedTrait[]> {
    const errors: string[] = [];
    const resolved: ResolvedTrait[] = [];

    for (const traitRef of traitRefs) {
      const result = this.resolveTraitRef(traitRef, imports);
      if (!result.success) {
        errors.push(...result.errors);
      } else {
        resolved.push(result.data!);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: resolved, warnings: [] };
  }

  /**
   * The import scope of an already-loaded orbital, memoised per source path.
   * A sibling that is itself a ref names its target through the SOURCE atom's
   * aliases, so it can only be resolved against those.
   */
  private async importsOfSource(
    imported: ResolvedImport,
    chain: ImportChainLike,
  ): Promise<ResolvedImports | null> {
    const key = imported.sourcePath ?? `${imported.alias}:${imported.from}`;
    const cached = this.sourceImportsCache.get(key);
    if (cached) return cached;
    const result = await this.resolveImports(
      imported.orbital.uses ?? [],
      imported.sourcePath,
      chain,
    );
    if (!result.success) return null;
    result.data.idIndex = buildIdIndex(imported.orbital, result.data.orbitals);
    this.sourceImportsCache.set(key, result.data);
    return result.data;
  }

  /**
   * Sibling-trait auto-pull — the JS twin of the compiler's
   * `phases/inline/trait.rs` pass, appending to `resolved` in place.
   *
   * An atom's main trait embeds its own sub-views as `@trait.<Sibling>` string
   * literals (`std-browse`'s `bodyContent: {children: [@trait.DataGrid1]}`).
   * A consumer that imports only the main trait never instantiates those
   * siblings, so the token dangles: no state machine, no fetch, an empty list
   * where the grid should be. The compiled path materialises them; without this
   * pass the interpreted path did not, so a raw `.orb` handed straight to
   * `OrbitalServerRuntime` rendered a different app than the same `.orb` run
   * through `orbital resolve`.
   *
   * Pulls are keyed per EMBEDDER (`owner` = the top-level consumer trait that
   * started the chain), not per atom. Two rebinds of one atom in one orbital
   * (`ChannelRail -> Channel` and `ChatThread -> ChatMessage`, both std-browse)
   * carry different entity rebinds and different hosts to listen to, so one
   * shared copy can only ever serve one of them. The first owner keeps the
   * source name; later owners pull under `<Owner><Sibling>` — unique by
   * construction, since owner names are unique within the orbital.
   */
  private async pullSiblingTraits(
    resolved: ResolvedTrait[],
    imports: ResolvedImports,
    chain: ImportChainLike,
  ): Promise<string[]> {
    interface PullItem {
      alias: string;
      sibling: string;
      linkedEntity: string | undefined;
      /** Immediate embedder — the trait whose `@trait.X` tokens get repointed. */
      parent: string;
      /** Top-level consumer trait this materialisation belongs to. */
      owner: string;
    }

    const work: PullItem[] = [];
    /** owner → (atom-side name → name it landed under for THIS owner). */
    const ownerSubs = new Map<string, Map<string, string>>();
    const subsFor = (owner: string): Map<string, string> => {
      let m = ownerSubs.get(owner);
      if (!m) {
        m = new Map();
        ownerSubs.set(owner, m);
      }
      return m;
    };

    for (const rt of resolved) {
      if (rt.source.type !== "imported" || !rt.trait.name) continue;
      const owner = rt.trait.name;
      // The atom-side name of the owner itself: a pulled sibling's listens name
      // their host by THAT name, and it has to resolve to this rebind.
      subsFor(owner).set(rt.source.traitName, owner);
      for (const sibling of traitEmbedNamesOf(rt.trait)) {
        work.push({ alias: rt.source.alias, sibling, linkedEntity: rt.linkedEntity, parent: owner, owner });
      }
    }
    if (work.length === 0) return [];

    const errors: string[] = [];
    const consumerDeclared = new Set(resolved.map((r) => r.trait.name).filter(Boolean));
    const seen = new Set(consumerDeclared);
    const visited = new Set<string>();
    const pulledAs = new Map<string, string>();
    /** pulled trait's final name → its owner. */
    const ownerOf = new Map<string, string>();
    /** parent final name → (`@trait.<from>` → `@trait.<to>`) rewrites. */
    const parentRewrites = new Map<string, Map<string, string>>();
    const pulled: ResolvedTrait[] = [];

    const noteRewrite = (parent: string, from: string, to: string): void => {
      let m = parentRewrites.get(parent);
      if (!m) {
        m = new Map();
        parentRewrites.set(parent, m);
      }
      m.set(from, to);
    };

    // LIFO, mirroring the compiler's `worklist.pop()`, so the two paths agree on
    // which owner keeps the bare source name.
    for (let item = work.pop(); item !== undefined; item = work.pop()) {
      const { alias, sibling, linkedEntity, parent, owner } = item;
      const pullKey = `${alias} ${sibling} ${owner}`;
      const existing = pulledAs.get(pullKey);
      if (existing !== undefined) {
        // Already materialised for THIS owner (two traits of one atom embedding
        // the same sub-view). Share it, repointing this parent's tokens.
        if (existing !== sibling) noteRewrite(parent, sibling, existing);
        continue;
      }
      let finalName = sibling;
      if (seen.has(sibling)) {
        // Explicit composition wins — the consumer declared this name itself.
        if (consumerDeclared.has(sibling)) continue;
        finalName = `${owner}${sibling}`;
        // Even the prefixed name is taken by something that is not this pull:
        // leave the token dangling for the validator rather than capture the
        // wrong trait.
        if (seen.has(finalName)) continue;
      }
      if (visited.has(pullKey)) continue;
      visited.add(pullKey);

      const imported = imports.orbitals.get(alias);
      if (!imported) continue;
      // Same-alias siblings only — a `@trait.X` naming anything else is the
      // validator's `ORB_BINDING_TRAIT_UNKNOWN` to report, not ours to guess.
      let atomEntry: Exclude<TraitRef, string> | null = null;
      for (const o of importedOrbitals(imported)) {
        atomEntry = findTraitEntryInOrbital(o, sibling);
        if (atomEntry) break;
      }
      if (!atomEntry) continue;

      let atomTrait: Trait;
      if ("stateMachine" in atomEntry) {
        const { trait: cfgResolved, errors: cfgErrors } = resolveConfigRefEmitNames(
          atomEntry as Trait,
        );
        if (cfgErrors.length > 0) {
          errors.push(...cfgErrors);
          continue;
        }
        atomTrait = cfgResolved;
      } else {
        // The sibling is itself a REF inside the source atom (`trait DenseTableView
        // = TableView.traits.TableViewRender -> BrowseItem {…}` — the shape every
        // std-browse sub-view uses). Resolve it in the SOURCE orbital's import
        // scope, never the consumer's: the alias `TableView` means something only
        // there. The compiler gets this for free by inlining bottom-up.
        const srcImports = await this.importsOfSource(imported, chain);
        if (!srcImports) continue;
        const refObj = atomEntry as {
          ref: string;
          refId?: TraitId;
          name?: string;
          config?: TraitConfig;
          linkedEntity?: string;
          events?: { [oldKey: string]: string };
          listens?: TraitEventListener[];
        };
        const nested = this.resolveTraitRefString(
          refObj.ref,
          srcImports,
          refObj.config,
          refObj.linkedEntity,
          refObj.name ?? sibling,
          refObj.events,
          refObj.listens,
          refObj.refId,
        );
        if (!nested.success) {
          errors.push(...nested.errors);
          continue;
        }
        atomTrait = nested.data.trait;
      }

      const embedder =
        resolved.find((r) => r.trait.name === parent)?.trait ??
        pulled.find((r) => r.trait.name === parent)?.trait;
      let copy = resolveForwardedSiblingConfig(
        applyLinkedEntityRename(atomTrait, linkedEntity),
        embedder,
      );
      if (finalName !== sibling) {
        copy = { ...copy, name: finalName };
        noteRewrite(parent, sibling, finalName);
      }

      // Recurse with THIS copy as the parent but the SAME owner, so a sibling's
      // own sub-views stay inside the owner's materialisation.
      for (const next of traitEmbedNamesOf(copy)) {
        work.push({ alias, sibling: next, linkedEntity, parent: finalName, owner });
      }

      pulledAs.set(pullKey, finalName);
      subsFor(owner).set(sibling, finalName);
      ownerOf.set(finalName, owner);
      seen.add(finalName);
      pulled.push({
        trait: copy,
        source: { type: "imported", alias, traitName: sibling },
        ...(linkedEntity !== undefined ? { linkedEntity } : {}),
      });
    }

    if (pulled.length === 0 && parentRewrites.size === 0) return errors;

    // Repoint each parent's `@trait.X` tokens at the copy it actually owns.
    const applyRewrites = (rt: ResolvedTrait): void => {
      const subs = rt.trait.name ? parentRewrites.get(rt.trait.name) : undefined;
      if (subs) rt.trait = renameTraitEmbeds(rt.trait, subs);
    };
    for (const rt of resolved) applyRewrites(rt);
    for (const rt of pulled) applyRewrites(rt);

    // A pulled copy's source-scoped listens name its host and co-siblings by
    // their ATOM names; resolve them through ITS OWNER's map. `traitId` is
    // id-first in `buildSourceMatcher`, so it has to follow the name to the
    // local declaration or the subscription matches nothing.
    const idByName = new Map<string, TraitId | undefined>();
    for (const rt of [...resolved, ...pulled]) {
      if (rt.trait.name) idByName.set(rt.trait.name, rt.trait.id);
    }
    for (const rt of pulled) {
      const listens = rt.trait.listens;
      const owner = rt.trait.name ? ownerOf.get(rt.trait.name) : undefined;
      const subs = owner ? ownerSubs.get(owner) : undefined;
      if (!listens || listens.length === 0 || !subs) continue;
      let changed = false;
      const nextListens = listens.map((listen) => {
        const source = listen.source;
        if (!source || source.kind !== "trait") return listen;
        const target = subs.get(source.trait);
        if (target === undefined || target === source.trait) return listen;
        changed = true;
        const traitId = idByName.get(target);
        return {
          ...listen,
          source: { kind: "trait" as const, trait: target, ...(traitId ? { traitId } : {}) },
        };
      });
      if (changed) rt.trait = { ...rt.trait, listens: nextListens };
    }

    refResolverLog.info("sibling-pull", {
      pulled: pulled.map((p) => ({
        trait: p.trait.name,
        owner: p.trait.name ? ownerOf.get(p.trait.name) : undefined,
        linkedEntity: p.linkedEntity ?? p.trait.linkedEntity,
      })),
    });
    resolved.push(...pulled);
    return errors;
  }

  /**
   * Resolve a single trait reference.
   */
  private resolveTraitRef(
    traitRef: TraitRef,
    imports: ResolvedImports
  ): ResolveResult<ResolvedTrait> {
    // Case 1: Inline trait definition. Emit-name `@config.<knob>` refs
    // resolve against the trait's own declared defaults (standalone
    // semantics — no call site exists here).
    if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
      const { trait: resolvedInline, errors } = resolveConfigRefEmitNames(traitRef as Trait);
      if (errors.length > 0) {
        return { success: false, errors };
      }
      return {
        success: true,
        data: {
          trait: resolvedInline,
          source: { type: "inline" },
        },
        warnings: [],
      };
    }

    // Case 2: Reference object { ref: "...", name?, config?, linkedEntity?, events?, listens? }
    // `events` is the call-site rename map ({ OLD: NEW, ... }). Every mention
    // of an old key inside the resolved trait's state machine (transition
    // triggers, events list entries, emits) is rewritten to the new key.
    // Without this, buttons in a molecule that dispatch the renamed event
    // (e.g. `ADD_ITEM` instead of the atom's internal `OPEN`) fire into a
    // trait whose state machine still only knows the old trigger, and the
    // transition silently fails to fire.
    //
    // `listens` is the Phase F.7 override: replace the imported trait's
    // `listens` array entirely with the call-site list. Required for
    // ref-based traits that need cross-trait subscription wiring (e.g.
    // CartItemAddItem listening to CartItemCartBrowse.ADD_ITEM); without
    // it the atom's empty listens flow through and the bus subscription
    // is never set up.
    if (typeof traitRef !== "string" && "ref" in traitRef) {
      const refObj = traitRef as {
        ref: string;
        refId?: TraitId;
        name?: string;
        config?: TraitConfig;
        linkedEntity?: string;
        events?: { [oldKey: string]: string };
        listens?: TraitEventListener[];
      };
      return this.resolveTraitRefString(
        refObj.ref,
        imports,
        refObj.config,
        refObj.linkedEntity,
        refObj.name,
        refObj.events,
        refObj.listens,
        refObj.refId,
      );
    }

    // Case 3: String reference
    if (typeof traitRef === "string") {
      return this.resolveTraitRefString(traitRef, imports);
    }

    return {
      success: false,
      errors: [`Unknown trait reference format: ${JSON.stringify(traitRef)}`],
    };
  }

  /**
   * Resolve a trait reference string.
   */
  private resolveTraitRefString(
    ref: string,
    imports: ResolvedImports,
    config?: TraitConfig,
    linkedEntity?: string,
    overrideName?: string,
    eventRenames?: { [oldKey: string]: string },
    listensOverride?: TraitEventListener[],
    refId?: TraitId,
  ): ResolveResult<ResolvedTrait> {
    // Check if it's an imported trait reference: "Alias.traits.TraitName"
    const parsed = parseImportedTraitRef(ref);

    if (parsed) {
      // Imported trait
      const imported = imports.orbitals.get(parsed.alias);
      if (!imported) {
        return {
          success: false,
          errors: [
            `Unknown import alias in trait reference: ${parsed.alias}. ` +
              `Available aliases: ${Array.from(imports.orbitals.keys()).join(", ") || "none"}`,
          ],
        };
      }

      // Find the trait in the imported orbital — id-primary: prefer the
      // ref's `refId` against the id index, falling back to the existing
      // name match when the id is absent or unindexed.
      // Search every orbital of the behavior — a trait name is unique across
      // one behavior's orbitals by convention, first match wins (same policy
      // as the compiled path's `get_trait`).
      let trait: Trait | null = null;
      for (const o of importedOrbitals(imported)) {
        trait = this.findTraitInOrbital(o, parsed.traitName, refId, imports.idIndex);
        if (trait) break;
      }
      if (!trait) {
        const available = importedOrbitals(imported).flatMap((o) => this.listTraitsInOrbital(o));
        return {
          success: false,
          errors: [
            `Trait "${parsed.traitName}" not found in imported orbital "${parsed.alias}". ` +
              `Available traits: ${available.join(", ") || "none"}`,
          ],
        };
      }

      // Rename the resolved trait if the call site declared one. Molecules
      // use this to give an imported atom a domain-specific local name
      // (e.g. `std-search`'s `SearchResultSearch` renamed to
      // `FilteredItemSearch` inside `std-filtered-list`). Without the
      // rename, `@trait.FilteredItemSearch` substrings in render-ui
      // patterns would fail to resolve because the trait index keys
      // would still hold the atom's original name.
      const baseTrait: Trait = overrideName
        ? { ...trait, name: overrideName }
        : trait;
      // Emit-name config refs resolve BEFORE event renames so a call-site
      // `events={...}` rename map targets the RESOLVED event names.
      const { trait: configResolvedTrait, errors: configRefErrors } =
        resolveConfigRefEmitNames(baseTrait, config);
      if (configRefErrors.length > 0) {
        return { success: false, errors: configRefErrors };
      }
      const reboundTrait = applyLinkedEntityRename(configResolvedTrait, linkedEntity);
      const renamedTrait = applyEventRenames(reboundTrait, eventRenames);
      const finalTrait: Trait = listensOverride !== undefined
        ? { ...renamedTrait, listens: listensOverride }
        : renamedTrait;
      if (listensOverride !== undefined) {
        refResolverLog.info("listens-override:imported", {
          trait: finalTrait.name,
          ref,
          atomListens: trait.listens?.length ?? 0,
          callSiteListens: listensOverride.length,
        });
      }

      return {
        success: true,
        data: {
          trait: finalTrait,
          source: { type: "imported", alias: parsed.alias, traitName: parsed.traitName },
          config,
          linkedEntity,
        },
        warnings: [],
      };
    }

    // Local trait (from localTraits map) — id-primary: prefer the id-keyed
    // map when the ref carries a `refId`, else the existing name-keyed map.
    const localTrait = (refId && this.localTraitsById.get(refId)) ?? this.localTraits.get(ref);
    if (localTrait) {
      const baseLocal: Trait = overrideName
        ? { ...localTrait, name: overrideName }
        : localTrait;
      const { trait: configResolvedLocal, errors: localConfigRefErrors } =
        resolveConfigRefEmitNames(baseLocal, config);
      if (localConfigRefErrors.length > 0) {
        return { success: false, errors: localConfigRefErrors };
      }
      const reboundLocal = applyLinkedEntityRename(configResolvedLocal, linkedEntity);
      const renamedLocalTrait = applyEventRenames(reboundLocal, eventRenames);
      const finalLocalTrait: Trait = listensOverride !== undefined
        ? { ...renamedLocalTrait, listens: listensOverride }
        : renamedLocalTrait;
      if (listensOverride !== undefined) {
        refResolverLog.info("listens-override:local", {
          trait: finalLocalTrait.name,
          ref,
          atomListens: localTrait.listens?.length ?? 0,
          callSiteListens: listensOverride.length,
        });
      }
      return {
        success: true,
        data: {
          trait: finalLocalTrait,
          source: { type: "local", name: ref },
          config,
          linkedEntity,
        },
        warnings: [],
      };
    }

    return {
      success: false,
      errors: [
        `Trait "${ref}" not found. ` +
          `For imported traits, use format "Alias.traits.TraitName". ` +
          `Local traits available: ${Array.from(this.localTraits.keys()).join(", ") || "none"}`,
      ],
    };
  }

  /**
   * Find a trait in an orbital by name. Id-primary: when the calling ref
   * carries a `refId` and the id index has a matching trait entry, return it
   * directly — else fall back to the existing name match unchanged.
   */
  private findTraitInOrbital(
    orbital: Orbital,
    traitName: string,
    refId?: TraitId,
    idIndex?: Map<string, IdIndexEntry>,
  ): Trait | null {
    if (refId && idIndex) {
      const entry = idIndex.get(refId);
      if (entry && entry.kind === "trait") {
        return entry.node as Trait;
      }
    }
    for (const traitRef of orbital.traits) {
      // Inline trait
      if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
        if ((traitRef as Trait).name === traitName) {
          return traitRef as Trait;
        }
      }
      // Reference with name
      if (typeof traitRef !== "string" && "ref" in traitRef) {
        const refObj = traitRef as { ref?: string; name?: string };
        if (refObj.ref === traitName || refObj.name === traitName) {
          // This is a reference, not an inline definition
          // We can't return it directly - need to look up in local traits
          // For now, skip these
        }
      }
    }
    return null;
  }

  /**
   * List trait names in an orbital.
   */
  private listTraitsInOrbital(orbital: Orbital): string[] {
    const names: string[] = [];
    for (const traitRef of orbital.traits) {
      if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
        names.push((traitRef as Trait).name);
      }
    }
    return names;
  }

  /**
   * Resolve page references.
   */
  private resolvePages(
    pageRefs: PageRef[],
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage[]> {
    const errors: string[] = [];
    const resolved: ResolvedPage[] = [];

    for (const pageRef of pageRefs) {
      const result = this.resolvePageRef(pageRef, imports);
      if (!result.success) {
        errors.push(...result.errors);
      } else {
        resolved.push(result.data!);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: resolved, warnings: [] };
  }

  /**
   * Resolve a single page reference.
   */
  private resolvePageRef(
    pageRef: PageRef,
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage> {
    // Case 1: Inline page definition
    if (!isPageReference(pageRef)) {
      return {
        success: true,
        data: {
          page: pageRef as Page,
          source: { type: "inline" },
          pathOverridden: false,
        },
        warnings: [],
      };
    }

    // Case 2: String reference "Alias.pages.PageName"
    if (isPageReferenceString(pageRef)) {
      return this.resolvePageRefString(pageRef, imports);
    }

    // Case 3: Object reference { ref: "Alias.pages.PageName", path?: "/override" }
    if (isPageReferenceObject(pageRef)) {
      return this.resolvePageRefObject(pageRef, imports);
    }

    return {
      success: false,
      errors: [`Unknown page reference format: ${JSON.stringify(pageRef)}`],
    };
  }

  /**
   * Resolve a page reference string.
   */
  private resolvePageRefString(
    ref: string,
    imports: ResolvedImports,
    refId?: PageId,
  ): ResolveResult<ResolvedPage> {
    const parsed = parsePageRef(ref);
    if (!parsed) {
      return {
        success: false,
        errors: [`Invalid page reference format: ${ref}. Expected "Alias.pages.PageName"`],
      };
    }

    const imported = imports.orbitals.get(parsed.alias);
    if (!imported) {
      return {
        success: false,
        errors: [
          `Unknown import alias in page reference: ${parsed.alias}. ` +
            `Available aliases: ${Array.from(imports.orbitals.keys()).join(", ") || "none"}`,
        ],
      };
    }

    // Id-primary: prefer `refId` against the id index, falling back to the
    // existing name match when the id is absent or unindexed.
    // Pages, like traits, may live in any orbital of a multi-orbital behavior.
    let page: Page | null = null;
    for (const o of importedOrbitals(imported)) {
      page = this.findPageInOrbital(o, parsed.pageName, refId, imports.idIndex);
      if (page) break;
    }
    if (!page) {
      const available = importedOrbitals(imported).flatMap((o) => this.listPagesInOrbital(o));
      return {
        success: false,
        errors: [
          `Page "${parsed.pageName}" not found in imported orbital "${parsed.alias}". ` +
            `Available pages: ${available.join(", ") || "none"}`,
        ],
      };
    }

    return {
      success: true,
      data: {
        page,
        source: { type: "imported", alias: parsed.alias, pageName: parsed.pageName },
        pathOverridden: false,
      },
      warnings: [],
    };
  }

  /**
   * Resolve a page reference object with optional path override.
   */
  private resolvePageRefObject(
    refObj: PageRefObject,
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage> {
    const baseResult = this.resolvePageRefString(refObj.ref, imports, refObj.refId);
    if (!baseResult.success) {
      return baseResult;
    }

    const resolved = baseResult.data!;

    // Apply path override if provided
    if (refObj.path) {
      const originalPath = resolved.page.path;
      resolved.page = {
        ...resolved.page,
        path: refObj.path,
      };
      resolved.pathOverridden = true;
      resolved.originalPath = originalPath;
    }

    return {
      success: true,
      data: resolved,
      warnings: baseResult.warnings,
    };
  }

  /**
   * Find a page in an orbital by name. Id-primary: when the calling ref
   * carries a `refId` and the id index has a matching page entry, return it
   * directly — else fall back to the existing name match unchanged.
   */
  private findPageInOrbital(
    orbital: Orbital,
    pageName: string,
    refId?: PageId,
    idIndex?: Map<string, IdIndexEntry>,
  ): Page | null {
    if (refId && idIndex) {
      const entry = idIndex.get(refId);
      if (entry && entry.kind === "page") {
        return { ...(entry.node as Page) };
      }
    }
    const pages = orbital.pages;
    if (!pages) return null;

    for (const pageRef of pages) {
      // Only look at inline pages (we don't support chained page references)
      if (typeof pageRef !== "string" && !("ref" in pageRef)) {
        const page = pageRef as Page;
        if (page.name === pageName) {
          // Return a copy to avoid mutation issues
          return { ...page };
        }
      }
    }
    return null;
  }

  /**
   * List page names in an orbital.
   */
  private listPagesInOrbital(orbital: Orbital): string[] {
    const pages = orbital.pages;
    if (!pages) return [];

    const names: string[] = [];
    for (const pageRef of pages) {
      if (typeof pageRef !== "string" && !("ref" in pageRef)) {
        names.push((pageRef as Page).name);
      }
    }
    return names;
  }

  /**
   * Add local traits for resolution.
   */
  addLocalTraits(traits: Trait[]): void {
    for (const trait of traits) {
      this.localTraits.set(trait.name, trait);
      if (trait.id) {
        this.localTraitsById.set(trait.id, trait);
      }
    }
  }

  /**
   * Clear loader cache.
   */
  clearCache(): void {
    this.loader?.clearCache();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a reference resolver with sensible defaults.
 */
export function createResolver(
  basePath: string,
  options?: Partial<ResolveOptions>
): ReferenceResolver {
  return new ReferenceResolver({
    basePath,
    ...options,
  });
}

// ============================================================================
// Schema Resolution
// ============================================================================

/**
 * Resolve all references in an OrbitalSchema.
 */
export async function resolveSchema(
  schema: OrbitalSchema,
  options: ResolveOptions
): Promise<ResolveResult<ResolvedOrbital[]>> {
  const resolver = new ReferenceResolver(options);
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedOrbital[] = [];

  // Collect all inline traits from all orbitals for local trait resolution
  for (const orbital of schema.orbitals) {
    const inlineTraits = orbital.traits.filter(
      (t): t is Trait => typeof t !== "string" && "stateMachine" in t
    );
    resolver.addLocalTraits(inlineTraits);
  }

  // Resolve each orbital
  for (const orbital of schema.orbitals) {
    const result = await resolver.resolve(orbital);
    if (!result.success) {
      errors.push(`Orbital "${orbital.name}": ${result.errors.join(", ")}`);
    } else {
      resolved.push(result.data);
      warnings.push(...result.warnings.map((w) => `Orbital "${orbital.name}": ${w}`));
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, data: resolved, warnings };
}
