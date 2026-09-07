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
  OrbitalRefObject,
  EntityRef,
  PageRef,
  PageRefObject,
  Entity,
  EntityField,
  Event,
  Page,
  PageTraitRef,
  Trait,
  TraitRef,
  TraitConfig,
  TraitEventListener,
  OrbitalSchema,
  UseDeclaration,
  PatternConfig,
  OrbitalId,
  TraitId,
  EntityId,
  PageId,
  ConfigFieldDeclaration,
  ConfigFieldItemsDeclaration,
  DeclaredTraitConfig,
  TraitConfigValue,
  CallSiteConfig,
  IdKind,
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
  parseOrbitalRef,
  isInlineTrait,
  configRefEventKnob,
  eventListPropsOf,
  resolveConfigRefEventName,
  normalizeCallSiteConfigToValues,
  isCallSiteConfigDeclaration,
  isReferenceConfigType,
  overrideDeclaredKnobs,
  deriveId,
  idPrefix,
  asTraitId,
  asEntityId,
  asOrbitalId,
  asPageId,
} from "@almadar/core";
import { identityEntitiesOf, roleVocabularyOf } from "@almadar/core/mock";
import type {
  LoaderOptions,
} from "../loader/external-loader.js";
import type {
  SchemaLoader,
  ImportChainLike,
} from "../loader/schema-loader.js";
import { createLogger } from '@almadar/logger';
import { spliceLambdaTraitRefs, LambdaSpliceError } from "../ui/splice-lambda-traits.js";
import { resolveOrbitalTypeParamSentinels } from "./sentinel-resolution.js";

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
      // event by identity rather than by name.
      //
      // ⚠️ It does NOT resolve to the post-rename key, which an earlier
      // version of this comment claimed. The index is built from the SOURCE
      // orbital's nodes, and `applyEventRenames` rebuilds `{...e, key}`
      // copies rather than mutating them, so the indexed `EventDefinition`
      // keeps its pre-rename `key` forever. Today that is inert rather than
      // wrong — nothing renamed the knob default either, so
      // `resolveConfigRefsById` finds `nextDefault === field.default` and
      // bails — but the two facts are independent, and a future change that
      // folds renames into the index's inputs without also re-indexing would
      // silently resurrect the divergence. Re-index after the rename, or
      // resolve through the renamed trait, before relying on the key here.
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

  /**
   * The imported behavior's own declared app-level `config {}` (ledger (b)),
   * folded with this `uses … { config }` call site's override via
   * {@link overrideDeclaredKnobs} — the same fold `materializeOrbitalRef`
   * applies to an `orbital X = Alias.orbitals.Y { config }` override (Rust
   * twin `inline/mod.rs:776-800`). Omitted (never `undefined`-valued) when
   * the loaded schema declares no config at all. A sibling pulled from this
   * import resolves its `@config.<knob>` schema rung against THIS, never
   * `this.schemaConfig` (the CONSUMER's own app-level config).
   */
  schemaConfig?: DeclaredTraitConfig;

  /**
   * This alias's OWN file, pre-resolved to completion — its own `uses`
   * (recursively), its own trait refs, its own sibling pulls (LIFO,
   * immediate-parent dedup key), its own entity-ref-id rebinds — BEFORE
   * this consumer folds or pulls from it. JS twin of Rust's per-`uses`
   * recursive `inline_orbital` call (`orbital-compiler/src/phases/inline/
   * mod.rs:1001-1013`, `for inlined_orbital in &mut inlined_orbitals {
   * inline_orbital(...) }`, run ahead of `ctx.add_alias_multi` registering
   * the alias) — critical for a sibling-pull name collision that is a
   * genuine top-level peer collision INSIDE the imported file itself
   * (`std-approval-request.orb`'s `InlineBrowseItemBrowse6`/`…10`, both
   * `ref: Dense.traits.BrowseItemBrowse`, both embedding `@trait.
   * DataGrid1` — see {@link ReferenceResolver.pullSiblingTraits}'s
   * drain-order comment for the full trace). Built by
   * {@link ReferenceResolver.preResolveImportFile}, cached per absolute
   * source path there so a file reached through multiple aliases (or
   * multiple `uses` sites) resolves once. `undefined` when pre-resolution
   * failed or was skipped (best-effort — `skipExternalLoading` test mode,
   * or a file whose own resolve() errored) — callers fall back to the
   * pre-existing raw-ref walk ({@link orbitals}) exactly as before this
   * field existed.
   */
  resolvedOrbitals?: ResolvedOrbital[];
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

  /**
   * (C) Auxiliary entities SURFACED by sibling-pull resolution — an
   * un-rebound (or cross-alias-rebound) pulled sibling's own bound entity,
   * carried forward per-orbital (compiled twin: `pulled_aux_entities`,
   * merged into `Orbital.auxiliary_entities` post-`inline_traits`).
   * Deduped against `entity` and the ORIGINAL `original.auxiliaryEntities`
   * by `resolve()`. Distinct from `original.auxiliaryEntities` — this is
   * the DERIVED, resolution-time set an orbital-import reference (`orbital
   * X = Alias.orbitals.Y { … }`) reads to prefix-rename the FULL closure,
   * mirroring the compiled path's in-place `Orbital.auxiliary_entities`
   * mutation. Absent (not `[]`) when nothing was carried.
   */
  auxiliaryEntities?: Entity[];

  /** Resolved pages (references expanded with path overrides applied) */
  pages: ResolvedPage[];

  /** Resolved imports */
  imports: ResolvedImports;

  /** Original orbital definition */
  original: OrbitalDefinition;
}

/** {@link ReferenceResolver.pullSiblingTraits}'s return shape. */
interface PullSiblingTraitsResult {
  readonly errors: string[];
  /** (C) aux-entity carry — see {@link ResolvedOrbital.auxiliaryEntities}. */
  readonly auxEntities: Entity[];
  /**
   * Every pulled sibling's FINAL (post owner-scoped disambiguation) trait
   * name, for {@link ReferenceResolver.uniquifyCrossOrbitalPulledSiblings}'s
   * schema-wide pass — JS twin of Rust's `pulled_by_orbital` (`inline/mod.
   * rs`), which the same schema-wide pass reads to know WHICH of an
   * orbital's declared trait names came from a sibling pull (only those are
   * eligible for the orbital-prefix rename; an explicitly-authored trait
   * ref never is).
   */
  readonly pulledNames: ReadonlySet<string>;
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

  /**
   * The import scope (`ResolvedImports` + alias) this trait's OWN
   * `@trait.<Sibling>` embeds resolve against — set only for `source.type
   * === "imported"`. Defaults to `{imports, alias: source.alias}` (the
   * scope THIS call resolved the ref against), but a nested ref
   * ({@link ReferenceResolver.resolveTraitEntry}'s ref branch, e.g. an io
   * atom's own trait entry pointing at a THIRD alias inside a std atom's
   * `uses`) resolves the CONCRETE trait definition against a DIFFERENT,
   * deeper import scope than the alias the outer ref named — `source.alias`
   * still reports the outer alias (existing provenance contract), so
   * {@link ReferenceResolver.pullSiblingTraits} reads `embedScope` instead
   * when searching for this trait's own further siblings. Absent for
   * `inline`/`local` traits and for an id-index hit (no ref chain to trace).
   */
  embedScope?: { readonly imports: ResolvedImports; readonly alias: string };

  /**
   * C1-J3: this trait REFERENCE's own call-site `:: p SomeType` type-arg
   * map (`TraitReference.typeArgs`), carried through unresolved — the twin
   * of Rust's `trait_def.type_args`, stashed at the same trait-ref
   * resolution point and consumed once per orbital by
   * {@link resolveOrbitalTypeParamSentinels} against the orbital's FINAL
   * (post sibling-pull) entity set. Absent when the reference declared no
   * `typeArgs`.
   */
  typeArgs?: Record<string, string>;
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

  /** The schema's declared `config {}` — the outermost rung of the forwarded-config chain (§4.5). */
  schemaConfig?: DeclaredTraitConfig;
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
  // The node's own `type:` selects which pattern's prop metadata applies —
  // the same discriminator the compiled path reads (`inline/rewrite.rs`).
  const rawType = (obj as { type?: unknown }).type;
  const patternType = typeof rawType === "string" ? rawType : undefined;
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
    // Descriptor arrays (`actions`, `itemActions`, `topBarActions`, …). Which
    // props carry events, and WHICH member of each descriptor holds the event,
    // are facts the pattern registry owns — read them, never re-list them here.
    // A hardcoded `actions`/`itemActions` allowlist with a hardcoded `event`
    // member used to stand in for this, and it silently missed every other
    // event-list prop (`dashboard-layout.topBarActions`,
    // `swipeable-row.leftActions`/`rightActions`, `breadcrumb.items`) as well
    // as any prop whose carrier is not literally named `event`.
    const eventField = patternType !== undefined ? eventListPropsOf(patternType).get(key) : undefined;
    if (eventField !== undefined && Array.isArray(value)) {
      const rewrittenArray = value.map((entry): unknown => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const action = entry as { [k: string]: unknown };
        const current = action[eventField];
        if (typeof current === "string" && !current.startsWith("@")) {
          return { ...action, [eventField]: rename(current) ?? current };
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
 * Rename event names inside a config VALUE, driven by the knob's declared
 * item schema: a member whose declared type is `event` holds an event-name
 * REFERENCE, so a call-site `events {}` rename must rewrite it.
 *
 * Type-directed, never name-directed — the member may be called anything, and
 * a member named `event` that is NOT declared `event`-typed is left alone.
 * Mirrors the compiled path's knob-level fold (`inline/trait.rs`), which
 * enforces the same invariant for scalar `event`-typed knobs.
 */
function renameEventTypedMembers(
  value: unknown,
  items: ConfigFieldItemsDeclaration | undefined,
  rename: (k: string | undefined) => string | undefined,
): unknown {
  if (items === undefined || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => renameEventTypedMembers(entry, items, rename));
  }
  if (typeof value !== "object") return value;
  const properties = items.properties;
  if (properties === undefined) return value;
  const entry = value as { [k: string]: unknown };
  const next: { [k: string]: unknown } = { ...entry };
  let touched = false;
  for (const [member, decl] of Object.entries(properties)) {
    const current = entry[member];
    if (decl.type === "event") {
      // `@`-bindings resolve elsewhere; "" is the default-off outlet.
      if (typeof current === "string" && current !== "" && !current.startsWith("@")) {
        const renamed = rename(current);
        if (renamed !== undefined && renamed !== current) {
          next[member] = renamed;
          touched = true;
        }
      }
      continue;
    }
    // Arrays/objects of objects nest — a descriptor can hold descriptors.
    if (decl.items !== undefined && current !== undefined) {
      const nested = renameEventTypedMembers(current, decl.items, rename);
      if (nested !== current) {
        next[member] = nested;
        touched = true;
      }
    }
  }
  return touched ? next : value;
}

/**
 * Fold a rename across a trait's DECLARED config knob defaults. The literals
 * a render-ui node forwards as `actions: "@config.actions"` live here, not in
 * the effect tree, so the effect walk never reaches them — the runtime twin of
 * SCAN-DETAIL-PANEL-ACTIONS-UNTAGGED-1.
 */
function renameEventsInDeclaredConfig(
  config: Trait["config"],
  rename: (k: string | undefined) => string | undefined,
): Trait["config"] {
  if (config === undefined) return config;
  let touched = false;
  const next: { [k: string]: ConfigFieldDeclaration } = {};
  for (const [knob, field] of Object.entries(config)) {
    if (field.default === undefined) {
      next[knob] = field;
      continue;
    }
    // A knob declared `: event` is itself a reference (the scalar case);
    // otherwise descend into its item schema for `event`-typed members.
    const renamedDefault =
      field.type === "event"
        ? (typeof field.default === "string" && field.default !== "" && !field.default.startsWith("@")
            ? (rename(field.default) ?? field.default)
            : field.default)
        : renameEventTypedMembers(field.default, field.items, rename);
    if (renamedDefault !== field.default) {
      next[knob] = { ...field, default: renamedDefault as ConfigFieldDeclaration["default"] };
      touched = true;
    } else {
      next[knob] = field;
    }
  }
  return touched ? next : config;
}

/**
 * Rewrite event names inside an effects SExpr array. Recursively walks
 * every effect node through {@link renameEventRefsInNode} — mirroring the
 * event arms of the compiled path's `rewrite_identifiers`.
 */
function renameEventsInEffects(
  effects: readonly unknown[],
  rename: (k: string | undefined) => string | undefined,
): unknown[] {
  return effects.map((effect) => renameEventRefsInNode(effect, rename));
}

/**
 * Recursive event-name rewrite over an effect/expression tree. Mirrors
 * the compiled path (`orbital-compiler` `inline/rewrite.rs`):
 *   - `["emit", "OLD", ...]` — position-1 event head (bare and payload
 *     forms; the walk continues into the tail). Skipping these left a
 *     composed atom's `(emit OLD …)` firing the pre-rename name while
 *     every listener subscribed the renamed key — renamed cascades never
 *     delivered on the runtime path (R-CLIENT-RENAMED-CASCADE-DEAD).
 *   - any object `emit: "OLD"` or `emit: { success: "OLD", ... }` option
 *     map on fetch/persist/call-service/ref effects.
 *   - `["render-ui", slot, config, ...]` — user-dispatchable event-name
 *     props inside the config via {@link renameEventsInRenderUiConfig}.
 * Only `emit` positions are rewritten, so guard/comparison strings are
 * never touched.
 */
/**
 * Emit-option map slot keys that carry event names — fetch/persist/
 * call-service/ref/os-watch/set effects. Mirrors the compiled path's
 * emit-map arm (`inline/rewrite.rs`).
 */
const EMIT_OPTION_SLOTS = new Set(["success", "failure", "on_message", "on_change"]);

function renameEventRefsInNode(
  node: unknown,
  rename: (k: string | undefined) => string | undefined,
): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    if (node[0] === "render-ui" && node.length >= 3) {
      const nextConfig = renameEventsInRenderUiConfig(node[2], rename);
      return [
        node[0],
        node[1],
        nextConfig,
        ...node.slice(3).map((x) => renameEventRefsInNode(x, rename)),
      ];
    }
    const out = node.map((x) => renameEventRefsInNode(x, rename));
    if (node[0] === "emit" && typeof node[1] === "string") {
      out[1] = rename(node[1]) ?? node[1];
    }
    return out;
  }
  if (typeof node === "object") {
    const obj = node as { [k: string]: unknown };
    const next: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "emit") {
        if (typeof v === "string") {
          next[k] = rename(v) ?? v;
        } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          // Only the declared emit-slot keys carry event names (the same
          // slot-key universe as the compiled path's emit-map arm) — other
          // values recurse normally so a rename key can never clobber an
          // arbitrary string that merely sits inside an emit map.
          const slots: { [k: string]: unknown } = {};
          for (const [slot, slotV] of Object.entries(v as { [k: string]: unknown })) {
            slots[slot] =
              EMIT_OPTION_SLOTS.has(slot) && typeof slotV === "string"
                ? (rename(slotV) ?? slotV)
                : renameEventRefsInNode(slotV, rename);
          }
          next[k] = slots;
        } else {
          next[k] = renameEventRefsInNode(v, rename);
        }
        continue;
      }
      next[k] = renameEventRefsInNode(v, rename);
    }
    return next;
  }
  return node;
}

/**
 * Apply a call-site `events: { OLD: NEW, ... }` rename map to a resolved
 * trait. Rewrites every mention of an old key in:
 *   - `stateMachine.transitions[].event` (the trigger)
 *   - `stateMachine.transitions[].effects[]` and `ticks[].effects[]`:
 *     `(emit OLD …)` heads, `emit:` option maps on fetch/persist/
 *     call-service/ref effects, and render-ui button / action /
 *     itemAction / submitEvent / cancelEvent / onX event-name props
 *   - `stateMachine.events[].key` + `.name` (humanized display)
 *   - `emits[].event`
 *   - `listens[].triggers` (this trait's own transition event) and
 *     `listens[].event` for UNSOURCED/`any` listens only
 *
 * Does NOT rewrite a SOURCED `listens[].event` (kind trait/orbital): that
 * entry names an event in the SOURCE trait's vocabulary and follows the
 * source trait's own renames, not this call site's.
 *
 * Parity: the compiled path rewrites all of the above at compose time
 * (`orbital-compiler` `inline/rewrite.rs` — `rewrite_identifiers` +
 * `rewrite_trait_event_fields`), so the runtime must produce the same
 * fully-renamed trait at registration time.
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
 * Rewrite a bare `@<EntityName>.<rest>` (or `@<EntityName>[...]`) BINDING
 * token's entity-name root anywhere it appears in a value tree — the
 * `entities {}` sibling of {@link renameTraitEmbedsInValue}'s `@trait.X`
 * rewrite. No fixed prefix to check against (unlike `@trait.`): any `@`-led
 * string's first segment is looked up in `entitySubs` directly, which is
 * safe without a capitalization guard — the reserved lowercase binding
 * roots (`@entity`, `@user`, `@config`, `@trait`, `@callsitePayload`, …)
 * are never themselves keys of an entity-name substitution map. JS twin of
 * the compiler's `visit_entity_slots` generic identifier walk
 * (`phases/inline/rewrite.rs`), which the position-only
 * `renameEntityInEffect` walker does not reach.
 */
function renameEntityNameTokensInValue(node: unknown, entitySubs: ReadonlyMap<string, string>): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") {
    if (!node.startsWith("@")) return node;
    const rest = node.slice(1);
    const dot = rest.search(/[.[]/);
    const name = dot === -1 ? rest : rest.slice(0, dot);
    const suffix = dot === -1 ? "" : rest.slice(dot);
    const to = entitySubs.get(name);
    return to === undefined ? node : `@${to}${suffix}`;
  }
  if (Array.isArray(node)) return node.map((item) => renameEntityNameTokensInValue(item, entitySubs));
  if (typeof node !== "object") return node;
  const next: { [k: string]: unknown } = {};
  for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
    next[key] = renameEntityNameTokensInValue(value, entitySubs);
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
 * unresolved `{ref, name, …}` wrapper. An atom's sub-views are often refs
 * (`trait DenseTableView = TableView.traits.TableViewRender -> BrowseItem`),
 * so callers need both shapes — {@link resolveTraitEntry} resolves either
 * one down to a concrete `Trait`.
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

/**
 * §B4-R5: the declared `config {}` of the orbital that OWNS an imported
 * trait — the JS twin of `InlineContext::get_orbital_config_for_trait`
 * (Rust `orbital-compiler/src/phases/inline/context.rs`). A
 * `Alias.traits.X` reference falls through to this when neither the
 * consumer's embedder chain nor its own `orbital.config` resolves one of
 * the trait's `@config.<knob>` forwards (an orbital-level knob no consumer
 * composing only the trait would ever declare). Name-based only — trait
 * names are unique across one behavior's orbitals by convention, the same
 * assumption `resolveTraitRefString`'s own orbital scan already makes.
 */
function homeOrbitalConfigForTrait(
  imported: ResolvedImport,
  traitName: string,
): DeclaredTraitConfig | undefined {
  for (const o of importedOrbitals(imported)) {
    if (findTraitEntryInOrbital(o, traitName)) return o.config;
  }
  return undefined;
}

/**
 * The page entry an orbital declares under `localName` — inline `Page` or
 * unresolved `PageRefObject` wrapper. Twin of {@link findTraitEntryInOrbital}
 * for pages: a `PageRefObject` carries no `name` of its own (that absence is
 * exactly how `isPageReferenceObject` tells it apart from an inline `Page`),
 * so a re-exported page's local name is the tail of its OWN `ref` string.
 */
function findPageEntryInOrbital(orbital: Orbital, localName: string): Page | PageRefObject | null {
  for (const pageRef of orbital.pages ?? []) {
    if (typeof pageRef === "string") continue;
    if (!("ref" in pageRef)) {
      if ((pageRef as Page).name === localName) return pageRef as Page;
      continue;
    }
    const refObj = pageRef as PageRefObject;
    if (parsePageRef(refObj.ref)?.pageName === localName) return refObj;
  }
  return null;
}

/**
 * Coerce a `PageRefObject.traits` override entry (a full `TraitRef` — inline,
 * a bare name/ref string, or a `{ref, …}` wrapper) down to the lightweight
 * `PageTraitRef` pointer `Page.traits` holds. A page-level trait entry is
 * always a pointer at a trait the orbital resolves elsewhere (`resolveTraits`
 * over the orbital's OWN `traits {}`), never an inline body — an inline
 * entry's own `name` becomes the pointer's `ref`.
 */
function toPageTraitRef(traitRef: TraitRef): PageTraitRef {
  if (typeof traitRef === "string") return { ref: traitRef };
  if ("stateMachine" in traitRef) return { ref: (traitRef as Trait).name };
  const refObj = traitRef as {
    ref: string;
    refId?: TraitId;
    name?: string;
    config?: TraitConfig;
    linkedEntity?: string;
    linkedEntityId?: EntityId;
  };
  return {
    ref: refObj.name ?? refObj.ref,
    ...(refObj.refId !== undefined ? { refId: refObj.refId } : {}),
    ...(refObj.linkedEntity !== undefined ? { linkedEntity: refObj.linkedEntity } : {}),
    ...(refObj.linkedEntityId !== undefined ? { linkedEntityId: refObj.linkedEntityId } : {}),
    ...(refObj.config !== undefined ? { config: refObj.config } : {}),
  };
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
  // Guard AND effects — Rust `sibling_trait_refs_of` (trait.rs) walks both;
  // an embed can live in a guard's own SExpr tree just as much as an
  // effect's (a conditional render branch keyed on a config-derived guard),
  // and a guard-only miss silently dangled the token instead of pulling the
  // sibling that would have satisfied it.
  for (const t of trait.stateMachine?.transitions ?? []) {
    walk(t.guard);
    walk(t.effects);
  }
  for (const tick of trait.ticks ?? []) {
    walk(tick.guard);
    walk(tick.effects);
  }
  for (const field of Object.values(trait.config ?? {})) walk(field.default);
  // Sorted by name, not encounter order — the Rust twin's `SExpression::Object`
  // is a HashMap, so its own walk order is unrecoverable; `sibling_trait_refs_of`
  // collects into a HashSet then sorts (trait.rs, B4-R3). Both the top-level
  // pull-worklist seed and this function's own recursive re-walk of a pulled
  // copy feed a deterministic LIFO stack from this list, so sorting here is
  // what keeps `orbital.traits` append order identical across runs AND
  // identical to the compiled path's.
  return [...found].sort();
}

/**
 * Resolve a pulled sibling's `@config.<knob>` forward defaults, walking the
 * chain embedder → owning orbital → schema — the JS twin of the compiler's
 * `forwarded_sibling_config` (`phases/inline/trait.rs`, §4.5).
 *
 * `MasterListView = DataList.traits.DataListRender { config { fields:
 * @config.fields } }` inside `std-browse` means "take `fields` from whoever
 * embeds me". The embedder is known at exactly one place, the pull site: a
 * sibling is materialised per embedder, and its own declared default IS the
 * forward string, so without this the knob still reads `@config.fields` at
 * render time, `deferEntityBindings`' hop finds the same token and stops, and
 * a populated list renders blank. When the embedder doesn't declare the knob
 * (or there is no embedder at all), the forward falls through to the trait's
 * owning orbital's declared `config {}`, then the schema's.
 *
 * Only whole-string forwards resolve here. A `@config.<knob>.<path>` form and
 * a knob none of the three rungs declare are left for the binding validator.
 */
function resolveForwardedSiblingConfig(
  trait: Trait,
  parent: Trait | undefined,
  orbitalConfig?: DeclaredTraitConfig,
  schemaConfig?: DeclaredTraitConfig,
): Trait {
  return resolveForwardedSiblingConfigFrom(trait, parent?.config ? [parent.config] : [], orbitalConfig, schemaConfig);
}

/**
 * {@link resolveForwardedSiblingConfig}'s body, taking a CHAIN of ancestor
 * declared configs (innermost/immediate embedder first) rather than a
 * single parent `Trait` — a hoisted forward may pass through several
 * embedders that themselves declare no knob at all before landing on a
 * concrete value three-plus levels up (ledger (n)-JS; Rust twin
 * `forwarded_sibling_config_from`, `phases/inline/trait.rs`). For each rung,
 * in order: undeclared → try the next rung with the SAME knob; declared as
 * another whole-string `@config.<knob2>` forward → switch to `knob2` and try
 * the NEXT rung (a rung that just forwards to itself under the original
 * name — the single-embedder case's old self-check — falls through the
 * same way, since re-checking it finds nothing new). The bound is the
 * chain's own length; callers building it (`pullSiblingTraits`,
 * `materializeOrbitalRef`) guard against a cycle in the ancestor graph
 * itself.
 */
function resolveForwardedSiblingConfigFrom(
  trait: Trait,
  parentChain: readonly DeclaredTraitConfig[],
  orbitalConfig?: DeclaredTraitConfig,
  schemaConfig?: DeclaredTraitConfig,
): Trait {
  const declared = trait.config;
  if (!declared) return trait;
  const next = resolveConfigForwards(declared, parentChain, orbitalConfig, undefined, undefined, schemaConfig);
  return next ? { ...trait, config: next } : trait;
}

/**
 * One rung's value for `knob`, in whichever call-site shape it's declared:
 * the annotated `{ type, default }` form (`isCallSiteConfigDeclaration`)
 * yields its `default`; a bare wiring value is itself the value. Shared by
 * both forward walkers below so a `{ref}` entry's OWN call-site override
 * (mixed shape, `CallSiteConfig`) and a trait's DECLARED config (always the
 * annotated form, `DeclaredTraitConfig`) read identically as chain rungs.
 */
function callSiteRungValue(rungConfig: CallSiteConfig, knob: string): TraitConfigValue | undefined {
  const entry = rungConfig[knob];
  if (entry === undefined) return undefined;
  return isCallSiteConfigDeclaration(entry) ? entry.default : entry;
}

/**
 * Walk `forward` (a whole-string `@config.<knob>` literal) through
 * `parentChain` rungs (innermost/immediate embedder first), switching keys
 * when a rung's own value for the current knob is itself another
 * whole-string forward, then falling through to `orbitalConfig`,
 * `upstreamOrbitalConfig`, `upstreamSchemaConfig`, and `schemaConfig` (in
 * that order) with whatever knob survives — the shared core of
 * {@link resolveConfigForwards} (a trait's own declared-default forwards)
 * and {@link resolveCallSiteConfigForwards} (a `{ref}` entry's call-site
 * override forwards; ledger (n)-JS, ref-entry half). Undeclared at a rung →
 * try the next rung with the SAME knob; a rung that merely echoes the
 * current forward back falls through the same way, since re-checking it
 * finds nothing new. Returns `undefined` when no rung ever resolves it —
 * the caller keeps the original literal.
 *
 * §B4-R5: `upstreamOrbitalConfig`/`upstreamSchemaConfig` are the two extra
 * rungs a §8 trait-form reference (`Alias.traits.X`) needs that no other
 * caller does — the orbital that actually DECLARES the imported trait (an
 * orbital-level knob no consumer composing only the trait would ever see),
 * then that alias's own app-level config, already folded with any `uses {
 * config }` call-site override. Every other caller passes `undefined` for
 * both, leaving their resolution exactly as before — a plain sibling pull or
 * a call-site's own forward has no separate "upstream" rung to fall through
 * to (Rust twin: `forwarded_sibling_config_from`'s `upstream_orbital_config`/
 * `upstream_schema_config` params, `orbital-compiler`'s `phases::inline::trait`).
 */
function walkConfigForwardChain(
  forward: string,
  parentChain: readonly CallSiteConfig[],
  orbitalConfig: DeclaredTraitConfig | undefined,
  upstreamOrbitalConfig: DeclaredTraitConfig | undefined,
  upstreamSchemaConfig: DeclaredTraitConfig | undefined,
  schemaConfig: DeclaredTraitConfig | undefined,
): TraitConfigValue | undefined {
  let knob = forward.slice("@config.".length);
  if (knob.length === 0 || knob.includes(".")) return undefined;
  let value: TraitConfigValue | undefined;
  let currentForward: string = forward;
  for (const rungConfig of parentChain) {
    const rungValue = callSiteRungValue(rungConfig, knob);
    if (rungValue === undefined || rungValue === currentForward) continue;
    if (typeof rungValue === "string" && rungValue.startsWith("@config.")) {
      const nextKnob = rungValue.slice("@config.".length);
      if (nextKnob.length === 0 || nextKnob.includes(".") || nextKnob === knob) continue;
      // This rung forwards under a DIFFERENT key — the value lives further
      // out still; keep walking the chain looking for the new key.
      knob = nextKnob;
      currentForward = rungValue;
      continue;
    }
    value = rungValue;
    break;
  }
  if (value === undefined || value === currentForward) value = orbitalConfig?.[knob]?.default;
  if (value === undefined || value === currentForward) value = upstreamOrbitalConfig?.[knob]?.default;
  if (value === undefined || value === currentForward) value = upstreamSchemaConfig?.[knob]?.default;
  if (value === undefined || value === currentForward) value = schemaConfig?.[knob]?.default;
  if (value === undefined || value === currentForward) return undefined;
  return value;
}

/**
 * Resolve every whole-string `@config.<knob>` forward in a trait's own
 * DECLARED config against the ancestor chain — the body
 * {@link resolveForwardedSiblingConfigFrom} wraps back into a `Trait`. See
 * {@link walkConfigForwardChain} for the `upstreamOrbitalConfig`/
 * `upstreamSchemaConfig` rungs (§B4-R5, trait-form reference only).
 */
function resolveConfigForwards(
  declared: DeclaredTraitConfig,
  parentChain: readonly CallSiteConfig[],
  orbitalConfig?: DeclaredTraitConfig,
  upstreamOrbitalConfig?: DeclaredTraitConfig,
  upstreamSchemaConfig?: DeclaredTraitConfig,
  schemaConfig?: DeclaredTraitConfig,
): DeclaredTraitConfig | undefined {
  let next: Record<string, ConfigFieldDeclaration> | undefined;
  for (const [key, field] of Object.entries(declared)) {
    const forward = field.default;
    if (typeof forward !== "string" || !forward.startsWith("@config.")) continue;
    const value = walkConfigForwardChain(
      forward,
      parentChain,
      orbitalConfig,
      upstreamOrbitalConfig,
      upstreamSchemaConfig,
      schemaConfig,
    );
    if (value === undefined) continue;
    next ??= { ...declared };
    // `forwardedFrom` — the field's OWN original `@config.<knob>` token —
    // survives the collapse so a dead-knob check can still recognize the
    // knob as forwarded on an already-resolved schema (B4-J5,
    // `ConfigFieldDeclaration.forwardedFrom`).
    next[key] = { ...field, default: value, forwardedFrom: forward };
  }
  return next;
}

/**
 * Resolve every whole-string `@config.<knob>` forward in a `{ref}` entry's
 * CALL-SITE config override against the ancestor chain — the `{ref}`-entry
 * half of ledger (n)-JS (a top-level `orbital.traits` entry, resolved
 * through {@link embedderChain} over {@link buildEmbedGraph}, not a pulled
 * sibling; `resolveConfigForwards` above is the declared-default half). Only
 * a whole-string top-level override value counts as a forward — an array or
 * object value (e.g. `children: [...]`) is left alone, exactly as
 * `resolveConfigForwards` leaves a trait's own non-string declared defaults
 * alone; no new recursion into nested structures. No upstream rungs here —
 * a call-site override has no "home orbital" of its own (§B4-R5 scope).
 */
function resolveCallSiteConfigForwards(
  config: CallSiteConfig,
  parentChain: readonly CallSiteConfig[],
  orbitalConfig: DeclaredTraitConfig | undefined,
  schemaConfig: DeclaredTraitConfig | undefined,
): CallSiteConfig | undefined {
  let next: Record<string, TraitConfigValue | ConfigFieldDeclaration> | undefined;
  for (const [key, entry] of Object.entries(config)) {
    const forward = isCallSiteConfigDeclaration(entry) ? entry.default : entry;
    if (typeof forward !== "string" || !forward.startsWith("@config.")) continue;
    const value = walkConfigForwardChain(forward, parentChain, orbitalConfig, undefined, undefined, schemaConfig);
    if (value === undefined) continue;
    next ??= { ...config };
    // `forwardedFrom` only has a slot on the annotated declaration form — a
    // plain wiring-value override has no metadata carrier to hang it on and
    // stays a plain value (B4-J5, `ConfigFieldDeclaration.forwardedFrom`).
    next[key] = isCallSiteConfigDeclaration(entry) ? { ...entry, default: value, forwardedFrom: forward } : value;
  }
  return next;
}

/** Every `@trait.X` root name a `TraitRef` entry (Inline or `{ref}`) names
 *  in its OWN scope — an Inline entry's declared config/state machine, a
 *  `{ref}` entry's call-site config override — via {@link traitEmbedNamesOf}
 *  on the entry's own `.config`; a plain string entry carries no config and
 *  contributes nothing. */
function traitRefEmbedNamesOf(traitRef: TraitRef): string[] {
  if (typeof traitRef === "string") return [];
  return traitEmbedNamesOf(traitRef as Trait);
}

/** The LOCAL name a `TraitRef` entry is known by inside its OWN
 *  `orbital.traits` list — a call-site rename (`{ name, ref }`) or an
 *  inline trait's own `name`; an unrenamed ref falls back to the upstream
 *  trait name parsed out of `ref`. */
function traitRefLocalName(traitRef: TraitRef): string | undefined {
  if (typeof traitRef === "string") {
    return parseImportedTraitRef(traitRef)?.traitName ?? traitRef;
  }
  if ("stateMachine" in traitRef) return (traitRef as Trait).name;
  const refObj = traitRef as { ref: string; name?: string };
  return refObj.name ?? parseImportedTraitRef(refObj.ref)?.traitName ?? refObj.ref;
}

/** A `TraitRef` entry's OWN config — an inline trait's declared config or a
 *  `{ref}` entry's call-site override; `undefined` for a plain string ref. */
function traitRefConfigOf(traitRef: TraitRef): CallSiteConfig | undefined {
  if (typeof traitRef === "string") return undefined;
  return (traitRef as Trait).config;
}

/**
 * Per-orbital child → first-referrer map over the PRE-resolution
 * `orbital.traits` list — the JS twin of the compiler's per-orbital
 * `EmbedGraph` (`trait.rs`, ledger (n)): a trait naming another via
 * `@trait.X`, whether in an Inline entry's own declared config/state
 * machine or a `{ref}` entry's call-site config override, becomes that
 * child's referrer (first mention wins, list order). {@link embedderChain}
 * walks these edges to resolve a `{ref}` entry's call-site `@config.<k>`
 * forward through however many embedders in between declare no matching
 * knob themselves. Distinct from `pullSiblingTraits`'s own local
 * `embedderChain`, which walks ALREADY-PULLED sibling copies (a separate
 * worklist this graph never touches) — this one is built once, directly off
 * the orbital's explicit top-level entries, before any of them resolve.
 */
function buildEmbedGraph(traitRefs: readonly TraitRef[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const traitRef of traitRefs) {
    const referrerName = traitRefLocalName(traitRef);
    if (!referrerName) continue;
    for (const child of traitRefEmbedNamesOf(traitRef)) {
      if (child === referrerName) continue;
      if (!out.has(child)) out.set(child, referrerName);
    }
  }
  return out;
}

/**
 * Every ancestor's OWN config from `localName`'s immediate embedder out to
 * the top of {@link buildEmbedGraph}'s referrer map, innermost first — the
 * rungs {@link resolveCallSiteConfigForwards} tries before falling through
 * to the orbital's and schema's declared `config {}`. `localName` itself is
 * excluded (its own config is the SUBJECT carrying the forward, never a
 * rung of its own chain); bounded by `traitRefs.length` with a visited set,
 * defensive against a cycle in the referrer graph.
 */
function embedderChain(
  localName: string,
  traitRefs: readonly TraitRef[],
  graph: ReadonlyMap<string, string>,
): CallSiteConfig[] {
  const chain: CallSiteConfig[] = [];
  const visited = new Set<string>([localName]);
  let cur = graph.get(localName);
  let hops = 0;
  while (cur !== undefined && !visited.has(cur) && hops < traitRefs.length) {
    visited.add(cur);
    hops++;
    const entry = traitRefs.find((t) => traitRefLocalName(t) === cur);
    const entryConfig = entry ? traitRefConfigOf(entry) : undefined;
    if (entryConfig) chain.push(entryConfig);
    cur = graph.get(cur);
  }
  return chain;
}

/**
 * Per-orbital context threaded to `resolveTraitRefString` so a top-level
 * `{ref}` entry's call-site config override can resolve its own
 * `@config.<k>` forwards through {@link embedderChain} before the override
 * reaches the schema. `undefined` at a nested-ref call site
 * (`resolveTraitEntry`, resolving a ref found INSIDE an imported atom's own
 * composition) — that scope's embedder graph belongs to the UPSTREAM
 * orbital, not the consumer's, and is out of scope for this ledger item.
 */
interface OrbitalEmbedContext {
  readonly traitRefs: readonly TraitRef[];
  readonly embedGraph: ReadonlyMap<string, string>;
  readonly orbitalConfig: DeclaredTraitConfig | undefined;
}

/**
 * A `{ref}` entry's call-site config override, forward-resolved through its
 * own embedder chain (ledger (n)-JS, ref-entry half; {@link
 * resolveForwardedSiblingConfigFrom} is the pulled-sibling half). No-op when
 * nothing in `config` is a still-unresolved forward.
 */
function resolveEmbedderConfigForward(
  config: TraitConfig,
  localName: string,
  embedCtx: OrbitalEmbedContext,
  schemaConfig: DeclaredTraitConfig | undefined,
): TraitConfig {
  const chain = embedderChain(localName, embedCtx.traitRefs, embedCtx.embedGraph);
  const next = resolveCallSiteConfigForwards(config, chain, embedCtx.orbitalConfig, schemaConfig);
  return next ? (next as TraitConfig) : config;
}

/**
 * Secondary (non-`linkedEntity`) entity-reference recovery — JS twin of
 * Rust's `consumer_known_entity_rebind_subs` (`orbital-compiler/src/phases/
 * inline/rewrite.rs`). Runs UNCONDITIONALLY, rebind or not: every
 * `entityRefIds` key whose id `entityIds` ALSO knows under a DIFFERENT name
 * is stale — the schema-wide roster already ties that id to a name THIS
 * consumer declared (an earlier-resolved orbital's own entity, or a sibling
 * pull's rebind), so the atom's copy of the token must follow it, whether or
 * not the trait carrying it was itself rebound. `idToConsumerName` keeps the
 * FIRST name found for a given id (`Map` iteration = insertion order,
 * mirroring Rust's `.entry(id).or_insert(name)`) — a genuine id collision
 * across two differently-named entities is a separate id-integrity issue,
 * not something this pass resolves either way.
 */
function consumerKnownEntityRebindSubs(
  trait: Trait,
  entityIds: ReadonlyMap<string, EntityId>,
): Map<string, string> {
  const out = new Map<string, string>();
  const refs = trait.entityRefIds;
  if (!refs) return out;
  const idToConsumerName = new Map<string, string>();
  for (const [name, id] of entityIds) {
    if (!idToConsumerName.has(id)) idToConsumerName.set(id, name);
  }
  for (const [tokenName, entityId] of Object.entries(refs)) {
    const consumerName = idToConsumerName.get(entityId);
    if (consumerName !== undefined && consumerName !== tokenName) {
      out.set(tokenName, consumerName);
    }
  }
  return out;
}

/**
 * Stale-token-name recovery for the trait's OWN bound entity, general case
 * of the atom's exact-name key — JS twin of Rust's `stale_entity_rebind_subs`.
 * Runs only for a genuine `linkedEntity` rebind (`newEntity`): every
 * `entityRefIds` key whose id equals the trait's PRE-rebind bound-entity id
 * (`trait.linkedEntityId`) is recovered to `newEntity`, even when the key's
 * NAME no longer matches `atomLinked` — the atom's own bound-entity
 * declaration was renamed after the side-map was stamped, so only the id
 * still ties the stale token to it.
 */
function staleEntityRebindSubs(trait: Trait, newEntity: string): Map<string, string> {
  const out = new Map<string, string>();
  const boundId = trait.linkedEntityId;
  const refs = trait.entityRefIds;
  if (boundId && refs) {
    for (const [tokenName, entityId] of Object.entries(refs)) {
      if (entityId === boundId) out.set(tokenName, newEntity);
    }
  }
  return out;
}

/**
 * Apply a linkedEntity override from a trait-ref call site to an
 * imported atom. When the atom declared `entity: "ModalRecord"` inside
 * its render-ui configs and the ref site supplied
 * `linkedEntity: "CartItem"`, rewrite every such literal so runtime
 * consumers (EntitySchemaContext lookup, DataService collection binding)
 * see the molecule-level entity name. `entityIds` (every caller passes
 * `this.entityIdsInScope`) drives two id-based `entityRefIds` recoveries —
 * {@link consumerKnownEntityRebindSubs} (unconditional) and
 * {@link staleEntityRebindSubs} (rebind-only) — plus the exact-name
 * `atomLinked → linkedEntity` substitution, combined into ONE `entitySubs`
 * map and applied via {@link rewriteEntityRefIds} exactly once, matching
 * Rust's `apply_overrides_to_trait` step order (secondary recovery inserted
 * FIRST, the primary rebind's own substitutions inserted after so they win
 * on an overlapping key). `rewriteEntityRefIds` runs even with NO rebind
 * (`entitySubs` may still be non-empty from the secondary recovery alone,
 * or empty — either way it also REFRESHES every untouched key's id to
 * `entityIds`' current value, same as the compiled path).
 */
function applyLinkedEntityRename(
  trait: Trait,
  linkedEntity: string | undefined,
  entityIds: ReadonlyMap<string, EntityId>,
): Trait {
  const atomLinked = trait.linkedEntity;
  const entitySubs = consumerKnownEntityRebindSubs(trait, entityIds);
  if (!linkedEntity || !atomLinked || linkedEntity === atomLinked) {
    return rewriteEntityRefIds(trait, entitySubs, entityIds);
  }
  for (const [from, to] of staleEntityRebindSubs(trait, linkedEntity)) {
    entitySubs.set(from, to);
  }
  entitySubs.set(atomLinked, linkedEntity);
  const rename: EntityRename = (name) => (name === atomLinked ? linkedEntity : undefined);
  const sm = trait.stateMachine;
  const rebound: Trait = {
    ...trait,
    linkedEntity,
    linkedEntityId: entityIds.get(linkedEntity),
  };
  if (!sm) {
    return renamePayloadEntityMarkers(rewriteEntityRefIds(rebound, entitySubs, entityIds), rename);
  }
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
  return renamePayloadEntityMarkers(
    rewriteEntityRefIds(
      { ...rebound, stateMachine: { ...sm, transitions: nextTransitions } },
      entitySubs,
      entityIds,
    ),
    rename,
  );
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
  const nextTransitions = (sm?.transitions ?? []).map((t) => {
    const nextEvent = rename(t.event) ?? t.event;
    const nextEffects = t.effects
      ? (renameEventsInEffects(t.effects as readonly unknown[], rename) as typeof t.effects)
      : t.effects;
    return { ...t, event: nextEvent, effects: nextEffects };
  });
  const nextEvents = (sm?.events ?? []).map((e) => {
    const newKey = rename(e.key);
    if (newKey === e.key) return e;
    return { ...e, key: newKey ?? e.key };
  });
  const nextEmits = (trait.emits ?? []).map((em) => {
    if (typeof em === "string") return rename(em) ?? em;
    const newEvent = rename(em.event);
    return newEvent === em.event ? em : { ...em, event: newEvent ?? em.event };
  });
  // Tick effects carry the same `(emit OLD …)` heads and render-ui event
  // props as transition effects — the compiled path walks them too.
  // Skipping ticks left tick-originated emits (e.g. a platformer body's
  // physicsTick BODY_MOVED) firing the pre-rename name.
  const nextTicks = (trait.ticks ?? []).map((tk) =>
    tk.effects
      ? {
          ...tk,
          effects: renameEventsInEffects(
            tk.effects as readonly unknown[],
            rename,
          ) as typeof tk.effects,
        }
      : tk,
  );
  // A listen's `triggers` names THIS trait's transition event — rename it.
  // A listen's `event` names the SOURCE trait's vocabulary when sourced
  // (kind trait/orbital); unsourced/`any` listens follow this trait's own
  // renames. Mirrors the compiled path's `rewrite_trait_event_fields`.
  const nextListens = (trait.listens ?? []).map((l) => {
    const sourced = l.source !== undefined && l.source.kind !== "any";
    const nextEvent = sourced ? l.event : (rename(l.event) ?? l.event);
    const nextTriggers = rename(l.triggers) ?? l.triggers;
    return nextEvent === l.event && nextTriggers === l.triggers
      ? l
      : { ...l, event: nextEvent, triggers: nextTriggers };
  });
  // Declared config knob defaults carry event literals the effect walk cannot
  // reach: a render-ui node forwards `actions: "@config.actions"` as a STRING,
  // and the array itself lives on the knob. Letting `trait.config` ride
  // through the spread untouched is what left a renamed atom firing its
  // pre-rename event keys from its own action buttons.
  const nextConfig = renameEventsInDeclaredConfig(trait.config, rename);
  return {
    ...trait,
    stateMachine: sm
      ? {
          ...sm,
          transitions: nextTransitions,
          events: nextEvents,
        }
      : sm,
    ...(trait.ticks ? { ticks: nextTicks } : {}),
    ...(trait.listens ? { listens: nextListens } : {}),
    ...(nextConfig !== undefined ? { config: nextConfig } : {}),
    emits: nextEmits,
  } as Trait;
}

/**
 * Fold a rename across a CALL-SITE config block. The call site's own
 * `config { actions: [...] }` override replaces the declared default, so the
 * rename must reach it too — otherwise overriding a knob silently opts out of
 * the rename. Member types come from the trait's DECLARED schema, which is the
 * only place they are stated.
 */
function applyEventRenamesToCallSiteConfig(
  config: TraitConfig | undefined,
  declared: Trait["config"],
  renames?: { [oldKey: string]: string },
): TraitConfig | undefined {
  if (config === undefined || declared === undefined) return config;
  if (!renames || Object.keys(renames).length === 0) return config;
  const rename = (k: string | undefined): string | undefined =>
    k !== undefined && k in renames ? renames[k] : k;
  let touched = false;
  const next: { [k: string]: unknown } = { ...(config as { [k: string]: unknown }) };
  for (const [knob, value] of Object.entries(config as { [k: string]: unknown })) {
    const field = declared[knob];
    if (field === undefined) continue;
    const renamed =
      field.type === "event"
        ? (typeof value === "string" && value !== "" && !value.startsWith("@")
            ? (rename(value) ?? value)
            : value)
        : renameEventTypedMembers(value, field.items, rename);
    if (renamed !== value) {
      next[knob] = renamed;
      touched = true;
    }
  }
  return touched ? (next as TraitConfig) : config;
}

/**
 * knob → resolved emit value, recovered by zipping `resolveConfigRefEmitNames`'s
 * before/after `emits` arrays position-for-position (same length, same
 * order — `resolveConfigRefEmitNames` only ever `.map`s in place). Only a
 * `TraitEventContract` position whose RAW event was `@config.<knob>` for a
 * `knob` in `knobs` contributes an entry.
 */
function resolvedKnobValues(
  before: Trait,
  after: Trait,
  knobs: readonly string[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (knobs.length === 0) return out;
  const knobSet = new Set(knobs);
  const beforeEmits = before.emits ?? [];
  const afterEmits = after.emits ?? [];
  for (let i = 0; i < beforeEmits.length; i++) {
    const knob = configRefEventKnob(beforeEmits[i]!.event);
    if (knob !== undefined && knobSet.has(knob)) out.set(knob, afterEmits[i]!.event);
  }
  return out;
}

/**
 * Fold a LATER `events:` rename of an already-resolved `@config.<knob>`
 * emit name back onto the knob's OWN declared default — the DECLARED half
 * of the fold (Rust `trait.rs:174-202`); the call-site half is the existing
 * `applyEventRenamesToCallSiteConfig`. Without this, `trait.config[knob]
 * .default` stays the pre-rename resolved literal (or, when the knob
 * forwards to a call-site override, the un-substituted `@config.<knob>`
 * string — `renameEventsInDeclaredConfig`'s ordinary rename pass
 * deliberately skips `@`-prefixed defaults), so a LATER `@config.<knob>`
 * read elsewhere (a nested sibling forward, a render-ui body literal) sees
 * a stale value instead of the final renamed one
 * (ORB_X_RENDER_UI_EVENT_LITERAL_STALE's JS twin).
 */
function foldEventRenameOntoDeclaredKnobs(
  trait: Trait,
  resolved: ReadonlyMap<string, string>,
  eventRenames?: { [oldKey: string]: string },
): Trait {
  if (!eventRenames || resolved.size === 0 || !trait.config) return trait;
  let nextConfig: Record<string, ConfigFieldDeclaration> | undefined;
  for (const [knob, resolvedValue] of resolved) {
    const renamed = eventRenames[resolvedValue];
    if (renamed === undefined || renamed === resolvedValue) continue;
    const field = trait.config[knob];
    if (!field) continue;
    nextConfig ??= { ...trait.config };
    nextConfig[knob] = { ...field, default: renamed };
  }
  return nextConfig ? { ...trait, config: nextConfig } : trait;
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
): { trait: Trait; errors: string[]; resolvedKnobs: string[] } {
  const emits = trait.emits ?? [];
  const hasRef = emits.some((em) => configRefEventKnob(em.event) !== undefined);
  if (!hasRef) return { trait, errors: [], resolvedKnobs: [] };

  const effectiveConfig = {
    ...(normalizeCallSiteConfigToValues(trait.config) ?? {}),
    ...(normalizeCallSiteConfigToValues(callSiteConfig) ?? {}),
  };
  const errors: string[] = [];
  // (knob, raw `@config.<knob>` token, resolved literal) per resolved emit —
  // mirrors the Rust twin's `resolved_triples` so the same rewrite also
  // reaches `stateMachine.events[].key` below (L1 lowering unions emit keys
  // into the events registry, so the raw token appears there too).
  const resolvedTriples: { knob: string; from: string; to: string }[] = [];
  const nextEmits = emits.map((em) => {
    const knob = configRefEventKnob(em.event);
    if (knob === undefined) return em;
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
    resolvedTriples.push({ knob, from: em.event, to: result.value });
    return { ...em, event: result.value };
  });
  const sm = trait.stateMachine;
  const nextEvents =
    resolvedTriples.length > 0 && sm
      ? sm.events.map((ev) => {
          const hit = resolvedTriples.find((t) => t.from === ev.key);
          return hit ? { ...ev, key: hit.to } : ev;
        })
      : sm?.events;
  return {
    trait: {
      ...trait,
      emits: nextEmits,
      ...(sm && nextEvents !== sm.events ? { stateMachine: { ...sm, events: nextEvents! } } : {}),
    },
    errors,
    resolvedKnobs: resolvedTriples.map((t) => t.knob),
  };
}

/**
 * Fold a `{ref}` entry's call-site `config` override onto the resolved
 * trait's OWN declared config — the JS twin of the compiler's
 * GAP-AG-VALUE-DRIFT fold (`phases/inline/trait.rs` step 6,
 * `apply_overrides_to_trait`). By the time this runs, `callSiteConfig` has
 * already been through the embedder-forward walk
 * ({@link resolveEmbedderConfigForward}) — a whole-string `@config.<knob>`
 * override already carries its RESOLVED value, with `forwardedFrom`
 * recording the original token — so this is the step that actually LANDS
 * that value on the trait: without it, only the caller-side
 * `ResolvedTrait.config` record ever saw the override, and every reader of
 * `trait.config[<knob>].default` (render, factory bake, a dead-knob check)
 * kept seeing the atom's bare declared default (`appName: "App"`,
 * `navItems: "@pages"` on `std-app-layout` regardless of an upstream
 * `uses { config { appName: "Project Friday" } }`).
 *
 * A call-site key naming an ALREADY-declared knob overrides that knob's
 * `default` — via the one knob-overlay owner, {@link overrideDeclaredKnobs}
 * (B1-F) — and its `forwardedFrom` is always REPLACED (never merged) by the
 * override's own, mirroring Rust's unconditional `field.forwarded_from =
 * cf.forwarded_from.clone()`. A key that is NOT already declared but is
 * itself a full annotated declaration ({@link isCallSiteConfigDeclaration})
 * is inserted as a brand-new declared knob (an alias trait widening the
 * wrapped trait's own config surface, e.g. adding its own `steps :
 * [StepSpec]`); a plain unmatched value names no slot to land in and is
 * dropped, exactly like Rust.
 */
function foldCallSiteConfigOntoTrait(trait: Trait, callSiteConfig: CallSiteConfig | undefined): Trait {
  if (!callSiteConfig) return trait;
  const declared = trait.config;
  const overrideValues: Record<string, TraitConfigValue> = {};
  const overriddenKeys = new Set<string>();
  const newDeclarations: Record<string, ConfigFieldDeclaration> = {};
  for (const [key, entry] of Object.entries(callSiteConfig)) {
    const isDecl = isCallSiteConfigDeclaration(entry);
    const value = isDecl ? entry.default : entry;
    if (declared && key in declared) {
      if (value !== undefined) {
        overrideValues[key] = value;
        overriddenKeys.add(key);
      }
    } else if (isDecl) {
      newDeclarations[key] = entry;
    }
  }
  if (overriddenKeys.size === 0 && Object.keys(newDeclarations).length === 0) {
    return trait;
  }
  let nextConfig: DeclaredTraitConfig = overrideDeclaredKnobs(declared ?? {}, overrideValues);
  if (overriddenKeys.size > 0) {
    const patched: Record<string, ConfigFieldDeclaration> = { ...nextConfig };
    for (const key of overriddenKeys) {
      const field = patched[key];
      if (!field) continue;
      const entry = callSiteConfig[key];
      const entryDecl = isCallSiteConfigDeclaration(entry) ? entry : undefined;
      patched[key] = {
        ...field,
        forwardedFrom: entryDecl?.forwardedFrom,
        // The atom's OWN `refId` (a reference-config field's declared
        // default names a SPECIFIC node by id) describes the ATOM's OWN
        // `default`, not whatever this override just replaced it with —
        // carrying it forward unchanged left a STALE id bound to the NEW
        // literal string, so the id-index's "current name" correction
        // (`resolveConfigRefsById`) silently rewrote the override BACK to
        // the atom's own default target — found via std-notes'
        // `NoteGlobalSearch`: `idleContent`'s override says `@trait.
        // NoteCatalog` but the atom's OWN stale `refId` (still pointing at
        // `AppSearchIdleHint`, the atom's default) rewrote the sibling-pull
        // target back to it (rung 2: an override with no id of its own
        // names no id, so it must clear the atom's). An override that
        // carries ITS OWN `refId` (an annotated, id-aware override) wins
        // instead — same precedence a `default` override already has.
        refId: entryDecl?.refId,
        ...(entryDecl?.label !== undefined ? { label: entryDecl.label } : {}),
        ...(entryDecl?.description !== undefined ? { description: entryDecl.description } : {}),
        ...(entryDecl?.synonyms !== undefined ? { synonyms: entryDecl.synonyms } : {}),
        ...(entryDecl?.tier !== undefined ? { tier: entryDecl.tier } : {}),
      };
    }
    nextConfig = patched;
  }
  if (Object.keys(newDeclarations).length > 0) {
    nextConfig = { ...nextConfig, ...newDeclarations };
  }
  return { ...trait, config: nextConfig };
}

// ============================================================================
// Orbital import — reference-form orbital materialization (W3-J)
//
// `orbital X = Alias.orbitals.Y { … }` (docs/Almadar_Orbital_Import.md §4) is
// the orbital-scope sibling of the trait/page reference forms this file
// already resolves. `materializeOrbitalRef` below is the JS twin of the
// (not-yet-landed) compiler's `resolve_orbital_reference` — it flattens an
// imported orbital's whole trait/entity/page closure into the consumer,
// unconditionally prefixed by the local orbital name (§4.3).
// ============================================================================

const ENTITY_FIELD_TOKEN_PREFIX = "@entity.";

/**
 * Rewrite `@entity.<from>` field-binding roots to `@entity.<to>` anywhere in
 * a value tree — the `OrbitalRefObject.fields` sibling of
 * {@link renameTraitEmbedsInValue}'s `@trait.` rewrite. Boundary-checked the
 * same way (`.`/`[`) so `@entity.dueDateRange` is not matched by a `dueDate`
 * substitution.
 */
function rewriteEntityFieldTokensInValue(node: unknown, subs: ReadonlyMap<string, string>): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") {
    if (!node.startsWith(ENTITY_FIELD_TOKEN_PREFIX)) return node;
    const rest = node.slice(ENTITY_FIELD_TOKEN_PREFIX.length);
    const dot = rest.search(/[.[]/);
    const name = dot === -1 ? rest : rest.slice(0, dot);
    const suffix = dot === -1 ? "" : rest.slice(dot);
    const to = subs.get(name);
    return to === undefined ? node : `${ENTITY_FIELD_TOKEN_PREFIX}${to}${suffix}`;
  }
  if (Array.isArray(node)) return node.map((item) => rewriteEntityFieldTokensInValue(item, subs));
  if (typeof node !== "object") return node;
  const next: { [k: string]: unknown } = {};
  for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
    next[key] = rewriteEntityFieldTokensInValue(value, subs);
  }
  return next;
}

/**
 * Apply an `OrbitalRefObject.fields` rename (`{ up: local }`) to every
 * `@entity.<field>` token a trait carries — transition guards + effects,
 * tick guards + effects, listen guards + payload mappings, and config-field
 * defaults. No existing helper covers field-level (as opposed to whole-name)
 * entity rewrites; this is new (§Report: fields rename).
 */
function rewriteEntityFieldsInTrait(trait: Trait, fieldSubs: ReadonlyMap<string, string>): Trait {
  if (fieldSubs.size === 0) return trait;
  const rewrite = (v: unknown): unknown => rewriteEntityFieldTokensInValue(v, fieldSubs);
  const next: Trait = { ...trait };
  const sm = trait.stateMachine;
  if (sm) {
    next.stateMachine = {
      ...sm,
      transitions: (sm.transitions ?? []).map((t) => ({
        ...t,
        ...(t.guard !== undefined ? { guard: rewrite(t.guard) as typeof t.guard } : {}),
        ...(t.effects ? { effects: rewrite(t.effects) as typeof t.effects } : {}),
      })),
    };
  }
  if (trait.ticks) {
    next.ticks = trait.ticks.map((tick) => ({
      ...tick,
      ...(tick.guard !== undefined ? { guard: rewrite(tick.guard) as typeof tick.guard } : {}),
      effects: rewrite(tick.effects) as typeof tick.effects,
    }));
  }
  if (trait.listens) {
    next.listens = trait.listens.map((l) => ({
      ...l,
      ...(l.guard !== undefined ? { guard: rewrite(l.guard) as typeof l.guard } : {}),
      ...(l.payloadMapping ? { payloadMapping: rewrite(l.payloadMapping) as typeof l.payloadMapping } : {}),
    }));
  }
  if (trait.initialEffects) {
    next.initialEffects = rewrite(trait.initialEffects) as typeof trait.initialEffects;
  }
  if (trait.config) {
    const nextConfig: { [k: string]: ConfigFieldDeclaration } = {};
    for (const [key, field] of Object.entries(trait.config)) {
      nextConfig[key] =
        field.default === undefined
          ? field
          : { ...field, default: rewrite(field.default) as ConfigFieldDeclaration["default"] };
    }
    next.config = nextConfig;
  }
  return next;
}

/**
 * Rename `entity`-level fields on the (already-resolved, inline) `Entity`
 * itself: field keys plus any `@entity.<field>` token inside its access
 * policies.
 */
function rewriteEntityFieldsInEntity(entity: Entity, fieldSubs: ReadonlyMap<string, string>): Entity {
  if (fieldSubs.size === 0) return entity;
  const rewrite = (v: unknown): unknown => rewriteEntityFieldTokensInValue(v, fieldSubs);
  return {
    ...entity,
    fields: entity.fields.map((f) => (f.name && fieldSubs.has(f.name) ? { ...f, name: fieldSubs.get(f.name)! } : f)),
    ...(entity.read_policy !== undefined
      ? { read_policy: rewrite(entity.read_policy) as typeof entity.read_policy }
      : {}),
    ...(entity.create_policy !== undefined
      ? { create_policy: rewrite(entity.create_policy) as typeof entity.create_policy }
      : {}),
    ...(entity.update_policy !== undefined
      ? { update_policy: rewrite(entity.update_policy) as typeof entity.update_policy }
      : {}),
    ...(entity.delete_policy !== undefined
      ? { delete_policy: rewrite(entity.delete_policy) as typeof entity.delete_policy }
      : {}),
  };
}

const USER_FIELD_PREFIX = "@user.";

/**
 * `@user.<f>` with NO deeper path (no `.`/`[` after `<f>`) — the direct-only
 * read `check_comparison`'s `user_field_of` uses; a nested path (`@user.a.b`)
 * is never a role-literal comparand. JS twin of Rust's `user_field_of`
 * (`orbital-compiler/src/phases/validation/user_identity.rs` L149).
 */
function directUserField(node: unknown): string | undefined {
  if (typeof node !== "string" || !node.startsWith(USER_FIELD_PREFIX)) return undefined;
  const rest = node.slice(USER_FIELD_PREFIX.length);
  return rest.length > 0 && !/[.[]/.test(rest) ? rest : undefined;
}

/**
 * Comparison operators `check_comparison` treats as equality (`orbital-rust`
 * `user_identity.rs` `EQUALITY_OPS` L52) — the shape oracle
 * {@link rewriteRoleLiteralsInValue} mirrors exactly so a remapped policy
 * stays silent under that validator.
 */
const EQUALITY_OPS: ReadonlySet<string> = new Set(["=", "==", "!=", "!==", "eq", "neq"]);
const NEGATED_EQUALITY_OPS: ReadonlySet<string> = new Set(["!=", "!==", "neq"]);

/**
 * Is an `array/includes` haystack array a LITERAL role list, and if so,
 * which elements are the members? Twin of Rust
 * `validation::user_identity::literal_haystack_members`
 * (`user_identity.rs`, mirrored again by `inline::rewrite::
 * try_rewrite_role_includes`) — all three must stay shape-identical: either
 * a `["list", …]` array-construction call (Rust
 * `mark_literal_list_in_place`'s wrap for a config-array-override value
 * that would otherwise collide with operator dispatch; both `.lolo`
 * spellings `(a b)`/`[a, b]` lower through it) whose TAIL is all-string, or
 * a bare array whose every element (including position 0) is a string
 * literal. Any other shape — a nested call like `["object/get",
 * ["array/nth", …], "allowedRoles"]`, std-step-flow's per-step dynamic role
 * guard — is not a literal haystack: `undefined` tells the caller to leave
 * the node untouched.
 */
function literalHaystackMembers(items: readonly unknown[]): string[] | undefined {
  const isListCall = items[0] === "list";
  const members = isListCall ? items.slice(1) : items;
  return members.every((v): v is string => typeof v === "string") ? [...members] : undefined;
}

/**
 * Rewrite an upstream role LITERAL to the consumer's roster, mirroring
 * `check_comparison`/`rewrite_role_literals` shape-for-shape (doc comment
 * must stay identical to the Rust twin — the two cite each other):
 *
 * (a) an equality comparison with exactly one direct `@user.<f>` operand
 *     (`f` a member of `roleFields`) and one plain string-literal operand
 *     that is a KEY of `roles`: a single target swaps the literal in place
 *     (the comparison operator, `=` or `!=`, is untouched — negation is
 *     already encoded by the operator); more than one target rewrites the
 *     WHOLE comparison to `(array/includes [...targets] @user.<f>)`, wrapped
 *     in `(not ...)` when the original operator was `!=`/`!==`/`neq`.
 * (b) an `array/includes` node whose haystack (position 0) is a literal
 *     array and whose needle (position 1) is a direct `@user.<f>` (`f` a
 *     member of `roleFields`): every literal in the haystack that is a KEY
 *     of `roles` is expanded to its targets (deduped, first-seen order); a
 *     literal with no mapping passes through unchanged.
 *
 * An upstream literal that is NOT a key of `roles` is left exactly as
 * written — the existing `ORB_S_ROLE_LITERAL_NOT_MEMBER` (fires once the
 * literal reaches a materialized entity) is the backstop for "left
 * unmapped, and the consumer roster doesn't happen to already have it".
 */
function rewriteRoleLiteralsInValue(
  node: unknown,
  roleFields: ReadonlyMap<string, readonly string[]>,
  roles: Readonly<Record<string, readonly string[]>>,
): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    const head = node[0];
    if (typeof head === "string" && EQUALITY_OPS.has(head) && node.length === 3) {
      const [, left, right] = node;
      const leftField = directUserField(left);
      const rightField = directUserField(right);
      const userField =
        leftField !== undefined && rightField === undefined
          ? leftField
          : rightField !== undefined && leftField === undefined
            ? rightField
            : undefined;
      if (userField !== undefined && roleFields.has(userField)) {
        const literalSide = leftField !== undefined ? right : left;
        if (typeof literalSide === "string" && literalSide in roles) {
          const targets = roles[literalSide];
          if (targets.length === 1) {
            return leftField !== undefined ? [head, left, targets[0]] : [head, targets[0], right];
          }
          const includesExpr = ["array/includes", [...targets], leftField !== undefined ? left : right];
          return NEGATED_EQUALITY_OPS.has(head) ? ["not", includesExpr] : includesExpr;
        }
      }
    }
    if (head === "array/includes" && node.length === 3 && Array.isArray(node[1])) {
      const needleField = directUserField(node[2]);
      if (needleField !== undefined && roleFields.has(needleField)) {
        const members = literalHaystackMembers(node[1]);
        if (members !== undefined) {
          const expanded: string[] = [];
          for (const literal of members) {
            const mapped = roles[literal];
            if (mapped) {
              for (const target of mapped) if (!expanded.includes(target)) expanded.push(target);
            } else if (!expanded.includes(literal)) {
              expanded.push(literal);
            }
          }
          const isListCall = node[1][0] === "list";
          return ["array/includes", isListCall ? ["list", ...expanded] : expanded, node[2]];
        }
      }
    }
    return node.map((item) => rewriteRoleLiteralsInValue(item, roleFields, roles));
  }
  if (typeof node !== "object") return node;
  const next: { [k: string]: unknown } = {};
  for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
    next[key] = rewriteRoleLiteralsInValue(value, roleFields, roles);
  }
  return next;
}

/**
 * Apply {@link rewriteRoleLiteralsInValue} across a trait's whole guard +
 * effect surface — transition guards/effects, tick guards/effects, listens
 * guard/payloadMapping, config defaults, `initialEffects`, and
 * `sourceEntityDefinition`'s four access policies (a materialized trait's
 * source-entity copy carries the same upstream role literals its own
 * policies do). Twin of {@link rewriteEntityFieldsInTrait}, applied after
 * {@link renameSourceEntityDefinition} so the source entity is already
 * renamed to the consumer's entity graph before its policies are rewritten.
 */
function rewriteRoleLiteralsInTrait(
  trait: Trait,
  roleFields: ReadonlyMap<string, readonly string[]>,
  roles: Readonly<Record<string, readonly string[]>>,
): Trait {
  if (roleFields.size === 0 || Object.keys(roles).length === 0) return trait;
  const rewrite = (v: unknown): unknown => rewriteRoleLiteralsInValue(v, roleFields, roles);
  const next: Trait = { ...trait };
  const sm = trait.stateMachine;
  if (sm) {
    next.stateMachine = {
      ...sm,
      transitions: (sm.transitions ?? []).map((t) => ({
        ...t,
        ...(t.guard !== undefined ? { guard: rewrite(t.guard) as typeof t.guard } : {}),
        ...(t.effects ? { effects: rewrite(t.effects) as typeof t.effects } : {}),
      })),
    };
  }
  if (trait.ticks) {
    next.ticks = trait.ticks.map((tick) => ({
      ...tick,
      ...(tick.guard !== undefined ? { guard: rewrite(tick.guard) as typeof tick.guard } : {}),
      effects: rewrite(tick.effects) as typeof tick.effects,
    }));
  }
  if (trait.listens) {
    next.listens = trait.listens.map((l) => ({
      ...l,
      ...(l.guard !== undefined ? { guard: rewrite(l.guard) as typeof l.guard } : {}),
      ...(l.payloadMapping ? { payloadMapping: rewrite(l.payloadMapping) as typeof l.payloadMapping } : {}),
    }));
  }
  if (trait.initialEffects) {
    next.initialEffects = rewrite(trait.initialEffects) as typeof trait.initialEffects;
  }
  if (trait.config) {
    const nextConfig: { [k: string]: ConfigFieldDeclaration } = {};
    for (const [key, field] of Object.entries(trait.config)) {
      nextConfig[key] =
        field.default === undefined
          ? field
          : { ...field, default: rewrite(field.default) as ConfigFieldDeclaration["default"] };
    }
    next.config = nextConfig;
  }
  if (trait.sourceEntityDefinition) {
    next.sourceEntityDefinition = rewriteRoleLiteralsInEntity(trait.sourceEntityDefinition, roleFields, roles);
  }
  return next;
}

/**
 * Apply {@link rewriteRoleLiteralsInValue} across an entity's four access
 * policies. Twin of {@link rewriteEntityFieldsInEntity}'s policy walk.
 */
function rewriteRoleLiteralsInEntity(
  entity: Entity,
  roleFields: ReadonlyMap<string, readonly string[]>,
  roles: Readonly<Record<string, readonly string[]>>,
): Entity {
  if (roleFields.size === 0 || Object.keys(roles).length === 0) return entity;
  const rewrite = (v: unknown): unknown => rewriteRoleLiteralsInValue(v, roleFields, roles);
  return {
    ...entity,
    ...(entity.read_policy !== undefined
      ? { read_policy: rewrite(entity.read_policy) as typeof entity.read_policy }
      : {}),
    ...(entity.create_policy !== undefined
      ? { create_policy: rewrite(entity.create_policy) as typeof entity.create_policy }
      : {}),
    ...(entity.update_policy !== undefined
      ? { update_policy: rewrite(entity.update_policy) as typeof entity.update_policy }
      : {}),
    ...(entity.delete_policy !== undefined
      ? { delete_policy: rewrite(entity.delete_policy) as typeof entity.delete_policy }
      : {}),
  };
}

/**
 * Rename every relation TARGET (`EntityField.relation.entity`) reachable
 * from one field, recursing through array/object `items` and `properties`
 * — the only entity-name-bearing slot `EntityField` carries. Distinct from
 * {@link rewriteEntityFieldsInEntity}, which renames FIELD KEYS (the
 * `fields {}` override surface), not relation targets. Gap (A): an
 * imported entity's own `authorId`/`parentId`/`tagIds`-style relation
 * fields still named the upstream entity, tripping `ORB_E_INVALID_RELATION`
 * / `ORB_X_UNRESOLVED_RELATION_TARGET` (and the consequential
 * `ORB_S_OWNER_FIELD_NOT_IDENTITY_TYPED` once the owner field's relation no
 * longer resolves to an `[identity]` entity). `entityIds` (final entity name
 * → its OWN freshly materialized id) resets the dual-carry `entityId`
 * sibling to the RENAMED target's own id rather than leaving it pointing at
 * upstream's id — a stale upstream id there resolves to upstream's
 * un-prefixed name and trips `ORB_ID_NAME_MISMATCH` against the just-renamed
 * `.entity` (Gap F). Only touched when the target name IS in `entitySubs`
 * (i.e. is part of THIS materialized closure); a target missing from
 * `entityIds` there (should not happen within one closure) drops the id
 * sibling rather than leaving it dangling — `entityId` is optional
 * (pre-Phase-7). JS twin of the Rust `rename_relation_targets_in_fields`
 * (`orbital-compiler/src/phases/inline/orbital.rs`).
 */
function renameRelationTargetsInField(
  field: EntityField,
  entitySubs: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, EntityId>,
): EntityField {
  let next: EntityField = field;
  if (next.type === "relation") {
    const to = entitySubs.get(next.relation.entity);
    if (to !== undefined) {
      next = { ...next, relation: { ...next.relation, entity: to, entityId: entityIds.get(to) } };
    }
  }
  if ((next.type === "array" || next.type === "object") && next.items) {
    next = { ...next, items: renameRelationTargetsInField(next.items, entitySubs, entityIds) };
  }
  if (next.properties) {
    const nextProperties: Record<string, EntityField> = {};
    for (const [key, value] of Object.entries(next.properties)) {
      nextProperties[key] = renameRelationTargetsInField(value, entitySubs, entityIds);
    }
    next = { ...next, properties: nextProperties };
  }
  return next;
}

/**
 * Rename every relation target on an entity's `fields` in place (immutably)
 * — the primary/auxiliary-entity AND `sourceEntityDefinition` sibling of
 * {@link renameEntitiesInTrait}'s trait-scope rename. Takes the SAME
 * combined trait+entity `subs` map `materializeOrbitalRef` builds (a
 * relation target is always an entity NAME, and `subs` already maps every
 * renamed entity name — mixing in trait names is harmless since a
 * relation's `entity` value never collides with a trait name). `entityIds`
 * is the entity-scope-only name→id map (Gap F) — see
 * {@link renameRelationTargetsInField}.
 */
function renameEntityRelationTargets(
  entity: Entity,
  entitySubs: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, EntityId>,
): Entity {
  if (entitySubs.size === 0) return entity;
  return { ...entity, fields: entity.fields.map((f) => renameRelationTargetsInField(f, entitySubs, entityIds)) };
}

/**
 * Gap (B): a materialized trait's `sourceEntityDefinition` is a COPY of the
 * atom's own entity, stamped when the trait was originally inlined
 * (`sourceBehavior` + `sourceEntityDefinition` together record "this trait
 * came from an atom bound to entity X"). An orbital import is a CLONE of the
 * whole subsystem, not a re-host of it onto a foreign entity — so the cloned
 * trait's source entity must track the clone: rename its `.name` (and any
 * relation target it carries) through the SAME `subs` map used for
 * `linkedEntity`, so a trait whose atom-original entity coincided with the
 * upstream orbital's own entity (the common `PageAtom.traits.X -> Note`
 * shape, where the atom's own entity is ALSO named `Note`) still has
 * `sourceEntityDefinition.name === linkedEntity` post-import, exactly as it
 * did pre-import. Left un-renamed, the compiler's rebindability check
 * (`linkedEntity` vs `sourceEntityDefinition.name`) sees a spurious rebind
 * (source still named upstream's un-prefixed name, `linkedEntity` already
 * renamed) and fires `ORB_T_ENTITY_NOT_REBINDABLE` on traits that were never
 * a rebind at all. Does NOT touch `entityRebindable` or clear the field —
 * provenance and any genuine (pre-existing) rebind opt-in survive untouched.
 * JS twin of Rust's `rename_source_entity_definition`.
 */
function renameSourceEntityDefinition(
  trait: Trait,
  subs: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, EntityId>,
): Trait {
  const src = trait.sourceEntityDefinition;
  if (!src || subs.size === 0) return trait;
  const renamedName = subs.get(src.name) ?? src.name;
  const nextSrc = renameEntityRelationTargets({ ...src, name: renamedName }, subs, entityIds);
  return { ...trait, sourceEntityDefinition: nextSrc };
}

/**
 * Rename every payload field's `.entity` marker (B4-C's `PayloadField.entity`
 * / `EventPayloadField.entity` — stamped when an entity-typed payload field,
 * scalar OR array-of-entity, is flattened into `type: "object"`/`"[object]"`
 * + `properties`), recursing through `.properties` for object-typed fields.
 * One generic walk covers both payload-field shapes (`stateMachine.events[]`'s
 * `PayloadField` and `emits[]`'s `EventPayloadField`) since both carry the
 * same `entity?: string` + `properties?: readonly Self[]` surface.
 */
function renamePayloadEntity<T extends { entity?: string; properties?: readonly T[] }>(
  fields: readonly T[],
  rename: EntityRename,
): T[] {
  return fields.map((field) => {
    const renamedEntity = field.entity !== undefined ? rename(field.entity) : undefined;
    const renamedProps = field.properties ? renamePayloadEntity(field.properties, rename) : field.properties;
    return {
      ...field,
      ...(renamedEntity !== undefined ? { entity: renamedEntity } : {}),
      ...(renamedProps !== undefined ? { properties: renamedProps } : {}),
    };
  });
}

/**
 * Rename every payload-field `entity` marker across a trait's
 * `stateMachine.events[].payloadSchema[]` AND `emits[].payloadSchema[]` —
 * every entity-rename surface must cover this marker, or a composed trait
 * rebound to another entity (`-> Entity` via {@link applyLinkedEntityRename},
 * a pulled sibling riding the same call, or the orbital-import
 * materializer's `subs` via {@link renameEntitiesInTrait}) keeps describing
 * its OWN payload as the atom's original entity — verified against
 * `std-notes.orb`'s `NoteDelete` (`Confirmation.traits
 * .ConfirmActionConfirmation -> Note`), whose `DELETE.payloadSchema[row]
 * .entity` stayed `"ConfirmAction"` without this.
 */
function renamePayloadEntityMarkers(trait: Trait, rename: EntityRename): Trait {
  const sm = trait.stateMachine;
  // `sm.events` is undefined on some materialized traits despite the type
  // saying required (defensive, not a `?? []` coercion) — an absent events
  // array must stay absent, never become a fresh `[]` the parity comparator
  // then sees as a new field nobody asked for.
  const nextEvents = sm?.events
    ? sm.events.map((ev) =>
        ev.payloadSchema ? { ...ev, payloadSchema: renamePayloadEntity(ev.payloadSchema, rename) } : ev,
      )
    : undefined;
  const nextEmits = trait.emits
    ? trait.emits.map((em) =>
        em.payloadSchema ? { ...em, payloadSchema: renamePayloadEntity(em.payloadSchema, rename) } : em,
      )
    : undefined;
  return {
    ...trait,
    ...(sm && nextEvents ? { stateMachine: { ...sm, events: nextEvents } } : {}),
    ...(nextEmits ? { emits: nextEmits } : {}),
  };
}

/** Apply `renameEntityInEffect`/the collecting-rename variant to each value of a `listens[].payloadMapping` map. */
function walkEntityInPayloadMapping(
  payloadMapping: NonNullable<TraitEventListener["payloadMapping"]>,
  rename: EntityRename,
  props: ReadonlySet<string>,
): NonNullable<TraitEventListener["payloadMapping"]> {
  const next: { [k: string]: unknown } = {};
  for (const [key, value] of Object.entries(payloadMapping)) {
    next[key] = renameEntityInEffect(value, rename, props);
  }
  return next as NonNullable<TraitEventListener["payloadMapping"]>;
}

/**
 * Rename every entity NAME in `entitySubs` (`old → new`) across a trait's
 * `linkedEntity` and every bare entity-name literal its guards AND effects
 * carry — transition guards/effects, tick guards/effects, and listens
 * guard/payloadMapping (two-path parity with the compiled path's
 * `rename_entities_in_trait`, which walks the same six surfaces via
 * `rewrite_identifiers`). Generalizes {@link applyLinkedEntityRename}'s
 * single-name call-site rebind (built from the same
 * `renameEntityInEffects`/`REBIND_ENTITY_PROPS` primitives it uses) to the
 * whole primary+auxiliary entity set an orbital import renames at once —
 * `applyLinkedEntityRename` itself is untouched and still drives the
 * ordinary trait-ref `-> Entity` rebind path.
 */
function renameEntitiesInTrait(trait: Trait, entitySubs: ReadonlyMap<string, string>): Trait {
  if (entitySubs.size === 0) return trait;
  const rename: EntityRename = (name) => entitySubs.get(name);
  // `renameEntityInEffect`'s POSITION table (fetch/persist/ref/deref/spawn
  // argument slots, render-ui props) only ever sees a BARE entity-name
  // string literal ("Other"). A guard/effect reading the entity's own
  // currently-bound row via a `@Other.name` BINDING token carries the name
  // PREFIXED with `@` — a shape no position rule recognizes, so it survived
  // the entities{} substitution unrewritten (Rust's `visit_entity_slots`
  // catches this generically; the position-only walker did not — found via
  // `orbital_import_stage_b` fixture parity). Run as a second, order-
  // independent pass over the SAME surfaces (`@trait.X`'s embed-token
  // rewrite is the sibling of this, `renameTraitEmbedsInValue`).
  const withTokens = <T>(value: T): T => renameEntityNameTokensInValue(value, entitySubs) as T;
  const nextLinked =
    trait.linkedEntity !== undefined ? (entitySubs.get(trait.linkedEntity) ?? trait.linkedEntity) : trait.linkedEntity;
  const sm = trait.stateMachine;
  const nextTransitions = sm?.transitions
    ? sm.transitions.map((t) => ({
        ...t,
        ...(t.guard !== undefined ? { guard: withTokens(renameEntityInEffect(t.guard, rename, REBIND_ENTITY_PROPS)) as typeof t.guard } : {}),
        effects: t.effects
          ? withTokens(renameEntityInEffects(t.effects as readonly unknown[], rename, REBIND_ENTITY_PROPS)) as typeof t.effects
          : t.effects,
      }))
    : sm?.transitions;
  const nextTicks = trait.ticks
    ? trait.ticks.map((tick) => ({
        ...tick,
        ...(tick.guard !== undefined
          ? { guard: withTokens(renameEntityInEffect(tick.guard, rename, REBIND_ENTITY_PROPS)) as typeof tick.guard }
          : {}),
        effects: withTokens(renameEntityInEffects(
          tick.effects as readonly unknown[],
          rename,
          REBIND_ENTITY_PROPS,
        )) as typeof tick.effects,
      }))
    : trait.ticks;
  const nextListens = trait.listens
    ? trait.listens.map((l) => ({
        ...l,
        ...(l.guard !== undefined ? { guard: withTokens(renameEntityInEffect(l.guard, rename, REBIND_ENTITY_PROPS)) as typeof l.guard } : {}),
        ...(l.payloadMapping
          ? { payloadMapping: withTokens(walkEntityInPayloadMapping(l.payloadMapping, rename, REBIND_ENTITY_PROPS)) as typeof l.payloadMapping }
          : {}),
      }))
    : trait.listens;
  const nextInitial = trait.initialEffects
    ? withTokens(renameEntityInEffects(
        trait.initialEffects as readonly unknown[],
        rename,
        REBIND_ENTITY_PROPS,
      )) as typeof trait.initialEffects
    : trait.initialEffects;
  return renamePayloadEntityMarkers(
    {
      ...trait,
      linkedEntity: nextLinked,
      ...(sm ? { stateMachine: { ...sm, transitions: nextTransitions ?? [] } } : {}),
      ...(nextTicks !== undefined ? { ticks: nextTicks } : {}),
      ...(nextListens !== undefined ? { listens: nextListens } : {}),
      ...(nextInitial !== undefined ? { initialEffects: nextInitial } : {}),
    },
    rename,
  );
}

/**
 * Rewrite `Trait.entityRefIds` (the V4 leverage-id side-map: token NAME →
 * the entity's stable id) the same way every body token {@link
 * renameEntitiesInTrait}/{@link applyLinkedEntityRename} just renamed: a
 * key naming an entity `entitySubs` renamed becomes the RENAMED name; EVERY
 * key (renamed or not) then has its value refreshed to that (possibly
 * renamed) name's CURRENT id in `entityIds` (the same map the
 * `linkedEntityId` re-stamp at the orbital-import call site reads) — never
 * the stale id the map originally carried.
 *
 * The by-name lookup runs even for a key `entitySubs` does not touch: a
 * SECONDARY reference whose name happens to be unchanged between the atom
 * and the consumer (no rename, so `entitySubs` never carries an entry for
 * it) can still be a DIFFERENT declaration with a DIFFERENT id — std-wiki's
 * `WikiAttachmentList = PageAtom.traits.WikiAttachmentList -> WikiAttachment`
 * next to its OWN `entityRefIds[WikiPage]`, foreign to a consumer that
 * ALSO happens to declare a `WikiPage`. A name `entityIds` does not know at
 * all keeps its old id — the only honest choice left. Two-path parity twin
 * of Rust's `rewrite_entity_ref_ids` (`orbital-compiler/src/phases/inline/
 * rewrite.rs`), called from the SAME sites: the orbital-import materializer
 * (after {@link renameEntitiesInTrait}) and the ordinary trait-ref
 * `-> Entity` rebind (after {@link applyLinkedEntityRename}). Without this,
 * `entityRefIds` goes stale post-rename — its keys keep naming an entity
 * the trait no longer declares and its values keep pointing at that
 * entity's OLD id, both of which {@link resolveEntityTokensById} (the
 * id-first reader) and the compiled twin's `identity_normalize.rs` assume
 * never happens.
 */
function rewriteEntityRefIds(
  trait: Trait,
  entitySubs: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, EntityId>,
): Trait {
  const refs = trait.entityRefIds;
  if (!refs) return trait;
  const out: Record<string, EntityId> = {};
  for (const [from, oldId] of Object.entries(refs)) {
    const name = entitySubs.get(from) ?? from;
    out[name] = entityIds.get(name) ?? oldId;
  }
  return { ...trait, entityRefIds: out };
}

/**
 * The alias-scoped extra substitution {@link
 * ReferenceResolver.buildAliasEntityRenames} computes, applied to ONE
 * resolved trait pulled from that same alias — JS twin of the
 * `alias_entity_renames` APPLICATION block in Rust's `inline/trait.rs`
 * (right after `apply_overrides_to_trait`, same `subs`). Deliberately
 * narrower than {@link renameEntitiesInTrait}: only transitions
 * guard/effects, ticks guard/effects, and `entityRefIds` — NOT
 * `linkedEntity`, listens, `initialEffects`, or payload markers, matching
 * Rust's own scope exactly. This trait's OWN primary binding is untouched;
 * only a SECONDARY, positional reference this trait's own rebind never
 * touched follows a SIBLING pull's rebind from the same alias.
 */
function applyAliasEntityRenames(
  trait: Trait,
  subs: ReadonlyMap<string, string>,
  entityIds: ReadonlyMap<string, EntityId>,
): Trait {
  if (subs.size === 0) return trait;
  const rename: EntityRename = (name) => subs.get(name);
  const withTokens = <T>(value: T): T => renameEntityNameTokensInValue(value, subs) as T;
  const sm = trait.stateMachine;
  const nextTransitions = sm?.transitions
    ? sm.transitions.map((t) => ({
        ...t,
        ...(t.guard !== undefined
          ? { guard: withTokens(renameEntityInEffect(t.guard, rename, REBIND_ENTITY_PROPS)) as typeof t.guard }
          : {}),
        effects: t.effects
          ? (withTokens(renameEntityInEffects(t.effects as readonly unknown[], rename, REBIND_ENTITY_PROPS)) as typeof t.effects)
          : t.effects,
      }))
    : sm?.transitions;
  const nextTicks = trait.ticks
    ? trait.ticks.map((tick) => ({
        ...tick,
        ...(tick.guard !== undefined
          ? { guard: withTokens(renameEntityInEffect(tick.guard, rename, REBIND_ENTITY_PROPS)) as typeof tick.guard }
          : {}),
        effects: withTokens(
          renameEntityInEffects(tick.effects as readonly unknown[], rename, REBIND_ENTITY_PROPS),
        ) as typeof tick.effects,
      }))
    : trait.ticks;
  const next: Trait = {
    ...trait,
    ...(sm ? { stateMachine: { ...sm, transitions: nextTransitions ?? [] } } : {}),
    ...(nextTicks !== undefined ? { ticks: nextTicks } : {}),
  };
  return rewriteEntityRefIds(next, subs, entityIds);
}

/**
 * Collect every entity NAME in `candidates` reachable from a trait's guards
 * + effects (transitions, ticks, listens guard/payloadMapping) — the
 * read-only twin of {@link renameEntitiesInTrait}, built through the SAME
 * position-based walker (`renameEntityInEffect`/`renameEntityInEffects`
 * with a rename callback that records a hit and returns `undefined`, so
 * nothing is actually replaced) rather than a second, independently
 * maintained position table. Used to compute an imported orbital's
 * "referenced out-of-orbital entities" set for `entities {}` validation.
 */
function collectEntityNamesInTrait(trait: Trait, candidates: ReadonlySet<string>): Set<string> {
  const collected = new Set<string>();
  const collect: EntityRename = (name) => {
    if (candidates.has(name)) collected.add(name);
    return undefined;
  };
  const sm = trait.stateMachine;
  for (const t of sm?.transitions ?? []) {
    if (t.guard !== undefined) renameEntityInEffect(t.guard, collect, REBIND_ENTITY_PROPS);
    if (t.effects) renameEntityInEffects(t.effects as readonly unknown[], collect, REBIND_ENTITY_PROPS);
  }
  for (const tick of trait.ticks ?? []) {
    if (tick.guard !== undefined) renameEntityInEffect(tick.guard, collect, REBIND_ENTITY_PROPS);
    renameEntityInEffects(tick.effects as readonly unknown[], collect, REBIND_ENTITY_PROPS);
  }
  for (const l of trait.listens ?? []) {
    if (l.guard !== undefined) renameEntityInEffect(l.guard, collect, REBIND_ENTITY_PROPS);
    if (l.payloadMapping) walkEntityInPayloadMapping(l.payloadMapping, collect, REBIND_ENTITY_PROPS);
  }
  if (trait.initialEffects) {
    renameEntityInEffects(trait.initialEffects as readonly unknown[], collect, REBIND_ENTITY_PROPS);
  }
  return collected;
}

/**
 * Every relation TARGET in `candidates` reachable from `fields`, recursing
 * through array/object `items`/`properties` — the read-only twin of
 * {@link renameRelationTargetsInField} used for `entities {}` "referenced"
 * detection.
 */
function collectRelationTargets(field: EntityField, candidates: ReadonlySet<string>, out: Set<string>): void {
  if (field.type === "relation" && candidates.has(field.relation.entity)) out.add(field.relation.entity);
  if ((field.type === "array" || field.type === "object") && field.items) {
    collectRelationTargets(field.items, candidates, out);
  }
  if (field.properties) {
    for (const value of Object.values(field.properties)) collectRelationTargets(value, candidates, out);
  }
}

/** Every relation target of an entity's own `fields` that is in `candidates`. */
function relationTargetsOfEntity(entity: Entity, candidates: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const field of entity.fields) collectRelationTargets(field, candidates, out);
  return out;
}

/**
 * Point a materialised trait's `listens[].source` at its rebound name.
 * Extracted from the sibling-pull pass's owner-scoped listens rewrite so
 * both it and {@link ReferenceResolver.materializeOrbitalRef} share one
 * implementation (refactor, not duplication — sibling-pull's own collision
 * behaviour is unchanged, it just calls through this now).
 *
 * `orbitalRename`, when given, additionally repoints a `ListenSource` of
 * kind `"orbital"` whose `orbital` matches `orbitalRename.from` at the local
 * orbital name — the 3-part `Orbital.Trait.EVENT` form, which sibling-pull
 * never needed (a pulled sibling's owner is always the SAME orbital).
 */
function rewriteListenSources(
  trait: Trait,
  subs: ReadonlyMap<string, string>,
  idByName: ReadonlyMap<string, TraitId | undefined>,
  orbitalRename?: { from: string; to: string },
): Trait {
  const listens = trait.listens;
  if (!listens || listens.length === 0) return trait;
  let changed = false;
  const nextListens = listens.map((listen) => {
    const source = listen.source;
    if (!source) return listen;
    if (source.kind === "trait") {
      const target = subs.get(source.trait);
      if (target === undefined || target === source.trait) return listen;
      changed = true;
      const traitId = idByName.get(target);
      return {
        ...listen,
        source: { kind: "trait" as const, trait: target, ...(traitId ? { traitId } : {}) },
      };
    }
    if (source.kind === "orbital" && orbitalRename && source.orbital === orbitalRename.from) {
      const targetTrait = subs.get(source.trait) ?? source.trait;
      changed = true;
      const traitId = idByName.get(targetTrait);
      return {
        ...listen,
        source: {
          kind: "orbital" as const,
          orbital: orbitalRename.to,
          trait: targetTrait,
          ...(traitId ? { traitId } : {}),
        },
      };
    }
    return listen;
  });
  return changed ? { ...trait, listens: nextListens } : trait;
}

/** `EntityRef` narrowed to the inline `Entity` shape (neither a string ref nor an `EntityCall`). */
function isInlineEntity(ref: EntityRef): ref is Entity {
  return !isEntityReference(ref) && !isEntityCall(ref);
}

/** One orbital's own inline entities: the primary plus any auxiliaries. */
function inlineEntityRefsOf(orbital: OrbitalDefinition): Entity[] {
  return [orbital.entity, ...(orbital.auxiliaryEntities ?? [])].filter(isInlineEntity);
}

/**
 * (C) JS twin of the compiled path's `InlineContext::get_entity_by_name_for_alias`
 * — scan every orbital of ONE alias (`importedOrbitals(imported)`) for a
 * primary or auxiliary entity named `entityName`. Feeds
 * {@link ReferenceResolver.pullSiblingTraits}'s aux-entity carry (mirrors
 * the compiled path's `pulled_aux_entities`).
 */
function entityByNameForAlias(
  imports: ResolvedImports,
  alias: string,
  entityName: string,
): Entity | undefined {
  const imported = imports.orbitals.get(alias);
  if (!imported) return undefined;
  for (const o of importedOrbitals(imported)) {
    const found = inlineEntityRefsOf(o).find((e) => e.name === entityName);
    if (found) return found;
  }
  return undefined;
}

/**
 * JS twin of `InlineContext::get_entity_by_name_any_alias` — the SAME
 * lookup across EVERY loaded alias, sorted for determinism (two aliases can
 * expose the same entity name; the pick must not depend on `Map` iteration
 * order).
 */
function entityByNameAnyAlias(imports: ResolvedImports, entityName: string): Entity | undefined {
  const aliases = Array.from(imports.orbitals.keys()).sort();
  for (const alias of aliases) {
    const found = entityByNameForAlias(imports, alias, entityName);
    if (found) return found;
  }
  return undefined;
}

/**
 * A parsed `Alias.traits.TraitName`-style trait ref's target — the trait
 * entry it names, and the owning orbital that declares it (searched across
 * every orbital {@link importedOrbitals} of the alias). `undefined` when
 * the entry doesn't resolve to an INLINE entity (a reference-form entity
 * needs its own resolve first — out of scope for both callers below).
 */
interface OwnedTraitEntry {
  readonly owner: OrbitalDefinition;
  /** `owner.entity`, already narrowed inline — `owner`'s own field stays the
   *  wider `EntityRef` (a fresh read off it loses the narrowing). */
  readonly ownerEntity: Entity;
  readonly entry: Exclude<TraitRef, string> | null;
}

function ownedTraitEntryFor(
  imports: ResolvedImports,
  alias: string,
  traitName: string,
): OwnedTraitEntry | undefined {
  const imported = imports.orbitals.get(alias);
  if (!imported) return undefined;
  const owner = importedOrbitals(imported).find(
    (o) => findTraitEntryInOrbital(o, traitName) !== null,
  );
  if (!owner || !isInlineEntity(owner.entity)) return undefined;
  return { owner, ownerEntity: owner.entity, entry: findTraitEntryInOrbital(owner, traitName) };
}

/**
 * JS twin of the compiled path's `InlineContext::get_bound_entity_for_trait_
 * orbital` — the imported trait's OWN bound entity (its atom's declared
 * `linkedEntity`, resolved within the owning orbital's own entity set),
 * independent of any call-site rebind; falls back to the owner orbital's own
 * primary when the declared name doesn't resolve within its own set. Also
 * surfaces the resolved entry's own `entityContract.requires` (when the
 * entry is an inline trait) — twin of the `resolved_trait.entity_contract`
 * lookup `merge_imported_entity_fields`'s caller makes alongside this same
 * bound-entity resolution (`inline/mod.rs`), read by
 * {@link mergeImportedEntityFieldsIntoOrbital} so a required DATA field is
 * never silently masked by an auto-merge.
 */
function boundTraitOrbitalBinding(
  imports: ResolvedImports,
  alias: string,
  traitName: string,
):
  | {
      readonly owner: OrbitalDefinition;
      /** `owner`'s own primary entity, already narrowed (see {@link OwnedTraitEntry.ownerEntity}). */
      readonly ownerEntity: Entity;
      readonly entity: Entity;
      readonly requiredData: ReadonlySet<string>;
    }
  | undefined {
  // Prefer the alias's OWN fully-resolved orbitals ({@link
  // ReferenceResolver.preResolveImportFile}'s cache) — the SAME entity
  // object that alias's own `resolve()` call already ran {@link
  // mergeImportedEntityFieldsIntoOrbital} against, so a TRANSITIVELY
  // composed atom's fields are already merged in (`PageAtom.traits.WikiDoc`'s
  // own `RecordDetail.traits.RecordItemDetail -> WikiPage`, two `uses` hops
  // up from this call — mirrors Rust's recursive `inline_orbital` fully
  // resolving every `uses` alias before registering it, `inline/mod.rs:
  // 1001-1017`). `entry.linkedEntity` still names the bound entity — the RAW
  // pre-resolve field, unaffected by pre-resolution — but the entity object
  // it resolves against is the POST-merge one. Best-effort: falls through to
  // the raw walk below when pre-resolution is unavailable for this alias,
  // exactly like every other {@link ResolvedImport.resolvedOrbitals} reader.
  const imported = imports.orbitals.get(alias);
  if (imported?.resolvedOrbitals) {
    for (const ro of imported.resolvedOrbitals) {
      const entry = findTraitEntryInOrbital(ro.original, traitName);
      if (!entry) continue;
      const bound = entry.linkedEntity;
      const resolvedEntities = [ro.entity, ...(ro.auxiliaryEntities ?? [])];
      const boundEntity = bound !== undefined ? resolvedEntities.find((e) => e.name === bound) : undefined;
      const requiredData = new Set<string>(
        ro.traits.find((rt) => rt.trait.name === traitName)?.trait.entityContract?.requires ?? [],
      );
      return { owner: ro.original, ownerEntity: ro.entity, entity: boundEntity ?? ro.entity, requiredData };
    }
  }

  const owned = ownedTraitEntryFor(imports, alias, traitName);
  if (!owned) return undefined;
  const ownerEntities = inlineEntityRefsOf(owned.owner);
  const bound = owned.entry?.linkedEntity;
  const boundEntity = bound !== undefined ? ownerEntities.find((e) => e.name === bound) : undefined;
  const requiredData = new Set<string>(
    owned.entry && "stateMachine" in owned.entry ? (owned.entry as Trait).entityContract?.requires ?? [] : [],
  );
  // No bound name resolves within the owner's own entity set → fall back to
  // the owner's OWN primary (mirrors the compiled path's unconditional tail).
  return { owner: owned.owner, ownerEntity: owned.ownerEntity, entity: boundEntity ?? owned.ownerEntity, requiredData };
}

/**
 * (C) JS twin of the compiled path's "Gap #22" pass (`inline_orbital`, mod.rs):
 * a TOP-LEVEL `{ref}` trait entry that imports an atom WITHOUT rebinding
 * `linkedEntity` (no `-> Entity` override at THIS call site) keeps the
 * atom's OWN bound entity as its bound entity once resolved — but this
 * orbital's own `entity` field can only carry ONE primary, so surface the
 * atom's bound entity into `auxiliaryEntities` (deduped by the caller) so a
 * later orbital-import's unconditional prefix rename actually covers it.
 * The imported orbital's OWN aux entities travel too, REGARDLESS of rebind
 * (a multi-entity atom's trait body fetches/persists its sibling entities
 * by name). Runs over the RAW (pre-resolve) `orbital.traits` list —
 * independent of {@link ReferenceResolver.pullSiblingTraits}, which only
 * carries a TRANSITIVELY-embedded sibling's entity, never a top-level
 * declared `{ref}` entry's own (found via the `orbital_import_disjoint.lolo`
 * id-integrity gate: `std-crm`'s un-rebound `PipelineStats =
 * Stats.traits.StatsItemStats` left `StatsItem` undeclared even after the
 * sibling-pull carry).
 */
function auxEntitiesFromUnrebindTraitRefs(
  orbitalTraits: readonly TraitRef[],
  imports: ResolvedImports,
): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<string>();
  const push = (e: Entity): void => {
    if (!seen.has(e.name)) {
      seen.add(e.name);
      out.push(e);
    }
  };
  for (const tr of orbitalTraits) {
    let ref: string | undefined;
    let linkedEntity: string | undefined;
    if (typeof tr === "string") {
      ref = tr;
    } else if ("ref" in tr) {
      ref = tr.ref;
      linkedEntity = tr.linkedEntity;
    } else {
      continue; // inline trait — nothing imported to surface
    }
    const parsed = parseImportedTraitRef(ref);
    if (!parsed) continue;
    const binding = boundTraitOrbitalBinding(imports, parsed.alias, parsed.traitName);
    if (!binding) continue;

    if (linkedEntity === undefined) {
      push(binding.entity);
    }

    // The imported orbital's OWN aux entities travel too, rebind or not.
    for (const e of inlineEntityRefsOf(binding.owner)) {
      if (e.name !== binding.ownerEntity.name) push(e);
    }
  }
  return out;
}

/**
 * JS twin of `rewrite_self_relation_target` (`orbital-compiler/src/phases/
 * inline/entity.rs`) — retargets a self-referential `relation.entity` (and
 * its dual-carry `relation.entityId`) from the imported entity's own name to
 * the merge target's, recursing into array/object `items` and object
 * `properties` so a nested relation (an object field's own relation) is
 * rewritten too. Only relations whose target equals `oldName` (the imported
 * entity's own name) change. Mutates `field` in place.
 */
function rewriteSelfRelationTarget(
  field: EntityField,
  oldName: string,
  newName: string,
  newId: EntityId | undefined,
): void {
  if (field.type === "relation" && field.relation.entity === oldName) {
    field.relation = { ...field.relation, entity: newName, entityId: newId };
  }
  if (field.type === "array" && field.items) {
    rewriteSelfRelationTarget(field.items, oldName, newName, newId);
  }
  if (field.type === "object" && field.items) {
    rewriteSelfRelationTarget(field.items, oldName, newName, newId);
  }
  if (field.properties) {
    for (const key of Object.keys(field.properties)) {
      rewriteSelfRelationTarget(field.properties[key], oldName, newName, newId);
    }
  }
}

/**
 * JS twin of `merge_imported_entity_fields` (`orbital-compiler/src/phases/
 * inline/entity.rs`) — auto-merges the imported behavior's canonical entity
 * fields INTO the caller's entity. For each field in `importedEntity`, if
 * `callerEntity` doesn't already have a field with that name, add it
 * (caller's fields win on name collision). `intrinsicOnly` carries ONLY
 * fields the atom marked `@intrinsic` in `.lolo` (the no-rebind, same-name
 * depth-propagation case); `requiredData` (the trait's own
 * `entityContract.requires`) is NEVER auto-merged unless the field is itself
 * intrinsic — a required DATA read must be satisfied by the target, not
 * silently masked by a merge. Mutates `callerEntity.fields` in place.
 */
function mergeImportedEntityFields(
  callerEntity: Entity,
  importedEntity: Entity,
  intrinsicOnly: boolean,
  requiredData: ReadonlySet<string>,
): void {
  const existingNames = new Set(
    callerEntity.fields.map((f) => f.name).filter((n): n is string => n !== undefined),
  );
  const oldName = importedEntity.name;
  const newName = callerEntity.name;
  const newId = callerEntity.id;
  for (const field of importedEntity.fields) {
    if (intrinsicOnly && field.intrinsic !== true) continue;
    if (field.name === undefined) continue;
    if (requiredData.has(field.name) && field.intrinsic !== true) continue;
    if (existingNames.has(field.name)) continue;
    const cloned = structuredClone(field);
    rewriteSelfRelationTarget(cloned, oldName, newName, newId);
    callerEntity.fields.push(cloned);
  }
}

/**
 * JS twin of the compiled path's "Auto-merge imported entity fields
 * (GAP-AGB-MOLECULE-ENTITY-CONTRACT)" pass (`orbital-compiler/src/phases/
 * inline/mod.rs`, ~line 1044) — runs BEFORE entity/trait resolution, exactly
 * like Rust, so a composed atom's field contract (an explicit `-> Entity`
 * rebind's FULL field set, or a no-rebind same-name atom's `@intrinsic`-only
 * fields) is present on the entity object every later phase — including
 * {@link resolveOrbitalTypeParamSentinels} — reads. Two cases carry the
 * imported entity's fields onto the caller entity: (a) an explicit
 * `linkedEntity` rebind (any target), and (b) NO rebind, but the imported
 * trait's own bound entity NAME equals the caller entity name (the depth-
 * propagation fix: an organism importing a self-contained widget atom
 * WITHOUT rebinding still reads the trait's intrinsic `@entity.X` fields
 * against its own same-named entity). The rebind target is honored — primary
 * or a matching AUTHOR-DECLARED auxiliary — falling back to the primary when
 * the name matches neither; a rebind target that is an IMPORTED aux entity
 * (surfaced by {@link auxEntitiesFromUnrebindTraitRefs} below, not yet
 * computed at this point) is a known Rust limitation too, mirrored here
 * unchanged. Mutates `entity`/`declaredAuxEntities` members in place.
 */
function mergeImportedEntityFieldsIntoOrbital(
  orbitalTraits: readonly TraitRef[],
  entity: Entity,
  declaredAuxEntities: readonly Entity[],
  imports: ResolvedImports,
): void {
  interface PendingMerge {
    readonly target: string | undefined;
    readonly imported: Entity;
    readonly intrinsicOnly: boolean;
    readonly requiredData: ReadonlySet<string>;
  }
  const mergedAliases = new Set<string>();
  const pending: PendingMerge[] = [];

  for (const tr of orbitalTraits) {
    let ref: string | undefined;
    let linkedEntity: string | undefined;
    if (typeof tr === "string") {
      ref = tr;
    } else if ("ref" in tr) {
      ref = tr.ref;
      linkedEntity = tr.linkedEntity;
    } else {
      continue; // inline trait — nothing imported to merge
    }
    const parsed = parseImportedTraitRef(ref);
    if (!parsed) continue;
    const binding = boundTraitOrbitalBinding(imports, parsed.alias, parsed.traitName);
    if (!binding) continue;

    const carriesFields = linkedEntity !== undefined ? true : binding.entity.name === entity.name;
    if (!carriesFields) continue;

    const key = `${parsed.alias} ${parsed.traitName}`;
    if (mergedAliases.has(key)) continue;
    mergedAliases.add(key);

    pending.push({
      target: linkedEntity,
      imported: binding.entity,
      intrinsicOnly: linkedEntity === undefined,
      requiredData: binding.requiredData,
    });
  }

  for (const pm of pending) {
    const auxTarget =
      pm.target !== undefined && pm.target !== entity.name
        ? declaredAuxEntities.find((e) => e.name === pm.target)
        : undefined;
    mergeImportedEntityFields(auxTarget ?? entity, pm.imported, pm.intrinsicOnly, pm.requiredData);
  }
}

/**
 * Consumer entity NAME → its own already-materialized id, spanning every
 * orbital the schema declares (both primaries and auxiliaries) — the
 * `entities {}` retarget's lookup for "does the consumer actually have an
 * entity by this name, and what id does it already carry" (an out-of-orbital
 * relation retargets to a REAL consumer entity, not a freshly derived one).
 * Computed once per {@link ReferenceResolver.resolveOrbitalImports} call,
 * over the schema's ORIGINAL (pre-flatten) orbitals — the entities an
 * `entities {}` map retargets to are always inline elsewhere in the same
 * schema, independent of import-flattening order.
 */
function consumerEntityIdsOf(orbitals: readonly OrbitalDefinition[]): Map<string, EntityId> {
  const out = new Map<string, EntityId>();
  for (const orbital of orbitals) {
    for (const entity of inlineEntityRefsOf(orbital)) {
      if (entity.id) out.set(entity.name, entity.id);
    }
  }
  return out;
}

/**
 * (B) The materialized NAME and derived ID of an `orbital X =
 * Alias.orbitals.Y { … }` reference's PRIMARY entity — computed BEFORE any
 * other part of the reference resolves. JS twin of the compiled path's
 * `materialized_primary_entity` (`orbital-compiler/src/phases/inline/orbital.rs`).
 * One owner, used by {@link ReferenceResolver.materializeOrbitalRef} itself
 * AND by {@link precomputeReferenceFormPrimaryIds}'s pre-pass, which needs
 * this SAME pair for every reference-form orbital in the schema —
 * INCLUDING ones not yet resolved — so `consumerEntityIdsOf` can already
 * `entities {}`-map onto them, order-free across sibling imports (the
 * approved two-import Project Friday shape).
 */
function materializedPrimaryEntity(
  upstreamEntity: Entity,
  upstreamOrbitalId: string | undefined,
  ref: { readonly entity?: string },
  localName: string,
): { name: string; id: EntityId } {
  const name = ref.entity ?? `${localName}${upstreamEntity.name}`;
  const id = asEntityId(
    deriveMaterializedId(upstreamEntity.id, upstreamOrbitalId, upstreamEntity.name, localName, "entity"),
  );
  return { name, id };
}

/** {@link applyExtendFields}'s return shape. */
interface ExtendFieldsResult {
  readonly entity: Entity;
  readonly errors: string[];
}

/**
 * L-J `extend { … }` — append the reference body's ADDED entity fields to
 * the (already renamed) primary entity, JS twin of the compiled path's
 * post-`field_subs` splice in `resolve_orbital_reference`. A relation-typed
 * added field's target resolves in the CONSUMER's own scope (never
 * upstream's) via `consumerEntityIds` — the same schema-wide map
 * `entities {}` retargeting already reads. Refuses (does not append) a name
 * already on the upstream primary after `fields {}` renames, or equal to a
 * rename TARGET — `ORB_O_EXTEND_FIELD_COLLISION`, appended to `errors`. The
 * "added field never read" case is a `orb validate` WARNING (Rust-only,
 * mirrored in JS by a `lintWiring` finding, not a resolve-time refusal).
 */
function applyExtendFields(
  entity: Entity,
  extend: readonly EntityField[] | undefined,
  fieldSubs: ReadonlyMap<string, string>,
  consumerEntityIds: ReadonlyMap<string, EntityId>,
  localName: string,
): ExtendFieldsResult {
  if (!extend || extend.length === 0) return { entity, errors: [] };
  const errors: string[] = [];
  const taken = new Set<string>(entity.fields.map((f) => f.name).filter((n): n is string => Boolean(n)));
  for (const target of fieldSubs.values()) taken.add(target);
  const added: EntityField[] = [];
  for (const field of extend) {
    const name = field.name;
    if (!name) continue;
    if (taken.has(name)) {
      errors.push(
        `Orbital "${localName}" declares extend field "${name}" but the upstream primary entity already has a ` +
          `field of that name after "fields {}" renames (ORB_O_EXTEND_FIELD_COLLISION)`,
      );
      continue;
    }
    taken.add(name);
    if (field.type === "relation" && !field.relation.entityId) {
      const targetId = consumerEntityIds.get(field.relation.entity);
      added.push(targetId ? { ...field, relation: { ...field.relation, entityId: targetId } } : field);
      continue;
    }
    added.push(field);
  }
  if (added.length === 0) return { entity, errors };
  return { entity: { ...entity, fields: [...entity.fields, ...added] }, errors };
}

/**
 * Deterministic id for a materialised node, rooted in the source node's own
 * id when it has one (`deriveId` then keeps that id's kind — trait stays
 * trait, entity stays entity). When the source has no id yet (pre-Phase-7,
 * common today — see `docs/Almadar_Orbital_Import.md` and CLAUDE.md's V4
 * dual-carry note), the fallback seed string is PREFIXED with `kind`'s own
 * id prefix (`idPrefix`) rather than chaining `deriveId` straight off
 * `upstream.id`: `deriveId` inherits the KIND of whatever parent id it's
 * given, and `upstream.id` is orbital-kind (`orb_`), so feeding it in
 * directly would stamp a trait/entity with an orbital-kind id. Fixed
 * 2026-09-06 (was a bare, unprefixed seed string, so `idKindOf` never
 * recognized it and `deriveId` silently fell back to ITS OWN default,
 * `'trait'` — every entity/page materialized this way threw
 * `asEntityId`/`asPageId`'s prefix check; `materializeOrbitalRef`'s own
 * `finalAuxEntities`/primary-entity derivation never exercised a fixture
 * missing a real id until now).
 */
function deriveMaterializedId(sourceId: string | undefined, upstreamOrbitalId: string | undefined, sourceName: string, localName: string, kind: IdKind): string {
  const parent = sourceId ?? `${idPrefix(kind)}orbital-import-seed:${upstreamOrbitalId ?? "no-orbital-id"}:${sourceName}`;
  return deriveId(parent, localName);
}

/** Segments of a URL path, ignoring empty leading/trailing slashes. */
function navigatePathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * The prefix a `str/concat`-built navigate target can be compared against: a
 * page path with its trailing `:param` segment stripped. Mirrors
 * `paramStrippedPrefix` in `packages/almadar-verify/src/observer/wiring-lint.ts`'s
 * `navigate-target-undeclared` check (only a TRAILING param segment yields a
 * prefix; a mid-path param has none).
 */
function navigateParamStrippedPrefix(path: string): string | undefined {
  const segments = navigatePathSegments(path);
  const last = segments[segments.length - 1];
  if (last === undefined || !last.startsWith(":")) return undefined;
  return `/${segments.slice(0, -1).join("/")}/`;
}

/**
 * The local prefix a `str/concat`-built navigate target's literal head
 * rewrites to, given the upstream→local page-path map — an EXACT match of
 * `navigateParamStrippedPrefix` against an upstream page's path (unlike the
 * lint's fuzzier either-direction `startsWith`, which only needs to flag a
 * finding, not pick a single replacement).
 */
function rewriteConcatPrefix(literalPrefix: string, pathMap: ReadonlyMap<string, string>): string | undefined {
  const normalized = literalPrefix.endsWith("/") ? literalPrefix : `${literalPrefix}/`;
  for (const [upstreamPath, finalPath] of pathMap) {
    const stripped = navigateParamStrippedPrefix(upstreamPath);
    if (stripped === undefined || stripped !== normalized) continue;
    const finalStripped = navigateParamStrippedPrefix(finalPath);
    if (finalStripped !== undefined) return finalStripped;
  }
  return undefined;
}

/**
 * Rewrite `(navigate "<upstream>")` literals — all three arities — against
 * an upstream→local page-path map. New: no existing helper rewrites
 * navigate targets (the compiled path's `rewrite_navigate_targets` has not
 * landed yet either — W3-R is a sibling, not-yet-shipped work item).
 */
function rewriteNavigateTargets(node: unknown, pathMap: ReadonlyMap<string, string>): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    if (node[0] === "navigate" && node.length >= 2) {
      const target = node[1];
      if (typeof target === "string" && pathMap.has(target)) {
        return [node[0], pathMap.get(target)!, ...node.slice(2).map((v) => rewriteNavigateTargets(v, pathMap))];
      }
      if (
        Array.isArray(target) &&
        target[0] === "str/concat" &&
        typeof target[1] === "string" &&
        target[1].startsWith("/")
      ) {
        const rewrittenPrefix = rewriteConcatPrefix(target[1], pathMap);
        const nextTarget = rewrittenPrefix !== undefined ? [target[0], rewrittenPrefix, ...target.slice(2)] : target;
        return [node[0], nextTarget, ...node.slice(2).map((v) => rewriteNavigateTargets(v, pathMap))];
      }
    }
    return node.map((item) => rewriteNavigateTargets(item, pathMap));
  }
  if (typeof node !== "object") return node;
  const next: { [k: string]: unknown } = {};
  for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
    next[key] = rewriteNavigateTargets(value, pathMap);
  }
  return next;
}

/** Apply {@link rewriteNavigateTargets} across a trait's whole effect surface. */
function rewriteTraitNavigateTargets(trait: Trait, pathMap: ReadonlyMap<string, string>): Trait {
  if (pathMap.size === 0) return trait;
  const rewrite = (v: unknown): unknown => rewriteNavigateTargets(v, pathMap);
  const next: Trait = { ...trait };
  const sm = trait.stateMachine;
  if (sm) {
    next.stateMachine = {
      ...sm,
      transitions: (sm.transitions ?? []).map((t) =>
        t.effects ? { ...t, effects: rewrite(t.effects) as typeof t.effects } : t,
      ),
    };
  }
  if (trait.ticks) {
    next.ticks = trait.ticks.map((tick) => ({ ...tick, effects: rewrite(tick.effects) as typeof tick.effects }));
  }
  if (trait.initialEffects) {
    next.initialEffects = rewrite(trait.initialEffects) as typeof trait.initialEffects;
  }
  return next;
}

/**
 * Gap (D): rewrite a config-default STRING that EXACTLY equals an upstream
 * page path to its local remapped path — the config-held twin of
 * {@link rewriteNavigateTargets}'s literal-page-path rewrite, for values
 * like an `AppLayout`'s `navItems[].href` that hold a bare upstream path
 * OUTSIDE any `(navigate …)` s-expression. Exact-match only — a string that
 * merely CONTAINS a path (e.g. a sentence mentioning "/notes" in prose) is
 * left alone; recurses through arrays/objects only, since a bare page path
 * never appears anywhere else in a config-default tree. JS twin of Rust's
 * `rewrite_config_page_paths`.
 */
function rewriteConfigPagePaths(node: unknown, pathMap: ReadonlyMap<string, string>): unknown {
  if (typeof node === "string") return pathMap.get(node) ?? node;
  if (Array.isArray(node)) return node.map((item) => rewriteConfigPagePaths(item, pathMap));
  if (node !== null && typeof node === "object") {
    const next: { [k: string]: unknown } = {};
    for (const [key, value] of Object.entries(node as { [k: string]: unknown })) {
      next[key] = rewriteConfigPagePaths(value, pathMap);
    }
    return next;
  }
  return node;
}

/** Apply {@link rewriteConfigPagePaths} across every declared config field's default on one trait. */
function rewriteTraitConfigPagePaths(trait: Trait, pathMap: ReadonlyMap<string, string>): Trait {
  if (pathMap.size === 0 || !trait.config) return trait;
  const nextConfig: { [k: string]: ConfigFieldDeclaration } = {};
  for (const [key, field] of Object.entries(trait.config)) {
    nextConfig[key] =
      field.default === undefined
        ? field
        : { ...field, default: rewriteConfigPagePaths(field.default, pathMap) as ConfigFieldDeclaration["default"] };
  }
  return { ...trait, config: nextConfig };
}

/**
 * Fold a `uses A from "…" { config { … } }` call-site override onto the
 * loaded behavior's own app-level `schemaConfig` (ledger (b); Rust twin
 * `inline/mod.rs:776-800`) — the schema rung a sibling pulled from THIS
 * import resolves its `@config.<knob>` forward against, distinct from the
 * CONSUMER's own `this.schemaConfig`. An override naming a knob the
 * upstream schema never declared is a diagnostic, not a hard failure here
 * (mirrors the Rust comment: the compiler collects it for a future
 * `ORB_U_CONFIG_UNKNOWN_KEY` validator rather than aborting the load) — this
 * loader-level fold only ever applies the keys that ARE declared.
 */
function foldUseConfigOverride(
  declared: DeclaredTraitConfig,
  override: DeclaredTraitConfig | undefined,
  context: { readonly as: string; readonly from: string },
): DeclaredTraitConfig {
  if (!override) return declared;
  const values: Record<string, TraitConfigValue> = {};
  for (const [key, field] of Object.entries(override)) {
    if (!(key in declared)) {
      refResolverLog.warn("use-config:unknown-knob", { ...context, key });
      continue;
    }
    if (field.default !== undefined) values[key] = field.default;
  }
  return Object.keys(values).length > 0 ? overrideDeclaredKnobs(declared, values) : declared;
}

/**
 * Last hop of a `uses Alias { config { k: @config.j } }` override: a folded
 * alias app-knob whose default is exactly the consumer app-knob token
 * `@config.<j>` takes the consumer's declared default, provenance stamped in
 * `forwardedFrom` (Rust twin: `inline::orbital::forward_consumer_app_knobs`).
 * Anything else is left as-is for the validator.
 */
function forwardConsumerAppKnobs(
  folded: DeclaredTraitConfig,
  consumer: DeclaredTraitConfig | undefined,
): DeclaredTraitConfig {
  if (!consumer) return folded;
  const forwards: Record<string, string> = {};
  for (const [key, field] of Object.entries(folded)) {
    const token = field.default;
    if (typeof token !== 'string' || !token.startsWith('@config.')) continue;
    const source = token.slice('@config.'.length);
    if (source.includes('.') || !(source in consumer)) continue;
    if (consumer[source].default === undefined) continue;
    forwards[key] = source;
  }
  if (Object.keys(forwards).length === 0) return folded;
  const next: Record<string, ConfigFieldDeclaration> = { ...folded };
  for (const [key, source] of Object.entries(forwards)) {
    next[key] = { ...folded[key], default: consumer[source].default, forwardedFrom: `@config.${source}` };
  }
  return next;
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

  /**
   * {@link preResolveImportFile}'s cache, keyed by absolute source path —
   * `null` for a file whose own pre-resolution failed (best-effort, cached
   * too, so a repeat import doesn't retry a doomed resolve). Distinct from
   * {@link sourceImportsCache} (raw import SCOPE, no trait resolution) —
   * this holds the file's fully RESOLVED orbitals.
   */
  private importFileResolveCache: Map<string, ResolvedOrbital[] | null> = new Map();

  private loaderInitialized = false;

  /** The schema's declared `config {}` — outermost rung of the forwarded-config chain (§4.5). */
  private schemaConfig: DeclaredTraitConfig | undefined;

  /**
   * Schema-wide CONSUMER entity NAME → id, growing as each of THIS
   * schema's own orbitals finishes resolving. JS twin of the compiled
   * path's `consumer_entity_ids` (`orbital-compiler/src/phases/inline/
   * mod.rs`), extended the same way: once per orbital, right after it
   * resolves. Extended ONLY by {@link noteResolvedEntityIds} — called by
   * the free function {@link resolveSchema} after each of ITS OWN orbitals
   * finishes — never automatically inside `resolve()` itself, so the
   * nested `this.resolve()` call {@link materializeOrbitalRef} makes for an
   * external upstream orbital (a DIFFERENT file, never this consumer
   * schema) cannot pollute it.
   */
  private schemaEntityIds: ReadonlyMap<string, EntityId> = new Map();

  /**
   * Entity NAME → id visible to the orbital CURRENTLY being resolved:
   * {@link schemaEntityIds} (every name an EARLIER orbital in this schema
   * already established) plus the current orbital's own declared primary +
   * auxiliary entities — JS twin of the compiled path's per-orbital `entity_
   * ids = consumer_entity_ids.clone(); entity_ids.extend(collect_orbital_
   * entity_ids(orbital))`, timed the same way (before this orbital's own
   * trait composition runs). Read by {@link applyLinkedEntityRename}'s call
   * sites so a call-site `-> Entity` rebind can REFRESH (never merely drop)
   * the trait's `entityRefIds` side-map when the rebind target's id is
   * already known — the gap `std-api-gateway` exposed: `RouteOrbital`'s
   * no-rebind `Audit.traits.AuditCaptureListener` pull establishes
   * `AuditEntry`'s id; `GatewayUserOrbital`, resolved LATER in the same
   * schema, rebinds `Browse.traits.BrowseItemBrowse -> AuditEntry` and must
   * see it. `resolve()` re-sets this fresh at its own entry (no restore
   * needed once it returns): nothing reads it once `resolve()` has
   * returned, and no `resolve()` call is ever active while another is on
   * this instance — the only recursive `this.resolve()` call
   * (`materializeOrbitalRef`'s upstream re-resolve) runs strictly BEFORE
   * `resolveSchema`'s own per-orbital loop begins, never nested inside it.
   */
  private entityIdsInScope: ReadonlyMap<string, EntityId> = new Map();

  /**
   * Per-orbital name → the FINAL trait names {@link pullSiblingTraits}
   * auto-pulled for it (`ResolvedOrbital.name` keyed, set once per `resolve()`
   * call). JS twin of Rust's `pulled_by_orbital` (`inline/mod.rs`) — read by
   * {@link uniquifyCrossOrbitalPulledSiblings}, run once by the free
   * function {@link resolveSchema} AFTER every orbital in the schema has
   * resolved, because the rename decision (does this pulled name collide
   * with ANOTHER orbital's own declared trait name?) needs the WHOLE
   * schema's roster, not just this orbital's — exactly why Rust's own
   * `uniquify_cross_orbital_pulled_siblings` runs once, after its per-orbital
   * inline loop, not inside `inline_orbital` itself.
   */
  private pulledTraitNamesByOrbital = new Map<string, ReadonlySet<string>>();

  /**
   * Seed {@link schemaEntityIds} with EVERY orbital's PRIMARY (+ any
   * already-declared auxiliary) entity name → id, from the RAW pre-resolve
   * schema — JS twin of the compiled path's `consumer_entity_ids` INITIAL
   * build (`orbital-compiler/src/phases/inline/mod.rs`, `schema.orbitals
   * .iter().flat_map(...)`), which scans ALL orbitals' primaries up front,
   * before ANY of them inlines — not just the ones resolved so far. Without
   * this, an EARLY-resolved orbital's own `entityRefIds` secondary
   * references to a LATER orbital's primary entity (`RouteOrbital`'s
   * `entityRefIds["RateBucket"]`, `RateBucket` being a DIFFERENT, not-yet-
   * resolved orbital's own primary in `std-api-gateway`) would see nothing
   * in {@link entityIdsInScope} and {@link consumerKnownEntityRebindSubs}
   * would never refresh the stale atom-baked id. Called by {@link
   * resolveSchema} ONCE, before its per-orbital loop begins; {@link
   * noteResolvedEntityIds} then keeps widening past this seed with each
   * orbital's post-resolve auxiliary discoveries (Gap #22, sibling pulls),
   * same as before.
   */
  seedSchemaEntityIds(orbitals: readonly OrbitalDefinition[]): void {
    const next = new Map(this.schemaEntityIds);
    for (const orbital of orbitals) {
      for (const e of inlineEntityRefsOf(orbital)) {
        if (e.id) next.set(e.name, e.id);
      }
    }
    this.schemaEntityIds = next;
  }

  /**
   * Extend {@link schemaEntityIds} with a just-resolved orbital's FINAL
   * entity set — primary + every auxiliary entity resolution carried in
   * (including a no-rebind sibling pull's own bound entity,
   * `ResolvedOrbital.auxiliaryEntities`). Mirrors the compiled path's
   * `consumer_entity_ids.extend(collect_orbital_entity_ids(orbital))`,
   * called the same way: once per orbital, immediately after it resolves.
   * Called by {@link resolveSchema}'s own per-orbital loop only.
   */
  noteResolvedEntityIds(resolved: ResolvedOrbital): void {
    const next = new Map(this.schemaEntityIds);
    if (resolved.entity.id) next.set(resolved.entity.name, resolved.entity.id);
    for (const aux of resolved.auxiliaryEntities ?? []) {
      if (aux.id) next.set(aux.name, aux.id);
    }
    this.schemaEntityIds = next;
  }

  /**
   * Make auto-pulled sibling traits app-unique across orbitals — JS twin of
   * Rust's `uniquify_cross_orbital_pulled_siblings` (`inline/mod.rs`), called
   * by the free function {@link resolveSchema} once every orbital in the
   * schema has resolved (mirroring Rust's own post-per-orbital-loop timing:
   * the rename decision needs the WHOLE schema's trait-name roster, built
   * fresh here rather than grown incrementally like {@link schemaEntityIds}).
   * An auto-pulled sibling keeps its source name within its OWN orbital, so a
   * `@trait.<Sibling>` reference inside that orbital still resolves — but
   * when TWO orbitals in the same schema each declare (pulled OR explicit) a
   * trait of the SAME name, that name collides app-wide. Only renames a
   * PULLED copy (never an explicitly-authored trait ref —
   * {@link pulledTraitNamesByOrbital} is the eligibility set) whose name is
   * ALSO declared by at least one OTHER orbital, prefixing it with the
   * owning orbital's own name; the prefixed name must itself be free
   * schema-wide or the rename is skipped (matches Rust: a collision on the
   * PREFIXED name is left for the validator, never silently double-renamed).
   * Mutates `orbitals`' traits in place, same mutation style as
   * {@link pullSiblingTraits}.
   */
  uniquifyCrossOrbitalPulledSiblings(orbitals: readonly ResolvedOrbital[]): void {
    if (this.pulledTraitNamesByOrbital.size === 0) return;
    const nameOrbitalCount = new Map<string, number>();
    for (const orbital of orbitals) {
      const local = new Set(
        orbital.traits.map((rt) => rt.trait.name).filter((n): n is string => Boolean(n)),
      );
      for (const name of local) {
        nameOrbitalCount.set(name, (nameOrbitalCount.get(name) ?? 0) + 1);
      }
    }
    for (const orbital of orbitals) {
      const pulledNames = this.pulledTraitNamesByOrbital.get(orbital.name);
      if (!pulledNames || pulledNames.size === 0) continue;
      const renames = new Map<string, string>();
      for (const oldName of pulledNames) {
        if ((nameOrbitalCount.get(oldName) ?? 0) <= 1) continue;
        const newName = `${orbital.name}${oldName}`;
        if (nameOrbitalCount.has(newName)) continue;
        renames.set(oldName, newName);
      }
      if (renames.size === 0) continue;
      for (const rt of orbital.traits) {
        if (rt.trait.name && renames.has(rt.trait.name)) {
          rt.trait = { ...rt.trait, name: renames.get(rt.trait.name) as string };
        }
      }
      const idByName = new Map<string, TraitId | undefined>();
      for (const rt of orbital.traits) {
        if (rt.trait.name) idByName.set(rt.trait.name, rt.trait.id);
      }
      for (const rt of orbital.traits) {
        rt.trait = renameTraitEmbeds(rt.trait, renames);
        rt.trait = rewriteListenSources(rt.trait, renames, idByName);
      }
    }
  }

  constructor(options: ResolveOptions) {
    this.options = options;
    // Use provided loader; filesystem loader will be created lazily if needed
    this.loader = options.loader as SchemaLoader;
    this.schemaConfig = options.schemaConfig;
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
    chain?: ImportChainLike,
    opts?: {
      /**
       * Skip the type-param sentinel pass below (only) — set by
       * {@link preResolveImportFile} when resolving an imported FILE's own
       * orbital, never by the ordinary top-level `resolve()` callers
       * ({@link resolveSchema}, `materializeOrbitalRef`'s upstream
       * re-resolve). JS twin of Rust's OWN gating: `resolve_orbital_type_
       * param_sentinels` (`orbital-compiler/src/phases/inline/mod.rs`) is
       * called ONCE, from `inline_schema_with_orbital_diagnostics`'s
       * TOP-LEVEL per-orbital loop, AFTER `inline_orbital(..., is_top_level:
       * true, ...)` returns — never from the RECURSIVE `inline_orbital`
       * call a nested `uses` import takes (`is_top_level: false`). A
       * generic atom's own `typeParams` default (e.g. `p: Type = string`)
       * is meant to be overridden by whichever EXTERNAL consumer's call
       * site supplies `typeArgs` (`Generic.traits.X :: p SomeType`) — that
       * override is not known yet while resolving the generic atom's OWN
       * file standalone, so running this pass THERE bakes in the PARAM's
       * OWN default (the `$p` sentinel is rewritten to a concrete type in
       * place, destructively — a second pass, once the real `typeArgs` IS
       * known, finds no more sentinel to substitute and silently no-ops).
       * Deferred to the TRUE top-level `resolve()` call instead, exactly
       * like Rust — by the time that runs, the generic trait is fully
       * INLINED into the consumer's own trait list, carrying the
       * consumer's actual `typeArgs` on `ResolvedTrait.typeArgs`.
       */
      skipTypeParamSentinels?: boolean;
    },
  ): Promise<ResolveResult<ResolvedOrbital>> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const importChain = chain ?? { push: () => null, pop: () => {}, clone() { return this; } } as ImportChainLike;

    // Entity ids visible to THIS orbital's own trait composition below —
    // every earlier-resolved sibling's entities (`schemaEntityIds`) plus
    // this orbital's own declared primary/aux, read off the PRE-resolve
    // `orbital.entity`/`orbital.auxiliaryEntities` (before this orbital's
    // own composition runs, matching the compiled path's per-orbital
    // `entity_ids` timing). See {@link entityIdsInScope}'s own doc for why
    // no restore is needed once this call returns.
    this.entityIdsInScope = new Map([...this.schemaEntityIds, ...inlineEntityRefsOf(orbital).flatMap((e) => (e.id ? [[e.name, e.id] as const] : []))]);

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

    // (C) Gap #22 twin, computed EARLY (before Step 3 resolves any trait) so
    // its aux entities' ids are already in `entityIdsInScope` — JS twin of
    // the compiled path's own ordering: Rust's Gap #22 pass runs BEFORE
    // `entity_ids` is built for `inline_traits` (`orbital-compiler/src/
    // phases/inline/mod.rs`), so EVERY trait in the orbital — even the
    // first one processed — already sees an aux entity's id in
    // `consumer_known_entity_rebind_subs`. Computed once here; the original
    // call site below (used for the `ResolvedOrbital.auxiliaryEntities`
    // merge) reuses this SAME value rather than recomputing it.
    const gap22AuxEntities = auxEntitiesFromUnrebindTraitRefs(orbital.traits ?? [], imports);
    if (gap22AuxEntities.length > 0) {
      // A NAME already known — this orbital's own primary/declared-aux,
      // seeded into `entityIdsInScope` above — always wins: mirrors Rust's
      // `seen_aux_names` being PRE-SEEDED with the orbital's own primary
      // name before the Gap #22 scan runs, so a coincidentally-same-named
      // atom entity (`RenewalRisk` the orbital's own primary vs a
      // DIFFERENT generic atom's OWN `RenewalRisk` placeholder) never
      // overwrites the orbital's real id with a foreign one.
      const next = new Map(this.entityIdsInScope);
      for (const e of gap22AuxEntities) {
        if (e.id && !next.has(e.name)) next.set(e.name, e.id);
      }
      this.entityIdsInScope = next;
    }

    // (D) GAP-AGB-MOLECULE-ENTITY-CONTRACT twin — auto-merge composed atoms'
    // own entity fields onto this orbital's primary/declared-aux BEFORE
    // entity resolution, mirroring Rust's exact ordering (`orbital-compiler/
    // src/phases/inline/mod.rs`, ~line 1044) so a composed atom's field
    // contract (an explicit rebind's full field set, or a no-rebind
    // same-name atom's `@intrinsic`-only fields) is present on the entity
    // object every later phase — including {@link
    // resolveOrbitalTypeParamSentinels} below — reads. `orbital.entity` is
    // mutated in place; `resolveEntity`'s inline branch returns the SAME
    // object, so `entityResult.data.entity` carries the merge through.
    if (isInlineEntity(orbital.entity)) {
      mergeImportedEntityFieldsIntoOrbital(
        orbital.traits ?? [],
        orbital.entity,
        (orbital.auxiliaryEntities ?? []).filter(isInlineEntity),
        imports,
      );
    }

    // Step 2: Resolve entity
    const entityResult = this.resolveEntity(orbital.entity, imports);
    if (!entityResult.success) {
      errors.push(...entityResult.errors);
    }

    // Step 3: Resolve traits
    const traitsResult = await this.resolveTraits(orbital.traits, imports, importChain, orbital.config);
    if (!traitsResult.success) {
      errors.push(...traitsResult.errors);
    }

    // Step 4: Resolve pages
    const pagesResult = await this.resolvePages(orbital.pages, imports, importChain);
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
    const { errors: pullErrors, auxEntities: pulledAuxEntities, pulledNames } = await this.pullSiblingTraits(
      traitsResult.data,
      imports,
      importChain,
      orbital.config,
    );
    if (pullErrors.length > 0) {
      return { success: false, errors: pullErrors };
    }
    // C1-J6: recorded for {@link uniquifyCrossOrbitalPulledSiblings}'s
    // schema-wide pass, run once every orbital has resolved (`resolveSchema`)
    // — see {@link pulledTraitNamesByOrbital}'s own doc for why it cannot be
    // applied here, per-orbital.
    this.pulledTraitNamesByOrbital.set(orbital.name, pulledNames);

    // (C) merge BOTH aux-entity carries (Gap #22 + sibling-pull) into this
    // orbital's own set, deduped against the primary + whatever
    // `auxiliaryEntities` the author already declared — mirroring the
    // compiled path's post-`inline_traits` merges (`inline_orbital`'s Gap
    // #22 pass AND its "Register auxiliary entities surfaced by no-rebind
    // SIBLING-PULLS"). `entityResult.data.entity` is this orbital's OWN
    // resolved primary (post `resolveEntity`), not `orbital.entity` (the
    // pre-resolve input) — matching Rust's dedup against the CURRENT primary.
    // Always start from the author-declared set (even with NOTHING to
    // carry) — `ResolvedOrbital.auxiliaryEntities` is the orbital-import
    // materializer's ONLY source of aux entities now (it no longer reads
    // the pre-resolve `orbital.auxiliaryEntities` directly), so gating this
    // on "only if there's something to ADD" would silently drop every
    // author-declared aux entity for the (common) orbital that carries
    // nothing new.
    const known = new Set<string>([entityResult.data.entity.name]);
    const declaredAux = (orbital.auxiliaryEntities ?? []).filter(isInlineEntity);
    for (const e of declaredAux) known.add(e.name);
    const combined = [...declaredAux];
    for (const e of [...gap22AuxEntities, ...pulledAuxEntities]) {
      if (!known.has(e.name)) {
        known.add(e.name);
        combined.push(e);
      }
    }
    const resolvedAuxEntities: Entity[] | undefined = combined.length > 0 ? combined : undefined;

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

    // J1: `@entity` / `$<TypeParam>` payload-sentinel resolution — once per
    // orbital, after every trait/sibling-pull/splice is final, mirroring
    // Rust's `resolve_orbital_type_param_sentinels` (called once per
    // TOP-LEVEL orbital post-inline — see `opts.skipTypeParamSentinels`'s
    // own doc for why a pre-resolved IMPORT's own orbital must skip this).
    // Runs against THIS orbital's own final entity set (primary + the aux
    // entities just merged above).
    if (!opts?.skipTypeParamSentinels) {
      resolveOrbitalTypeParamSentinels(
        traitsResult.data,
        entityResult.data.entity,
        resolvedAuxEntities ?? [],
        orbital.types,
      );
    }

    return {
      success: true,
      data: {
        name: orbital.name,
        entity: entityResult.data.entity,
        entitySource: entityResult.data.source,
        traits: traitsResult.data,
        ...(resolvedAuxEntities ? { auxiliaryEntities: resolvedAuxEntities } : {}),
        pages: pagesResult.data,
        imports,
        original: orbital,
      },
      warnings,
    };
  }

  /**
   * Pre-resolve one imported FILE's own orbitals to completion — its own
   * `uses` (recursively, through THIS same method), its own trait refs,
   * its own sibling pulls, its own entity-ref-id rebinds — BEFORE the
   * consumer that names this alias ever folds or pulls from it. JS twin
   * of Rust's per-`uses` recursive `inline_orbital` call (`orbital-
   * compiler/src/phases/inline/mod.rs:1001-1013`): every `uses` alias's
   * OWN orbitals are inlined to completion, ahead of `ctx.add_alias_multi`
   * registering the alias for the consumer's own lookups. Without this, a
   * sibling-pull collision that is a genuine top-level PEER collision
   * INSIDE the imported file (`std-approval-request.orb`'s
   * `InlineBrowseItemBrowse6`/`…10`, both `ref: Dense.traits.
   * BrowseItemBrowse`, each embedding `@trait.DataGrid1`) never becomes
   * visible as a peer collision to the CONSUMER's own {@link
   * pullSiblingTraits} call — it arrives already flattened one level
   * deeper, sharing one JS-visible owner (see that method's own
   * drain-order doc for the full trace this ports).
   *
   * Cached per absolute `sourcePath` ({@link importFileResolveCache}) —
   * "a file imported twice resolves once" — so the cache must not bake in
   * any ONE call site's `uses { config }` override: the child resolver
   * below is seeded with this FILE's own raw, un-folded `config {}`
   * (`fileSchemaConfig`), never a folded override. A genuinely
   * call-site-configured explicit ref (`Alias.traits.X { config: {…} }`)
   * still resolves through the pre-existing lazy path
   * ({@link resolveTraitEntry} / {@link resolveTraitRefString}), which
   * this cache does not touch.
   *
   * Runs on a FRESH child `ReferenceResolver`, never `this` — `resolve()`'s
   * own `entityIdsInScope` / `schemaEntityIds` / `pulledTraitNamesByOrbital`
   * are single mutable instance state scoped to ONE active `resolve()` call
   * tree (see {@link entityIdsInScope}'s own doc: "no `resolve()` call is
   * ever active while another is on this instance"); reusing `this` here
   * would nest a `resolve()` call inside the CONSUMER's own still-active
   * `resolve()` → `resolveImports` call and corrupt that state once this
   * nested call returns. The child reuses `this.loader` (and therefore its
   * underlying `LoaderCache`) so raw parsing still dedupes exactly as
   * before. `chain` is threaded through unchanged (not cloned, matching
   * every other cross-call `chain` hand-off in this file) so genuine `uses`
   * cycles are still caught by the loader.
   *
   * Mirrors {@link resolveSchema}'s own orchestration (flatten orbital
   * references → collect local traits → seed schema entity ids →
   * per-orbital `resolve()` → `uniquifyCrossOrbitalPulledSiblings`) rather
   * than calling that free function directly — it accepts no `chain`
   * parameter, so a direct call would silently drop cycle protection one
   * level in.
   *
   * Best-effort: returns `null` (never throws) on any failure — a caller
   * falls back to the pre-existing raw-ref walk, matching this file's
   * other best-effort pre-passes (e.g. {@link precomputeReferenceFormPrimaryIds}).
   */
  private async preResolveImportFile(
    fileOrbitals: readonly OrbitalDefinition[],
    sourcePath: string,
    fileSchemaConfig: DeclaredTraitConfig | undefined,
    chain: ImportChainLike,
  ): Promise<ResolvedOrbital[] | null> {
    const cached = this.importFileResolveCache.get(sourcePath);
    if (cached !== undefined) return cached;
    let result: ResolvedOrbital[] | null;
    try {
      result = await this.preResolveImportFileUncached(fileOrbitals, sourcePath, fileSchemaConfig, chain);
    } catch {
      result = null;
    }
    this.importFileResolveCache.set(sourcePath, result);
    return result;
  }

  private async preResolveImportFileUncached(
    fileOrbitals: readonly OrbitalDefinition[],
    sourcePath: string,
    fileSchemaConfig: DeclaredTraitConfig | undefined,
    chain: ImportChainLike,
  ): Promise<ResolvedOrbital[] | null> {
    const child = new ReferenceResolver({
      ...this.options,
      loader: this.loader,
      schemaConfig: fileSchemaConfig,
    });
    const fileSchema: OrbitalSchema = {
      name: sourcePath,
      orbitals: fileOrbitals as OrbitalDefinition[],
      ...(fileSchemaConfig ? { config: fileSchemaConfig } : {}),
    };
    const flattenResult = await child.resolveOrbitalImports(fileSchema, { skipTypeParamSentinels: true });
    if (!flattenResult.success) return null;
    const orbitals = flattenResult.data;

    const inlineTraits = orbitals.flatMap((o) =>
      o.traits.filter((t): t is Trait => typeof t !== "string" && "stateMachine" in t),
    );
    child.addLocalTraits(inlineTraits);
    child.seedSchemaEntityIds(orbitals);

    // NO {@link uniquifyCrossOrbitalPulledSiblings} here — Rust's own
    // recursive `inline_orbital` call for a NESTED `uses` import passes
    // `pulled_names_sink: None` (`orbital-compiler/src/phases/inline/
    // mod.rs`, doc'd there as "top-level orbitals only"), so a nested
    // import's own cross-orbital pulled-sibling collisions are NEVER
    // renamed at this level — only a TOP-LEVEL schema's own orbitals go
    // through that pass (`resolveSchema`, after every orbital resolves).
    // Doing it here regressed `std-fitness-studio`/`std-healthcare`: it
    // prefixed pulled names with THIS FILE's own internal orbital name for
    // collisions that only exist because of how THIS file happens to be
    // organized internally — names the CONSUMER's own `@trait.X` embed
    // tokens never reference, so the rename orphaned them (surfaced as
    // "trait missing on the JS side").
    const resolved: ResolvedOrbital[] = [];
    for (const orbital of orbitals) {
      const result = await child.resolve(orbital, sourcePath, chain, { skipTypeParamSentinels: true });
      if (!result.success) return null;
      resolved.push(result.data);
      child.noteResolvedEntityIds(result.data);
    }
    return resolved;
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

    // Fallback no-op chain, same default `resolve()` itself uses — threaded
    // through {@link preResolveImportFile} too so a genuinely cyclic `uses`
    // graph is still caught by the loader one level in, not silently
    // dropped by this method's own optional `chain` param.
    const effectiveChain: ImportChainLike =
      chain ?? { push: () => null, pop: () => { /* no-op */ }, clone(): ImportChainLike { return this; } };

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
        effectiveChain
      );

      if (!loadResult.success) {
        errors.push(`Failed to load "${use.from}" as "${use.as}": ${loadResult.error}`);
        continue;
      }

      const fileOrbitals = loadResult.data.orbitals ?? [loadResult.data.orbital];
      // Per-alias pre-resolution (see {@link preResolveImportFile}'s own
      // doc) — best-effort: `null` on failure leaves `resolvedOrbitals`
      // unset and every downstream lookup falls back to the pre-existing
      // raw-ref walk, exactly as before this field existed.
      const resolvedOrbitals = await this.preResolveImportFile(
        fileOrbitals,
        loadResult.data.sourcePath,
        loadResult.data.schemaConfig,
        effectiveChain,
      );

      orbitals.set(use.as, {
        alias: use.as,
        from: use.from,
        orbital: loadResult.data.orbital,
        orbitals: fileOrbitals,
        sourcePath: loadResult.data.sourcePath,
        ...(resolvedOrbitals ? { resolvedOrbitals } : {}),
        ...(loadResult.data.schemaConfig
          ? {
              schemaConfig: forwardConsumerAppKnobs(
                foldUseConfigOverride(loadResult.data.schemaConfig, use.config, use),
                this.schemaConfig,
              ),
            }
          : {}),
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
   * The ATOM's OWN trait `alias.traits.traitName` resolves to — no call-site
   * overrides applied (`callSiteConfig` omitted) — so its DECLARED
   * `linkedEntity` can drive {@link buildAliasEntityRenames}. Same lookup
   * `resolveTraitRefString`'s imported branch performs to find the base
   * `trait` before any rebind, factored out so the pre-pass and the main
   * resolve share one lookup rather than two. `null` when the alias or
   * trait cannot be found — the pre-pass simply skips that entry, same as a
   * lookup failure anywhere else in this best-effort pass.
   */
  private async atomOwnTrait(
    alias: string,
    traitName: string,
    imports: ResolvedImports,
    chain: ImportChainLike,
  ): Promise<Trait | null> {
    const imported = imports.orbitals.get(alias);
    if (!imported) return null;
    for (const o of importedOrbitals(imported)) {
      const entry = findTraitEntryInOrbital(o, traitName);
      if (!entry) continue;
      const entryResolved = await this.resolveTraitEntry(imported, entry, traitName, chain, imports);
      return entryResolved.success ? entryResolved.data.trait : null;
    }
    return null;
  }

  /**
   * Alias-scoped cross-trait entity-rebind propagation — JS twin of Rust's
   * `alias_entity_renames` pre-pass (`inline/trait.rs::inline_traits`). One
   * explicit pull's `linkedEntity` override (`Button.traits.ButtonRender ->
   * Route`) establishes a rebind (the atom's OWN declared `linkedEntity` →
   * the override) that a SIBLING pull from the SAME alias with NO rebind of
   * its own (`Button.traits.ButtonRender`, no `->`) never sees through
   * {@link applyLinkedEntityRename} — that call only ever knows ITS OWN
   * delta. But the no-rebind pull's `entityRefIds` side-map can still carry
   * a SECONDARY, positional reference to that same atom-local name (a
   * "self" entry keyed by the atom's own bound entity), which nothing else
   * rewrites — `std-api-gateway`'s `RouteOrbital.InlineButtonRender3`
   * (`Button.traits.ButtonRender`, no rebind) recovers `entityRefIds`'
   * `ButtonItem` key to `Route` only because `InlineButtonRender9` (`Button.
   * traits.ButtonRender -> Route`) established the rebind earlier in the
   * SAME orbital's `traits` list. Scanned once per orbital, over every
   * EXPLICIT `Alias.traits.X -> Y` entry in `traitRefs`: `(alias, atom's
   * declared linkedEntity) -> override`. First rebind for a given `(alias,
   * atomLocal)` pair wins (`Map.set` only on a fresh key), matching Rust's
   * `.or_insert_with`.
   */
  private async buildAliasEntityRenames(
    traitRefs: readonly TraitRef[],
    imports: ResolvedImports,
    chain: ImportChainLike,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    for (const traitRef of traitRefs) {
      if (typeof traitRef === "string" || "stateMachine" in traitRef || !("ref" in traitRef)) continue;
      const refObj = traitRef as { ref: string; linkedEntity?: string };
      if (!refObj.linkedEntity) continue;
      const parsed = parseImportedTraitRef(refObj.ref);
      if (!parsed) continue;
      const atomTrait = await this.atomOwnTrait(parsed.alias, parsed.traitName, imports, chain);
      const atomLocal = atomTrait?.linkedEntity;
      if (!atomLocal || atomLocal === refObj.linkedEntity) continue;
      const forAlias = out.get(parsed.alias) ?? new Map<string, string>();
      if (!forAlias.has(atomLocal)) forAlias.set(atomLocal, refObj.linkedEntity);
      out.set(parsed.alias, forAlias);
    }
    return out;
  }

  /**
   * Resolve trait references.
   */
  private async resolveTraits(
    traitRefs: TraitRef[],
    imports: ResolvedImports,
    chain: ImportChainLike,
    orbitalConfig?: DeclaredTraitConfig,
  ): Promise<ResolveResult<ResolvedTrait[]>> {
    const errors: string[] = [];
    const resolved: ResolvedTrait[] = [];
    // Built once, off the PRE-resolution list, so a `{ref}` entry's own
    // call-site `@config.<k>` forward can walk out through however many
    // embedders in between publish no matching knob (ledger (n)-JS).
    const embedCtx: OrbitalEmbedContext = {
      traitRefs,
      embedGraph: buildEmbedGraph(traitRefs),
      orbitalConfig,
    };
    const aliasEntityRenames = await this.buildAliasEntityRenames(traitRefs, imports, chain);

    for (const traitRef of traitRefs) {
      const result = await this.resolveTraitRef(traitRef, imports, chain, embedCtx, aliasEntityRenames);
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
   * The concrete base `Trait` a trait entry (found under `localName` in
   * `imported`) resolves to — an inline entry resolves its own
   * `@config.<knob>` emit refs against `callSiteConfig` (the ref hop that
   * led here, e.g. `std-approval-gate`'s `CloseButton = Button.traits.
   * ButtonRender { config: { action: CLOSE } }` resolving `ButtonRender`
   * itself); a ref-shaped entry (an atom's sub-view declared `trait X =
   * Y.traits.Z {…}` INSIDE the source atom, e.g. `std-note`'s
   * `NoteSubpages = RecordDetail.traits.RecordItemDetail`) recurses through
   * that source's own import scope via {@link importsOfSource} — the
   * entry's own declared overrides are its call site. Single owner for
   * `pullSiblingTraits`' sibling pull and `resolveTraitRefString`'s
   * imported branch, both of which used to reach `findTraitInOrbital`'s
   * `stateMachine`-gated lookup (its ref arm did nothing), silently failing
   * to resolve a nested ref (ledger (i)).
   *
   * `callSiteConfig` MUST be threaded by any caller that goes on to fold a
   * call-site config of its own onto the returned trait
   * (`resolveTraitRefString`'s ref-imported branch, ledger (o)) — the
   * `@config.<knob>` emit-name substitution is destructive
   * (`resolveConfigRefEmitNames` rewrites the marker to a concrete literal
   * in place), so resolving it here with the WRONG effective config
   * (the atom's own bare default, absent the override) permanently loses
   * the override: a second `resolveConfigRefEmitNames` call downstream sees
   * no more `@config.<knob>` marker to substitute and silently no-ops.
   * `pullSiblingTraits` (no further fold of its own) omits it, matching its
   * prior no-callSiteConfig behavior exactly.
   */
  private async resolveTraitEntry(
    imported: ResolvedImport,
    entry: Exclude<TraitRef, string>,
    localName: string,
    chain: ImportChainLike,
    homeImports: ResolvedImports,
    callSiteConfig?: TraitConfig,
  ): Promise<
    ResolveResult<{
      trait: Trait;
      embedScope: { imports: ResolvedImports; alias: string };
      typeArgs?: Record<string, string>;
    }>
  > {
    if ("stateMachine" in entry) {
      const { trait, errors } = resolveConfigRefEmitNames(entry as Trait, callSiteConfig);
      if (errors.length > 0) return { success: false, errors };
      return {
        success: true,
        data: { trait, embedScope: { imports: homeImports, alias: imported.alias } },
        warnings: [],
      };
    }
    const refObj = entry as {
      ref: string;
      refId?: TraitId;
      name?: string;
      config?: TraitConfig;
      linkedEntity?: string;
      events?: { [oldKey: string]: string };
      listens?: TraitEventListener[];
      typeArgs?: Record<string, string>;
    };
    const srcImports = await this.importsOfSource(imported, chain);
    if (!srcImports) {
      return {
        success: false,
        errors: [
          `Trait "${localName}" in imported behavior could not resolve its own import scope to follow ref "${refObj.ref}"`,
        ],
      };
    }
    const nested = await this.resolveTraitRefString(
      refObj.ref,
      srcImports,
      chain,
      refObj.config,
      refObj.linkedEntity,
      refObj.name ?? localName,
      refObj.events,
      refObj.listens,
      refObj.refId,
      refObj.typeArgs,
    );
    if (!nested.success) return nested;
    // `nested.data.embedScope` is set whenever `resolveTraitRefString`
    // resolved an IMPORTED trait (the common case here); fall back to this
    // level's own scope for a local/id-index hit, same default as above.
    return {
      success: true,
      data: {
        trait: nested.data.trait,
        embedScope: nested.data.embedScope ?? { imports: srcImports, alias: imported.alias },
        ...(nested.data.typeArgs !== undefined ? { typeArgs: nested.data.typeArgs } : {}),
      },
      warnings: nested.warnings,
    };
  }

  /**
   * The concrete `Page` a page entry (found under `localName` in `imported`)
   * resolves to — an inline `Page` passes through; a `PageRefObject` (a
   * re-exported page declared inside the SOURCE orbital's own `pages {}`,
   * {@link findPageEntryInOrbital}'s ref arm) recurses through that source's
   * own import scope via {@link importsOfSource} and
   * {@link resolvePageRefObject} — the page twin of {@link resolveTraitEntry}
   * (nested refs, ledger (i)).
   */
  private async resolvePageEntry(
    imported: ResolvedImport,
    entry: Page | PageRefObject,
    chain: ImportChainLike,
  ): Promise<ResolveResult<{ page: Page }>> {
    if (!("ref" in entry)) return { success: true, data: { page: entry }, warnings: [] };
    const srcImports = await this.importsOfSource(imported, chain);
    if (!srcImports) {
      return {
        success: false,
        errors: [`Page in imported behavior could not resolve its own import scope to follow ref "${entry.ref}"`],
      };
    }
    const nested = await this.resolvePageRefObject(entry, srcImports, chain);
    if (!nested.success) return nested;
    return { success: true, data: { page: nested.data.page }, warnings: nested.warnings };
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
    orbitalConfig?: DeclaredTraitConfig,
  ): Promise<PullSiblingTraitsResult> {
    // (C) aux-entity carry, mirroring the compiled path's `pulled_aux_entities`
    // (`inline/trait.rs` — "no-rebind sibling: it keeps its OWN bound
    // entity... carry it into the consumer so the sibling's `(fetch X)` /
    // `linkedEntity` resolve"). A self-contained widget trait pulled
    // transitively via `@trait.<Sibling>` (un-rebound OR rebound to an
    // entity from a DIFFERENT alias than it was pulled from) keeps its own
    // runtime-view entity, auxiliary in the SOURCE behavior — without this
    // carry, this orbital's own `entities {}`/prefix-rename never learns
    // that entity exists, so the pulled sibling's `linkedEntity`/
    // `entityRefIds` stay named after an entity this orbital never declares
    // (found via the `orbital_import_disjoint.lolo` id-integrity gate:
    // `std-crm`'s un-rebound `PipelineStats = Stats.traits.StatsItemStats`
    // left `StatsItem` undeclared). Deduped against the primary + already-
    // declared auxiliaries by `resolve()`, the caller.
    const auxEntities: Entity[] = [];
    interface PullItem {
      /**
       * The PRIMARY alias to search `sibling` in — the top-level pull's own
       * scope (`imports`, this function's outer param), propagated
       * UNCHANGED through every recursion level. A `@trait.X` token can be
       * introduced two ways, and each has a DIFFERENT home: (1) the atom's
       * OWN declared config/effects (home = wherever the ATOM is defined —
       * `resolveTraitEntry`'s `embedScope`, carried as {@link fallback}
       * below), or (2) a CALL-SITE config override authored alongside the
       * entry that named this trait in the FIRST place (home = the SAME
       * scope as that entry itself — e.g. `std-approval-request`'s
       * `InlineSimpleGridRender30 = UiSimpleGrid.traits.SimpleGridRender {
       * config { children: [@trait.InlineStatDisplayRender28, …] } }`
       * names siblings declared in std-approval-request's OWN `.orb`, under
       * the OUTER "ApprovalRequestPipeline"-embedding alias, not
       * `UiSimpleGrid`). Since a resolved trait's `.config` no longer
       * distinguishes which source a given value came from (folded by
       * {@link foldCallSiteConfigOntoTrait}), search BOTH: this constant
       * primary first, `fallback` (the atom's own home) second.
       */
      alias: string;
      /**
       * The atom's OWN home scope (`resolveTraitEntry`'s `embedScope` for
       * THIS pull) — tried only when `alias` (primary) doesn't declare
       * `sibling` at all. `undefined` when the entry resolved without
       * crossing into a deeper alias (embedScope === primary already).
       */
      fallback: { readonly imports: ResolvedImports; readonly alias: string } | undefined;
      sibling: string;
      linkedEntity: string | undefined;
      /** Immediate embedder — the trait whose `@trait.X` tokens get repointed. */
      parent: string;
      /** Top-level consumer trait this materialisation belongs to. */
      owner: string;
      /**
       * The specific pre-resolved orbital (see {@link preResolveImportFile})
       * THIS pull's own trait came from, carried into recursion so a
       * further descendant embed searches that SAME already-flattened
       * orbital directly, by name — safe (no cross-orbital collision risk,
       * since it is pinned to one orbital index already established by the
       * PARENT's own discovery) and correct (that orbital's own
       * sibling-pull already ran every descendant to completion, so a
       * transitively-nested atom-internal name is present there even
       * though it is never a RAW top-level entry). `undefined` for a
       * top-level SEED (discovery always starts with the raw-walk-first
       * gate below, matching pre-existing PRIMARY/`fallback` semantics
       * exactly) or when the parent's own pull did NOT come from a
       * pre-resolved orbital (pre-resolution unavailable for that alias —
       * every descendant then also falls through to the pre-existing
       * raw-walk + {@link resolveTraitEntry} path, unchanged).
       */
      preResolvedScope: ResolvedOrbital | undefined;
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
        work.push({
          alias: rt.source.alias,
          fallback: rt.embedScope,
          sibling,
          linkedEntity: rt.linkedEntity,
          parent: owner,
          owner,
          // Top-level SEED — always starts with the raw-walk-first gate
          // (see {@link PullItem.preResolvedScope}'s own doc).
          preResolvedScope: undefined,
        });
      }
    }
    if (work.length === 0) return { errors: [], auxEntities: [], pulledNames: new Set() };

    const errors: string[] = [];
    const consumerDeclared = new Set(resolved.map((r) => r.trait.name).filter(Boolean));
    /**
     * Provenance of each consumer-declared trait — Rust twin
     * `consumer_declared_provenance` (trait.rs): a pull is satisfied by a
     * consumer-declared trait of the SAME NAME only when that trait is an
     * INSTANCE OF THE SAME SOURCE (same alias + same upstream name), not a
     * coincidental name match. L1 numbers inline chrome per file
     * (`InlineDividerRender5` exists in most atoms AND possibly in the
     * consumer's own unrelated markup), and a name-only skip binds the
     * pulled body's `@trait.<Sibling>` tokens to the wrong trait — found via
     * std-notes: `NoteDocPage`'s own `@trait.NoteDivider` embed coincides
     * with `NoteCatalog`'s own (unrelated) `@trait.NoteDivider` pull, and
     * without this gate the SECOND pull silently no-ops instead of
     * disambiguating under `NoteDocPageNoteDivider` (Rust's own name for it).
     */
    const consumerDeclaredProvenance = new Map<string, { alias: string; traitName: string }>();
    for (const rt of resolved) {
      if (rt.source.type === "imported" && rt.trait.name) {
        consumerDeclaredProvenance.set(rt.trait.name, { alias: rt.source.alias, traitName: rt.source.traitName });
      }
    }
    const seen = new Set(consumerDeclared);
    const visited = new Set<string>();
    const pulledAs = new Map<string, string>();
    /** pulled trait's final name → its owner. */
    const ownerOf = new Map<string, string>();
    /**
     * Pulled trait's final name → its immediate embedder's final name (ledger
     * (n)-JS). A hoisted `@config.<knob>` forward may pass through several
     * pulled traits before landing on a declared value three-plus levels up
     * (`TimelineFeed.title → Stack8 → Stack5 → Typography4.content`), so the
     * single direct embedder `resolveForwardedSiblingConfig` used to try is
     * not enough — the chain below walks this map from a pull's parent
     * outward. Every pull sets this ONCE (a repeat pull of the same pullKey
     * `continue`s before reaching this point), so the map is always a forest
     * — no entry ever points into a cycle — but the walk still bounds itself
     * defensively with a `visited` set.
     */
    const parentOf = new Map<string, string>();
    /** parent final name → (`@trait.<from>` → `@trait.<to>`) rewrites. */
    const parentRewrites = new Map<string, Map<string, string>>();
    const pulled: ResolvedTrait[] = [];

    /**
     * Every declared `config {}` from `finalName`'s immediate embedder out to
     * the top of its `parentOf` chain, innermost first — the rungs
     * `resolveForwardedSiblingConfigFrom` tries before falling through to
     * `orbitalConfig`/`this.schemaConfig`.
     */
    const embedderChain = (finalName: string): DeclaredTraitConfig[] => {
      const chain: DeclaredTraitConfig[] = [];
      const seenNames = new Set<string>();
      let cur: string | undefined = finalName;
      while (cur !== undefined && !seenNames.has(cur)) {
        seenNames.add(cur);
        const t = resolved.find((r) => r.trait.name === cur)?.trait ?? pulled.find((r) => r.trait.name === cur)?.trait;
        if (!t) break;
        if (t.config) chain.push(t.config);
        cur = parentOf.get(cur);
      }
      return chain;
    };

    const noteRewrite = (parent: string, from: string, to: string): void => {
      let m = parentRewrites.get(parent);
      if (!m) {
        m = new Map();
        parentRewrites.set(parent, m);
      }
      m.set(from, to);
    };

    // LIFO (stack, `.pop()`) — JS twin of Rust's `worklist.pop()`
    // (`orbital-compiler/src/phases/inline/trait.rs:2026`), draining a Vec
    // built by `sibling_pull_work.push(...)` in `traits[]` declaration order
    // (trait.rs:1899): the LAST-pushed (LATEST-declared) item pops FIRST and
    // wins a contested bare name.
    //
    // C1-J7 (2026-09-06) traced why a naive FIFO/LIFO swap alone couldn't
    // reproduce Rust here: two collisions in the corpus are the SAME rule
    // applied at DIFFERENT levels —
    //
    //   - `std-api-gateway`'s `GatewayUserOrbital`: `AuditBrowseList`
    //     (traits[7]) and `GatewayUserBrowseList` (traits[4]) are BOTH
    //     genuine top-level `Reference` entries of THIS orbital's OWN
    //     `traits[]` (`parent === owner === themselves`) — a pure
    //     drain-order question THIS orbital's own worklist already sees.
    //
    //   - PF's `ApprovalRequestOrbital`: `InlineBrowseItemBrowse6`/`…10` are
    //     std-approval-request's OWN internal composed chrome
    //     (`std-approval-request.orb`'s `ApprovalRequestOrbital`, traits[6]
    //     and traits[10], each `ref: Dense.traits.BrowseItemBrowse`),
    //     reached only because `ApprovalRequestPipeline`'s render body
    //     embeds `@trait.InlineBrowseItemBrowse6`/`…10` tokens — NOT top-
    //     level entries of PF's own `traits[]`. Rust resolves every `uses`
    //     import's OWN orbitals to full completion BEFORE the consumer ever
    //     sees them (`inline_orbital` recurses over `inlined_orbitals` per
    //     alias, `inline/mod.rs:1000-1013`, ahead of `ctx.add_alias_multi`
    //     registering the alias), so by the time PF's OWN sibling-pull calls
    //     `ctx.get_trait("ApprovalRequest", "InlineBrowseItemBrowse6")`,
    //     `Browse6`/`…10` have ALREADY collided as two DISTINCT top-level
    //     peers of std-approval-request's OWN recursive `inline_orbital`
    //     pass, one `uses`-boundary in — the EXACT SAME mechanism as
    //     `AuditBrowseList`/`GatewayUserBrowseList`, just resolved a level
    //     earlier.
    //
    // A flat JS worklist over ONE orbital's own `resolved` traits can never
    // see PF's collision as a peer collision, because `imports.orbitals`
    // used to stay in RAW/unresolved `ref:` form — `Browse6`/`…10` arrived
    // here already flattened one level deeper than Rust ever sees them,
    // sharing one JS-visible owner (`ApprovalRequestPipeline`). Ported by
    // {@link preResolveImportFile}: every `uses` alias's own file is now
    // resolved to completion (recursively, through THIS SAME method, on a
    // child resolver) BEFORE `resolveImports` hands the alias to any
    // consumer — so std-approval-request's `Browse6`/`…10` collide as
    // top-level peers INSIDE their OWN pre-resolution pass, exactly like
    // Rust's recursive `inline_orbital`, and PF's own sibling-pull below
    // finds them already disambiguated (see the `preResolved` branch in the
    // search block just below). With that pre-resolution in place, `.pop()`
    // is correct at every level — no further asymmetry.
    for (let item = work.pop(); item !== undefined; item = work.pop()) {
      const { alias, fallback, sibling, linkedEntity, parent, owner, preResolvedScope } = item;
      // J2: keyed (and disambiguated) by ‘parent’ — the IMMEDIATE embedder —
      // not ‘owner’ (the top-level consumer trait). A TOP-LEVEL seed has
      // parent === owner (unchanged from before), so this only changes
      // behavior for a sibling reached through a DEEPER, DISTINCTLY-NAMED
      // intermediate — e.g. std-approval-request's InlineBrowseItemBrowse6
      // and …10, both refs to Dense.traits.BrowseItemBrowse, each embed
      // @trait.DataGrid1; under the OLD owner-only key both pulls of
      // DataGrid1 shared one alias/sibling/owner key and collapsed to a
      // single copy. Two DIFFERENT direct embeds of ApprovalRequestPipeline
      // ITSELF still share parent === owner and still collapse — the
      // compiled path's own "two traits of one atom" sharing is unaffected.
      const pullKey = `${alias} ${sibling} ${owner} ${parent}`;
      const existing = pulledAs.get(pullKey);
      if (existing !== undefined) {
        // Already materialised for THIS owner+parent (two traits of one atom
        // embedding the same sub-view). Share it, repointing this parent's tokens.
        if (existing !== sibling) noteRewrite(parent, sibling, existing);
        continue;
      }
      let finalName = sibling;
      if (seen.has(sibling)) {
        // Explicit composition wins — but ONLY when the consumer's trait IS
        // this source trait (same alias + same upstream name); a
        // coincidental name match (no provenance, or a different source)
        // falls through to disambiguation like any other taken name.
        const provenance = consumerDeclaredProvenance.get(sibling);
        if (consumerDeclared.has(sibling) && provenance?.alias === alias && provenance.traitName === sibling) {
          continue;
        }
        // Disambiguate with the IMMEDIATE embedder's name, not the top-level
        // owner — matches the compiled path (e.g.
        // ApprovalRequestOrbitalInlineBrowseItemBrowse6DataGrid1, never
        // ...ApprovalRequestPipelineDataGrid1).
        finalName = `${parent}${sibling}`;
        // Even the prefixed name is taken by something that is not this pull:
        // leave the token dangling for the validator rather than capture the
        // wrong trait.
        if (seen.has(finalName)) continue;
      }
      if (visited.has(pullKey)) continue;
      visited.add(pullKey);

      let searchImports = imports;
      let searchAlias = alias;
      let atomTrait: Trait | undefined;
      let childScope: { readonly imports: ResolvedImports; readonly alias: string } | undefined;
      let foundTypeArgs: Record<string, string> | undefined;
      let childPreResolvedScope: ResolvedOrbital | undefined;

      // Fast path: the PARENT's own trait came from a pre-resolved orbital
      // (see {@link PullItem.preResolvedScope}) — that orbital's own
      // sibling-pull already ran every descendant of every one of its
      // top-level traits to completion, so THIS sibling (however deeply
      // nested, atom-internal, never a raw top-level entry) is already
      // present there under the exact name `copy`'s embed token carries.
      // Pinned to the SAME orbital the parent came from — no cross-orbital
      // collision risk (see the raw-walk branch's own doc for why a BLIND
      // cross-orbital name search is unsafe).
      if (preResolvedScope) {
        const found = preResolvedScope.traits.find((rt) => rt.trait.name === sibling);
        if (found) {
          atomTrait = found.trait;
          childScope = { imports: searchImports, alias: searchAlias };
          foundTypeArgs = found.typeArgs;
          childPreResolvedScope = preResolvedScope;
        }
      }

      if (!atomTrait) {
        // Same-alias siblings only — a `@trait.X` naming anything else is
        // the validator's `ORB_BINDING_TRAIT_UNKNOWN` to report, not ours
        // to guess. Try the PRIMARY scope (the constant top-level alias)
        // first — a call-site-introduced sibling lives there — then
        // `fallback` (the atom's own home) for a sibling the atom declares
        // itself but the primary alias never named (see {@link PullItem}
        // doc). Discovery (WHICH entry, in which orbital, wins
        // PRIMARY-vs-`fallback`) stays byte-for-byte the pre-pre-resolution
        // walk over the RAW file — only an EXPLICIT top-level `TraitRef`
        // counts here, same as before this cache existed. Searching the
        // pre-resolved FLATTENED trait list directly (every auto-pulled
        // sibling included) instead would widen the match to a
        // coincidentally-same-numbered PULLED trait from an unrelated atom
        // elsewhere in the same file — each orbital's own sibling-pull runs
        // with its OWN local `seen` set, so two orbitals in one
        // multi-orbital file can independently land a pulled trait under
        // the exact same bare numbered name (`std-fitness-studio`'s
        // `InlineTypographyRender21` surfaced this: a blind flattened-list
        // search grabbed a same-named PULLED sibling from a different
        // orbital instead of `MembershipDirectory`'s own atom-declared one,
        // cascading into spurious multi-level rename chains). Once a RAW
        // entry is found, its pre-resolved counterpart is looked up in the
        // SAME orbital INDEX only — safe, because within one orbital the
        // explicit name and any pulled name can never collide (the `seen`
        // set forbids it) — and used as the concrete trait when available.
        let imported = imports.orbitals.get(alias);
        let atomEntry: Exclude<TraitRef, string> | null = null;
        let atomOrbitalIndex = -1;
        if (imported) {
          const list = importedOrbitals(imported);
          for (let i = 0; i < list.length; i++) {
            atomEntry = findTraitEntryInOrbital(list[i], sibling);
            if (atomEntry) {
              atomOrbitalIndex = i;
              break;
            }
          }
        }
        if (!atomEntry && fallback) {
          const fbImported = fallback.imports.orbitals.get(fallback.alias);
          if (fbImported) {
            const list = importedOrbitals(fbImported);
            for (let i = 0; i < list.length; i++) {
              atomEntry = findTraitEntryInOrbital(list[i], sibling);
              if (atomEntry) {
                imported = fbImported;
                searchImports = fallback.imports;
                searchAlias = fallback.alias;
                atomOrbitalIndex = i;
                break;
              }
            }
          }
        }
        if (!imported || !atomEntry) continue;

        // {@link preResolveImportFile}'s cache: the SAME orbital `atomEntry`
        // was found in, already fully resolved (its own `uses`, trait refs,
        // sibling pulls — same LIFO drain as this one). A hit is the
        // concrete, FINAL trait — no further ref-chasing needed.
        // `undefined` (not attempted) when pre-resolution is unavailable
        // for that alias (best-effort — falls through to
        // {@link resolveTraitEntry} exactly as before this cache existed).
        const preResolvedOrbital = imported.resolvedOrbitals?.[atomOrbitalIndex];
        const preResolved = preResolvedOrbital?.traits.find((rt) => rt.trait.name === sibling);
        if (preResolved) {
          atomTrait = preResolved.trait;
          childScope = { imports: searchImports, alias: searchAlias };
          foundTypeArgs = preResolved.typeArgs;
          childPreResolvedScope = preResolvedOrbital;
        } else {
          const entryResolved = await this.resolveTraitEntry(imported, atomEntry, sibling, chain, searchImports);
          if (!entryResolved.success) {
            errors.push(...entryResolved.errors);
            continue;
          }
          atomTrait = entryResolved.data.trait;
          childScope = entryResolved.data.embedScope;
          foundTypeArgs = entryResolved.data.typeArgs;
        }
      }
      // Unreachable in practice — every path above either sets both
      // `atomTrait`/`childScope` or `continue`s — but TS can't see that
      // across the nested branches, and a defensive `continue` (dangling
      // token, left for the validator) is exactly this function's existing
      // idiom for "nothing found" elsewhere in this same loop.
      if (!atomTrait || !childScope) continue;

      // The just-resolved trait's OWN concrete-definition home — next
      // level's `fallback` (its own further un-overridden embeds live
      // there); `undefined` when it's already the same as `searchAlias`
      // (no deeper crossing happened resolving THIS one).
      const nextFallback =
        childScope.alias === searchAlias && childScope.imports === searchImports ? undefined : childScope;

      let copy = resolveForwardedSiblingConfigFrom(
        applyLinkedEntityRename(atomTrait, linkedEntity, this.entityIdsInScope),
        embedderChain(parent),
        orbitalConfig,
        this.schemaConfig,
      );
      if (finalName !== sibling) {
        copy = { ...copy, name: finalName };
        noteRewrite(parent, sibling, finalName);
      }

      // Recurse with THIS copy as the parent but the SAME owner, so a sibling's
      // own sub-views stay inside the owner's materialisation.
      //
      // `parent` for the CHILD: `finalName` (this pull's own, possibly
      // just-renamed name) UNLESS the child will itself search within a
      // pre-resolved scope (`childPreResolvedScope` set — either just
      // entered here, or continuing from `preResolvedScope` above), in
      // which case `parent` STAYS the CURRENT item's own `parent` —
      // effectively the name of whichever trait FIRST crossed from this
      // orbital's own scope into the alias's pre-resolved one, held
      // constant for every descendant reached transitively within it.
      // `std-fitness-studio`'s `InlineTypographyRender21 → 17/20 → 15/16/
      // 18/19` chain (all pre-resolved, none of it a raw-ref hop) surfaced
      // why: Rust's ACTUAL disambiguated names for every one of those seven
      // (`orbital resolve` output) are ALL flat single-level
      // `MembershipDirectory<Name>` — never a cascade through the renamed
      // intermediate (`MembershipDirectoryInlineTypographyRender21Inline
      // TypographyRender17…`). Cascading through `finalName` instead
      // (matching this file's pre-existing behavior for a RAW-walked,
      // non-pre-resolved hop, where each hop genuinely IS a fresh
      // materialization needing its own disambiguation) does not apply
      // once the whole subtree is one already-flattened pre-resolved
      // file — a nested pre-resolved name is either taken (bare) already
      // by construction (no internal collision — pre-resolution runs its
      // own `pullSiblingTraits`/`seen` pass) or genuinely re-collides with
      // something in THIS consumer's OWN `seen` set, and Rust resolves
      // that collision against the ORIGINAL boundary-crossing name, not
      // against whatever this consumer happened to rename an intermediate
      // hop to.
      const childParent = childPreResolvedScope ? parent : finalName;
      for (const next of traitEmbedNamesOf(copy)) {
        work.push({
          alias,
          fallback: nextFallback,
          sibling: next,
          linkedEntity,
          parent: childParent,
          owner,
          preResolvedScope: childPreResolvedScope,
        });
      }

      pulledAs.set(pullKey, finalName);
      subsFor(owner).set(sibling, finalName);
      ownerOf.set(finalName, owner);
      parentOf.set(finalName, parent);
      seen.add(finalName);
      pulled.push({
        trait: copy,
        source: { type: "imported", alias, traitName: sibling },
        ...(linkedEntity !== undefined ? { linkedEntity } : {}),
        ...(foundTypeArgs !== undefined ? { typeArgs: foundTypeArgs } : {}),
      });

      // (C) carry the pulled sibling's CURRENT bound entity forward — same
      // alias first (the common case), any alias as fallback (a rebind can
      // retarget to an entity a DIFFERENT `uses` alias names, mirroring the
      // compiled path's fallback). No bound entity (a stateless render
      // trait) → nothing to carry.
      if (copy.linkedEntity !== undefined) {
        const aux =
          entityByNameForAlias(imports, alias, copy.linkedEntity) ??
          entityByNameAnyAlias(imports, copy.linkedEntity);
        if (aux) auxEntities.push(aux);
      }
    }

    if (pulled.length === 0 && parentRewrites.size === 0) {
      return { errors, auxEntities, pulledNames: new Set() };
    }

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
      const owner = rt.trait.name ? ownerOf.get(rt.trait.name) : undefined;
      const subs = owner ? ownerSubs.get(owner) : undefined;
      if (!subs) continue;
      rt.trait = rewriteListenSources(rt.trait, subs, idByName);
    }

    refResolverLog.info("sibling-pull", {
      pulled: pulled.map((p) => ({
        trait: p.trait.name,
        owner: p.trait.name ? ownerOf.get(p.trait.name) : undefined,
        parent: p.trait.name ? parentOf.get(p.trait.name) : undefined,
        linkedEntity: p.linkedEntity ?? p.trait.linkedEntity,
      })),
    });
    resolved.push(...pulled);
    const pulledNames = new Set(
      pulled.map((p) => p.trait.name).filter((n): n is string => Boolean(n)),
    );
    return { errors, auxEntities, pulledNames };
  }

  /**
   * Resolve a single trait reference.
   */
  private async resolveTraitRef(
    traitRef: TraitRef,
    imports: ResolvedImports,
    chain: ImportChainLike,
    embedCtx?: OrbitalEmbedContext,
    aliasEntityRenames?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ): Promise<ResolveResult<ResolvedTrait>> {
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
        typeArgs?: Record<string, string>;
      };
      return this.resolveTraitRefString(
        refObj.ref,
        imports,
        chain,
        refObj.config,
        refObj.linkedEntity,
        refObj.name,
        refObj.events,
        refObj.listens,
        refObj.refId,
        refObj.typeArgs,
        embedCtx,
        aliasEntityRenames,
      );
    }

    // Case 3: String reference
    if (typeof traitRef === "string") {
      return this.resolveTraitRefString(
        traitRef,
        imports,
        chain,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        embedCtx,
        aliasEntityRenames,
      );
    }

    return {
      success: false,
      errors: [`Unknown trait reference format: ${JSON.stringify(traitRef)}`],
    };
  }

  /**
   * Resolve a trait reference string.
   */
  private async resolveTraitRefString(
    ref: string,
    imports: ResolvedImports,
    chain: ImportChainLike,
    config?: TraitConfig,
    linkedEntity?: string,
    overrideName?: string,
    eventRenames?: { [oldKey: string]: string },
    listensOverride?: TraitEventListener[],
    refId?: TraitId,
    typeArgs?: Record<string, string>,
    embedCtx?: OrbitalEmbedContext,
    aliasEntityRenames?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ): Promise<ResolveResult<ResolvedTrait>> {
    // Check if it's an imported trait reference: "Alias.traits.TraitName"
    const parsed = parseImportedTraitRef(ref);

    // This entry's own local name inside `embedCtx.traitRefs` — a call-site
    // rename or, absent one, the upstream trait name. Resolve a whole-string
    // `@config.<k>` call-site override THROUGH the embedder chain BEFORE it
    // reaches the trait body (ledger (n)-JS, ref-entry half): `embedCtx` is
    // `undefined` for a nested-ref call (`resolveTraitEntry`, an upstream
    // atom's own internal composition — out of scope here), so this is a
    // no-op there, matching prior behavior exactly.
    const localName = overrideName ?? (parsed ? parsed.traitName : ref);
    const resolvedConfig =
      config && embedCtx
        ? resolveEmbedderConfigForward(config, localName, embedCtx, this.schemaConfig)
        : config;

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
      // ref's `refId` against the id index, falling back to a name-keyed
      // entry lookup (`findTraitEntryInOrbital`, which resolves a ref-shaped
      // entry recursively via `resolveTraitEntry` — nested refs, ledger (i))
      // when the id is absent or unindexed. Search every orbital of the
      // behavior — a trait name is unique across one behavior's orbitals by
      // convention, first match wins (same policy as the compiled path's
      // `get_trait`).
      let trait: Trait | null = null;
      // Default embed scope: THIS level's own (`imports`/`parsed.alias`) —
      // overwritten below when the entry recurses into a deeper ref
      // (`resolveTraitEntry`'s embedScope then carries whatever scope the
      // recursion actually resolved against).
      let embedScope: { imports: ResolvedImports; alias: string } = { imports, alias: parsed.alias };
      const idEntry = refId ? imports.idIndex?.get(refId) : undefined;
      if (idEntry && idEntry.kind === "trait") {
        trait = idEntry.node as Trait;
      } else {
        for (const o of importedOrbitals(imported)) {
          const entry = findTraitEntryInOrbital(o, parsed.traitName);
          if (!entry) continue;
          const entryResolved = await this.resolveTraitEntry(
            imported,
            entry,
            parsed.traitName,
            chain,
            imports,
            resolvedConfig,
          );
          if (!entryResolved.success) return entryResolved;
          trait = entryResolved.data.trait;
          embedScope = entryResolved.data.embedScope;
          break;
        }
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

      // §B4-R5: the resolved trait may itself carry an unresolved
      // `@config.<knob>` forward on its OWN declared config — a knob native
      // to the orbital that DECLARES the trait (e.g. an orbital-level knob
      // like `TimesheetPanelOrbital.config.browseColumns` forwarded by its
      // inline `TimesheetBrowseList.config.columns`), left raw because the
      // loader that produced this trait never substitutes an imported
      // atom's own defaults (the override surface must survive for whoever
      // composes it). A §8 trait-form reference (`Alias.traits.X`) has no
      // equivalent to an orbital-import's own re-resolution against the
      // upstream orbital's config, so without this the forward is judged
      // only against the CONSUMER's rungs and never resolves — the
      // validator then reports a knob no trait in the referrer chain
      // declares (Rust twin: `trait.rs`'s `TraitReference::Reference` arm,
      // same `embedGraph`/`embedderChain`, plus `ctx.get_orbital_config_for_trait`
      // + `alias_schema_configs`). Same embedder chain the call-site's own
      // forward resolution above used, plus the two rungs only this call
      // site needs: the orbital that actually owns the trait, then that
      // alias's app config folded with any `uses { config }` override
      // (`imported.schemaConfig`) — the SAME chain the knob would have
      // resolved through inside its own home file. The consumer's
      // embedders/`orbital.config` are still tried FIRST, so a consumer
      // override of the same knob name still wins. Runs BEFORE every
      // rename/fold below so a call-site override (landed later by
      // `foldCallSiteConfigOntoTrait`) still wins over whatever this step
      // resolves.
      if (embedCtx && trait.config) {
        const homeResolvedConfig = resolveConfigForwards(
          trait.config,
          embedderChain(localName, embedCtx.traitRefs, embedCtx.embedGraph),
          embedCtx.orbitalConfig,
          homeOrbitalConfigForTrait(imported, parsed.traitName),
          imported.schemaConfig,
          this.schemaConfig,
        );
        if (homeResolvedConfig) {
          trait = { ...trait, config: homeResolvedConfig };
        }
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
      const { trait: configResolvedTrait, errors: configRefErrors, resolvedKnobs } =
        resolveConfigRefEmitNames(baseTrait, resolvedConfig);
      if (configRefErrors.length > 0) {
        return { success: false, errors: configRefErrors };
      }
      const reboundTrait = applyLinkedEntityRename(configResolvedTrait, linkedEntity, this.entityIdsInScope);
      // C1-J6: a SIBLING pull from this SAME alias may already have
      // established a rebind (see {@link ReferenceResolver.
      // buildAliasEntityRenames}) that THIS trait's own rebind (or lack of
      // one) never touches — apply it as an extra, narrower pass.
      const aliasSubs = aliasEntityRenames?.get(parsed.alias);
      const aliasReboundTrait = aliasSubs
        ? applyAliasEntityRenames(reboundTrait, aliasSubs, this.entityIdsInScope)
        : reboundTrait;
      const renamedTrait = applyEventRenames(aliasReboundTrait, eventRenames);
      // Declared half of the config-ref/events-rename fold (ledger (j)) — the
      // call-site half is `renamedConfig` below.
      const foldedTrait = foldEventRenameOntoDeclaredKnobs(
        renamedTrait,
        resolvedKnobValues(baseTrait, configResolvedTrait, resolvedKnobs),
        eventRenames,
      );
      const renamedConfig = applyEventRenamesToCallSiteConfig(resolvedConfig, reboundTrait.config, eventRenames);
      // GAP-AG-VALUE-DRIFT twin (Rust `trait.rs` step 6): land the resolved
      // call-site config onto the trait's OWN declared config, not just the
      // `ResolvedTrait.config` side-record below — a downstream reader of
      // `trait.config[<knob>].default` (render, factory bake, a dead-knob
      // check) must see the override, exactly like every other consumer of
      // `overrideDeclaredKnobs`.
      const configFoldedTrait = foldCallSiteConfigOntoTrait(foldedTrait, renamedConfig);
      const finalTrait: Trait = listensOverride !== undefined
        ? { ...configFoldedTrait, listens: listensOverride }
        : configFoldedTrait;
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
          config: renamedConfig,
          linkedEntity,
          embedScope,
          ...(typeArgs !== undefined ? { typeArgs } : {}),
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
      const { trait: configResolvedLocal, errors: localConfigRefErrors, resolvedKnobs: localResolvedKnobs } =
        resolveConfigRefEmitNames(baseLocal, resolvedConfig);
      if (localConfigRefErrors.length > 0) {
        return { success: false, errors: localConfigRefErrors };
      }
      const reboundLocal = applyLinkedEntityRename(configResolvedLocal, linkedEntity, this.entityIdsInScope);
      const renamedLocalTrait = applyEventRenames(reboundLocal, eventRenames);
      const foldedLocalTrait = foldEventRenameOntoDeclaredKnobs(
        renamedLocalTrait,
        resolvedKnobValues(baseLocal, configResolvedLocal, localResolvedKnobs),
        eventRenames,
      );
      const renamedLocalConfig = applyEventRenamesToCallSiteConfig(resolvedConfig, reboundLocal.config, eventRenames);
      // Same GAP-AG-VALUE-DRIFT fold as the imported branch above — a local
      // trait ref's call-site config must land on its OWN declared config
      // too, not just the `ResolvedTrait.config` side-record.
      const configFoldedLocalTrait = foldCallSiteConfigOntoTrait(foldedLocalTrait, renamedLocalConfig);
      const finalLocalTrait: Trait = listensOverride !== undefined
        ? { ...configFoldedLocalTrait, listens: listensOverride }
        : configFoldedLocalTrait;
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
          config: renamedLocalConfig,
          linkedEntity,
          ...(typeArgs !== undefined ? { typeArgs } : {}),
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
  private async resolvePages(
    pageRefs: PageRef[],
    imports: ResolvedImports,
    chain: ImportChainLike,
  ): Promise<ResolveResult<ResolvedPage[]>> {
    const errors: string[] = [];
    const resolved: ResolvedPage[] = [];

    for (const pageRef of pageRefs) {
      const result = await this.resolvePageRef(pageRef, imports, chain);
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
  private async resolvePageRef(
    pageRef: PageRef,
    imports: ResolvedImports,
    chain: ImportChainLike,
  ): Promise<ResolveResult<ResolvedPage>> {
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
      return this.resolvePageRefString(pageRef, imports, chain);
    }

    // Case 3: Object reference { ref: "Alias.pages.PageName", path?: "/override" }
    if (isPageReferenceObject(pageRef)) {
      return this.resolvePageRefObject(pageRef, imports, chain);
    }

    return {
      success: false,
      errors: [`Unknown page reference format: ${JSON.stringify(pageRef)}`],
    };
  }

  /**
   * Resolve a page reference string.
   */
  private async resolvePageRefString(
    ref: string,
    imports: ResolvedImports,
    chain: ImportChainLike,
    refId?: PageId,
  ): Promise<ResolveResult<ResolvedPage>> {
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

    // Id-primary: prefer `refId` against the id index, falling back to a
    // name-keyed entry lookup (`findPageEntryInOrbital`, which resolves a
    // ref-shaped entry recursively via `resolvePageEntry` — nested refs,
    // ledger (i)) when the id is absent or unindexed. Pages, like traits,
    // may live in any orbital of a multi-orbital behavior.
    let page: Page | null = null;
    const idEntry = refId ? imports.idIndex?.get(refId) : undefined;
    if (idEntry && idEntry.kind === "page") {
      page = { ...(idEntry.node as Page) };
    } else {
      for (const o of importedOrbitals(imported)) {
        const entry = findPageEntryInOrbital(o, parsed.pageName);
        if (!entry) continue;
        const entryResolved = await this.resolvePageEntry(imported, entry, chain);
        if (!entryResolved.success) return entryResolved;
        page = entryResolved.data.page;
        break;
      }
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
   * Resolve a page reference object, applying every call-site override —
   * `path` (direct assignment), `linkedEntity` (rebind `primaryEntity` and
   * every page-level trait pointer that named the old entity), and `traits`
   * (full replacement) — mirroring the compiler's `apply_overrides_to_page`
   * (`phases/inline/page.rs:21-93`). `Page.traits` is a `PageTraitRef[]`
   * pointer list (a trait's own body lives in the orbital's `traits {}`, not
   * on the page), so unlike Rust's `TraitReference` the `linkedEntity` rebind
   * only ever touches each pointer's OWN `linkedEntity` field — there is no
   * inline trait body here to walk with `renameEntitiesInTrait`.
   */
  private async resolvePageRefObject(
    refObj: PageRefObject,
    imports: ResolvedImports,
    chain: ImportChainLike,
  ): Promise<ResolveResult<ResolvedPage>> {
    const baseResult = await this.resolvePageRefString(refObj.ref, imports, chain, refObj.refId);
    if (!baseResult.success) {
      return baseResult;
    }

    const resolved = baseResult.data!;

    if (refObj.path) {
      const originalPath = resolved.page.path;
      resolved.page = {
        ...resolved.page,
        path: refObj.path,
      };
      resolved.pathOverridden = true;
      resolved.originalPath = originalPath;
    }

    if (refObj.linkedEntity) {
      const oldEntity = resolved.page.primaryEntity;
      const newEntity = refObj.linkedEntity;
      const rebindPointers = (pointers: PageTraitRef[] | undefined): PageTraitRef[] | undefined =>
        oldEntity && oldEntity !== newEntity
          ? pointers?.map((pt) => (pt.linkedEntity === oldEntity ? { ...pt, linkedEntity: newEntity } : pt))
          : pointers;
      resolved.page = {
        ...resolved.page,
        primaryEntity: newEntity,
        traits: rebindPointers(resolved.page.traits),
      };
    }

    if (refObj.traits) {
      resolved.page = { ...resolved.page, traits: refObj.traits.map(toPageTraitRef) };
    }

    return {
      success: true,
      data: resolved,
      warnings: baseResult.warnings,
    };
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
   * Flatten every reference-form orbital (`orbital X = Alias.orbitals.Y
   * { … }`, docs/Almadar_Orbital_Import.md §4) in a schema BEFORE the
   * ordinary per-orbital {@link resolve} pass runs — the interpreter-path
   * twin of the (not-yet-landed) compiler's inline-phase flatten. After this
   * call, no returned `OrbitalDefinition` carries `.reference`.
   */
  async resolveOrbitalImports(
    schema: OrbitalSchema,
    opts?: {
      /**
       * Skip the type-param sentinel pre-pass below (only) — set by
       * {@link preResolveImportFile} for the SAME reason `resolve()`'s own
       * `opts.skipTypeParamSentinels` exists (see its doc): this pre-pass
       * mutates the orbital's inline trait objects IN PLACE, destructively
       * substituting a `$p` sentinel with the type param's OWN declared
       * default. Every other caller of this method either follows up with
       * an ordinary `resolve()` call (which needs this pre-pass for the
       * standalone-`resolveOrbitalImports`-only callers that never call
       * `resolve()` afterward — direct-callers in `test/reference-resolver-
       * orbital-import*.test.ts`) or IS that standalone caller — so this
       * defaults to running, exactly as before this option existed. Only
       * `preResolveImportFile`'s OWN nested `resolveOrbitalImports` call
       * passes `true`: an imported FILE's own generic atom must keep its
       * `$p` sentinel untouched until the EXTERNAL consumer's `typeArgs` is
       * known (the loader can hand back the SAME shared trait object on
       * every load — this file's tests use exactly that pattern — so a
       * destructive substitution here corrupts the object the REAL
       * consumer-level resolve reads from too, not just this pre-resolution
       * pass's own throwaway copy).
       */
      skipTypeParamSentinels?: boolean;
    },
  ): Promise<ResolveResult<OrbitalDefinition[]>> {
    const errors: string[] = [];
    const flattened: OrbitalDefinition[] = [];
    const chain: ImportChainLike = { push: () => null, pop: () => { /* no-op */ }, clone(): ImportChainLike { return this; } };
    const visiting = new Set<string>();
    // Computed ONCE over the schema's original (pre-flatten) orbitals — an
    // `entities {}`/`roles {}` retarget always names a REAL consumer entity
    // / roster declared inline elsewhere in the same schema, independent of
    // import-flattening order (§ Stage B `entities {}`/`roles {}`).
    const consumerEntityIds = consumerEntityIdsOf(schema.orbitals);
    // (B) fix: `consumerEntityIdsOf` above excludes reference-form orbitals
    // BY CONSTRUCTION (their real primary entity doesn't exist until THEY
    // resolve) — which made the approved two-import Project Friday shape
    // order-dependent, since orbital N's `entities {}` naming orbital M's
    // own materialized primary only worked if M happened to resolve first.
    // Add every reference-form orbital's OWN materialized primary name →
    // derived id too, so `entities {}` targeting works ORDER-FREE across
    // sibling imports in the same schema — mirrors the compiled path's
    // `precompute_reference_form_primary_ids`.
    for (const [name, id] of await this.precomputeReferenceFormPrimaryIds(schema, chain)) {
      if (!consumerEntityIds.has(name)) consumerEntityIds.set(name, id);
    }
    const consumerRoster = identityEntitiesOf(schema.orbitals);
    for (const orbital of schema.orbitals) {
      if (!orbital.reference) {
        // J1: a non-reference orbital never runs through `resolve()` here
        // (nothing to import/flatten), so its inline traits' payload
        // sentinels would otherwise never get resolved at all. Reference-
        // form orbitals get this for free inside `materializeOrbitalRef`'s
        // own `resolve(upstream)` call below.
        if (!opts?.skipTypeParamSentinels && isInlineEntity(orbital.entity)) {
          resolveOrbitalTypeParamSentinels(
            orbital.traits.filter(isInlineTrait).map((t) => ({ trait: t as Trait })),
            orbital.entity,
            (orbital.auxiliaryEntities ?? []).filter(isInlineEntity),
            orbital.types,
          );
        }
        flattened.push(orbital);
        continue;
      }
      const result = await this.resolveOrbitalRefChain(orbital, undefined, chain, visiting, consumerEntityIds, consumerRoster);
      if (!result.success) {
        errors.push(...result.errors);
        continue;
      }
      flattened.push(result.data);
    }
    if (errors.length > 0) return { success: false, errors };
    return { success: true, data: flattened, warnings: [] };
  }

  /**
   * (B) The materialized primary name → derived id of every REFERENCE-FORM
   * orbital this schema declares (`orbital X = Alias.orbitals.Y { … }`),
   * computed order-free — WITHOUT requiring any other orbital in `schema`
   * to have resolved first, and without recursively flattening the
   * upstream. Each reference's alias is loaded via the ordinary
   * `resolveImports` path, which the loader caches by absolute path (see
   * `ExternalOrbitalLoader`'s `LoaderCache`) — the REAL flatten
   * (`resolveOrbitalRefChain`) moments later is then a cache hit, no
   * duplicate work — and its named orbital looked up directly in the
   * loaded (un-flattened) schema: an upstream's OWN primary entity id/name
   * never change through resolution (only a CONSUMER-side CLONE gets a
   * fresh derived id), so this shallow load's entity is exactly what the
   * real flatten pass would see too. Uses the SAME `materializedPrimaryEntity`
   * pair `materializeOrbitalRef` computes for itself — one owner. JS twin
   * of the compiled path's `precompute_reference_form_primary_ids`.
   *
   * Best-effort: a reference this pre-pass cannot resolve (unknown alias,
   * malformed reference string, upstream orbital not found, load failure)
   * is silently skipped here — the REAL `resolveOrbitalRefChain` call
   * moments later still surfaces the actual error for it.
   */
  private async precomputeReferenceFormPrimaryIds(
    schema: OrbitalSchema,
    chain: ImportChainLike,
  ): Promise<Map<string, EntityId>> {
    const out = new Map<string, EntityId>();
    for (const orbital of schema.orbitals) {
      const ref = orbital.reference;
      if (!ref) continue;
      const parsed = parseOrbitalRef(ref.ref);
      if (!parsed) continue;
      const importsResult = await this.resolveImports(orbital.uses ?? [], undefined, chain);
      if (!importsResult.success) continue;
      const imported = importsResult.data.orbitals.get(parsed.alias);
      if (!imported) continue;
      const upstream = importedOrbitals(imported).find((o) => o.name === parsed.orbitalName);
      if (!upstream || !isInlineEntity(upstream.entity)) continue;
      const { name, id } = materializedPrimaryEntity(upstream.entity, upstream.id, ref, orbital.name);
      out.set(name, id);
    }
    return out;
  }

  /**
   * Resolve one reference-form orbital, recursing into the upstream first
   * when IT is also reference-form ("already fully inlined because inline
   * recursed into every loaded orbital" — docs/Almadar_Orbital_Import.md §9
   * step 3 — the JS resolver needs its own cycle guard since it has no
   * file-level inline-order pass to lean on).
   */
  private async resolveOrbitalRefChain(
    orbital: OrbitalDefinition,
    sourcePath: string | undefined,
    chain: ImportChainLike,
    visiting: Set<string>,
    consumerEntityIds: ReadonlyMap<string, EntityId>,
    consumerRoster: readonly Entity[],
  ): Promise<ResolveResult<OrbitalDefinition>> {
    const ref = orbital.reference;
    if (!ref) return { success: true, data: orbital, warnings: [] };

    const parsed = parseOrbitalRef(ref.ref);
    if (!parsed) {
      return {
        success: false,
        errors: [`Invalid orbital reference format: ${ref.ref}. Expected "Alias.orbitals.OrbitalName"`],
      };
    }

    const importsResult = await this.resolveImports(orbital.uses ?? [], sourcePath, chain);
    if (!importsResult.success) return { success: false, errors: importsResult.errors };
    const imported = importsResult.data.orbitals.get(parsed.alias);
    if (!imported) {
      return {
        success: false,
        errors: [
          `Unknown import alias in orbital reference: ${parsed.alias}. ` +
            `Available aliases: ${Array.from(importsResult.data.orbitals.keys()).join(", ") || "none"}`,
        ],
      };
    }

    const candidates = importedOrbitals(imported);
    let upstream = candidates.find((o) => o.name === parsed.orbitalName);
    if (!upstream) {
      return {
        success: false,
        errors: [
          `Orbital "${parsed.orbitalName}" not found in imported behavior "${parsed.alias}". ` +
            `Available orbitals: ${candidates.map((o) => o.name).join(", ") || "none"}`,
        ],
      };
    }

    const cycleKey = `${imported.sourcePath}::${parsed.orbitalName}`;
    if (visiting.has(cycleKey)) {
      return {
        success: false,
        errors: [
          `Circular orbital reference: "${orbital.name}" imports "${parsed.alias}.orbitals.${parsed.orbitalName}" ` +
            `while that orbital is itself being resolved`,
        ],
      };
    }
    visiting.add(cycleKey);
    if (upstream.reference) {
      const nested = await this.resolveOrbitalRefChain(
        upstream,
        imported.sourcePath,
        chain,
        visiting,
        consumerEntityIds,
        consumerRoster,
      );
      if (!nested.success) {
        visiting.delete(cycleKey);
        return nested;
      }
      upstream = nested.data;
    }
    visiting.delete(cycleKey);

    const materialized = await this.materializeOrbitalRef(
      upstream,
      ref,
      orbital.name,
      orbital.id,
      imported.sourcePath,
      chain,
      candidates,
      consumerEntityIds,
      consumerRoster,
      imported.schemaConfig,
    );
    if (!materialized.success) return materialized;
    // Sibling trait declarations legal inside the reference body (§ Stage B
    // "siblings") ride the LOCAL orbital's own `.traits` — Stage A forced
    // this empty for a pure reference-form orbital; Stage B's grammar lets a
    // `trait` statement sit alongside `= Alias.orbitals.Y { … }`. Appended
    // UN-prefixed (never touched by `subs`) after the materialized set; they
    // resolve later by the ordinary per-orbital `resolve()` pass against
    // THIS orbital's own `uses` (set below), never upstream's.
    const siblingTraits = orbital.traits ?? [];
    // `uses` on a reference-form orbital is provenance for the consumer's OWN
    // declarations (a nested import mixed into the same local orbital), not
    // upstream's — matches `resolve()`'s existing "already-resolved schemas
    // keep `uses` as provenance" convention (§ comment above `resolve()`).
    // Also the scope siblings resolve `Alias.traits.X` refs against — the
    // `...upstream` spread inside `materializeOrbitalRef` would otherwise
    // hand a sibling the UPSTREAM behavior's aliases.
    return {
      success: true,
      data: {
        ...materialized.data,
        ...(siblingTraits.length > 0
          ? { traits: [...materialized.data.traits, ...siblingTraits] }
          : {}),
        uses: orbital.uses,
      },
      warnings: materialized.warnings,
    };
  }

  /**
   * Materialize a reference-form orbital: flatten the (already-inlined)
   * upstream orbital's whole trait/entity/page closure into the consumer,
   * unconditionally prefixed by `localName` (docs/Almadar_Orbital_Import.md
   * §4.3). JS twin of the (not-yet-landed) compiler's
   * `resolve_orbital_reference`.
   */
  private async materializeOrbitalRef(
    upstream: Orbital,
    ref: OrbitalRefObject,
    localName: string,
    localId: OrbitalId | undefined,
    sourcePath: string | undefined,
    chain: ImportChainLike,
    aliasOrbitals: readonly Orbital[],
    consumerEntityIds: ReadonlyMap<string, EntityId>,
    consumerRoster: readonly Entity[],
    /**
     * The imported behavior's OWN loaded app-level `config {}` (already
     * folded with `uses … { config }`, see {@link resolveImports}) — the
     * schema rung for the upstream traits' own forward chain. NEVER
     * `this.schemaConfig`, which belongs to the CONSUMER (ledger (b)); using
     * it here would let a same-named consumer knob leak into the imported
     * orbital's own resolution.
     */
    importedSchemaConfig: DeclaredTraitConfig | undefined,
  ): Promise<ResolveResult<OrbitalDefinition>> {
    // Upstream traits must be inline first: resolve the upstream's OWN trait
    // refs, sibling pulls, and config-forward chain in ITS OWN import scope
    // (REUSED — the ordinary `resolve()` pass) before this orbital's
    // unconditional prefix runs over the result.
    //
    // `this.schemaConfig` is single mutable instance state (the CURRENT
    // file's own app-level config — see its own doc comment), read by
    // `resolveEmbedderConfigForward`/`resolveForwardedSiblingConfigFrom` as
    // the outermost fallback rung of a `@config.<knob>` forward chain. It
    // was never swapped here despite `importedSchemaConfig`'s OWN doc
    // comment already saying it must be — so a top-level call-site forward
    // inside the upstream (e.g. `std-time-tracking`'s `TimesheetAppLayout
    // { config { appName: "@config.appName" } }`) fell through to the
    // CONSUMER's schema config (this schema's own `config {}`, which
    // doesn't declare `appName` at all, let alone the `uses { config }`
    // override) instead of the upstream's OWN (`importedSchemaConfig`,
    // already folded with `uses { config }` by `resolveImports`), and the
    // forward silently never resolved. `resolveOrbitalImports` processes
    // reference-form orbitals strictly sequentially (a `for` loop with
    // `await`, `resolveOrbitalRefChain`/`materializeOrbitalRef` never run
    // concurrently on one resolver instance), so a save/swap/restore around
    // this single nested call is race-free.
    const savedSchemaConfig = this.schemaConfig;
    this.schemaConfig = importedSchemaConfig;
    let resolvedUpstream: ResolveResult<ResolvedOrbital>;
    try {
      resolvedUpstream = await this.resolve(upstream, sourcePath, chain);
    } finally {
      this.schemaConfig = savedSchemaConfig;
    }
    if (!resolvedUpstream.success) {
      return {
        success: false,
        errors: resolvedUpstream.errors.map(
          (e) => `Orbital reference "${localName}" (${ref.ref}): ${e}`,
        ),
      };
    }
    const {
      entity: upstreamEntity,
      traits: upstreamTraits,
      pages: upstreamPages,
      // (C) the RESOLVED aux-entity set — includes whatever sibling-pull
      // surfaced (`pullSiblingTraits`'s aux-entity carry), never just
      // `upstream.auxiliaryEntities` (the pre-resolve INPUT, which misses
      // every un-rebound composed atom's own entity).
      auxiliaryEntities: upstreamAuxiliaryEntities,
    } = resolvedUpstream.data;

    // omit/only trim BEFORE the unconditional prefix — `subs` only ever maps
    // survivors.
    const onlySet = ref.only ? new Set(ref.only) : undefined;
    const omitSet = new Set(ref.omit ?? []);
    const keptTraits = upstreamTraits.filter((rt) =>
      onlySet ? onlySet.has(rt.trait.name) : !omitSet.has(rt.trait.name),
    );
    const keptNames = new Set(keptTraits.map((rt) => rt.trait.name));
    const removedNames = new Set(
      upstreamTraits.map((rt) => rt.trait.name).filter((n) => !keptNames.has(n)),
    );

    const errors: string[] = [];
    for (const rt of keptTraits) {
      for (const embed of traitEmbedNamesOf(rt.trait)) {
        if (removedNames.has(embed)) {
          errors.push(
            `Orbital "${localName}" omits trait "${embed}" but surviving trait "${rt.trait.name}" still embeds ` +
              `it via @trait.${embed} (ORB_O_OMIT_EMBEDDED_TRAIT)`,
          );
        }
      }
    }
    if (errors.length > 0) return { success: false, errors };

    // Unconditional prefix (§4.3) — traits + entities, one combined subs map.
    let auxEntities = upstreamAuxiliaryEntities ?? [];
    const subs = new Map<string, string>();
    for (const rt of keptTraits) subs.set(rt.trait.name, `${localName}${rt.trait.name}`);
    const { name: primaryFinalName, id: primaryId } = materializedPrimaryEntity(
      upstreamEntity,
      upstream.id,
      ref,
      localName,
    );
    subs.set(upstreamEntity.name, primaryFinalName);
    for (const e of auxEntities) subs.set(e.name, `${localName}${e.name}`);
    const fieldSubs = new Map<string, string>(Object.entries(ref.fields ?? {}));

    // `entities {}` — out-of-orbital retarget (§ Stage B "entities"):
    // "out-of-orbital" = named by the imported closure but declared by
    // ANOTHER orbital of the same upstream alias — a decidable set read off
    // `aliasOrbitals` (every orbital `importedOrbitals(imported)` returns).
    // `upstreamUniverseEntities` additionally keeps each name's own upstream
    // DEFINITION and `primaryEntityNames` whether it is EVER some orbital's
    // PRIMARY entity — the clone ruling below discriminates on that, not
    // persistence (an entity is "aux-only" when no orbital of the alias
    // ever declares it as `entity`, only ever as an `auxiliaryEntities`
    // member).
    const closure = new Set<string>([upstreamEntity.name, ...auxEntities.map((e) => e.name)]);
    const upstreamUniverse = new Set<string>();
    const upstreamUniverseEntities = new Map<string, Entity>();
    const primaryEntityNames = new Set<string>();
    for (const o of aliasOrbitals) {
      if (o.name === upstream.name) continue;
      if (isInlineEntity(o.entity)) primaryEntityNames.add(o.entity.name);
      for (const entity of inlineEntityRefsOf(o)) {
        if (!closure.has(entity.name)) {
          upstreamUniverse.add(entity.name);
          upstreamUniverseEntities.set(entity.name, entity);
        }
      }
    }
    // Entity ids for the entities THIS closure owns are derived further down
    // (Gap F); an out-of-orbital retarget instead reuses the REAL consumer
    // entity's own already-materialized id — folded into the SAME `subs`/
    // `entityIds` maps every other rewrite below reads from.
    const entityIds = new Map<string, EntityId>();
    if (ref.entities) {
      for (const [upstreamKey, consumerName] of Object.entries(ref.entities)) {
        if (!upstreamUniverse.has(upstreamKey)) {
          errors.push(
            `Orbital "${localName}" declares entities { ${upstreamKey}: ${consumerName} } but "${upstreamKey}" is ` +
              `not an out-of-orbital entity of upstream alias "${upstream.name}" (ORB_O_ENTITY_UNKNOWN_KEY)`,
          );
          continue;
        }
        const consumerId = consumerEntityIds.get(consumerName);
        if (consumerId === undefined) {
          errors.push(
            `Orbital "${localName}" entities { ${upstreamKey}: ${consumerName} } targets "${consumerName}", which ` +
              `the consumer schema does not declare (ORB_O_ENTITY_TARGET_UNKNOWN)`,
          );
          continue;
        }
        subs.set(upstreamKey, consumerName);
        entityIds.set(consumerName, consumerId);
      }
      if (errors.length > 0) return { success: false, errors };
    }
    // Every out-of-orbital entity the kept closure actually reaches — relation
    // targets (primary, each aux, every kept trait's `sourceEntityDefinition`),
    // entity-slot tokens inside kept traits (`collectEntityNamesInTrait`, the
    // read-only twin of `renameEntitiesInTrait`'s position rule), and page
    // `primaryEntity` / trait `linkedEntity` — must have an `entities {}` key,
    // or the reference is silently left pointing at upstream's un-prefixed name.
    const referenced = new Set<string>();
    for (const rt of keptTraits) {
      if (rt.trait.linkedEntity && upstreamUniverse.has(rt.trait.linkedEntity)) {
        referenced.add(rt.trait.linkedEntity);
      }
      for (const name of collectEntityNamesInTrait(rt.trait, upstreamUniverse)) referenced.add(name);
      if (rt.trait.sourceEntityDefinition) {
        for (const name of relationTargetsOfEntity(rt.trait.sourceEntityDefinition, upstreamUniverse)) {
          referenced.add(name);
        }
      }
    }
    for (const name of relationTargetsOfEntity(upstreamEntity, upstreamUniverse)) referenced.add(name);
    for (const aux of auxEntities) {
      for (const name of relationTargetsOfEntity(aux, upstreamUniverse)) referenced.add(name);
    }
    for (const rp of upstreamPages) {
      if (rp.page.primaryEntity && upstreamUniverse.has(rp.page.primaryEntity)) {
        referenced.add(rp.page.primaryEntity);
      }
      for (const tr of rp.page.traits ?? []) {
        if (tr.linkedEntity && upstreamUniverse.has(tr.linkedEntity)) referenced.add(tr.linkedEntity);
      }
    }
    // Discriminator is PRIMARY vs AUXILIARY in the upstream, NOT persistence
    // (Rust twin gets the same ruling). An out-of-orbital entity that is
    // some OTHER orbital's PRIMARY entity (e.g. `Employee`) requires
    // `entities {}` — it is that orbital's own record identity, a real
    // cross-orbital row. One that appears ONLY as an auxiliary entity
    // anywhere in the upstream (materialized by descent from an atom — e.g.
    // `std-notification-panel`'s PERSISTENT `NotificationRecord`, or a
    // runtime `AppLayoutData`) is not owned by any single orbital's record
    // identity, so it is CLONED into this import as a prefixed aux entity
    // (fresh derived id, relation/entity tokens renamed through `subs` like
    // every other aux) rather than demanded in `entities {}` — regardless of
    // its persistence. Exception: `identity: true` (the entity typing the
    // ambient `@user` viewer — `[runtime, identity]` is "the provider-
    // supplied current viewer" per `Entity.identity`'s own doc) is NEVER
    // cloned even when aux-only — a roster clone would fork `@user`/role
    // comparisons away from the real shared roster, so it still requires
    // the mapping (verified against the existing `Member` roster fixture in
    // `reference-resolver-orbital-import.test.ts`, `persistence: 'runtime',
    // identity: true`, which must keep failing `ORB_O_ENTITY_UNMAPPED`
    // unmapped). Explicitly mapping an aux-only entity in `entities {}` is
    // still allowed (the `subs.has(name)` check below skips it). Two
    // imports of the same upstream alias each run this independently, so
    // they produce two disjoint prefixed clones, never a shared one.
    for (const name of referenced) {
      if (subs.has(name)) continue;
      const definition = upstreamUniverseEntities.get(name);
      const auxOnly = definition !== undefined && !primaryEntityNames.has(name);
      if (definition && auxOnly && !definition.identity) {
        auxEntities = [...auxEntities, definition];
        subs.set(name, `${localName}${name}`);
        continue;
      }
      errors.push(
        `Orbital "${localName}" references out-of-orbital entity "${name}" with no "${name}: <consumer entity>" ` +
          `mapping in entities {} (ORB_O_ENTITY_UNMAPPED)`,
      );
    }
    if (errors.length > 0) return { success: false, errors };

    // `roles {}` — upstream role-LITERAL remap to the consumer roster (§
    // Stage B "roles"). `roleFields`: every UPSTREAM field with a declared
    // vocabulary across EVERY orbital of the upstream alias (field name ->
    // declared values) — the roster entity need not live in the orbital
    // actually being imported.
    const roleFields = new Map<string, readonly string[]>();
    for (const entity of identityEntitiesOf(aliasOrbitals)) {
      for (const field of entity.fields) {
        if (!field.name) continue;
        const vocab = roleVocabularyOf(entity, field.name);
        if (vocab) roleFields.set(field.name, vocab);
      }
    }
    // Per-field CONSUMER vocabulary (Rust B4-R4 twin —
    // `consumer_role_vocabulary` / `orbital_ref_config.rs`). JS has no
    // post-inline validator (unlike the compiled path), so the
    // target-membership check happens here rather than downstream. A
    // `roles {}` target is a member iff the consumer roster has a field
    // with the SAME NAME as the UPSTREAM field the literal came from, and
    // THAT field's own values contain the target — never the union across
    // every field (a status field's `active` must not pass as a role
    // remap target just because SOME field, anywhere, also declares
    // `active`; `roles { approver: [owner, active] }` where `active` is a
    // STATUS value of `Person`, not a role, must still fail).
    const consumerRoleFields = new Map<string, Set<string>>();
    for (const entity of consumerRoster) {
      for (const field of entity.fields) {
        if (!field.name) continue;
        const vocab = roleVocabularyOf(entity, field.name);
        if (!vocab) continue;
        let values = consumerRoleFields.get(field.name);
        if (!values) {
          values = new Set();
          consumerRoleFields.set(field.name, values);
        }
        for (const value of vocab) values.add(value);
      }
    }
    for (const [literal, targets] of Object.entries(ref.roles ?? {})) {
      // Every UPSTREAM field whose vocabulary actually contains this
      // literal — a literal can appear in more than one upstream field,
      // each gets its own check (Rust `matching_fields`, sorted for
      // determinism).
      const matchingFields = [...roleFields.entries()]
        .filter(([, vocab]) => vocab.includes(literal))
        .map(([field]) => field)
        .sort();
      if (matchingFields.length === 0) {
        errors.push(
          `Orbital "${localName}" declares roles { ${literal}: ... } but upstream alias "${upstream.name}"'s ` +
            `roster declares no role field with literal "${literal}" in its vocabulary (ORB_O_ROLE_UNKNOWN_UPSTREAM)`,
        );
        continue;
      }
      for (const field of matchingFields) {
        const allowed = consumerRoleFields.get(field);
        for (const target of targets) {
          if (allowed?.has(target)) continue;
          errors.push(
            `Orbital "${localName}" roles { ${literal}: ${target} } targets "${target}", which is not a member of ` +
              `consumer field "${field}" on the roster (values: ${allowed ? [...allowed].sort().join(", ") : "(none)"}) ` +
              `(ORB_O_ROLE_TARGET_NOT_MEMBER)`,
          );
        }
      }
    }
    if (errors.length > 0) return { success: false, errors };

    // config: upstream's DECLARED knobs folded with the call-site override —
    // an override of an undeclared knob is the JS twin of ORB_O_CONFIG_UNKNOWN_KEY.
    const declaredConfig = upstream.config;
    if (ref.config) {
      for (const key of Object.keys(ref.config)) {
        if (!declaredConfig || !(key in declaredConfig)) {
          errors.push(
            `Orbital "${localName}" overrides config "${key}" but upstream orbital "${upstream.name}" does not ` +
              `declare that knob (ORB_O_CONFIG_UNKNOWN_KEY)`,
          );
        }
      }
      if (errors.length > 0) return { success: false, errors };
    }
    // Fold via the single owner shared with the factory-runtime overlay
    // (`applyParamsToOrb`'s `params.config` handling) — same operation, two
    // call sites. `ref.config` carries full `ConfigFieldDeclaration`s (only
    // `.default` is ever meaningful at an override call site); flatten to
    // the plain value map `overrideDeclaredKnobs` takes.
    const configOverrideValues: Record<string, TraitConfigValue> = {};
    for (const [key, field] of Object.entries(ref.config ?? {})) {
      if (field.default !== undefined) configOverrideValues[key] = field.default;
    }
    const foldedConfig: DeclaredTraitConfig | undefined = declaredConfig
      ? overrideDeclaredKnobs(declaredConfig, configOverrideValues)
      : undefined;

    // Ids: every cloned node (trait AND entity — two imports of one upstream
    // must be pairwise disjoint, not just pairwise renamed) gets a FRESH
    // derived id rooted in its own source id when it has one, else a
    // deterministic fallback seed — see {@link deriveMaterializedId}. Never
    // `mintId`.
    const idByName = new Map<string, TraitId | undefined>();
    const materializedTraits: Trait[] = keptTraits.map((rt) => {
      const finalName = subs.get(rt.trait.name)!;
      const finalId = asTraitId(deriveMaterializedId(rt.trait.id, upstream.id, rt.trait.name, localName, "trait"));
      idByName.set(finalName, finalId);
      return { ...rt.trait, name: finalName, id: finalId };
    });

    // Embedder index: for a cloned trait's final name, the final names of the
    // cloned traits that embed it (`@trait.<X>` in their own effects/ticks/
    // config defaults) — the `materializeOrbitalRef` sibling of the single
    // `embedder` a `pullSiblingTraits` pull site already knows structurally.
    // Every sibling here arrives pre-cloned (no worklist), so the index is
    // built once over the whole kept set instead. Read via `traitEmbedNamesOf`
    // BEFORE `renameTraitEmbeds` runs below — embed tokens still carry
    // UPSTREAM names at this point — then translated through `subs` to the
    // final (prefixed) names both sides of the map use everywhere else.
    // Order is upstream trait order (`materializedTraits` preserves
    // `keptTraits`/`upstreamTraits` order), so "first embedder wins" below
    // agrees with `pullSiblingTraits`' LIFO-processed pull order.
    const embeddersOf = new Map<string, string[]>();
    for (const t of materializedTraits) {
      for (const embed of traitEmbedNamesOf(t)) {
        const embedFinal = subs.get(embed);
        if (!embedFinal) continue;
        let embedders = embeddersOf.get(embedFinal);
        if (!embedders) {
          embedders = [];
          embeddersOf.set(embedFinal, embedders);
        }
        embedders.push(t.name);
      }
    }
    // Each embedder's OWN declared config, snapshotted BEFORE the per-trait
    // loop below (pre-forward-resolution) so a forward chain reads the
    // embedder's literal declared default, never a value the same loop
    // resolved for it earlier in this pass.
    const parentConfigs = new Map<string, DeclaredTraitConfig | undefined>(
      materializedTraits.map((t) => [t.name, t.config]),
    );

    /**
     * `embeddersOf`, walked first-embedder-per-hop, out from `name` (ledger
     * (n)-JS) — the multi-hop fallback for a knob no DIRECT embedder
     * declares. Cycle-safe: `embeddersOf` is a flat scan over every
     * materialized trait's `@trait.X` tokens (unlike `pullSiblingTraits`'
     * dedup-guaranteed `parentOf` forest), so a genuinely circular embed
     * structure is possible here and the walk bounds itself with a
     * `visited` set.
     */
    const transitiveEmbedderChain = (name: string): DeclaredTraitConfig[] => {
      const chain: DeclaredTraitConfig[] = [];
      const seenNames = new Set<string>([name]);
      let cur = embeddersOf.get(name)?.[0];
      while (cur !== undefined && !seenNames.has(cur)) {
        seenNames.add(cur);
        const cfg = parentConfigs.get(cur);
        if (cfg) chain.push(cfg);
        cur = embeddersOf.get(cur)?.[0];
      }
      return chain;
    };

    // Entity ids: final entity name → its OWN freshly materialized id — the
    // entity-scope-only sibling of `idByName` above (Gap F). `primaryId` was
    // already derived above (alongside `primaryFinalName`, via the shared
    // `materializedPrimaryEntity`) so it's set into `entityIds` here, BEFORE
    // any relation-target rewrite needs it (per-trait `sourceEntityDefinition`
    // rename below, and the primary/aux entity rename further down), same as
    // the Rust twin's `entity_ids`. Adds into the SAME `entityIds` map the
    // `entities {}` fold above already seeded with out-of-orbital retargets.
    entityIds.set(primaryFinalName, primaryId);
    for (const e of auxEntities) {
      entityIds.set(
        subs.get(e.name)!,
        asEntityId(deriveMaterializedId(e.id, upstream.id, e.name, localName, "entity")),
      );
    }

    // `pages {}`/`mounts {}` keys must each name a real upstream page path —
    // a typo'd key was previously silently ignored (planning find ii).
    const upstreamPathSet = new Set(upstreamPages.map((rp) => rp.page.path));
    for (const path of [...Object.keys(ref.pages ?? {}), ...Object.keys(ref.mounts ?? {})]) {
      if (!upstreamPathSet.has(path)) {
        errors.push(
          `Orbital "${localName}" names page path "${path}" but upstream orbital "${upstream.name}" has no page ` +
            `at that path (ORB_O_PAGE_UNKNOWN_PATH)`,
        );
      }
    }
    if (errors.length > 0) return { success: false, errors };

    const pathMap = new Map<string, string>(
      upstreamPages.map((rp) => [rp.page.path, ref.pages?.[rp.page.path] ?? rp.page.path]),
    );
    const orbitalRename = upstream.name !== localName ? { from: upstream.name, to: localName } : undefined;
    const finalTraits: Trait[] = materializedTraits.map((trait) => {
      let next = renameTraitEmbeds(trait, subs);
      next = renameEntitiesInTrait(next, subs);
      // Rust sets `linkedEntityId` on every materialized trait — the FINAL
      // (post-rename) `linkedEntity`'s own id, whether that's the primary,
      // an aux (declared or cloned), or an `entities {}` out-of-orbital
      // retarget's real consumer id — all of which already live in the ONE
      // `entityIds` map by this point (V4 dual-carry id sibling of `name`).
      if (next.linkedEntity !== undefined) {
        const linkedEntityId = entityIds.get(next.linkedEntity);
        if (linkedEntityId !== undefined) next = { ...next, linkedEntityId };
      }
      // Same lockstep rule for the `entityRefIds` side-map: every key this
      // import renamed must key the CONSUMER name and carry that entity's
      // id from the SAME `entityIds` map, not the upstream's.
      next = rewriteEntityRefIds(next, subs, entityIds);
      next = renameSourceEntityDefinition(next, subs, entityIds);
      next = rewriteRoleLiteralsInTrait(next, roleFields, ref.roles ?? {});
      if (fieldSubs.size > 0) next = rewriteEntityFieldsInTrait(next, fieldSubs);
      next = rewriteListenSources(next, subs, idByName, orbitalRename);
      if (pathMap.size > 0) {
        next = rewriteTraitNavigateTargets(next, pathMap);
      }
      // Embedder rung first — precedence embedder → orbital → schema (§
      // resolveForwardedSiblingConfigFrom). Each embedder-only pass only
      // moves keys that embedder actually declares (any still-`@config.`
      // key is left alone by construction), so trying every embedder in
      // upstream order and then falling through to orbital/schema is
      // equivalent to "first embedder to declare the knob wins" per key.
      for (const embedderName of embeddersOf.get(trait.name) ?? []) {
        const embedderConfig = parentConfigs.get(embedderName);
        next = resolveForwardedSiblingConfigFrom(next, embedderConfig ? [embedderConfig] : []);
      }
      // Multi-hop fallback (ledger (n)-JS): the direct-embedder loop above
      // only ever tries the trait's IMMEDIATE embedders one rung each — a
      // knob still `@config.`-shaped afterward may be declared by a
      // grandparent embedder instead, so walk the transitive chain before
      // falling through to the orbital/schema rungs. A no-op for any field
      // the loop above already resolved (its default is no longer a
      // `@config.` string).
      next = resolveForwardedSiblingConfigFrom(next, transitiveEmbedderChain(trait.name));
      next = resolveForwardedSiblingConfigFrom(next, [], foldedConfig, importedSchemaConfig);
      // AFTER the config forward (planning find i): a page-path-shaped
      // config default (`navItems[].href`) is often ITSELF a `@config.`
      // forward (an app-level `navItems` knob) — rewriting page paths before
      // the forward resolves leaves every href pointing at the raw string
      // `"@config.navItems"`, missing the rewrite entirely.
      if (pathMap.size > 0) {
        next = rewriteTraitConfigPagePaths(next, pathMap);
      }
      next = applyEventRenames(next, ref.events);
      return next;
    });

    // (A) the primary/auxiliary entities' own relation fields (e.g.
    // `authorId: Author`, a self-relation `parentId: Note`, or an array
    // relation `tagIds: [NoteTagRef]`) still name upstream's un-prefixed
    // entities — rename via the combined `subs` map AFTER the field-key
    // rewrite (`fieldSubs`), which only ever touches field NAMES.
    const renamedPrimaryEntity = rewriteRoleLiteralsInEntity(
      renameEntityRelationTargets(
        rewriteEntityFieldsInEntity(
          {
            ...upstreamEntity,
            name: primaryFinalName,
            id: primaryId,
          },
          fieldSubs,
        ),
        subs,
        entityIds,
      ),
      roleFields,
      ref.roles ?? {},
    );
    // L-J `extend { … }` — ADD fields to the primary entity, after every
    // rename above (fieldSubs/relation-target/role-literal). A relation
    // target resolves in the CONSUMER's own scope.
    const extendResult = applyExtendFields(
      renamedPrimaryEntity,
      ref.extend,
      fieldSubs,
      consumerEntityIds,
      localName,
    );
    if (extendResult.errors.length > 0) return { success: false, errors: extendResult.errors };
    const primaryEntity = extendResult.entity;
    const finalAuxEntities: Entity[] = auxEntities.map((e) => {
      const finalName = subs.get(e.name)!;
      return rewriteRoleLiteralsInEntity(
        renameEntityRelationTargets(
          rewriteEntityFieldsInEntity(
            {
              ...e,
              name: finalName,
              id: entityIds.get(finalName)!,
            },
            fieldSubs,
          ),
          subs,
          entityIds,
        ),
        roleFields,
        ref.roles ?? {},
      );
    });

    const finalPages: Page[] = upstreamPages.map((rp) => {
      const original = rp.page;
      // `pages { "/up": "/local" -> TraitA, TraitB }` — sibling traits (ride
      // the reference body, riding `orbital.traits` un-prefixed) mounted onto
      // this page, keyed by the UPSTREAM path. Their own definitions resolve
      // later by the ordinary per-orbital `resolve()` pass, against this
      // orbital's own `uses`.
      const mountNames = ref.mounts?.[original.path] ?? [];
      const finalPageTraits = [
        ...(original.traits ?? [])
          .filter((tr) => !removedNames.has(tr.ref))
          .map((tr) => {
            const finalRef = subs.get(tr.ref) ?? tr.ref;
            const refId = idByName.get(finalRef);
            return {
              ...tr,
              ref: finalRef,
              ...(refId !== undefined ? { refId } : {}),
              ...(tr.linkedEntity !== undefined
                ? { linkedEntity: subs.get(tr.linkedEntity) ?? tr.linkedEntity }
                : {}),
            };
          }),
        ...mountNames.map((name) => ({ ref: name })),
      ];
      return {
        ...original,
        // Gap (E) — unconditionally prefixed, same as traits/entities (§4.3):
        // two imports of the same upstream orbital with distinct `pages {}`
        // path maps must not collide on page NAME (`Duplicate page name`).
        // `id` is the page-scope sibling of `deriveMaterializedId` (never
        // `mintId`) — fresh and pairwise-disjoint across imports, same as
        // trait/entity ids above.
        name: `${localName}${original.name}`,
        id: asPageId(deriveMaterializedId(original.id, upstream.id, original.name, localName, "page")),
        path: pathMap.get(original.path) ?? original.path,
        ...(original.primaryEntity !== undefined
          ? { primaryEntity: subs.get(original.primaryEntity) ?? original.primaryEntity }
          : {}),
        traits: finalPageTraits,
      };
    });

    // Planning find (iii): after `omit`/`only` trims the kept set, a folded
    // knob whose only forwarder was dropped must not survive as a dead knob
    // on the materialized orbital (`ORB_O_CONFIG_DEAD_KNOB` on the consumer).
    // A knob counts as forwarded when SOME kept trait's OWN declared config
    // field default is the literal string `@config.<knob>` — read off
    // `keptTraits` (pre-forward-resolution; by the time `finalTraits` exists
    // the forward has already replaced that string with its resolved value).
    const forwardedKnobs = new Set<string>();
    for (const rt of keptTraits) {
      for (const field of Object.values(rt.trait.config ?? {})) {
        if (typeof field.default === "string" && field.default.startsWith("@config.")) {
          const knob = field.default.slice("@config.".length);
          if (knob.length > 0 && !knob.includes(".")) forwardedKnobs.add(knob);
        }
      }
    }
    const prunedConfig: DeclaredTraitConfig | undefined = foldedConfig
      ? Object.fromEntries(Object.entries(foldedConfig).filter(([key]) => forwardedKnobs.has(key)))
      : undefined;

    // (C) the LOCAL placeholder orbital is its own ledgered node — only its
    // CONTENTS are derived from upstream. Keep the local orbital's own id
    // when it has one; derive from upstream only when it doesn't (overwriting
    // it unconditionally orphans the id-ledger row the local declaration
    // already owns).
    const orbitalId = localId ?? (upstream.id ? asOrbitalId(deriveId(upstream.id, localName)) : undefined);

    refResolverLog.info("orbital-import:materialize", {
      local: localName,
      upstream: upstream.name,
      traits: finalTraits.length,
      pages: finalPages.length,
    });

    // `emits`/`listens`/`exposes` are the ORIGINAL upstream orbital's
    // computed-from-traits fields, naming upstream's pre-rename trait/event
    // vocabulary — carrying them through unrenamed would be wrong (this
    // resolver never computes them itself; nothing in this file reads an
    // `OrbitalDefinition`'s `emits`/`listens`/`exposes`, so dropping them is
    // strictly safer than shipping stale names).
    return {
      success: true,
      data: {
        ...upstream,
        name: localName,
        ...(orbitalId ? { id: orbitalId } : {}),
        entity: primaryEntity,
        ...(finalAuxEntities.length > 0 ? { auxiliaryEntities: finalAuxEntities } : {}),
        traits: finalTraits,
        pages: finalPages,
        emits: undefined,
        listens: undefined,
        exposes: undefined,
        ...(prunedConfig ? { config: prunedConfig } : { config: undefined }),
        uses: undefined,
        reference: undefined,
      },
      warnings: [],
    };
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
  const resolver = new ReferenceResolver({ ...options, schemaConfig: schema.config });
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedOrbital[] = [];

  // Flatten every `orbital X = Alias.orbitals.Y { … }` reference-form orbital
  // FIRST (W3-J), so every downstream `resolve()` call below sees an
  // ordinary, fully-inlined `OrbitalDefinition` — the interpreter-path twin
  // of "flatten upstream of both paths" (docs/Almadar_Orbital_Import.md §3).
  const flattenResult = await resolver.resolveOrbitalImports(schema);
  if (!flattenResult.success) {
    return { success: false, errors: flattenResult.errors };
  }
  const orbitals = flattenResult.data;

  // Collect all inline traits from all orbitals for local trait resolution
  for (const orbital of orbitals) {
    const inlineTraits = orbital.traits.filter(
      (t): t is Trait => typeof t !== "string" && "stateMachine" in t
    );
    resolver.addLocalTraits(inlineTraits);
  }

  // C1-J6: seed the schema-wide entity-id map with EVERY orbital's own
  // primary (+ declared aux) BEFORE any of them resolves — see
  // {@link ReferenceResolver.seedSchemaEntityIds}'s own doc for why an
  // EARLIER orbital needs to see a LATER orbital's primary too.
  resolver.seedSchemaEntityIds(orbitals);

  // Resolve each orbital, sequentially — each iteration widens
  // `resolver`'s schema-wide entity-id map (`noteResolvedEntityIds`) with
  // THIS orbital's final entity set BEFORE the next orbital resolves, so a
  // later orbital's `-> Entity` rebind can recover an id an earlier
  // orbital's no-rebind sibling pull already established for that name
  // (C1-J5, `std-api-gateway`'s `AuditEntry`; mirrors the compiled path's
  // per-orbital `consumer_entity_ids.extend`).
  for (const orbital of orbitals) {
    const result = await resolver.resolve(orbital);
    if (!result.success) {
      errors.push(`Orbital "${orbital.name}": ${result.errors.join(", ")}`);
    } else {
      resolved.push(result.data);
      resolver.noteResolvedEntityIds(result.data);
      warnings.push(...result.warnings.map((w) => `Orbital "${orbital.name}": ${w}`));
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // C1-J6: cross-orbital pulled-sibling naming, once every orbital's own
  // resolve is final — see {@link ReferenceResolver.
  // uniquifyCrossOrbitalPulledSiblings} for why this runs LAST, schema-wide,
  // matching Rust's post-per-orbital-loop `uniquify_cross_orbital_pulled_
  // siblings` call.
  resolver.uniquifyCrossOrbitalPulledSiblings(resolved);

  return { success: true, data: resolved, warnings };
}
