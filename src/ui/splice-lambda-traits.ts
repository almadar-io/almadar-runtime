/**
 * Lambda-scope splice for render-only trait references — JS-interpreter twin
 * of the compiled path's `orbital-compiler/src/phases/inline/splice.rs`.
 *
 * A `@trait.X` reference inside a `["fn"|"lambda", params, body]` render
 * subtree (a data-list `renderItem`, any function-typed render prop) cannot
 * survive as a reference: the referenced trait renders in its OWN binding
 * context, so its author expressions would resolve outside the lambda's
 * per-item scope. When the referenced trait is structurally render-only, this
 * pass splices its render template in place of the `@trait.X` string, with the
 * wrapper's own `config {}` defaults substituted first (`@config.content` →
 * `@party.title`), so the expressions end up physically inside the lambda and
 * resolve per item. The wrapper's `emits` are merged into the host trait and
 * the consumed wrapper is dropped from the orbital + its pages.
 *
 * PARITY NOTES vs splice.rs:
 * - The compiler runs AFTER `apply_overrides_to_trait`, so its stored template
 *   already has `@config.X` substituted. The runtime resolves `@config.X` at
 *   render time (keyed by trait NAME), so splicing away the wrapper name would
 *   strand its config. We therefore substitute the wrapper's declared config
 *   defaults into the template at splice time (mirror of the compiler's
 *   `rewrite_config_bindings`) — the one deliberate extra step on this path.
 * - `Transition.from` is a plain string here (not `StringOrArray`), so the
 *   self-loop test is a direct `from === to`.
 * - Outside lambda scope, references are left untouched (the normal embed /
 *   `<TraitFrame>` path owns them).
 *
 * @packageDocumentation
 */
import type {
  DeclaredTraitConfig,
  Page,
  PageTraitRef,
  SExpr,
  Trait,
  TraitEventContract,
  TraitId,
} from '@almadar/core';
import { collectDeclaredConfigDefaults } from '../config-defaults.js';
import { collectTraitRefsFromEffects, collectTraitRefsFromValue } from './embedded-traits.js';

const TRAIT_BINDING_PREFIX = '@trait.';
const CONFIG_BINDING_PREFIX = '@config.';

/** Minimal shapes the splice needs; the resolver's `ResolvedTrait` /
 *  `ResolvedPage` satisfy them structurally, so this module never imports
 *  resolver types (no ui → resolver cycle). */
export interface SpliceResolvedTrait {
  trait: Trait;
}
export interface SpliceResolvedPage {
  page: Page;
}

/** Hard errors, mirroring the compiler's `InlineError` variants
 *  `ORB_T_LAMBDA_STATEFUL_TRAIT` and `ORB_T_EMIT_MERGE_CONFLICT`. */
export class LambdaSpliceError extends Error {
  constructor(
    readonly code: 'LAMBDA_STATEFUL_TRAIT' | 'EMIT_MERGE_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'LambdaSpliceError';
  }
}

/** Render-only template (config-substituted) + the wrapper's emits, or a
 *  `null` template when the trait is present but NOT render-only (a stateful
 *  reference inside a lambda is a hard error). */
interface SpliceEntry {
  template: SExpr | null;
  emits: TraitEventContract[];
  /** The wrapper trait's current (post-rename) name — the identity by which
   *  consumed-wrapper removal tracks it (the embed token may hold a stale
   *  name when resolution went through the id side-map). */
  traitName: string;
  /** V4 leverage-ids — the wrapper trait's stable id (when stamped), so a
   *  host's `traitEmbedIds` side-map can resolve this template by id. */
  id?: TraitId;
  /** V4 leverage-ids — the wrapper's OWN `@trait.<Name>` embed side-map, used
   *  when recursing into this template's nested embed refs. */
  embedIds?: Record<string, TraitId>;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function isRenderUiEffect(effect: SExpr): boolean {
  return Array.isArray(effect) && effect.length >= 1 && effect[0] === 'render-ui';
}

/**
 * Structural render-only test (never name-based): at most one state, all
 * transitions guard-free self-loops whose effects are exclusively `render-ui`,
 * exactly one `render-ui` across the trait, no `listens`, no `ticks`. `emits`
 * do NOT disqualify. Returns the single render-ui pattern subtree, else `null`.
 */
function renderOnlyTemplate(trait: Trait): SExpr | null {
  if (trait.listens && trait.listens.length > 0) return null;
  if (trait.ticks && trait.ticks.length > 0) return null;
  const sm = trait.stateMachine;
  const states = sm?.states ?? [];
  if (states.length > 1) return null;
  let template: SExpr | null = null;
  for (const transition of sm?.transitions ?? []) {
    const selfLoop = transition.from === transition.to;
    const guarded = transition.guard !== undefined && transition.guard !== null;
    if (!selfLoop || guarded) return null;
    for (const effect of (transition.effects ?? []) as SExpr[]) {
      if (!isRenderUiEffect(effect) || !Array.isArray(effect)) return null;
      const pattern = effect[2];
      if (pattern === undefined) return null;
      // Two render-ui effects — no single canonical template exists.
      if (template !== null) return null;
      template = pattern as SExpr;
    }
  }
  return template;
}

// ---------------------------------------------------------------------------
// Config substitution — mirror of rewrite.rs `rewrite_config_bindings`
// ---------------------------------------------------------------------------

function resolveObjectPath(value: { [k: string]: unknown }, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as { [k: string]: unknown })[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Substitute `@config.<param>` bindings with the wrapper's declared config
 *  defaults. Pure — returns a new tree, leaving unmatched bindings intact so
 *  forwards to the host (`@config.foo` where `foo` is not the wrapper's own
 *  knob) survive to resolve against the host at render time. */
function substituteConfig(expr: SExpr, subs: Record<string, SExpr>): SExpr {
  if (typeof expr === 'string') {
    if (!expr.startsWith(CONFIG_BINDING_PREFIX)) return expr;
    const rest = expr.slice(CONFIG_BINDING_PREFIX.length);
    const dot = rest.indexOf('.');
    const param = dot === -1 ? rest : rest.slice(0, dot);
    const trailing = dot === -1 ? undefined : rest.slice(dot + 1);
    if (!(param in subs)) return expr;
    const value = subs[param];
    if (trailing === undefined) {
      // Self-reference guard (`x: @config.x`) — leave for the validator.
      if (typeof value === 'string' && value === expr) return expr;
      return substituteConfig(value, subs);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const leaf = resolveObjectPath(value as { [k: string]: unknown }, trailing);
      if (leaf !== undefined) return substituteConfig(leaf as SExpr, subs);
    }
    return expr;
  }
  if (Array.isArray(expr)) {
    return expr.map((item) => substituteConfig(item, subs));
  }
  if (expr !== null && typeof expr === 'object') {
    const out: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(expr)) {
      out[k] = substituteConfig(v as SExpr, subs);
    }
    return out as SExpr;
  }
  return expr;
}

function buildTemplate(trait: Trait): SpliceEntry {
  const raw = renderOnlyTemplate(trait);
  const emits = trait.emits ?? [];
  if (raw === null) return { template: null, emits, traitName: trait.name, id: trait.id, embedIds: trait.traitEmbedIds };
  const defaults = collectDeclaredConfigDefaults(trait as { config?: DeclaredTraitConfig });
  const template = defaults ? substituteConfig(raw, defaults as Record<string, SExpr>) : raw;
  return { template, emits, traitName: trait.name, id: trait.id, embedIds: trait.traitEmbedIds };
}

// ---------------------------------------------------------------------------
// Splice walker — mirror of splice.rs `splice_expr`
// ---------------------------------------------------------------------------

interface SpliceState {
  templates: Map<string, SpliceEntry>;
  /** V4 leverage-ids — id-keyed mirror of `templates`, populated wherever a
   *  wrapper trait carries an `id`. Consulted first when the current scope's
   *  `embedIds` side-map maps an embed token to a trait id. */
  templatesById: Map<string, SpliceEntry>;
  /** V4 leverage-ids — the `traitEmbedIds` side-map of the trait whose body is
   *  currently being walked (host at top level, the wrapper when recursing into
   *  a spliced template). Maps embed token NAME → embedded trait id. */
  embedIds?: Record<string, TraitId>;
  visiting: string[];
  merged: Array<[string, TraitEventContract]>;
  spliced: Set<string>;
  hostName: string;
  /** Set true the moment any `@trait.X` in a lambda is expanded, so a host
   *  with no lambda splice keeps its original trait object (test-4 regression). */
  changed: boolean;
}

function isLambdaForm(expr: readonly unknown[]): boolean {
  return expr.length === 3 && (expr[0] === 'fn' || expr[0] === 'lambda');
}

function spliceExpr(expr: SExpr, inLambda: boolean, st: SpliceState): SExpr {
  if (typeof expr === 'string') {
    if (!inLambda || !expr.startsWith(TRAIT_BINDING_PREFIX)) return expr;
    const name = expr.slice(TRAIT_BINDING_PREFIX.length);
    if (name.length === 0 || name.includes('.')) return expr;
    // Id-primary: prefer the current scope's `traitEmbedIds` side-map, resolving
    // the embedded trait's stable id against the id-keyed template map — so a
    // renamed wrapper still resolves via id. Else fall back to the name match.
    const embedId = st.embedIds?.[name];
    const entry = (embedId !== undefined ? st.templatesById.get(embedId) : undefined)
      ?? st.templates.get(name);
    // Unknown reference — the binding validator owns that error.
    if (entry === undefined) return expr;
    if (entry.template === null) {
      throw new LambdaSpliceError(
        'LAMBDA_STATEFUL_TRAIT',
        `Trait "${name}" keeps its own state machine and cannot be expanded ` +
          `per list item — use the list pattern's item events (referenced ` +
          `inside a lambda in trait "${st.hostName}")`,
      );
    }
    // Reference cycle — leave the string for the validator rather than looping.
    if (st.visiting.includes(name)) return expr;
    st.visiting.push(name);
    // The wrapper's template may itself hold nested inline refs (JSX
    // children); they are now inside the lambda too, so splice recursively.
    // Nested embeds resolve against the WRAPPER's own side-map, so swap the
    // active `embedIds` for the recursion and restore it after.
    const prevEmbedIds = st.embedIds;
    st.embedIds = entry.embedIds;
    const expanded = spliceExpr(entry.template, true, st);
    st.embedIds = prevEmbedIds;
    st.visiting.pop();
    for (const emit of entry.emits) st.merged.push([entry.traitName, emit]);
    // Track the wrapper by its resolved (current) name, not the embed token —
    // the two differ when resolution went through the id side-map.
    st.spliced.add(entry.traitName);
    st.changed = true;
    return expanded;
  }
  if (Array.isArray(expr)) {
    if (isLambdaForm(expr)) {
      return [expr[0], expr[1], spliceExpr(expr[2] as SExpr, true, st)];
    }
    return expr.map((item) => spliceExpr(item, inLambda, st));
  }
  if (expr !== null && typeof expr === 'object') {
    const out: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(expr)) {
      out[k] = spliceExpr(v as SExpr, inLambda, st);
    }
    return out as SExpr;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Emit merge — mirror of splice.rs `merge_wrapper_emits`
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: { [k: string]: unknown } = {};
    for (const key of Object.keys(value as { [k: string]: unknown }).sort()) {
      out[key] = canonical((value as { [k: string]: unknown })[key]);
    }
    return out;
  }
  return value;
}

function mergeWrapperEmits(
  host: Trait,
  incoming: Array<[string, TraitEventContract]>,
): TraitEventContract[] {
  const emits: TraitEventContract[] = [...(host.emits ?? [])];
  for (const [wrapper, emit] of incoming) {
    const existing = emits.find((e) => e.event === emit.event);
    if (existing) {
      const same = JSON.stringify(canonical(existing)) === JSON.stringify(canonical(emit));
      if (!same) {
        throw new LambdaSpliceError(
          'EMIT_MERGE_CONFLICT',
          `Emit "${emit.event}" merged from spliced wrapper "${wrapper}" ` +
            `conflicts with an existing "${emit.event}" on host "${host.name}" ` +
            `(different payload shape)`,
        );
      }
    } else {
      emits.push(emit);
    }
  }
  return emits;
}

// ---------------------------------------------------------------------------
// Consumed-wrapper removal — mirror of splice.rs `remove_consumed_wrappers`
// ---------------------------------------------------------------------------

function removeConsumedWrappers(
  traits: SpliceResolvedTrait[],
  pages: SpliceResolvedPage[],
  spliced: Set<string>,
): void {
  // Id side-map support: a surviving `@trait.X` reference may hold a stale
  // token name that resolves (via the referring trait's `traitEmbedIds`) to a
  // wrapper whose current name differs. Removal tracks wrappers by current
  // name, so resolve each collected token to the wrapper's current name via
  // this id→name map before testing "still referenced". Absent side-maps, the
  // token IS the current name and this is a no-op.
  const idToName = new Map<string, string>();
  for (const { trait } of traits) {
    if (trait.id) idToName.set(trait.id, trait.name);
  }

  // Fixpoint: removing an outer wrapper can strand the reference that kept an
  // inner wrapper alive (nested JSX children), so re-scan survivors until
  // nothing more drops.
  for (;;) {
    const stillReferenced = new Set<string>();
    for (const { trait } of traits) {
      // Collect this trait's raw embed tokens, then resolve each to the
      // wrapper's current name through the trait's own `traitEmbedIds`.
      const rawTokens = new Set<string>();
      for (const t of trait.stateMachine?.transitions ?? []) {
        if (t.guard !== undefined && t.guard !== null) {
          collectTraitRefsFromValue(t.guard as SExpr, rawTokens);
        }
        collectTraitRefsFromEffects(t.effects as SExpr[] | undefined, rawTokens);
      }
      for (const tick of trait.ticks ?? []) {
        if (tick.guard !== undefined && tick.guard !== null) {
          collectTraitRefsFromValue(tick.guard as SExpr, rawTokens);
        }
        collectTraitRefsFromEffects(tick.effects as SExpr[] | undefined, rawTokens);
      }
      if (trait.config) {
        for (const field of Object.values(trait.config)) {
          if (field && typeof field === 'object' && 'default' in field && field.default !== undefined) {
            collectTraitRefsFromValue(field.default as SExpr, rawTokens);
          }
        }
      }
      for (const token of rawTokens) {
        const embedId = trait.traitEmbedIds?.[token];
        const resolvedName = (embedId !== undefined ? idToName.get(embedId) : undefined) ?? token;
        stillReferenced.add(resolvedName);
      }
    }

    const removable = new Set<string>();
    for (const { trait } of traits) {
      if (spliced.has(trait.name) && !stillReferenced.has(trait.name)) {
        removable.add(trait.name);
      }
    }
    if (removable.size === 0) return;

    // Never empty a page: if removal would leave a page with zero traits, the
    // traits it lists survive.
    for (const { page } of pages) {
      const pageTraits = page.traits;
      if (!pageTraits) continue;
      const survivors = pageTraits.filter((pt: PageTraitRef) => !removable.has(pt.ref)).length;
      if (survivors === 0) {
        for (const pt of pageTraits) removable.delete(pt.ref);
      }
    }
    if (removable.size === 0) return;

    for (const resolvedPage of pages) {
      const pageTraits = resolvedPage.page.traits;
      if (pageTraits) {
        resolvedPage.page.traits = pageTraits.filter((pt: PageTraitRef) => !removable.has(pt.ref));
      }
    }
    const survivors = traits.filter(({ trait }) => !removable.has(trait.name));
    traits.length = 0;
    traits.push(...survivors);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — mirror of splice.rs `splice_lambda_trait_refs`
// ---------------------------------------------------------------------------

/**
 * Splice lambda-scoped `@trait.X` references throughout the resolved traits,
 * merge consumed wrappers' emits into their hosts, and drop the wrappers from
 * the trait list + pages. Mutates `traits` / `pages` in place. Throws
 * {@link LambdaSpliceError} on a stateful-in-lambda reference or an emit-merge
 * conflict.
 */
export function spliceLambdaTraitRefs(
  traits: SpliceResolvedTrait[],
  pages: SpliceResolvedPage[],
): void {
  if (traits.length === 0) return;
  const templates = new Map<string, SpliceEntry>();
  const templatesById = new Map<string, SpliceEntry>();
  for (const { trait } of traits) {
    const entry = buildTemplate(trait);
    templates.set(trait.name, entry);
    if (trait.id) templatesById.set(trait.id, entry);
  }

  const spliced = new Set<string>();
  for (const resolved of traits) {
    const host = resolved.trait;
    const st: SpliceState = {
      templates,
      templatesById,
      embedIds: host.traitEmbedIds,
      // Seed with the host itself so a self-reference never self-splices.
      visiting: [host.name],
      merged: [],
      spliced,
      hostName: host.name,
      changed: false,
    };

    const sm = host.stateMachine;
    const nextTransitions = sm?.transitions
      ? sm.transitions.map((t) => ({
          ...t,
          effects: t.effects
            ? ((t.effects as SExpr[]).map((e) => spliceExpr(e, false, st)) as typeof t.effects)
            : t.effects,
        }))
      : sm?.transitions;
    const nextTicks = host.ticks
      ? host.ticks.map((tick) => ({
          ...tick,
          effects: (tick.effects as SExpr[]).map((e) => spliceExpr(e, false, st)) as typeof tick.effects,
        }))
      : host.ticks;

    if (!st.changed) {
      // No lambda splice touched this host — leave its trait object untouched.
      continue;
    }

    const nextEmits = st.merged.length > 0 ? mergeWrapperEmits(host, st.merged) : host.emits;
    resolved.trait = {
      ...host,
      ...(sm ? { stateMachine: { ...sm, transitions: nextTransitions ?? [] } } : {}),
      ...(nextTicks !== undefined ? { ticks: nextTicks } : {}),
      ...(nextEmits !== undefined ? { emits: nextEmits } : {}),
    };
  }

  if (spliced.size > 0) {
    removeConsumedWrappers(traits, pages, spliced);
  }
}
