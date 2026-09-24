/**
 * OrbitalServerRuntime - Dynamic Server-Side Orbital Execution
 *
 * This runtime takes an OrbitalSchema and dynamically:
 * 1. Registers all orbitals and their traits
 * 2. Creates Express routes for trait communication
 * 3. Executes state machines server-side
 * 4. Handles cross-orbital event propagation
 *
 * This is the "interpreted" mode - no compilation needed.
 * The compiler generates equivalent static code for production.
 *
 * @example
 * ```typescript
 * import { OrbitalServerRuntime } from '@kflow-builder/shared/runtime';
 * import express from 'express';
 *
 * const app = express();
 * const runtime = new OrbitalServerRuntime();
 *
 * // Register schema (can be loaded from file, API, etc.)
 * runtime.register(orbitalSchema);
 *
 * // Mount orbital routes
 * app.use('/api/orbitals', runtime.router());
 *
 * // Client can now:
 * // POST /api/orbitals/:orbital/events  - Send event to orbital
 * // GET  /api/orbitals/:orbital/state   - Get current state
 * // GET  /api/orbitals                  - List registered orbitals
 * ```
 *
 * @packageDocumentation
 */

// `express` is Node-only (HTTP router, no browser equivalent). Importing
// the named `Router` at top-level baked the module into the dist bundle,
// where Vite/rollup's stricter named-import resolution choked because
// `__vite-browser-external` doesn't expose `Router`. Solution: type-only
// import here, load the runtime value inside `router()` via the
// eval-require helper below — invisible to bundler static analysis.
import type {
  Router as ExpressRouter,
  Request,
  Response,  NextFunction,
} from "express";
// Type-only: the VALUE is loaded lazily inside `withRegistrationMutation`
// via dynamic import — same keep-it-out-of-the-browser-bundle idiom as
// `createOsHandlers`/`@almadar/server` below.
import type { AsyncLocalStorage as BracketAsyncLocalStorage } from "node:async_hooks";
import { EventBus } from "../events/EventBus.js";
import type { EffectDispatch } from "../evaluation/dispatch-memory.js";
import { eventRouteKey } from "../events/identity/routing.js";
import {
  evaluateOrbitalEvent,
  collectListenerTargets,
  deliveryOf,
  freshDeliveryGuardBindings,
  type EvaluateEffectRunner,
  type EvaluateOrbitalEventDeps,
  type WorklistItem,
} from "../evaluation/evaluateOrbitalEvent.js";
import { MountLifecycle } from "../evaluation/mount-lifecycle.js";
import { buildTraitIndexForOrbital, type TraitIndex } from "../traits/trait-index.js";
import { createTickScheduler, type TickHandle, type TickScheduler } from "../time/TickScheduler.js";
import { isValidCronExpression } from "../time/cron.js";
import { parseDurationString } from "../time/duration.js";
import {
  StateMachineManager,
  LIFECYCLE_EVENTS,
  UNMOUNT_EVENT,
  findInitialState,
} from "../traits/StateMachineCore.js";
import { EffectExecutor } from "../effects/EffectExecutor.js";
import { parseOrbitalTraits } from "../traits/OrbitalTraitParsing.js";
import type { ServerEffectResult } from "../effects/ServerEffectHandlers.js";
import { createLogger } from '@almadar/logger';
// Same treatment for `createOsHandlers` (uses `fs`, `net`, `child_process`).
// The runtime auto-wires it in the constructor's Node-only branch — guarded
// by `isNodeEnv()` — and the eval-require keeps the import out of the
// browser bundle entirely.
import type {
  createOsHandlers as CreateOsHandlersFn,
  OsHandlerResult,
} from "../effects/createOsHandlers.js";
import type {
  createAgentSubstrateHandlers as CreateAgentSubstrateHandlersFn,
  AgentSubstrateHandlerResult,
  SubstrateServices,
} from "../effects/createAgentSubstrateHandlers.js";

/**
 * Synchronous Node-only require, hidden from bundler static analysis.
 *
 * Bundlers (tsup, Vite/rollup, webpack) walk imports statically. The two
 * indirections below — `(0, eval)('require')` and the namespace import of
 * `'module'` resolved by property access — keep the dist bundle free of
 * any reference to `fs`, `net`, `child_process`, or `express`, so any
 * browser bundler can consume `OrbitalServerRuntime.js` without a
 * polyfill / stub / fallback chain.
 *
 * Why both paths:
 * - `eval('require')` works in CommonJS Node (returns the runtime require).
 * - In ESM Node, `require` isn't a global, so the eval returns undefined.
 *   We fall back to `createRequire(import.meta.url)` from the `'module'`
 *   built-in, which IS the canonical ESM-Node way to synchronously load
 *   a Node module.
 *
 * Every call site is guarded by `isNodeEnv()` upstream so the browser
 * never reaches this. In browsers the namespace import of `'module'`
 * resolves to an empty stub via the package.json `browser` field; the
 * function is never invoked, so the empty-stub never matters.
 */
import * as nodeModule from 'module';
let _resolvedNodeRequire: NodeRequire | null = null;
function nodeRequire<T>(modulePath: string): T {
  if (!_resolvedNodeRequire) {
    const evalRequire = (0, eval)('typeof require !== "undefined" ? require : null') as NodeRequire | null;
    if (evalRequire) {
      _resolvedNodeRequire = evalRequire;
    } else {
      const createReq = (nodeModule as { createRequire?: (url: string | URL) => NodeRequire }).createRequire;
      if (typeof createReq !== 'function') {
        throw new Error(
          '[OrbitalServerRuntime] No synchronous require available. This branch is Node-only — invoking it from a browser indicates an isNodeEnv() guard regression upstream.',
        );
      }
      _resolvedNodeRequire = createReq(import.meta.url);
    }
  }
  return _resolvedNodeRequire(modulePath) as T;
}

const effectLog = createLogger("almadar:runtime:effects");
const busLog = createLogger("almadar:runtime:bus");
// Render-ui-side observability for the runtime path. Lit up via
// `ALMADAR_DEBUG=almadar:runtime:render-ui` (or `localStorage.ALMADAR_DEBUG`
// in the browser). Tracks every render-ui clientEffect push so we can tell
// when the runtime re-fires `render-ui` for the modal slot during a typing
// session — the suspected reason form fields snap back to pre-fill on the
// runtime path while the compiled path holds them stable.
const renderLog = createLogger("almadar:runtime:render-ui");
// Gap #11 (Almadar_Std_Verification.md): cross-orbital cascade tracing.
// Logs per processOrbitalEvent entry and per emit so the runtime-verify
// console capture shows which orbital's traits actually fired during a
// dispatch. Pairs with the UI-side `almadar:runtime:cross-orbital` channel
// in OrbPreview / ServerBridge / SlotsContext.
const xOrbitalLog = createLogger("almadar:runtime:cross-orbital");
const persistLog = createLogger("almadar:runtime:persist");
const registerLog = createLogger("almadar:runtime:register");

/**
 * Relay hop cap — a circuit breaker for pathological cross-orbital listen
 * cycles (orbital A emits → orbital B relays → A re-emits …). The visited
 * set already bounds work to distinct
 * (orbital, trait, triggers, from-state) keys; this caps worst-case
 * latency, the same rationale as the composition's cascade cap
 * (G-RUNTIME-027).
 */
const CROSS_ORBITAL_RELAY_CAP = 500;
import type { SSEEvent } from '@almadar/server';
import {
  interpolateProps,
  createContextFromBindings,
} from "../evaluation/BindingResolver.js";
import { evaluateGuard } from "@almadar/evaluator";
import type {
  TraitDefinition,
  TraitState,
  EffectHandlers,
  EntityRow,
  EventPayload,
  EvaluationContextExtensions,
} from "../types.js";
import { collectDeclaredConfigDefaults } from "../traits/config-defaults.js";
// Backward-compat: `collectDeclaredConfigDefaults` used to live here. The package
// index now re-exports it from the browser-safe `../traits/config-defaults.js` (so it
// doesn't drag this node-only module into a browser bundle), but keep the
// original export site for existing importers (tests, server consumers).
export { collectDeclaredConfigDefaults };
import type {
  OrbitalSchema,
  OrbitalDefinition,
  Entity,
  EntityField,
  EntityId,
  Trait,
  TraitTick,
  TraitConfig,
  BusEventSource,
  SExpr,
  RuntimeValue,
  UserContext,
  RawUserClaims,
} from "@almadar/core";

// Single upstream owner (`@almadar/core`'s `types/bus.ts`) — both execution
// paths (this runtime and orbital-shell-typescript's generated handlers,
// mirrored 1:1 in orbital-core) carry the same wire shapes, so they cannot
// drift. Re-exported here so every existing importer of these names from
// `@almadar/runtime` keeps working unchanged.
export type {
  OrbitalEventRequest,
  OrbitalEventResponse,
  ClientEffectTuple,
  ClientRenderUITuple,
  ClientNavigateTuple,
  ClientNavigateBackTuple,
  TransitionRejection,
} from "@almadar/core";
import { themeDataKey } from "@almadar/core";
import type {
  OrbitalEventRequest,
  OrbitalEventResponse,
  ClientEffectByTrait,
  ClientEffectTuple,
} from "@almadar/core";
import { dispatchVisitKey, isEntityCall, buildResolvedTraitConfigs, collectCallsiteCaptureChildren, normalizeUserContext, personaFromIdentityRow, DEFAULT_VIEWER, isPageReference, type NavItem, type Page, type PageRef,
} from "@almadar/core";
import { ownerFieldsFromSchema, identityEntityName, entityAccessPoliciesByStoreKey } from "@almadar/core/mock";
import { checkMutationAccess } from "../entities/entityAccess.js";
import { runServerEffectStage } from "../effects/effect-stage.js";
import { MockPersistenceAdapter } from "../entities/MockPersistenceAdapter.js";
import {
  preprocessSchema,
  type PreprocessedSchema,
  type EntitySharingMap,
  type EventNamespaceMap,
} from "../traits/UsesIntegration.js";
import {
  type SchemaLoader,
  createUnifiedLoader,
} from "../entities/loader/index.js";
// `createOsHandlers` is type-imported at the top of this file and value-
// loaded via `nodeRequire` inside the constructor's Node-only branch.
// Removed the value-import here so the dist bundle has no static
// reference to `../effects/createOsHandlers.js` and its fs/net/child_process
// imports vanish from the browser-side dependency graph.

// Node-detection helper. Used to guard call sites of express, fs/path/net,
// and child_process — those modules are stubbed by the package.json `browser`
// field in browser bundles, so calling them would crash. Browser consumers
// (e.g. `<BrowserPlayground>` from @almadar/ui in mock mode) skip these
// paths entirely.
function isNodeEnv(): boolean {
  return typeof process !== "undefined" && Boolean(process.versions?.node);
}

// ============================================================================
// Types
// ============================================================================

// Uses OrbitalSchema, OrbitalDefinition, Trait, TraitTick from @almadar/core directly.
// No redundant runtime-specific types.

/** @deprecated Use OrbitalSchema from @almadar/core */
export type RuntimeOrbitalSchema = OrbitalSchema;
/** @deprecated Use OrbitalDefinition from @almadar/core */
export type RuntimeOrbital = OrbitalDefinition;
/** @deprecated Use Trait from @almadar/core */
export type RuntimeTrait = Trait;
/** @deprecated Use TraitTick from @almadar/core */
export type RuntimeTraitTick = TraitTick;

const ANONYMOUS_CLIENT = '\u0000anonymous';

/**
 * Incremental-push item streamed to an SSE client mid-dispatch (an emitted
 * event or a client effect), before the response resolves.
 */
export type PushItem =
  | { type: 'event'; data: { event: string; payload?: EventPayload; source?: BusEventSource } }
  | { type: 'effect'; data: ClientEffectTuple };

/**
 * Registered orbital with runtime state
 */
export interface RegisteredOrbital {
  schema: OrbitalDefinition;
  /** Resolved entity (never a string ref at runtime) */
  entity: Entity;
  /** Resolved inline traits (string refs filtered out) */
  traits: Trait[];
  /**
   * Call-site `config: { ... }` attached to each trait ref, keyed by trait
   * name. Used to populate the `@config.X` binding when running that trait's
   * effects. Preserved from the preprocessed schema's trait-ref wrapper
   * (`{ ref, config, linkedEntity, _resolved }`) before the wrapper is
   * unwrapped to its inline form.
   */
  configByTrait: Map<string, TraitConfig>;
  manager: StateMachineManager;
  /** The client's mount, followed from each leg's `_awaitingInit` (see `mount-lifecycle.ts`). */
  mount: MountLifecycle<WorklistItem>;
  entityData: Map<string, EntityRow>; // entityId -> data
  /**
   * Per-trait scalar state set by `(set @entity.X Y)`. Mirrors compiled's
   * `state.fields`. The trait's `@entity` binding is a three-layer merge:
   * declared entity field defaults < persistence entityData < this map.
   * Mutated only by the `set` effect handler.
   *
   * For a `[shared]` linked entity the map is keyed `$shared::<entityName>`
   * instead of the trait name — ONE frame across every bound trait, the
   * server half of the client hook's `sharedKeyByTraitName` groups. Without
   * it a writer trait's `(set @entity.X …)` was invisible to a sibling's
   * effect interpolation (the chat thread's refetch filter read "" while the
   * composer held the open channel).
   */
  traitFieldStates: Map<string, EntityRow>;
  /**
   * Lazily built evaluation index (`traitIndexFor`), cached on the
   * registration. Invalidated whenever another orbital registers — a late
   * registrant's entities must appear in already-built indexes'
   * cross-orbital `linkedEntity` resolution.
   */
  traitIndex?: TraitIndex;
}

// `OrbitalEventRequest` — event sent from client to server — is owned by
// `@almadar/core` (re-exported above).

/**
 * One persist-envelope success emit, handed to the live-broadcast sink
 * (`setLiveBroadcastSink`). Fired only from the `persist` effect's
 * `emit:{success}` envelope (batch and single-op) — never from the generic
 * emit funnel — so transport layers can fan it out to every OTHER
 * connected client without matching on event names.
 */
export interface LiveBroadcastItem {
  event: string;
  payload?: EventPayload;
  source: BusEventSource;
  /** `clientId` of the request that produced this emit; excluded from delivery by the transport. */
  originClientId?: string;
}

// `OrbitalEventResponse` — response from event processing — is owned by
// `@almadar/core` (re-exported above).

/**
 * Loader configuration for resolving `uses` imports
 */
export interface LoaderConfig {
  /** Base path for schema files */
  basePath: string;
  /** Standard library path (filesystem or URL) */
  stdLibPath?: string;
  /** Scoped package paths */
  scopedPaths?: Record<string, string>;
  /** Custom loader instance (overrides basePath/stdLibPath) */
  loader?: SchemaLoader;
}

/**
 * Runtime configuration
 */
export interface OrbitalServerRuntimeConfig {
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Snapshot cadence (ms) for relaying tick-stamped broadcasts to other
   * clients — newest-per-(client, orbital, event) wins between flushes
   * (T6, docs/Almadar_Tick_Loop.md §3a). Default 50 (≈20Hz).
   */
  tickRelayIntervalMs?: number;
  /** Custom effect handlers (for integrating with your data layer) */
  effectHandlers?: Partial<EffectHandlers>;
  /** Persistence adapter for entity data */
  persistence?: PersistenceAdapter;
  /**
   * Data mode:
   * - 'mock': Use faker-generated mock data (default for preview)
   * - 'real': Use actual persistence layer
   */
  mode?: 'mock' | 'real';
  /** Seed for deterministic mock data generation */
  mockSeed?: number;
  /** Number of mock records to generate per entity */
  mockSeedCount?: number;
  /**
   * Loader configuration for resolving `uses` imports.
   * Required when using `registerWithPreprocess` or `autoPreprocess`.
   */
  loaderConfig?: LoaderConfig;
  /**
   * Automatically preprocess schemas on register() to resolve `uses` imports.
   * Requires `loaderConfig` to be set.
   * Default: false
   */
  autoPreprocess?: boolean;
  /**
   * Apply event namespacing to imported traits.
   * Default: true
   */
  namespaceEvents?: boolean;
  /**
   * Additional fields to spread onto every EvaluationContext.
   * Use this to inject module contexts (e.g., { agent: AgentContext }).
   * The evaluator dispatches agent/* operators to ctx.agent.
   */
  contextExtensions?: EvaluationContextExtensions;
  /**
   * Substrate service implementations for effect-position operators
   * (compose/compose-all, behavior/instantiate, validate/validate, etc.).
   * @almadar-io/rabit injects these at runtime; tests can inject mocks.
   */
  substrateServices?: SubstrateServices;
  /**
   * Viewer identity used when a request carries no authenticated user — the
   * persona a preview or verification run is looking at the app AS.
   *
   * `@user.id` / `@user.role` are what an app's ownership scoping and role
   * gates resolve against, so with no user every predicate takes its negative
   * branch and every owner filter matches nothing. A host that has real auth
   * leaves this unset and the request's own user always wins; a dev host
   * (playground, runtime-verify) sets it to make both branches reachable.
   *
   * Never a fallback for production auth: an authenticated request is not
   * overridden, and a host that sets this is declaring itself a dev host.
   */
  defaultUser?: UserContext;
  /**
   * Seeded columns that hold a user id, as `Entity.field` pairs (e.g.
   * `RosterEntry.memberId`). In mock mode the `defaultUser` is assigned to
   * every other seeded row of each named column, so a scoped view has real
   * rows and a second persona sees the complement. Explicit by design — the
   * seeder never guesses an owner column from its name.
   */
  mockOwnerFields?: string[];
}

/**
 * Adapter for persisting entity data
 */
// `PersistenceAdapter` + `InMemoryPersistence` live in their own browser-safe
// module so the in-browser mock runtime can reuse the same storage contract
// without pulling in this server-only module's express dependency. Re-exported
// here so existing `import { PersistenceAdapter } from './OrbitalServerRuntime'`
// call sites keep working.
export type { PersistenceAdapter } from "../entities/PersistenceAdapter.js";
export { InMemoryPersistence } from "../entities/PersistenceAdapter.js";
import type { PersistenceAdapter } from "../entities/PersistenceAdapter.js";
import { InMemoryPersistence } from "../entities/PersistenceAdapter.js";

// ============================================================================
// OrbitalServerRuntime
// ============================================================================

/**
 * Check whether a schema needs preprocessing (has `uses` declarations or
 * un-inlined cross-orbital trait references).
 *
 * Cross-orbital refs are trait entries like
 * `{ ref: "Modal.traits.ModalRecordModal", ... }` with no inline
 * `stateMachine`. If these aren't resolved before `register()` runs, the
 * trait binder produces an empty state machine and all interactions
 * targeting the trait are silently dropped.
 */
/**
 * Walk a trait's DECLARED config schema (`{ icon: { type, default }, ... }`)
 * and collect a flat `{ icon: <default>, ... }` map of just the default
 * values. Used to seed the `@config.X` binding context with the atom's
 * own declared defaults before any call-site override is applied. Mirrors
 * the compiled path's `DEFAULT_<TRAIT>_CONFIG` constant emitted by
 * backend.rs's Solution-1 plumbing.
 *
 * Returns `undefined` when the trait has no config schema or none of its
 * fields declare a default — keeps the caller's existing fast-path.
 */
/**
 * Structural shape that both `@almadar/core`'s `Trait` and
 * `ResolvedTrait` satisfy: a `config?` map keyed by field name whose
 * values either carry a `default` (the declared-schema form loaded
 * from `.orb`) or are bare values (the runtime-resolved form).
 *
 * Widening to a structural parameter lets callers from the resolved
 * side (e.g., `@almadar/ui`'s `useTraitStateMachine`) pass their own
 * `ResolvedTrait` without an `as unknown as` cast.
 */
/**
 * Read the `default` from each field of a trait's declared
 * `config { }` schema and return the flat `{ key: default, ... }`
 * map. Used to seed `@config.X` binding context with the atom's
 * own declared defaults before any call-site override is applied.
 *
 * Mirrors the compiled path's `DEFAULT_<TRAIT>_CONFIG` constant
 * emitted by `backend.rs` Solution-1.
 */
function needsPreprocessing(schema: OrbitalSchema): boolean {
  for (const orbital of schema.orbitals) {
    if (orbital.uses && orbital.uses.length > 0) {
      return true;
    }
    for (const t of orbital.traits ?? []) {
      if (typeof t === 'object' && 'ref' in t && t.ref.includes('.')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Map the host orbital's inline pages to the `NavItem[]` the `@pages` render
 * sigil yields (`href = page.path`, `label = page.name`). Mirrors the Rust
 * resolver's `get_page_from_ref` filter — only inline `Page` definitions
 * contribute; string and `{ ref }` page references are skipped (they have no
 * resolvable path/name at this layer).
 */
function inlineNavItems(pages: readonly PageRef[]): NavItem[] {
  const items: NavItem[] = [];
  for (const page of pages) {
    if (isPageReference(page)) continue;
    const p = page as Page;
    if (typeof p.path !== 'string' || typeof p.name !== 'string') continue;
    // Root pages only: detail/param pages (paths with a `:` segment) are not
    // nav entries. Mirrors the compiler's `p.path.contains(':')` filter.
    if (p.path.includes(':')) continue;
    const item: NavItem = {
      href: p.path,
      // `@label` annotation wins; else derive by stripping a trailing
      // `Page` suffix from `name` (`ContactsPage` → `Contacts`).
      label: p.label ?? deriveNavLabel(p.name),
    };
    if (typeof p.icon === 'string') item.icon = p.icon;
    items.push(item);
  }
  return items;
}

/** Derive a human nav label from a page `name`: strip a trailing `Page`
 * suffix. Mirrors the compiler's `derive_nav_label`. */
function deriveNavLabel(name: string): string {
  if (name.endsWith('Page') && name.length > 'Page'.length) {
    return name.slice(0, -'Page'.length);
  }
  return name;
}

/** The baseline theme `@currentTheme` falls back to when an orbital declares
 * no `theme`. Keeps standalone renders (no rabit) styled; rabit overrides
 * globally via `Orbital.theme`. Mirrors the compiler's `DEFAULT_THEME_KEY`. */
const DEFAULT_THEME_KEY = 'minimalist-light';

/**
 * Internal tick binding for tracking active ticks
 */
interface TickBinding {
  orbitalName: string;
  traitName: string;
  tick: RuntimeTraitTick;
  handle: TickHandle;
}

export class OrbitalServerRuntime {
  protected orbitals = new Map<string, RegisteredOrbital>();
  private eventBus: EventBus;
  private config: OrbitalServerRuntimeConfig;
  /** The bound persistence adapter (mock/in-memory/consumer-supplied). Public
   *  so a test can inspect committed rows honestly — `(runtime as any)
   *  .persistence` was the alternative, and that cast is what this field
   *  visibility replaces. */
  public readonly persistence: PersistenceAdapter;
  private tickBindings: TickBinding[] = [];
  /** `orbital::trait` → the clients that have it mounted (Runtime Spec Clause 8.3). */
  private readonly mountedBy = new Map<string, Set<string>>();
  // One coalesced clock for every tick this runtime registers — replaces
  // "one setInterval per tick" with a single accumulator loop so ticks due
  // in the same pass fire together instead of on independent timers.
  private readonly tickScheduler: TickScheduler = createTickScheduler();
  private loader: SchemaLoader | null = null;
  private preprocessedCache = new Map<string, PreprocessedSchema>();
  private entitySharingMap: EntitySharingMap = {};
  private eventNamespaceMap: EventNamespaceMap = {};
  private osHandlers: OsHandlerResult | null = null;
  private osHandlersPromise: Promise<void> | null = null;
  private substrateHandlers: AgentSubstrateHandlerResult | null = null;
  private substrateHandlersPromise: Promise<void> | null = null;
  private resolvedSchema: OrbitalSchema | null = null;

  /** App-level theme key from the schema's `theme "<key>"` header — the
   *  `@currentTheme` fallback between an orbital's own `theme` and
   *  `DEFAULT_THEME_KEY`. Set at registration, before the orbital loops
   *  (`resolvedSchema` is assigned only after them). */
  private appThemeKey: string | undefined;
  /** Wired by the hosting server (e.g. the playground SSE endpoint) via `setLiveBroadcastSink`. */
  private liveBroadcastSink: ((item: LiveBroadcastItem) => void) | null = null;
  /**
   * Tick-broadcast relay (T6): newest pending item per
   * (originClientId, orbital, event), flushed to the live-broadcast sink on
   * the `tickRelayIntervalMs` cadence — other tabs get the latest position
   * at snapshot rate, never 1:1 with emissions.
   */
  private readonly tickRelayPending = new Map<string, LiveBroadcastItem>();
  private tickRelayTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Trait name -> resolved `TraitConfig`, computed once per `register()` via
   * `buildResolvedTraitConfigs` (`@almadar/core`). An embedded sub-trait's
   * OWN declared config schema (`registered.traits` / `collectDeclaredConfigDefaults`)
   * carries `@config.X` forwards verbatim — this map chains those through to
   * the trait that actually embeds it (see `embedded-trait-config.ts` for the
   * full rationale). Used as a fallback layer in `buildBindingContext` behind
   * `declaredDefaults` and ahead of `callSiteOverride`.
   */
  private resolvedTraitConfigs: Record<string, TraitConfig> = {};
  /**
   * Referrer trait name → the DIRECT children (via `@trait.X`) that need
   * their lifecycle transition re-run under the referrer's `callsitePayload`
   * whenever the referrer's own transition fires — computed once per
   * `register()` via `@almadar/core`'s `collectCallsiteCaptureChildren`
   * (merged across every orbital in the schema, same flattening
   * `resolvedTraitConfigs` uses). See `rerenderCallsiteCaptureChildren`.
   */
  private callsiteCaptureChildrenByTrait: ReadonlyMap<string, ReadonlySet<string>> = new Map();

  constructor(config: OrbitalServerRuntimeConfig = {}) {
    this.config = {
      mode: 'mock', // Default to mock mode for preview
      autoPreprocess: false,
      namespaceEvents: true,
      ...config,
      // `@user` is never Null. A host that named no viewer (no ALMADAR_PERSONA,
      // no auth yet) otherwise renders every `viewerName: @user.name` blank, so
      // the app cannot say who you are. DEFAULT_VIEWER carries an empty `role`,
      // so no `@user.role` guard changes outcome — see its doc in @almadar/core.
      defaultUser: config.defaultUser ?? DEFAULT_VIEWER,
    };
    this.eventBus = new EventBus();

    // Initialize loader only if a fully-configured one was handed in, or if
    // stdLibPath is explicitly set. Otherwise leave null so ensureLoader()
    // can lazily construct one with the auto-detected @almadar/std path —
    // passing only basePath here would build a loader without stdLibPath
    // and then short-circuit ensureLoader's proper lookup.
    if (config.loaderConfig?.loader) {
      this.loader = config.loaderConfig.loader;
    } else if (config.loaderConfig?.stdLibPath) {
      this.loader = createUnifiedLoader({
        basePath: config.loaderConfig.basePath,
        stdLibPath: config.loaderConfig.stdLibPath,
        scopedPaths: config.loaderConfig.scopedPaths,
      });
    }

    // Use MockPersistenceAdapter for mock mode, otherwise use provided or InMemoryPersistence
    if (this.config.mode === 'mock' && !config.persistence) {
      this.persistence = new MockPersistenceAdapter({
        seed: config.mockSeed,
        defaultSeedCount: config.mockSeedCount ?? 6,
        debug: config.debug,
        // Let the dev viewer own some seeded rows, so ownership-scoped views
        // ("only mine") have data instead of being indistinguishable from a
        // broken filter. Columns are declared, never inferred by name.
        // `this.config`, not `config` — the DEFAULT_VIEWER fallback is applied
        // there, and reading the raw param leaves every seeded row unowned.
        ownerId: this.config.defaultUser?.id,
        ownerFields: config.mockOwnerFields,
      });
      if (config.debug) {
        persistLog.debug('mock:init', { adapter: 'MockPersistenceAdapter' });
      }
    } else {
      this.persistence = config.persistence || new InMemoryPersistence();
    }

    // OS handlers (fs/net/child_process effects) are wired lazily on the first
    // event via ensureOsHandlers(). They live in the ESM-only
    // `../effects/createOsHandlers.js`; the package is `type: module`, so a synchronous
    // require() of it throws ERR_REQUIRE_ESM in a Node consumer. A dynamic
    // import() loads it cleanly AND keeps it out of the browser graph
    // (isNodeEnv-guarded, lazy chunk) — same goal as the old eval-require, but
    // without the CJS hazard. Default to empty handlers until then.
    this.osHandlers = { handlers: {}, cleanup: () => {} };
  }

  /**
   * Lazily wire the OS-level effect handlers (fs/net/child_process), merging
   * them UNDER any user-provided handlers. Deferred out of the constructor
   * because `../effects/createOsHandlers.js` is ESM and `require()`-ing it from a
   * `type: module` package throws ERR_REQUIRE_ESM — so it is dynamic-import()ed
   * here on the first event. Node-only, idempotent (single shared load), and a
   * no-op in the browser (the import never runs behind the isNodeEnv guard).
   */
  private async ensureOsHandlers(): Promise<void> {
    if (!isNodeEnv()) return;
    if (!this.osHandlersPromise) {
      this.osHandlersPromise = (async () => {
        // Literal `.js` specifier: a template literal makes tsup emit a
        // __glob helper keyed by the source `.ts`, which then misses at dist
        // runtime (ext resolves to `.js`) and throws "Module not found in
        // bundle". A literal `import()` resolves the real dist `.js` in Node
        // and Vite/vitest maps `.js`→`.ts` source automatically.
        const { createOsHandlers } = (await import('../effects/createOsHandlers.js')) as {
          createOsHandlers: typeof CreateOsHandlersFn;
        };
        this.osHandlers = createOsHandlers({
          emitEvent: (type, payload) => this.dispatchExternalEvent(type, payload),
        });
        this.config.effectHandlers = {
          ...this.osHandlers.handlers,
          ...this.config.effectHandlers,
        };
      })();
    }
    return this.osHandlersPromise;
  }

  /**
   * Lazily wire the agent substrate effect handlers (compose/behavior/
   * validate/lolo), merging them UNDER any user-provided handlers.
   * Same deferred-import pattern as ensureOsHandlers.
   */
  private async ensureAgentSubstrateHandlers(): Promise<void> {
    if (!isNodeEnv()) return;
    if (!this.substrateHandlersPromise) {
      this.substrateHandlersPromise = (async () => {
        const { createAgentSubstrateHandlers } = (await import('../effects/createAgentSubstrateHandlers.js')) as {
          createAgentSubstrateHandlers: typeof CreateAgentSubstrateHandlersFn;
        };
        this.substrateHandlers = createAgentSubstrateHandlers({
          emitEvent: (type, payload) => this.dispatchExternalEvent(type, payload),
          services: this.config.substrateServices ?? {},
        });
        this.config.effectHandlers = {
          ...this.substrateHandlers.handlers,
          ...this.config.effectHandlers,
        };
      })();
    }
    return this.substrateHandlersPromise;
  }

  /**
   * Lazily construct a default loader when the caller didn't provide one
   * but `register()` needs to preprocess. Looks for `@almadar/std` in the
   * nearest `node_modules` so cross-orbital `std/behaviors/<name>` imports
   * resolve to the tiered registry on disk.
   *
   * Node only — browsers should receive already-preprocessed schemas from
   * their server.
   */
  private async ensureLoader(): Promise<void> {
    if (this.loader) return;
    if (typeof process === 'undefined' || !process.versions?.node) {
      // Not Node — can't read the filesystem. Bail silently; the caller's
      // debug log in register() explains the skip.
      return;
    }
    try {
      const [{ fileURLToPath }, path, fs] = await Promise.all([
        import('node:url'),
        import('node:path'),
        import('node:fs'),
      ]);
      // Use ESM resolution (import.meta.resolve) because @almadar/std's
      // exports field only declares the `import` condition, which createRequire
      // (CJS conditions) can't match. Walk up from the resolved main entry
      // to the package root — robust against `exports` restrictions that
      // don't expose `./package.json` directly.
      const mainEntryUrl = import.meta.resolve('@almadar/std');
      const mainEntry = fileURLToPath(mainEntryUrl);
      let stdLibPath = path.dirname(mainEntry);
      while (stdLibPath !== path.dirname(stdLibPath)) {
        if (fs.existsSync(path.join(stdLibPath, 'package.json'))) {
          const pkg = JSON.parse(
            fs.readFileSync(path.join(stdLibPath, 'package.json'), 'utf-8'),
          ) as { name?: string };
          if (pkg.name === '@almadar/std') break;
        }
        stdLibPath = path.dirname(stdLibPath);
      }
      const basePath =
        this.config.loaderConfig?.basePath ?? process.cwd();
      this.loader = createUnifiedLoader({
        basePath,
        stdLibPath,
        scopedPaths: this.config.loaderConfig?.scopedPaths,
      });
      if (this.config.debug) {
        registerLog.debug('loader:constructed', { basePath, stdLibPath });
      }
    } catch (err) {
      if (this.config.debug) {
        registerLog.warn('loader:construct-failed', { error: err instanceof Error ? err : String(err) });
      }
    }
  }

  // ==========================================================================
  // Schema Registration
  // ==========================================================================

  /**
   * Register an OrbitalSchema for execution.
   *
   * Auto-preprocesses the schema when it contains `uses` declarations or
   * unresolved cross-orbital trait references (e.g. a trait with
   * `ref: "Modal.traits.ModalRecordModal"` and no inline `stateMachine`).
   * Without preprocessing, those refs arrive empty at the state machine and
   * button clicks silently do nothing — see Phase 9.5.H.
   *
   * Preprocessing needs a loader. If `loaderConfig` is set, that loader is
   * used. Otherwise, a default loader is constructed that points at
   * `<cwd>` (for `basePath`) and the nearest `node_modules/@almadar/std` (for
   * `stdLibPath`), which matches how every caller in this monorepo has the
   * std registry on disk.
   */
  /**
   * The in-flight (or last-completed) app mutation — `register()` chains its
   * body onto this, and `unregisterAll()` stamps a marker after clearing.
   * `processOrbitalEvent` consults it when the requested orbital is missing:
   * during a catalog-style app swap the new schema's registration is already
   * in flight while a client's first events arrive, and answering those with
   * an immediate `Orbital not found` 404 (the pre-fix behavior) races the
   * swap — big multi-orbital organisms lost their mount INITs intermittently
   * while single-orbital ones almost always won. Awaiting the epoch and
   * re-reading the map turns the race into a brief wait. `BrowserPlayground`
   * gated dispatches on registration ad hoc for the same race; the epoch is
   * the canonical, host-wide fix.
   */
  private registrationEpoch: Promise<unknown> | null = null;

  /**
   * Reentrancy guard for `withRegistrationMutation`. While a bracket is
   * open, `register()`/`unregisterAll()` must NOT chain/stamp the epoch:
   * the callback's sequential awaits already order them, and chaining a
   * `register()` awaited by the callback onto the bracket's gate would
   * deadlock (callback → register → epoch → gate → callback's finally).
   */
  private registrationMutationDepth = 0;

  async register(schema: OrbitalSchema): Promise<void> {
    if (this.registrationMutationDepth > 0) {
      // Inside a withRegistrationMutation bracket — ordering is guaranteed
      // by the callback's awaits; chaining onto the bracket epoch would
      // deadlock. See registrationMutationDepth.
      await this.doRegister(schema);
      return;
    }
    const previous = this.registrationEpoch ?? Promise.resolve();
    // Chain on BOTH fulfillment and rejection: a failed previous mutation
    // must not wedge the queue for the next schema.
    const epoch = previous.then(
      () => this.doRegister(schema),
      () => this.doRegister(schema),
    );
    this.registrationEpoch = epoch;
    await epoch;
  }

  private async doRegister(schema: OrbitalSchema): Promise<void> {
    if (this.config.debug) {
      registerLog.debug('register:schema', { name: schema.name });
    }
    this.appThemeKey = themeDataKey(schema.theme) || undefined;

    // Auto-preprocess if the schema has unresolved imports and we have (or
    // can construct) a loader. This replaces the old autoPreprocess flag,
    // which was off by default and led to silent failures when a consumer
    // forgot to enable it.
    if (needsPreprocessing(schema)) {
      await this.ensureLoader();
      if (this.loader) {
        if (this.config.debug) {
          registerLog.debug('register:auto-preprocessing', { name: schema.name });
        }
        const result = await preprocessSchema(schema, {
          basePath: this.config.loaderConfig?.basePath || process.cwd(),
          stdLibPath: this.config.loaderConfig?.stdLibPath,
          scopedPaths: this.config.loaderConfig?.scopedPaths,
          loader: this.loader,
          namespaceEvents: this.config.namespaceEvents,
        });
        if (!result.success) {
          throw new Error(
            `Schema preprocessing failed: ${result.errors.join('; ')}`,
          );
        }
        schema = result.data.schema;
        this.entitySharingMap = {
          ...this.entitySharingMap,
          ...result.data.entitySharing,
        };
        this.eventNamespaceMap = {
          ...this.eventNamespaceMap,
          ...result.data.eventNamespaces,
        };
      } else if (this.config.debug) {
        registerLog.warn('register:no-loader', { name: schema.name });
      }
    }

    // BEFORE the loop: registerOrbital seeds each entity eagerly
    // (MockPersistenceAdapter.registerEntity -> seed), so owner columns learned
    // after it would arrive too late to stamp a single row.
    this.applyIdentityOwnerFields(schema);

    // Register all orbitals (await to ensure instance seeding completes)
    for (const orbital of schema.orbitals) {
      await this.registerOrbitalAsync(orbital);
    }

    // Set up scheduled ticks
    this.setupTicks();

    // Stash the post-preprocessing schema so HTTP layers (e.g. a playground
    // server's /api/schema handler) can serve the fully-resolved copy instead
    // of re-reading the raw .orb from disk. See getResolvedSchema().
    this.resolvedSchema = schema;
    this.resolvedTraitConfigs = buildResolvedTraitConfigs(schema);
    this.callsiteCaptureChildrenByTrait = this.buildCallsiteCaptureChildrenByTrait(schema);
    this.installOwnerGate();
  }

  /**
   * Teach the mock seeder which columns hold the viewer's id, derived from the
   * schema's `[identity]` entity. No-op for a program that declares none, so
   * unmigrated apps seed exactly as before. Mirrors
   * `orbital-core/src/runtime/seed.rs::owner_fields_from_schema` — a feature
   * that lives on only one execution path is not a feature.
   */
  private applyIdentityOwnerFields(schema: OrbitalSchema): void {
    if (!(this.persistence instanceof MockPersistenceAdapter)) return;
    const derived = ownerFieldsFromSchema(schema);
    if (derived.length === 0) return;
    this.persistence.addOwnerFields(derived);
    persistLog.debug('mock:identity-owner-fields', {
      identity: identityEntityName(schema),
      columns: derived,
    });
  }

  /**
   * Merge `collectCallsiteCaptureChildren` across every orbital in the
   * schema into ONE flat referrer-trait-name → children map — same
   * flattening `resolvedTraitConfigs` uses, safe because trait names are
   * unique within one running schema (the compose/resolve pipeline already
   * relies on that for `configByTrait` and `resolvedTraitConfigs`).
   */
  private buildCallsiteCaptureChildrenByTrait(
    schema: OrbitalSchema,
  ): ReadonlyMap<string, ReadonlySet<string>> {
    const merged = new Map<string, ReadonlySet<string>>();
    for (const orbital of schema.orbitals) {
      for (const [referrer, children] of collectCallsiteCaptureChildren(orbital)) {
        merged.set(referrer, children);
      }
    }
    return merged;
  }

  /**
   * Register an OrbitalSchema synchronously (for backward compatibility).
   * Note: This version doesn't wait for instance seeding to complete.
   * Use async register() for guaranteed instance seeding.
   */
  registerSync(schema: OrbitalSchema): void {
    if (this.config.debug) {
      registerLog.debug('register:schema-sync', { name: schema.name });
    }
    this.appThemeKey = themeDataKey(schema.theme) || undefined;

    // Before the loop — see the note in register(): seeding is eager.
    this.applyIdentityOwnerFields(schema);

    for (const orbital of schema.orbitals) {
      this.registerOrbital(orbital);
    }

    // Set up scheduled ticks
    this.setupTicks();

    this.resolvedSchema = schema;
    this.resolvedTraitConfigs = buildResolvedTraitConfigs(schema);
    this.callsiteCaptureChildrenByTrait = this.buildCallsiteCaptureChildrenByTrait(schema);
    this.installOwnerGate();
  }

  /**
   * Returns the schema that this runtime is currently executing, post-
   * preprocessing. Safe to expose from an HTTP `/api/schema` endpoint — every
   * cross-orbital trait ref will have an inline `stateMachine` already, which
   * is what the browser's `schema-to-ir` resolver needs to wire button clicks
   * back to state transitions.
   *
   * Returns `null` if `register()` hasn't run yet.
   */
  getResolvedSchema(): OrbitalSchema | null {
    return this.resolvedSchema;
  }

  /**
   * One-call entry point: read an `.orb` file from disk, parse it, preprocess
   * cross-orbital imports, and register the result. Callers never touch raw
   * `.orb` bytes — `register()` handles preprocessing internally.
   *
   * Node only. Browsers must receive already-resolved schemas from their
   * server (see `getResolvedSchema()`).
   */
  async registerFromFile(path: string): Promise<void> {
    if (typeof process === 'undefined' || !process.versions?.node) {
      throw new Error(
        'registerFromFile is Node-only. Browsers should receive resolved schemas from their server.',
      );
    }
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path, 'utf-8');
    let schema: OrbitalSchema;
    try {
      schema = JSON.parse(raw) as OrbitalSchema;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`registerFromFile: ${path} is not valid JSON: ${msg}`);
    }
    await this.register(schema);
  }

  /**
   * Register an OrbitalSchema with preprocessing to resolve `uses` imports.
   *
   * This method:
   * 1. Loads all external orbitals referenced in `uses` declarations
   * 2. Expands entity/trait/page references to inline definitions
   * 3. Builds entity sharing and event namespace maps
   * 4. Caches the preprocessed result
   * 5. Registers the resolved schema
   *
   * @param schema - Schema with potential `uses` declarations
   * @param options - Optional preprocessing options
   * @returns Preprocessing result with entity sharing info
   *
   * @example
   * ```typescript
   * const runtime = new OrbitalServerRuntime({
   *   loaderConfig: {
   *     basePath: '/schemas',
   *     stdLibPath: '/std',
   *   },
   * });
   *
   * const result = await runtime.registerWithPreprocess(schema);
   * if (result.success) {
   *   console.log('Registered with', Object.keys(result.entitySharing).length, 'orbitals');
   * }
   * ```
   */
  async registerWithPreprocess(
    schema: OrbitalSchema,
    options?: { sourcePath?: string }
  ): Promise<{
    success: boolean;
    entitySharing?: EntitySharingMap;
    eventNamespaces?: EventNamespaceMap;
    warnings?: string[];
    errors?: string[];
  }> {
    // Check if preprocessing is possible
    if (!this.loader && !this.config.loaderConfig) {
      return {
        success: false,
        errors: ['Loader not configured. Set loaderConfig in OrbitalServerRuntimeConfig.'],
      };
    }

    // Ensure loader is initialized
    if (!this.loader && this.config.loaderConfig) {
      this.loader = this.config.loaderConfig.loader ?? createUnifiedLoader({
        basePath: this.config.loaderConfig.basePath,
        stdLibPath: this.config.loaderConfig.stdLibPath,
        scopedPaths: this.config.loaderConfig.scopedPaths,
      });
    }

    // Check cache
    const cacheKey = `${schema.name}:${schema.version || '1.0.0'}`;
    const cached = this.preprocessedCache.get(cacheKey);
    if (cached) {
      if (this.config.debug) {
        registerLog.debug('preprocess:cache-hit', { name: schema.name });
      }
      this.register(cached.schema);
      this.entitySharingMap = { ...this.entitySharingMap, ...cached.entitySharing };
      this.eventNamespaceMap = { ...this.eventNamespaceMap, ...cached.eventNamespaces };
      return {
        success: true,
        entitySharing: cached.entitySharing,
        eventNamespaces: cached.eventNamespaces,
        warnings: cached.warnings,
      };
    }

    if (this.config.debug) {
      registerLog.debug('preprocess:start', { name: schema.name });
    }

    // Preprocess schema
    const result = await preprocessSchema(schema, {
      basePath: this.config.loaderConfig?.basePath || '.',
      stdLibPath: this.config.loaderConfig?.stdLibPath,
      scopedPaths: this.config.loaderConfig?.scopedPaths,
      loader: this.loader!,
      namespaceEvents: this.config.namespaceEvents,
    });

    if (!result.success) {
      return {
        success: false,
        errors: result.errors,
      };
    }

    // Cache the result
    this.preprocessedCache.set(cacheKey, result.data);

    // Store sharing maps
    this.entitySharingMap = { ...this.entitySharingMap, ...result.data.entitySharing };
    this.eventNamespaceMap = { ...this.eventNamespaceMap, ...result.data.eventNamespaces };

    // Register the preprocessed schema
    this.register(result.data.schema);

    return {
      success: true,
      entitySharing: result.data.entitySharing,
      eventNamespaces: result.data.eventNamespaces,
      warnings: result.data.warnings,
    };
  }

  /**
   * Get entity sharing information for registered orbitals.
   * Useful for determining entity isolation and collection names.
   */
  getEntitySharing(): EntitySharingMap {
    return { ...this.entitySharingMap };
  }

  /**
   * Get event namespace mapping for registered orbitals.
   * Useful for debugging cross-orbital event routing.
   */
  getEventNamespaces(): EventNamespaceMap {
    return { ...this.eventNamespaceMap };
  }

  /**
   * Clear the preprocessing cache.
   */
  clearPreprocessCache(): void {
    this.preprocessedCache.clear();
  }

  /**
   * Register a single orbital
   */
  private async registerOrbitalAsync(orbital: OrbitalDefinition): Promise<void> {
    // Trait unwrap + config-by-trait + entity resolution — shared with the
    // stateless per-request transition path, see OrbitalTraitParsing.ts.
    const { traits: traitDefs, inlineTraits, configByTrait, entity } = parseOrbitalTraits(orbital);

    const manager = new StateMachineManager(traitDefs, {
      contextExtensions: this.config.contextExtensions,
    });

    // Bind each trait's call-site config to the manager so `@config.X`
    // resolves inside guard expressions at runtime. The orbital's
    // `configByTrait` map was just built above from the trait-ref
    // wrapper config blocks; thread those through to the SMM so
    // mode-aware guards (e.g. std-modal's "OPEN requires row when
    // mode=edit") work end-to-end on the runtime path. No-op for
    // traits with no call-site config supplied.
    for (const [traitName, traitConfig] of configByTrait) {
      manager.setTraitConfig(traitName, traitConfig);
    }

    this.orbitals.set(orbital.name, {
      schema: orbital,
      entity,
      traits: inlineTraits,
      configByTrait,
      manager,
      entityData: new Map(),
      traitFieldStates: new Map(),
      mount: new MountLifecycle<WorklistItem>(),
    });

    // A newly registered orbital's entities must appear in every
    // already-built evaluation index's cross-orbital `linkedEntity`
    // resolution — drop the caches so the next use rebuilds.
    for (const other of this.orbitals.values()) {
      other.traitIndex = undefined;
    }

    // Seed entity instances from schema if they exist
    if (entity?.name && entity.instances && Array.isArray(entity.instances)) {
      const instances = entity.instances;
      if (instances.length > 0) {
        persistLog.debug('seed:start', { entity: entity.name, count: instances.length });

        // Seed each instance (await to ensure they're created)
        const results = await Promise.all(
          instances.map(async (instance) => {
            try {
              const result = await this.persistence.create(entity.name, instance);
              persistLog.debug('seed:instance', { entity: entity.name, id: instance.id ?? 'no-id' });
              return result;
            } catch (err) {
              persistLog.error('seed:instance-error', {
                entity: entity.name,
                id: instance.id,
                error: err instanceof Error ? err : String(err),
              });
              return null;
            }
          })
        );

        const successCount = results.filter(r => r !== null).length;
        persistLog.debug('seed:done', { entity: entity.name, success: successCount, total: instances.length });
      }
    } else if (this.config.mode === 'mock' && this.persistence instanceof MockPersistenceAdapter) {
      // Fall back to mock data generation if no instances defined
      if (this.config.debug) {
        persistLog.debug('mock:generate', { entity: entity?.name });
      }
      if (entity?.name && entity.fields) {
        const fields = entity.fields
          .filter((f): f is typeof f & { name: string } =>
            typeof f.name === 'string' && f.name.length > 0,
          )
          ;
        this.persistence.registerEntity({
          name: entity.name,
          id: entity.id,
          collection: entity.collection,
          fields,
          persistence: entity.persistence,
        });
        if (this.config.debug) {
          persistLog.debug('mock:seeded', { entity: entity.name, count: this.persistence.count(entity.name) });
        }
      }
    }

    // Gap #22 — register + mock-seed auxiliary entities. These are imported
    // atom entities surfaced when a trait reference omits the `-> Entity`
    // rebind at the molecule's call site, registered on the resolved
    // schema's `auxiliaryEntities` field by the inline phase. Without this
    // block, `(fetch SearchResult ...)` from a trait whose linkedEntity is
    // an imported atom hits an unregistered persistence entry and returns
    // empty, breaking the entity-as-UI-state contract those slim atoms rely
    // on. Mock-mode seeding mirrors the primary entity branch above.
    const auxiliaryEntities = orbital.auxiliaryEntities;
    if (
      auxiliaryEntities !== undefined &&
      auxiliaryEntities.length > 0 &&
      this.config.mode === 'mock' &&
      this.persistence instanceof MockPersistenceAdapter
    ) {
      for (const auxRef of auxiliaryEntities) {
        // EntityRef is a union of string | EntityCall | Entity. The
        // inline phase populates auxiliaryEntities with inline Entity
        // objects (string/EntityCall forms get resolved before this
        // branch fires), but narrow defensively to keep the type
        // checker happy and to skip unresolved forms gracefully.
        if (typeof auxRef === 'string' || isEntityCall(auxRef)) continue;
        const auxEntity: Entity = auxRef;
        if (!auxEntity.name || !auxEntity.fields) continue;
        const auxFields = auxEntity.fields
          .filter((f): f is typeof f & { name: string } =>
            typeof f.name === 'string' && f.name.length > 0,
          )
          ;
        this.persistence.registerEntity({
          name: auxEntity.name,
          id: auxEntity.id,
          collection: auxEntity.collection,
          fields: auxFields,
          persistence: auxEntity.persistence,
        });
        if (this.config.debug) {
          persistLog.debug('mock:seeded-auxiliary', {
            entity: auxEntity.name,
            count: this.persistence.count(auxEntity.name),
          });
        }
      }
    }

    if (this.config.debug) {
      registerLog.debug('register:orbital', {
        name: orbital.name,
        traitCount: (orbital.traits || []).length,
      });
    }
  }

  /**
   * Register a single orbital (sync wrapper for backward compatibility)
   */
  private registerOrbital(orbital: OrbitalDefinition): void {
    // Create a synchronous version by using a promise that we don't await
    // For truly async registration, use the async register() method
    this.registerOrbitalAsync(orbital).catch((err) => {
      registerLog.error('register:failed', {
        name: orbital.name,
        error: err instanceof Error ? err : String(err),
      });
    });
  }

  /**
   * Set up scheduled ticks for all traits
   */
  private setupTicks(): void {
    // Clean up existing ticks
    this.cleanupTicks();

    // For each orbital's traits with `ticks`
    for (const [orbitalName, registered] of this.orbitals) {
      for (const trait of registered.traits || []) {
        if (!trait.ticks || trait.ticks.length === 0) continue;

        for (const tick of trait.ticks) {
          this.registerTick(orbitalName, trait.name, tick, registered);
        }
      }
    }

    if (this.config.debug && this.tickBindings.length > 0) {
      registerLog.debug('register:ticks', { count: this.tickBindings.length });
    }
  }

  /**
   * Register a single tick
   */
  private registerTick(
    orbitalName: string,
    traitName: string,
    tick: RuntimeTraitTick,
    registered: RegisteredOrbital,
  ): void {
    // A cron-shaped string ("0 9 * * *") schedules on calendar matches, not
    // a fixed millisecond delay — route it to the scheduler's cron mode
    // instead of forcing it through parseIntervalString (which used to
    // silently default a cron string to 1000ms).
    if (typeof tick.interval === "string" && isValidCronExpression(tick.interval)) {
      if (this.config.debug) {
        registerLog.debug('register:tick-cron', {
          orbital: orbitalName,
          trait: traitName,
          tick: tick.name,
          expression: tick.interval,
        });
      }
      const handle = this.tickScheduler.addCron(tick.interval, () => {
        void this.executeTick(orbitalName, traitName, tick, registered);
      });
      this.tickBindings.push({ orbitalName, traitName, tick, handle });
      return;
    }

    // Determine interval in milliseconds
    let intervalMs: number;
    if (typeof tick.interval === "number") {
      intervalMs = tick.interval;
    } else if (typeof tick.interval === "string") {
      // Parse a duration string (e.g., '5s', '1m', '1h'). A string that's
      // neither this shape nor a valid cron expression (already checked
      // above) is an authoring mistake — this throws rather than silently
      // defaulting to some fallback ms, so it surfaces loudly instead of
      // ticking at a value the author never wrote.
      intervalMs = parseDurationString(tick.interval);
    } else {
      intervalMs = 1000; // Default to 1 second
    }

    if (this.config.debug) {
      registerLog.debug('register:tick', {
        orbital: orbitalName,
        trait: traitName,
        tick: tick.name,
        intervalMs,
      });
    }

    const handle = this.tickScheduler.add(intervalMs, () => {
      void this.executeTick(orbitalName, traitName, tick, registered);
    });

    this.tickBindings.push({
      orbitalName,
      traitName,
      tick,
      handle,
    });
  }

  /**
   * Execute a tick for all applicable entities
   */
  private async executeTick(
    orbitalName: string,
    traitName: string,
    tick: RuntimeTraitTick,
    registered: RegisteredOrbital,
  ): Promise<void> {
    // Mount-scoped by default: an unmounted trait's tick is paused, not fired (Runtime Spec Clause 8.3).
    if (tick.runsInBackground !== true && !this.isTraitMounted(orbitalName, traitName)) return;
    const entityType = registered.entity.name;
    const emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }> = [];
    const now = Date.now();

    try {
      // Get all entities (or filtered by appliesTo)
      let entities = await this.persistence.list(entityType);

      if (tick.appliesTo && tick.appliesTo.length > 0) {
        const appliesToSet = new Set(tick.appliesTo);
        entities = entities.filter((e) => appliesToSet.has(e.id as string));
      }

      if (this.config.debug && entities.length > 0) {
        effectLog.debug('tick:processing', () => ({
          orbital: orbitalName,
          trait: traitName,
          tick: tick.name,
          entityCount: entities.length,
        }));
      }

      for (const entity of entities) {
        // Evaluate guard if present
        if (tick.guard) {
          try {
            const ctx = createContextFromBindings({
              entity,
              payload: {},
              state:
                registered.manager.getState(traitName)?.currentState ||
                "unknown",
              // A tick has no request user; only a dev host's ambient persona.
              user: this.config.defaultUser,
              now,
            }, false, this.config.contextExtensions);

            const guardPasses = evaluateGuard(
              tick.guard as Parameters<typeof evaluateGuard>[0],
              ctx,
            );

            if (!guardPasses) {
              if (this.config.debug) {
                effectLog.debug('tick:guard-failed', () => ({
                  tick: tick.name,
                  entityId: typeof entity.id === 'string' ? entity.id : undefined,
                }));
              }
              continue;
            }
          } catch (error) {
            effectLog.error('tick:guard-error', {
              tick: tick.name,
              entityId: typeof entity.id === 'string' ? entity.id : undefined,
              error: error instanceof Error ? error : String(error),
            });
            continue;
          }
        }

        // Execute effects for this entity
        if (tick.effects && tick.effects.length > 0) {
          const fetchedData: { [entityType: string]: EntityRow | EntityRow[] } = {};
          const clientEffects: ClientEffectTuple[] = [];
          const tickEffectResults: ServerEffectResult[] = [];
          await this.executeEffects(
            registered,
            traitName,
            tick.effects,
            {}, // No payload for ticks
            entity,
            entity.id as string,
            emittedEvents,
            fetchedData,
            clientEffects,
            tickEffectResults,
            this.config.defaultUser,
            undefined,
            undefined,
            undefined,
            undefined,
            now,
          );

          if (this.config.debug) {
            effectLog.debug('tick:effects-executed', () => ({
              tick: tick.name,
              entityId: typeof entity.id === 'string' ? entity.id : undefined,
            }));
          }
        }
      }

      // The tick ran its effects directly (never entering the composition),
      // so its emits saw no in-band fan-out — relay them to every orbital's
      // matching listeners, this orbital's included (the deleted bus
      // fan-out's role for tick emits).
      if (emittedEvents.length > 0) {
        this.enqueueEvent(async () => {
          await this.relayEmittedEvents(orbitalName, emittedEvents, {
            includeSourceOrbital: true,
            visited: new Set<string>(),
          });
        }).catch((error: Error) => {
          effectLog.error('tick:relay-error', {
            tick: tick.name,
            error: error.message,
          });
        });
      }
    } catch (error) {
      effectLog.error('tick:execute-error', {
        tick: tick.name,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /**
   * Clean up all active ticks
   */
  private cleanupTicks(): void {
    for (const binding of this.tickBindings) {
      binding.handle.stop();
    }
    this.tickBindings = [];
  }

  /**
   * Unregister all orbitals and clean up
   */
  /** A client mounts a trait by dispatching its lifecycle event and releases it with `$UNMOUNT`. */
  private recordMount(orbitalName: string, request: OrbitalEventRequest, mounted: boolean): void {
    const client = request.clientId ?? ANONYMOUS_CLIENT;
    const traits = request.targetTrait !== undefined ? [request.targetTrait] : (request.traits ?? []).map((t) => t.trait);
    for (const traitName of traits) {
      const key = `${orbitalName}::${traitName}`;
      const clients = this.mountedBy.get(key) ?? new Set<string>();
      if (mounted) clients.add(client);
      else clients.delete(client);
      if (clients.size > 0) this.mountedBy.set(key, clients);
      else this.mountedBy.delete(key);
    }
  }

  /** Drop every mount a disconnected client held, so its traits' mount-scoped ticks pause. */
  releaseClient(clientId: string): void {
    for (const [key, clients] of this.mountedBy) {
      clients.delete(clientId);
      if (clients.size === 0) this.mountedBy.delete(key);
    }
  }

  /** True while at least one client has `traitName` mounted. */
  isTraitMounted(orbitalName: string, traitName: string): boolean {
    return (this.mountedBy.get(`${orbitalName}::${traitName}`)?.size ?? 0) > 0;
  }

  unregisterAll(): void {
    // Clean up ticks
    this.cleanupTicks();
    this.mountedBy.clear();

    this.orbitals.clear();
    this.eventBus.clear();

    // Clear mock persistence so the next registerFromFile re-seeds from
    // the schema instead of inheriting rows the previous walk created.
    // Without this, runtime-verify's state walk keeps every SAVE's
    // persist-create row across test sessions — the grid accumulates
    // "Mock name" rows that are never pruned, and empty cards from
    // partial walk-step payloads stay visible forever.
    if (this.persistence instanceof MockPersistenceAdapter) {
      this.persistence.clearAll();
    }

    // Clean up OS handlers (close file watchers, intervals, signal listeners)
    if (this.osHandlers) {
      this.osHandlers.cleanup();
      this.osHandlers = null;
    }

    if (this.substrateHandlers) {
      this.substrateHandlers.cleanup();
      this.substrateHandlers = null;
    }

    // Stamp the mutation epoch AFTER the clear completes: a concurrent
    // processOrbitalEvent that finds an orbital missing consults
    // `registrationEpoch`, and a marker here (rather than nothing) keeps a
    // just-cleared runtime from answering stale lookups while the matching
    // register() is still chaining behind it. NOTE: this marker only covers
    // the clear itself — hosts that unregister → resolve → register as a swap
    // must bracket the WHOLE sequence in `withRegistrationMutation`, or the
    // resolve window between this marker and the upcoming register() answers
    // dispatches with a premature 404 (G-RUNTIME-039). Inside such a bracket
    // the stamp is skipped (the bracket's own epoch covers the swap, and
    // stamping here would deadlock it — see registrationMutationDepth).
    if (this.registrationMutationDepth === 0) {
      this.registrationEpoch = (this.registrationEpoch ?? Promise.resolve())
        .then(() => undefined, () => undefined);
    }
  }

  /**
   * Bracket a multi-step app mutation (the classic swap is
   * `unregisterAll()` → resolve next schema → `register()`) as ONE
   * registration epoch. `register()` alone chains only its own body onto
   * the epoch, so between `unregisterAll()` and the `register()` call the
   * runtime's map is empty while the epoch marker has already resolved —
   * any `processOrbitalEvent` that lands in that gap (the resolve of a big
   * organism takes real time) 404s `Orbital not found` even though the
   * requested orbital is milliseconds away from landing. Inside this
   * bracket the epoch stays pending for the WHOLE callback, so mid-swap
   * dispatches await the completed swap and then resolve against the new
   * app. A failed callback still releases the epoch (chained on both
   * branches), so a failed swap falls through to the honest 404 instead of
   * wedging the queue. Callbacks SERIALIZE: each bracket awaits the previous
   * epoch before running `fn`, so two hosts swapping at once (a catalog
   * select racing a preview remount's `/register`) cannot interleave their
   * unregister/register sequences into a mixed registry. A bracket opened
   * from INSIDE another bracket's callback runs `fn` directly — detected
   * via the AsyncLocalStorage context below (a depth counter alone can't
   * tell a true nest from a concurrent caller) — because the outer
   * callback's awaits already serialize it and queueing on the outer gate
   * would deadlock. Deadlock-free otherwise: `doRegister` never dispatches
   * events, so awaiting dispatches never block registration progress.
   */
  /**
   * Reentrancy context for `withRegistrationMutation`. A depth counter alone
   * cannot distinguish "called from inside a bracket callback" (must run
   * directly — queueing on the outer gate would deadlock) from "called
   * concurrently while another bracket is in flight" (must queue — running
   * directly would interleave two swaps). The ALS marks the callback's async
   * context, which separates the two exactly.
   */
  private bracketAls: Promise<BracketAsyncLocalStorage<symbol>> | null = null;
  private ensureBracketAls(): Promise<BracketAsyncLocalStorage<symbol>> {
    this.bracketAls ??= import('node:async_hooks').then(
      ({ AsyncLocalStorage }) => new AsyncLocalStorage<symbol>(),
    );
    return this.bracketAls;
  }

  async withRegistrationMutation<T>(fn: () => Promise<T>): Promise<T> {
    // Publish the gate SYNCHRONOUSLY: a dispatch arriving in the same tick
    // as the bracket call must see a pending epoch, not a resolved one —
    // any await (including the ALS load below) before this publication
    // would reopen the 404 window the bracket exists to close.
    const previous = this.registrationEpoch ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.registrationEpoch = previous.then(() => gate, () => gate);
    this.registrationMutationDepth++;
    try {
      const als = await this.ensureBracketAls();
      if (als.getStore() !== undefined) {
        // Called from inside an open bracket's callback — the outer
        // callback's awaits already serialize us; queueing on the epoch
        // would deadlock. Our transient gate released here is harmless.
        release();
        return await fn();
      }
      await previous.catch(() => undefined);
      const nestingToken = Symbol('withRegistrationMutation');
      return await als.run(nestingToken, fn);
    } finally {
      this.registrationMutationDepth--;
      release();
    }
  }

  /**
   * Reset the mock persistence store to a clean-slate re-seed without
   * unregistering orbitals. Exposed for verifier tools that want to
   * start each test with deterministic seeded rows, not the residue of
   * the previous walk's persist-creates. No-op when the persistence
   * layer is not MockPersistenceAdapter.
   */
  resetMockPersistence(): void {
    if (!(this.persistence instanceof MockPersistenceAdapter)) return;
    busLog.debug('mock:reset:enter', {
      orbitalCount: this.orbitals.size,
      timestamp: new Date().toISOString(),
    });
    this.persistence.clearAll();
    for (const registered of this.orbitals.values()) {
      const entity = registered.entity;
      if (entity?.name && entity.fields) {
        const fields = entity.fields
          .filter((f): f is typeof f & { name: string } =>
            typeof f.name === 'string' && f.name.length > 0,
          )
          ;
        this.persistence.registerEntity({
          name: entity.name,
          id: entity.id,
          collection: entity.collection,
          fields,
          persistence: entity.persistence,
        });
      }
      // Auxiliary entities (imported atom entities) were registered at boot;
      // a reset that drops them would leave their fetches on empty stores and
      // orphan any sibling sharing their collection.
      for (const auxRef of registered.schema.auxiliaryEntities ?? []) {
        if (typeof auxRef === 'string' || isEntityCall(auxRef)) continue;
        if (!auxRef.name || !auxRef.fields) continue;
        const auxFields = auxRef.fields
          .filter((f): f is typeof f & { name: string } =>
            typeof f.name === 'string' && f.name.length > 0,
          )
          ;
        this.persistence.registerEntity({
          name: auxRef.name,
          id: auxRef.id,
          collection: auxRef.collection,
          fields: auxFields,
          persistence: auxRef.persistence,
        });
      }
    }
  }

  /**
   * Return every registered orbital's circuit to boot: trait states to their
   * initial states, frames and row cache emptied, and a fresh mount (no trait
   * awaiting INIT, nothing held). The hermetic-reset twin of
   * `resetMockPersistence`: a reset walk must not inherit the previous walk's
   * circuit any more than its rows.
   */
  resetCircuitState(): void {
    for (const registered of this.orbitals.values()) {
      registered.manager.resetAll();
      registered.traitFieldStates.clear();
      registered.entityData.clear();
      registered.mount = new MountLifecycle<WorklistItem>();
    }
  }

  /**
   * Wire a live-broadcast sink. Called only from a `persist` effect's
   * `emit:{success}` envelope firing site (batch and single-op) — see
   * `docs/Almadar_Live_Push.md`. The hosting server (e.g. the playground's
   * `/api/events` SSE endpoint) uses this to fan persist mutations out to
   * every OTHER connected client; a fresh call replaces the previous sink.
   */
  setLiveBroadcastSink(sink: (item: LiveBroadcastItem) => void): void {
    this.liveBroadcastSink = sink;
  }

  /**
   * Switch the viewer a dev host presents the app as — see
   * `OrbitalServerRuntimeConfig.defaultUser`. Pass `undefined` for an
   * unauthenticated viewer. Takes effect on the next event; an authenticated
   * request still overrides it.
   *
   * Mock mode seeded owner columns EAGERLY at construction, stamped with
   * whichever id was `defaultUser` then (see `MockPersistenceAdapter.seed`).
   * Switching to a different id here would otherwise leave those columns
   * pointing at the old viewer forever, so an ownership-scoped view for the
   * new one stays empty — `restampOwner` re-points the already-stamped cells
   * instead of re-seeding.
   */
  setDefaultUser(user: UserContext | undefined): void {
    const previousId = this.config.defaultUser?.id;
    this.config.defaultUser = user;
    if (
      this.persistence instanceof MockPersistenceAdapter &&
      user?.id !== undefined &&
      user.id !== previousId
    ) {
      this.restampOwnerGated(user);
    }
  }

  /** setDefaultUser can land before register() finishes resolving the schema
   *  (a dev host pins a persona right after boot). An ungated restamp there
   *  would hand a read-only persona authorship of drafts, so the restamp is
   *  DEFERRED until the schema exists — register()/registerSync() flush it. */
  private pendingOwnerRestamp = false;

  /**
   * Re-point the mock seeder's owner stamps at `user`. The adapter's
   * installed owner gate (see installOwnerGate) decides per row whether the
   * persona could have CREATED it — a reader keeps seeing the store's
   * published face instead of inheriting draft ownership from the demo
   * stamper. Deferred when the schema (and so the gate) isn't resolved yet.
   */
  private restampOwnerGated(user: UserContext): void {
    if (!(this.persistence instanceof MockPersistenceAdapter)) return;
    if (!this.resolvedSchema) {
      this.pendingOwnerRestamp = true;
      return;
    }
    this.persistence.restampOwner(user.id);
  }

  /**
   * Install the schema's `@create` directives as the mock seeder's owner
   * gate — the single authority on who may author a row. Consulted by BOTH
   * `restampOwner` (persona switches) and `seed()` (a client connect
   * re-registers, and the deterministic reseed re-stamps with the current
   * ownerId — gating only the switch path would leak right there). Reads the
   * CURRENT default user at evaluation time so one installation covers every
   * later switch. Then flushes any switch that arrived before the schema.
   */
  private installOwnerGate(): void {
    if (!(this.persistence instanceof MockPersistenceAdapter) || !this.resolvedSchema) return;
    const policiesByStore = entityAccessPoliciesByStoreKey(this.resolvedSchema);
    this.persistence.setOwnerGate((storeKey, candidateRow) => {
      const user = this.config.defaultUser;
      if (!user) return true;
      return checkMutationAccess(candidateRow, policiesByStore.get(storeKey)?.create, { user });
    });
    // Per-candidate twin of the gate above, for linkRelationFields and the
    // eligible-owner seed fallback: may THIS identity row (not the current
    // default user) own the candidate row? A row without a usable `id` fails
    // closed rather than being evaluated as an unauthenticated request.
    this.persistence.setOwnerCandidateGate((storeKey, candidateRow, candidateIdentityRow) => {
      const persona = personaFromIdentityRow(candidateIdentityRow);
      if (!persona) return false;
      return checkMutationAccess(candidateRow, policiesByStore.get(storeKey)?.create, { user: persona });
    });
    if (this.pendingOwnerRestamp) {
      this.pendingOwnerRestamp = false;
      const user = this.config.defaultUser;
      if (user?.id !== undefined) this.restampOwnerGated(user);
    }
  }

  /** The viewer a dev host is currently presenting the app as. */
  getDefaultUser(): UserContext | undefined {
    return this.config.defaultUser;
  }

  /**
   * Queue a tick-stamped dispatch for coalesced snapshot relay (T6). Newest
   * per (originClientId, orbital, event) wins between flushes — the standard
   * netcode position-broadcast discipline.
   */
  private queueTickRelay(orbitalName: string, request: OrbitalEventRequest): void {
    const key = `${request.clientId ?? ''}:${orbitalName}:${request.event}`;
    this.tickRelayPending.set(key, {
      event: request.event,
      payload: request.payload,
      source: { orbital: orbitalName, trait: request.sourceTrait, tick: request.tick },
      originClientId: request.clientId,
    });
    if (this.tickRelayTimer === null) {
      const timer = setInterval(() => this.flushTickRelay(), this.config.tickRelayIntervalMs ?? 50);
      // Never hold a Node process open for the relay.
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
      this.tickRelayTimer = timer;
    }
  }

  private flushTickRelay(): void {
    if (this.tickRelayPending.size === 0) {
      if (this.tickRelayTimer !== null) {
        clearInterval(this.tickRelayTimer);
        this.tickRelayTimer = null;
      }
      return;
    }
    const items = Array.from(this.tickRelayPending.values());
    this.tickRelayPending.clear();
    for (const item of items) this.liveBroadcastSink?.(item);
  }

  /**
   * The registered app's declared persona roster: the live rows of its
   * `[identity]` entity, mapped onto viewers (`Almadar_LOLO_Identity.md` §4.3).
   * Live-store rows rather than a re-derivation, so the roster carries the ids
   * ownership scoping actually compares `@user.id` against. Empty when no
   * schema is registered or the app declares no `[identity]` entity — there is
   * no global fallback roster by design.
   */
  async getIdentityRoster(): Promise<UserContext[]> {
    const schema = this.resolvedSchema;
    if (!schema) return [];
    const entityName = identityEntityName(schema);
    if (!entityName) return [];
    const rows = await this.persistence.list(entityName);
    return rows
      .map((row) => personaFromIdentityRow(row))
      .filter((p): p is UserContext => p !== undefined);
  }

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  /**
   * `traitFieldStates` key for one trait: its own name, or — when its linked
   * entity is `[shared]` — `$shared::<entityName>` so every trait bound to
   * that entity reads/writes ONE frame. The server twin of the client hook's
   * `sharedKeyByTraitName` (useTraitStateMachine): without it, a sibling
   * trait's effect interpolation (a fetch filter reading
   * `@entity.activeChannel`) never saw the writer's `(set …)`.
   */
  private sharedFieldKey(registered: RegisteredOrbital, traitName: string): string {
    const trait = registered.traits.find((t) => t.name === traitName);
    const linked = trait?.linkedEntity ?? registered.entity.name;
    return this.isSharedEntity(registered, linked) ? `$shared::${linked}` : traitName;
  }

  /** Resolve an entity name to its declared `shared` flag: the orbital's own
   *  entity, its auxiliary entities, then other registered orbitals' primary
   *  entities (cross-orbital binds like a membership rail in the chat page). */
  private isSharedEntity(registered: RegisteredOrbital, entityName: string): boolean {
    if (registered.entity.name === entityName) return registered.entity.shared === true;
    for (const aux of registered.schema.auxiliaryEntities ?? []) {
      if (typeof aux === 'object' && !isEntityCall(aux) && aux.name === entityName) {
        return aux.shared === true;
      }
    }
    for (const other of this.orbitals.values()) {
      if (other.entity.name === entityName) return other.entity.shared === true;
    }
    return false;
  }

  /** Resolve an entity by name the same way `isSharedEntity` does: the
   *  orbital's own entity, its auxiliary entities, then other registered
   *  orbitals' primary entities (cross-orbital binds like a membership rail
   *  in the chat page). The one entity-resolution walk shared by every
   *  field-level lookup (`intrinsicFieldNames`, `entityFieldsFor`) so a new
   *  lookup never grows a second copy of this walk. */
  private resolveEntityByName(registered: RegisteredOrbital, entityName: string): Entity | undefined {
    if (registered.entity.name === entityName) return registered.entity;
    for (const aux of registered.schema.auxiliaryEntities ?? []) {
      if (typeof aux === 'object' && !isEntityCall(aux) && aux.name === entityName) {
        return aux;
      }
    }
    for (const other of this.orbitals.values()) {
      if (other.entity.name === entityName) return other.entity;
    }
    return undefined;
  }

  /** Names of an entity's `@intrinsic` fields — trait-owned view state
   *  (`ChatMessage.activeChannel`, `ChannelMember.pendingChannelId`, …) that
   *  is NEVER a persisted column. */
  private intrinsicFieldNames(registered: RegisteredOrbital, entityName: string): string[] {
    return this.entityFieldsFor(registered, entityName)
      .filter((field): field is EntityField & { name: string } => field.intrinsic === true && typeof field.name === 'string')
      .map((field) => field.name);
  }

  /** Full declared field list for an entity — the schema source `persist
   *  create`'s required-column check reads (`EffectExecutor.
   *  resolveEntityFields`), via the same `resolveEntityByName` walk
   *  `intrinsicFieldNames` uses. */
  private entityFieldsFor(registered: RegisteredOrbital, entityName: string): EntityField[] {
    return this.resolveEntityByName(registered, entityName)?.fields ?? [];
  }

  /**
   * Process an event for an orbital — the stateful host's thin shell over
   * the unified `evaluateOrbitalEvent` composition (design:
   * docs/Almadar_Runtime_Stateless_Stateful_PLAN.md §4.1). This method owns
   * ONLY session concerns: orbital lookup, viewer normalization, the lazy
   * OS/substrate handler wiring, the per-request relay mask
   * (G-RUNTIME-031 — the client's mounted set as DATA, replacing the
   * deleted blanket `originClientId` skip), the tick snapshot relay, and
   * the cross-orbital listens relay (a listener registered under a
   * DIFFERENT orbital than the emitter — the per-orbital composition's
   * in-band fan-out covers the rest). Target resolution, payload
   * validation, the cascade, the fan-out, structured rejections, and
   * response assembly are the composition's, identical to the stateless
   * path.
   *
   * Serialization: the whole evaluation runs on ONE runtime-wide async
   * queue. The composition commits manager state directly (no per-trait
   * actor queue), so concurrent requests against the long-lived session
   * manager would otherwise both evaluate from the same held state and
   * lose a transition. Coarser than the old per-(trait, entityId) actor
   * queues — a deliberate W4 tradeoff, recorded in the plan doc.
   *
   * @param onPush - Optional incremental-push callback. Called immediately
   * when an event is emitted or a client effect fires, before the promise
   * resolves. Used by the SSE streaming path to write items to the
   * response as they arrive rather than buffering and flushing at the end.
   */
  /**
   * Read an orbital by name, awaiting an in-flight registration mutation
   * first when the lookup misses (G-RUNTIME-038): mid-swap lookups 404ed
   * against the emptied map even though the requested orbital was
   * milliseconds from landing. A failed mutation falls through to the miss.
   */
  private async resolveRegisteredOrbital(orbitalName: string): Promise<RegisteredOrbital | undefined> {
    let registered = this.orbitals.get(orbitalName);
    if (!registered && this.registrationEpoch !== null) {
      await this.registrationEpoch.catch(() => undefined);
      registered = this.orbitals.get(orbitalName);
    }
    return registered;
  }

  async processOrbitalEvent(
    orbitalName: string,
    request: OrbitalEventRequest,
    onPush?: (item: PushItem) => void,
  ): Promise<OrbitalEventResponse> {
    // Gap 4 (Almadar_Rabit_V3_Deepseek_Gaps.md #4): this whole body used to
    // have no top-level error boundary, so a throw deep in an effect
    // handler (e.g. an LLM abort inside emitLoloBody) escaped as an
    // unhandled rejection instead of a normal failure response. Wrap it
    // and reuse the same failure shape already returned above for
    // "orbital not found" / payload-validation failures.
    try {
    // Wire OS-level + substrate effect handlers before any effect runs.
    await this.ensureOsHandlers();
    await this.ensureAgentSubstrateHandlers();

    const registered = await this.resolveRegisteredOrbital(orbitalName);
    if (!registered) {
      return {
        success: false,
        transitioned: false,
        states: {},
        emittedEvents: [],
        error: `Orbital not found: ${orbitalName}`,
      };
    }

    if (request.event === UNMOUNT_EVENT) {
      this.recordMount(orbitalName, request, false);
      return { success: true, transitioned: false, states: {}, emittedEvents: [] };
    }
    if ((LIFECYCLE_EVENTS as readonly string[]).includes(request.event)) {
      this.recordMount(orbitalName, request, true);
    }

    const response = await this.enqueueEvent(() =>
      this.evaluateForOrbital(registered, request, onPush),
    );

    // T6: a tick-stamped dispatch is a latest-state broadcast — queue it for
    // coalesced snapshot relay to other tabs. Local processing above is
    // unchanged (guards/persists still run); only the cross-tab fan-out is
    // lossy.
    if (request.tick !== undefined && this.liveBroadcastSink !== null) {
      this.queueTickRelay(orbitalName, request);
    }

    return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      xOrbitalLog.error('processOrbitalEvent:error', {
        orbital: orbitalName,
        event: request.event,
        entityId: request.entityId,
        error: message,
      });
      return {
        success: false,
        transitioned: false,
        states: {},
        emittedEvents: [],
        error: message,
      };
    }
  }

  /**
   * The enqueued critical section behind `processOrbitalEvent`: evaluate
   * one request through the composition, then relay its emits to
   * cross-orbital listeners. MUST only run holding the event queue.
   */
  private async evaluateForOrbital(
    registered: RegisteredOrbital,
    request: OrbitalEventRequest,
    onPush?: (item: PushItem) => void,
  ): Promise<OrbitalEventResponse> {
    const orbitalName = registered.schema.name;
    // Trace every server-side event entry. If the runtime path is
    // re-firing render-ui during a typing session, the smoking gun
    // appears here: a `processOrbitalEvent:enter` line per keystroke
    // means something upstream (bus replay, snapshot poll, cascade
    // listener) is triggering a transition cycle the user didn't
    // intend. EventPayload values are typed as `EventPayloadValue`
    // (a recursive union including nested EventPayload) — narrow with
    // typeof checks instead of an unknown cast.
    const payloadRow = request.payload?.['row'];
    const payloadRowAsPayload =
      payloadRow !== null && typeof payloadRow === 'object' && !Array.isArray(payloadRow)
        ? (payloadRow as EventPayload)
        : undefined;
    const payloadRowId = payloadRowAsPayload?.['id'];
    renderLog.debug('processOrbitalEvent:enter', {
      orbital: orbitalName,
      event: request.event,
      hasPayloadRow: payloadRowAsPayload !== undefined,
      payloadRowId: typeof payloadRowId === 'string' || typeof payloadRowId === 'number' ? payloadRowId : undefined,
      entityId: request.entityId,
    });
    busLog.debug('bus:incoming', () => ({
      orbital: orbitalName,
      event: request.event,
      payload: JSON.stringify(request.payload ?? null),
      entityId: request.entityId,
      traitStates: JSON.stringify(
        Array.from(registered.manager.getAllStates().entries()).map(([traitName, state]) => ({
          traitName,
          currentState: state.currentState,
        })),
      ),
    }));
    xOrbitalLog.info('processOrbitalEvent:enter', () => ({
      orbital: orbitalName,
      event: request.event,
      traitsInOrbital: registered.traits.map((t) => t.name).join(','),
      payloadActiveTraits: JSON.stringify(
        (request.payload as EventPayload | undefined)?.['_activeTraits'] ?? null,
      ),
    }));

    // The viewer this event is executed as. A request's own authenticated
    // user always wins; `defaultUser` only fills the gap for a dev host
    // that has no auth (see the config field's doc).
    const viewer = normalizeUserContext(request.user) ?? this.config.defaultUser;

    // A TARGETED request carrying circuit state is the client role's
    // delegated server leg — the composition's own delegated-leg semantics
    // apply (empty relay mask: the server runs the whole circuit,
    // G-RUNTIME-029). Anything else is server-authoritative: strip
    // client-carried circuit state so a non-targeted request can't inject
    // client-held states into the session manager. The legacy client's
    // `_targetTrait` payload sidecar is PROMOTED to the canonical
    // first-class field here: the composition's sidecar fallback only
    // guesses an initial state for single-state traits (a stateless-server
    // protection), which would silently drop the multi-state scoped
    // deliveries the old stateful path served from its held states.
    const isDelegatedLeg = request.targetTrait !== undefined &&
      (request.traits !== undefined || request.entityByTrait !== undefined);
    let serverRequest = request;
    if (!isDelegatedLeg && request.targetTrait === undefined) {
      const sidecarTarget = (request.payload as EventPayload | undefined)?.['_targetTrait'] as string | undefined;
      if (sidecarTarget !== undefined || request.traits !== undefined || request.entityByTrait !== undefined) {
        serverRequest = { ...request, ...(sidecarTarget !== undefined ? { targetTrait: sidecarTarget } : {}) };
        delete serverRequest.traits;
        delete serverRequest.entityByTrait;
      }
    }

    // This host HOLDS every trait's state, so it runs every listener itself
    // (G-RUNTIME-031's off-page listeners included); the client's mounted
    // set only scopes which renders come back (`_activeTraits`, read by the
    // composition). Leaving on-page listeners to the client left this
    // host's held state stale (G-RUNTIME-042).
    const response = await evaluateOrbitalEvent(
      this.makeEvaluateDeps(registered, { viewer, onPush, originClientId: request.clientId }),
      serverRequest,
    );

    // Cross-orbital listens relay: the composition's in-band fan-out
    // covered THIS orbital's listeners; a listener registered under a
    // different orbital gets the emit here (the deleted bus fan-out's
    // only load-bearing role). Awaited — the old bus handlers were
    // fire-and-forget, which let a relayed persist land after the
    // response.
    await this.relayEmittedEvents(orbitalName, response.emittedEvents, {
      includeSourceOrbital: false,
      visited: new Set<string>(),
      into: response,
    });

    return response;
  }

  /**
   * Build the composition deps for one registered orbital — the stateful
   * session shape: long-lived manager + frames, the server effect stage
   * (relation trio + live broadcast), and the per-request viewer/push/
   * origin context. The stage runner also re-runs JSX-hoisted
   * callsite-capture children under each step's payload (see
   * `rerenderCallsiteCaptureChildren`).
   */
  private makeEvaluateDeps(
    registered: RegisteredOrbital,
    context: {
      viewer?: UserContext;
      onPush?: (item: PushItem) => void;
      originClientId?: string;
    },
  ): EvaluateOrbitalEventDeps {
    const runEffects: EvaluateEffectRunner = async (traitName, args) => {
      const originClientId = args.originClientId ?? context.originClientId;
      await this.executeEffects(
        registered,
        traitName,
        args.effects,
        args.payload,
        args.entityData,
        args.entityId,
        args.emittedEvents,
        args.fetchedData,
        args.clientEffects,
        args.effectResults,
        context.viewer,
        args.clientEffectsByTrait,
        context.onPush,
        originClientId,
        undefined,
        args.now,
        args.dispatch,
        args.firing,
      );
      await this.rerenderCallsiteCaptureChildren(
        registered,
        traitName,
        args.payload ?? {},
        args.entityData,
        args.entityId,
        args.emittedEvents,
        args.fetchedData,
        args.clientEffects,
        args.effectResults,
        context.viewer,
        args.clientEffectsByTrait,
        context.onPush,
        originClientId,
        args.now,
      );
    };
    return {
      traitIndex: this.traitIndexFor(registered),
      manager: registered.manager,
      persistence: this.persistence,
      frames: registered.traitFieldStates,
      mount: registered.mount,
      runEffects,
      // This host holds every trait's state and runs every listener itself:
      // an explicit empty mask, so the composition's request-shape mask (for
      // a host that holds no state) never silences a target's own listens.
      relayMask: new Set<string>(),
      ...(context.viewer !== undefined ? { user: context.viewer } : {}),
      ...(context.originClientId !== undefined ? { originClientId: context.originClientId } : {}),
      ...(this.config.contextExtensions !== undefined ? { contextExtensions: this.config.contextExtensions } : {}),
      ...(this.config.debug !== undefined ? { debug: this.config.debug } : {}),
      logContext: { orbitalName: registered.schema.name },
    };
  }

  /**
   * The orbital's evaluation index, built lazily on first use (by then
   * every orbital is registered, so cross-orbital `linkedEntity`
   * resolution sees the full registry) and cached on the registration.
   */
  private traitIndexFor(registered: RegisteredOrbital): TraitIndex {
    if (registered.traitIndex === undefined) {
      registered.traitIndex = buildTraitIndexForOrbital(
        registered.schema,
        [...this.orbitals.values()].filter((other) => other !== registered).map((other) => other.schema),
      );
    }
    return registered.traitIndex;
  }

  /**
   * The runtime-wide event queue — ONE async serialization point for every
   * composition run (requests, cross-orbital relays, external emits, tick
   * relays). The composition commits manager state directly rather than
   * through the manager's per-(trait, entityId) actor queues, so without
   * this, two concurrent requests against the session manager could both
   * evaluate from the same held state and lose a transition. `run` sees
   * the caller's result (or throw); the queue itself never wedges on a
   * failure.
   */
  private eventQueue: Promise<void> = Promise.resolve();

  private enqueueEvent<T>(run: () => Promise<T>): Promise<T> {
    const result = this.eventQueue.then(run, run);
    this.eventQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Cross-orbital listens relay — the host half of the circuit the
   * per-orbital composition cannot see: a listener registered under a
   * DIFFERENT orbital than the emitter's. Each match runs the listener's
   * `triggers` event through the listener's own orbital composition
   * (targeted delivery — the same shape the deleted bus fan-out posted,
   * minus its blanket `originClientId` skip: G-RUNTIME-031). Recursion is
   * bounded by a per-entry visited set (distinct
   * orbital/trait/triggers/from keys, mirroring the composition's own
   * cascade visited-set) plus a hop cap. MUST only run holding the event
   * queue.
   *
   * @param sourceOrbital The orbital whose composition produced `emits`,
   *   or undefined for external producers (os/substrate handlers). The
   *   source orbital is skipped unless `includeSourceOrbital` — its own
   *   listeners already ran in-band (composition emits), or the caller
   *   explicitly wants them (ticks, which never enter the composition).
   */
  private async relayEmittedEvents(
    sourceOrbital: string | undefined,
    emits: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }>,
    opts: {
      includeSourceOrbital: boolean;
      visited: Set<string>;
      /** The requesting response: each relay hop's renders, rows and states
       *  fold into it so the requester sees the work its event caused. */
      into?: OrbitalEventResponse;
    },
  ): Promise<void> {
    const queue = [...emits];
    let hops = 0;
    while (queue.length > 0) {
      const emitted = queue.shift();
      if (emitted === undefined) break;
      // The composition already fanned an emit out within the orbital that
      // produced it; skip THAT orbital (the emit's own), not the request's —
      // a relay hop's answer must still reach the requesting orbital.
      const producedIn = emitted.source?.orbital ?? sourceOrbital;
      for (const [orbitalName, registered] of this.orbitals) {
        if (orbitalName === producedIn && !opts.includeSourceOrbital) continue;
        const delivery = deliveryOf(emitted);
        const traitIndex = this.traitIndexFor(registered);
        for (const target of collectListenerTargets(
          traitIndex,
          emitted.source,
          emitted.event,
          emitted.payload,
          undefined,
          {
            guardBindings: freshDeliveryGuardBindings(delivery, (listener) => {
              const entry = traitIndex.byName.get(listener);
              return registered.manager.getState(listener)?.currentState ??
                (entry !== undefined ? findInitialState(entry.traitDef) : '');
            }),
          },
        )) {
          const from = registered.manager.getState(target.listenerTrait, target.entityId)?.currentState ??
            findInitialState(target.entry.traitDef);
          const key = `${orbitalName}\u0000${dispatchVisitKey(target.listenerTrait, target.triggers, from, target.payload)}`;
          if (opts.visited.has(key)) continue;
          if (hops >= CROSS_ORBITAL_RELAY_CAP) {
            xOrbitalLog.warn('relay:truncated', { event: emitted.event, hops });
            return;
          }
          opts.visited.add(key);
          hops += 1;
          try {
            const response = await evaluateOrbitalEvent(
              { ...this.makeEvaluateDeps(registered, { viewer: this.config.defaultUser }), seedDelivery: delivery },
              {
                event: target.triggers,
                ...(target.triggersId !== undefined ? { eventId: target.triggersId } : {}),
                ...(target.payload !== undefined ? { payload: target.payload } : {}),
                ...(target.entityId !== undefined ? { entityId: target.entityId } : {}),
                targetTrait: target.listenerTrait,
              },
            );
            queue.push(...response.emittedEvents);
            if (opts.into !== undefined) foldRelayHop(opts.into, response);
          } catch (error) {
            // One listener's failure must not strand the remaining relay
            // (the old bus fan-out's handlers were independent too).
            xOrbitalLog.error('relay:error', {
              orbital: orbitalName,
              trait: target.listenerTrait,
              event: target.triggers,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }

  /**
   * Entry point for events produced OUTSIDE any orbital's composition —
   * the OS effect handlers (fs/net/child_process watchers) and the agent
   * substrate handlers (the deleted bus's last producers). Fans the event
   * out to every registered orbital's matching listeners. Runs on the
   * event queue; errors are logged, never thrown at the producer.
   */
  private dispatchExternalEvent(event: string, payload?: EventPayload): void {
    this.enqueueEvent(async () => {
      await this.relayEmittedEvents(
        undefined,
        [{ event, ...(payload !== undefined ? { payload } : {}) }],
        { includeSourceOrbital: true, visited: new Set<string>() },
      );
    }).catch((error: Error) => {
      xOrbitalLog.error('dispatchExternalEvent:error', {
        event,
        error: error.message,
      });
    });
  }


  /**
   * Execute effects from a transition
   */
  private async executeEffects(
    registered: RegisteredOrbital,
    traitName: string,
    effects: RuntimeValue[],
    payload: EventPayload | undefined,
    entityData: EntityRow,
    entityId: string | undefined,
    emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }>,
    fetchedData: { [entityType: string]: EntityRow | EntityRow[] },
    clientEffects: ClientEffectTuple[],
    effectResults: ServerEffectResult[],
    /** Already-normalized viewer (see `processOrbitalEvent`'s `viewer`). */
    user?: UserContext,
    clientEffectsByTrait?: ClientEffectByTrait[],
    onPush?: (item: { type: 'event'; data: { event: string; payload?: EventPayload; source?: BusEventSource } } | { type: 'effect'; data: ClientEffectTuple }) => void,
    /** Per-request originating client (from `OrbitalEventRequest.clientId`); absent for ticks. Carried through to persist-envelope broadcast items so the sink can exclude the origin. */
    originClientId?: string,
    /**
     * The composing effect's triggering payload, when `traitName` is an
     * embedded child (`@trait.X`) being re-run under its embedder's
     * transition. Surfaced on the binding context as `@callsitePayload.<field>`
     * — see `BindingContext.callsitePayload`. Absent for a trait's own,
     * non-embedded execution.
     */
    callsitePayload?: EventPayload,
    /** The dispatch's `now` stamp. */
    now?: number,
    /** The transition being run, for post-commit `state` and the dispatch roots. */
    dispatch?: EffectDispatch,
    /** The firing transition's event and from-state, stamped on each client effect. */
    firing?: { event: string; fromState: string },
  ): Promise<void> {
    const sigilPages: NavItem[] = [];
    const seenPaths = new Set<string>();
    for (const reg of this.orbitals.values()) {
      for (const item of inlineNavItems(reg.schema.pages ?? [])) {
        if (seenPaths.has(item.href)) continue;
        seenPaths.add(item.href);
        sigilPages.push(item);
      }
    }
    const sigilTheme = themeDataKey(registered.schema.theme) || this.appThemeKey || DEFAULT_THEME_KEY;

    await runServerEffectStage(
      {
        persistence: this.persistence,
        frames: registered.traitFieldStates,
        frameKeyFor: (t) => this.sharedFieldKey(registered, t),
        orbitalName: registered.schema.name,
        orbitalId: registered.schema.id,
        irTraits: registered.traits,
        entity: registered.entity,
        configByTrait: registered.configByTrait,
        resolvedTraitConfigs: this.resolvedTraitConfigs,
        resolvedSchema: this.resolvedSchema,
        registeredOrbitals: this.orbitals.values(),
        getTraitState: (t) => registered.manager.getState(t),
        intrinsicFieldNames: (type) => this.intrinsicFieldNames(registered, type),
        entityFieldsFor: (type) => this.entityFieldsFor(registered, type),
        validateRelationCardinality: (type, data) => this.validateRelationCardinality(type, data),
        enforceOnDeleteRules: (type, id) => this.enforceOnDeleteRules(type, id),
        populateRelations: (entities, type, include) => this.populateRelations(entities, type, include),
        sigilPages,
        sigilTheme,
        extraEffectHandlers: this.config.effectHandlers,
        deliverEmit: (event, eventPayload, stamp, fromPersistSuccess) => {
          // Observability tap, NOT circuit routing (W4): the runtime's own
          // fan-out is the composition's in-band loop + the host's
          // cross-orbital relay — nothing inside the runtime subscribes to
          // the bus anymore. The emit still fires here because the bus is
          // the public firehose (`getEventBus().onAny`) tests and
          // diagnostics observe the circuit through (including tick emits,
          // which have no response to read).
          this.eventBus.emit(event, eventPayload, stamp, eventRouteKey(event, stamp.eventId));
          if (fromPersistSuccess) {
            this.liveBroadcastSink?.({ event, payload: eventPayload, source: stamp, originClientId });
          }
        },
        liveBroadcastSinkWired: this.liveBroadcastSink !== null,
        debug: this.config.debug,
        mockMode: this.config.mode === 'mock',
        contextExtensions: this.config.contextExtensions,
      },
      { traitName, effects, payload, entityData, entityId, emittedEvents, fetchedData, clientEffects, effectResults, user, clientEffectsByTrait, onPush, originClientId, callsitePayload, ...(now !== undefined ? { now } : {}), ...(dispatch !== undefined ? { dispatch } : {}), ...(firing !== undefined ? { firing } : {}) },
    );
  }

  /**
   * Re-run a JSX-hoisted inline child trait's (`@trait.X`) lifecycle
   * transition under `callsitePayload` — the payload of the transition that
   * just composed it — so its `@callsitePayload.<field>` captures reflect
   * the composing event instead of staying frozen at whatever the child
   * captured at its own mount-time INIT (a child renders once at mount and
   * never again on its own).
   *
   * `this.callsiteCaptureChildrenByTrait` (built at `register()` via
   * `@almadar/core`'s `collectCallsiteCaptureChildren`) gives `traitName`'s
   * DIRECT children that need this — either because the child itself
   * captures, or because it is a pass-through to a capturing descendant.
   * The child's lifecycle event (INIT/LOAD/$MOUNT) is re-dispatched
   * TARGETED at just that trait, from its CURRENT state (the same
   * guard-aware `sendEvent`/`canHandleEvent` lookup a mount-time INIT
   * uses), then its effects run through the SAME `executeEffects` used
   * everywhere else, with `payload: {}` (a lifecycle event carries none)
   * and `callsitePayload` set so `@callsitePayload.*` resolves — pushing
   * into the SAME `clientEffects`/`clientEffectsByTrait`/`effectResults`
   * so the child's refreshed frame reaches the sidecar under its own trait
   * name. Recurses into the child's own entry in the same map (still under
   * the SAME `callsitePayload` — the capture resolves up the embed chain to
   * the nearest transition that actually has one) for grandchildren;
   * `visited` guards against a malformed embed graph cycling on itself.
   * Never goes through `processOrbitalEvent` (that would be re-entrant) —
   * calls this internal executor directly, exactly like every other
   * transition's effects.
   */
  private async rerenderCallsiteCaptureChildren(
    registered: RegisteredOrbital,
    traitName: string,
    callsitePayload: EventPayload,
    entityData: EntityRow,
    entityId: string | undefined,
    emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }>,
    fetchedData: { [entityType: string]: EntityRow | EntityRow[] },
    clientEffects: ClientEffectTuple[],
    effectResults: ServerEffectResult[],
    user: UserContext | undefined,
    clientEffectsByTrait: ClientEffectByTrait[] | undefined,
    onPush: ((item: { type: 'event'; data: { event: string; payload?: EventPayload; source?: BusEventSource } } | { type: 'effect'; data: ClientEffectTuple }) => void) | undefined,
    originClientId: string | undefined,
    now: number | undefined,
    visited: Set<string> = new Set(),
  ): Promise<void> {
    const children = this.callsiteCaptureChildrenByTrait.get(traitName);
    if (!children || children.size === 0) return;
    for (const childName of children) {
      if (visited.has(childName)) continue;
      visited.add(childName);
      const lifecycleEvent = LIFECYCLE_EVENTS.find((evt) => registered.manager.canHandleEvent(childName, evt));
      if (lifecycleEvent === undefined) continue;
      const [entry] = registered.manager.sendEvent(lifecycleEvent, {}, entityData, undefined, undefined, childName, user);
      if (!entry || !entry.result.executed) continue;
      xOrbitalLog.debug('callsite-capture-child:rerender', () => ({
        referrer: traitName,
        child: childName,
        lifecycleEvent,
        callsitePayload: JSON.stringify(callsitePayload),
      }));
      await this.executeEffects(
        registered,
        childName,
        entry.result.effects,
        {},
        entityData,
        entityId,
        emittedEvents,
        fetchedData,
        clientEffects,
        effectResults,
        user,
        clientEffectsByTrait,
        onPush,
        originClientId,
        callsitePayload,
        now,
      );
      await this.rerenderCallsiteCaptureChildren(
        registered,
        childName,
        callsitePayload,
        entityData,
        entityId,
        emittedEvents,
        fetchedData,
        clientEffects,
        effectResults,
        user,
        clientEffectsByTrait,
        onPush,
        originClientId,
        now,
        visited,
      );
    }
  }

  // ==========================================================================
  // Relation Population
  // ==========================================================================

  /**
   * Populate relation fields on entities
   *
   * For each field in `include`, find the relation field configuration and
   * fetch the related entity, attaching it to the parent entity.
   *
   * @param entities - Entities to populate
   * @param entityType - Entity type name
   * @param include - Relation field names to populate
   */
  /**
   * Validate that relation field values match their declared cardinality.
   * Called before create/update to ensure data integrity.
   */
  private validateRelationCardinality(
    entityType: string,
    data: EntityRow,
  ): void {
    // Find the entity schema
    for (const [, registered] of this.orbitals) {
      if (registered.entity.name !== entityType) continue;

      for (const field of registered.entity.fields ?? []) {
        if (field.type !== 'relation') continue;
        if (field.name === undefined) continue;
        const fieldName = field.name;
        const value = data[fieldName];
        if (value === undefined || value === null) continue;

        const cardinality = field.relation?.cardinality || 'one';

        if (cardinality === 'one' || cardinality === 'many-to-one') {
          if (Array.isArray(value)) {
            throw new Error(
              `Cardinality violation: ${entityType}.${fieldName} has cardinality '${cardinality}' but received an array. Expected a single string ID.`
            );
          }
        } else if (cardinality === 'many' || cardinality === 'many-to-many' || cardinality === 'one-to-many') {
          if (typeof value === 'string') {
            data[fieldName] = [value];
          } else if (Array.isArray(value)) {
            const nonStrings = value.filter((v) => typeof v !== 'string');
            if (nonStrings.length > 0) {
              throw new Error(
                `Cardinality violation: ${entityType}.${fieldName} has cardinality '${cardinality}' but array contains non-string values.`
              );
            }
          }
        }
      }
      break;
    }
  }

  /**
   * Enforce onDelete rules for relation fields pointing to the entity being deleted.
   * Scans all registered entities for relation fields targeting the given entity type,
   * finds records referencing the ID being deleted, and applies cascade/nullify/restrict.
   */
  private async enforceOnDeleteRules(
    entityType: string,
    deletedId: string,
  ): Promise<void> {
    for (const [, registered] of this.orbitals) {
      const entity = registered.entity;
      const fields = entity.fields ?? [];

      for (const field of fields) {
        if (field.type !== 'relation') continue;
        if (field.relation?.entity !== entityType) continue;
        if (field.name === undefined) continue;
        const fieldName = field.name;

        const onDelete = field.relation.onDelete || 'restrict';
        const referringEntityType = entity.name;

        const allRecords = await this.persistence.list(referringEntityType);
        const affectedRecords = allRecords.filter(record => {
          const fkValue = record[fieldName];
          if (typeof fkValue === 'string') return fkValue === deletedId;
          if (Array.isArray(fkValue)) return fkValue.includes(deletedId);
          return false;
        });

        if (affectedRecords.length === 0) continue;

        switch (onDelete) {
          case 'restrict':
            throw new Error(
              `Cannot delete ${entityType} ${deletedId}: ${affectedRecords.length} ${referringEntityType} record(s) reference it via ${field.name}. Rule: restrict.`
            );

          case 'cascade':
            for (const record of affectedRecords) {
              const recordId = record.id as string;
              if (recordId) {
                await this.persistence.delete(referringEntityType, recordId);
              }
            }
            if (this.config.debug) {
              persistLog.debug('cascade-delete', {
                count: affectedRecords.length,
                entityType: referringEntityType,
              });
            }
            break;

          case 'nullify':
            for (const record of affectedRecords) {
              const recordId = record.id as string;
              if (recordId && field.name !== undefined) {
                const fieldName = field.name;
                const update: EntityRow = {};
                const fkValue = record[fieldName];
                if (Array.isArray(fkValue)) {
                  update[fieldName] = fkValue.filter((id) => id !== deletedId);
                } else {
                  update[fieldName] = null;
                }
                await this.persistence.update(referringEntityType, recordId, update);
              }
            }
            if (this.config.debug) {
              persistLog.debug('nullify', {
                field: field.name,
                count: affectedRecords.length,
                entityType: referringEntityType,
              });
            }
            break;
        }
      }
    }
  }

  private async populateRelations(
    entities: EntityRow[],
    entityType: string,
    include: string[],
    depth: number = 0,
    visited: Set<string> = new Set(),
  ): Promise<void> {
    // Circular reference protection: stop if depth exceeded or entity type already visited
    const maxDepth = 2;
    if (depth >= maxDepth || visited.has(entityType)) {
      if (this.config.debug) {
        persistLog.debug('populate:skip', {
          entityType,
          depth,
          visited: visited.has(entityType),
        });
      }
      return;
    }
    visited.add(entityType);
    // Find the orbital that owns this entity type
    let entityFields: Array<{ name: string; type: string; relation?: { entity?: string; entityId?: EntityId; cardinality?: string; onDelete?: string } }> | undefined;

    for (const [, registered] of this.orbitals) {
      if (registered.entity.name === entityType) {
        // EntityField.name is optional in @almadar/core 7+ to match the
        // Rust IR (FieldDefinition.name: Option<String>). For relation
        // population we only care about named top-level fields; nameless
        // nested item descriptors don't carry FK metadata.
        entityFields = registered.entity.fields.filter(
          (f): f is typeof f & { name: string } =>
            typeof f.name === 'string' && f.name.length > 0,
        );
        break;
      }
    }

    if (!entityFields) {
      if (this.config.debug) {
        persistLog.warn('populate:no-entity-def', { entityType });
      }
      return;
    }

    // Process each include field
    for (const includeField of include) {
      // Find the relation field (check both "fieldName" and "fieldNameId" patterns)
      const relationField = entityFields.find(f => {
        if (f.type !== 'relation') return false;
        // Match "company" against "company" or "companyId"
        return f.name === includeField ||
               f.name === `${includeField}Id` ||
               f.name.replace(/Id$/, '') === includeField;
      });

      if (!relationField?.relation?.entity) {
        if (this.config.debug) {
          persistLog.warn('populate:no-relation-field', { includeField, entityType });
        }
        continue;
      }

      const foreignKeyField = relationField.name;
      // Id-primary: prefer `relation.entityId` resolved against the
      // registered orbitals' entity ids, falling back to the `entity` name
      // string when the id is absent or unindexed (transition-period
      // tolerance) — never throw on an unindexed id.
      let relatedEntityType = relationField.relation.entity;
      if (relationField.relation.entityId) {
        for (const registered of this.orbitals.values()) {
          if (registered.entity.id === relationField.relation.entityId) {
            relatedEntityType = registered.entity.name;
            break;
          }
        }
      }
      const cardinality = relationField.relation.cardinality || 'one';

      // Collect all foreign key IDs to batch fetch
      // Handles both single ID (string) and array of IDs (string[]) for many cardinalities
      const foreignKeyIds = new Set<string>();
      for (const entity of entities) {
        const fkValue = entity[foreignKeyField];
        if (fkValue && typeof fkValue === 'string') {
          foreignKeyIds.add(fkValue);
        } else if (Array.isArray(fkValue)) {
          for (const id of fkValue) {
            if (id && typeof id === 'string') {
              foreignKeyIds.add(id);
            }
          }
        }
      }

      if (foreignKeyIds.size === 0) continue;

      // Batch fetch all related entities
      const relatedEntities = new Map<string, EntityRow>();
      for (const fkId of foreignKeyIds) {
        try {
          const related = await this.persistence.getById(relatedEntityType, fkId);
          if (related) {
            relatedEntities.set(fkId, related);
          }
        } catch (error) {
          if (this.config.debug) {
            persistLog.error('populate:fetch-related-error', {
              entityType: relatedEntityType,
              error: error instanceof Error ? error : String(error),
            });
          }
        }
      }

      // Attach related entities to parent entities
      // Use the base name without "Id" suffix for the populated field
      const populatedFieldName = includeField.endsWith('Id')
        ? includeField.slice(0, -2)
        : includeField;

      // Self-referential relations (target entity === source entity, e.g.
      // ThreadPost.replies : [ThreadPost]) would otherwise attach LIVE store
      // rows that also appear in `entities` and get hydrated themselves —
      // producing mutual object references (A.replies→B, B.replies→A) that make
      // `res.json()` throw "Converting circular structure to JSON" → 500. Attach
      // a shallow clone instead, and for the self-referential case neutralize the
      // child's own back-pointer field so hydrated children are leaves (one level
      // of hydration, no cycle).
      const isSelfRef = relatedEntityType === entityType;
      const hydrateClone = (id: string): EntityRow | undefined => {
        const related = relatedEntities.get(id);
        if (!related) return undefined;
        const copy: EntityRow = { ...related };
        if (isSelfRef) copy[foreignKeyField] = [];
        return copy;
      };

      for (const entity of entities) {
        const fkValue = entity[foreignKeyField];
        // Population attaches related EntityRow objects to the entity at runtime.
        // This mutates beyond the EntityRow type, so we use Object.defineProperty.
        if (cardinality === 'one' || cardinality === 'many-to-one') {
          if (typeof fkValue === 'string' && relatedEntities.has(fkValue)) {
            Object.defineProperty(entity, populatedFieldName, {
              value: hydrateClone(fkValue),
              writable: true, enumerable: true, configurable: true,
            });
          }
        } else {
          if (Array.isArray(fkValue)) {
            const fkIds = (fkValue as string[]).filter((id): id is string => typeof id === 'string');
            Object.defineProperty(entity, populatedFieldName, {
              value: fkIds.map(hydrateClone).filter(Boolean),
              writable: true, enumerable: true, configurable: true,
            });
          } else if (typeof fkValue === 'string' && relatedEntities.has(fkValue)) {
            Object.defineProperty(entity, populatedFieldName, {
              value: [hydrateClone(fkValue)],
              writable: true, enumerable: true, configurable: true,
            });
          }
        }
      }

      if (this.config.debug) {
        persistLog.debug('populate:done', {
          field: populatedFieldName,
          count: entities.length,
          entityType,
        });
      }
    }
  }

  // ==========================================================================
  // Express Router
  // ==========================================================================

  /**
   * Create Express router for orbital API endpoints
   *
   * All data access goes through trait events with guards.
   * No direct CRUD routes - use events with `fetch` effects.
   *
   * Routes:
   * - GET  /              - List registered orbitals
   * - GET  /:orbital      - Get orbital info and current states
   * - GET  /:orbital/entities/:entityType - Full mock-store row set (verification/tooling only)
   * - POST /:orbital/events - Send event to orbital (includes data from `fetch` effects)
   */
  router(): ExpressRouter {
    if (!isNodeEnv()) {
      throw new Error(
        "OrbitalServerRuntime.router() is Node-only (uses Express). " +
        "For in-browser use, mount <BrowserPlayground> from @almadar/ui instead.",
      );
    }
    // Eval-require so the dist bundle has no static `import 'express'`
    // — browsers (which never reach this branch anyway) get a clean
    // bundle with zero express references.
    const { Router } = nodeRequire<typeof import('express')>('express');
    const router = Router();

    // List orbitals
    router.get("/", (_req: Request, res: Response) => {
      const orbitals = Array.from(this.orbitals.entries()).map(
        ([name, reg]) => ({
          name,
          entity: reg.entity?.name,
          traits: (reg.traits || []).map((t) => t.name),
        }),
      );
      res.json({ success: true, orbitals });
    });

    // Get orbital info
    router.get("/:orbital", async (req: Request, res: Response, next: NextFunction) => {
      try {
      const orbitalName = req.params.orbital as string;
      // Await an in-flight swap before the 404 (G-RUNTIME-038) — a state
      // fetch racing a select/reload must not error against the emptied map.
      const registered = await this.resolveRegisteredOrbital(orbitalName);
      if (!registered) {
        res.status(404).json({ success: false, error: "Orbital not found" });
        return;
      }

      const states: Record<string, string> = {};
      for (const [name, state] of registered.manager.getAllStates()) {
        states[name] = state.currentState;
      }

      res.json({
        success: true,
        orbital: {
          name: orbitalName,
          entity: registered.entity,
          traits: registered.traits.map((t) => ({
            name: t.name,
            currentState: states[t.name],
            states: (t.stateMachine?.states || []).map((s) => s.name),
            events: [...new Set((t.stateMachine?.transitions || []).map((tr) => tr.event))],
          })),
        },
      });
      } catch (error) {
        next(error);
      }
    });

    // Get an entity's FULL mock-store row set (verification/tooling only —
    // read-only, bypasses guards). App CRUD still goes exclusively through
    // `/:orbital/events`; this exists because a verifier reasoning from the
    // BROWSER's rendered snapshot sees only a filtered/paged SUBSET of this
    // same store (a trait's fetched `data`) and can pick a row a hidden
    // sibling references, which the runtime's own `onDelete: restrict` then
    // rejects — see `@almadar-io/verify`'s `driver/tick.ts` `listEntityRows`.
    router.get("/:orbital/entities/:entityType", (req: Request, res: Response, next: NextFunction) => {
      const orbitalName = req.params.orbital as string;
      const entityType = req.params.entityType as string;
      // Same mid-swap await as GET /:orbital (G-RUNTIME-038).
      this.resolveRegisteredOrbital(orbitalName)
        .then((registered) => {
          if (!registered) {
            res.status(404).json({ success: false, error: "Orbital not found" });
            return;
          }
          return this.persistence.list(entityType).then((rows) => {
            res.json({ success: true, entityType, rows });
          });
        })
        .catch(next);
    });

    // Send event to orbital - this is the ONLY data access point
    // All reads go through `fetch` effects with guard enforcement
    // All writes go through `persist` effects with guard enforcement
    router.post(
      "/:orbital/events",
      async (req: Request, res: Response, next: NextFunction) => {
        const wantsStream =
          req.query['stream'] === 'true' ||
          (req.headers['accept'] ?? '').includes('text/event-stream');

        if (!wantsStream) {
          try {
            const orbitalName = req.params.orbital as string;
            const firebaseUser = (req as Request & { firebaseUser?: OrbitalEventRequest["user"] }).firebaseUser;
            const user = firebaseUser ? {
              ...firebaseUser,
              displayName: (firebaseUser.name as string | undefined) ?? firebaseUser.displayName,
            } : undefined;
            const result = await this.processOrbitalEvent(orbitalName, { ...req.body, user });
            res.json(result);
          } catch (error) {
            next(error);
          }
          return;
        }

        // SSE streaming path — true incremental: each emitted event or client
        // effect is written to the stream immediately via onPush as it fires,
        // before processOrbitalEvent resolves. Dynamic import keeps
        // @almadar/server (ESM, Node-only) out of browser bundles.
        const { setupSSE, sendSSEEvent, sendSSEDone, closeSSE } =
          (await import('@almadar/server')) as {
            setupSSE: (res: import('http').ServerResponse) => void;
            sendSSEEvent: (res: import('http').ServerResponse, ev: SSEEvent) => void;
            sendSSEDone: (res: import('http').ServerResponse) => void;
            closeSSE: (res: import('http').ServerResponse) => void;
          };
        setupSSE(res);
        try {
          const orbitalName = req.params.orbital as string;
          const firebaseUser = (req as Request & { firebaseUser?: OrbitalEventRequest["user"] }).firebaseUser;
          const user = firebaseUser ? {
            ...firebaseUser,
            displayName: (firebaseUser.name as string | undefined) ?? firebaseUser.displayName,
          } : undefined;

          const result = await this.processOrbitalEvent(orbitalName, { ...req.body, user }, (item) => {
            sendSSEEvent(res, { type: item.type, data: item.data, timestamp: Date.now() });
          });

          sendSSEEvent(res, { type: 'complete', data: result, timestamp: Date.now() });
          sendSSEDone(res);
          closeSSE(res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendSSEEvent(res, { type: 'error', data: { message }, timestamp: Date.now() });
          sendSSEDone(res);
          closeSSE(res);
        }
      },
    );

    // No direct CRUD routes - all data access goes through events
    // This ensures guards are always evaluated for both reads and writes

    return router;
  }

  // ==========================================================================
  // Direct API (for programmatic use)
  // ==========================================================================

  /**
   * Get the event bus for manual event emission
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get state for a specific orbital/trait
   */
  getState(
    orbitalName: string,
    traitName?: string,
  ): TraitState | Record<string, TraitState> | undefined {
    const registered = this.orbitals.get(orbitalName);
    if (!registered) return undefined;

    if (traitName) {
      return registered.manager.getState(traitName);
    }

    // Return all states for the orbital
    const states: Record<string, TraitState> = {};
    for (const [name, state] of registered.manager.getAllStates()) {
      states[name] = state;
    }
    return states;
  }

  /**
   * List registered orbitals
   */
  listOrbitals(): string[] {
    return Array.from(this.orbitals.keys());
  }

  /**
   * Check if an orbital is registered
   */
  hasOrbital(name: string): boolean {
    return this.orbitals.has(name);
  }

  /**
   * Get information about active ticks
   */
  getActiveTicks(): Array<{
    orbital: string;
    trait: string;
    tick: string;
    interval: number | string;
    hasGuard: boolean;
  }> {
    return this.tickBindings.map((binding) => ({
      orbital: binding.orbitalName,
      trait: binding.traitName,
      tick: binding.tick.name,
      interval: binding.tick.interval,
      hasGuard: !!binding.tick.guard,
    }));
  }

  /** Halt every registered tick's shared clock. Delegates to `TickScheduler.pause`. */
  pauseTicks(): void {
    this.tickScheduler.pause();
  }

  /** Resume ticks halted by `pauseTicks()`. Delegates to `TickScheduler.resume`. */
  resumeTicks(): void {
    this.tickScheduler.resume();
  }

  /** True while ticks are paused. Delegates to `TickScheduler.isPaused`. */
  areTicksPaused(): boolean {
    return this.tickScheduler.isPaused;
  }
}

/**
 * Factory function to create a runtime instance
 */
export function createOrbitalServerRuntime(
  config?: OrbitalServerRuntimeConfig,
): OrbitalServerRuntime {
  return new OrbitalServerRuntime(config);
}

// ============================================================================
// Source-scoped listen support
// ============================================================================
//
// `parseListenSource` moved to `../events/identity/routing.js` (2026-09-18) so the
// stateless `@almadar-io/playground-runtime` path can reuse the exact same
// `listens {}` matching predicate for its own cross-orbital cascade instead
// of a second, divergent copy — see that module's doc comment.

/** Fold one cross-orbital relay hop's results into the requesting response. */
function foldRelayHop(into: OrbitalEventResponse, hop: OrbitalEventResponse): void {
  if (hop.clientEffects !== undefined && hop.clientEffects.length > 0) {
    into.clientEffects = [...(into.clientEffects ?? []), ...hop.clientEffects];
  }
  if (hop.clientEffectsByTrait !== undefined && hop.clientEffectsByTrait.length > 0) {
    into.clientEffectsByTrait = [...(into.clientEffectsByTrait ?? []), ...hop.clientEffectsByTrait];
  }
  if (hop.entityByTrait !== undefined) {
    into.entityByTrait = { ...(into.entityByTrait ?? {}), ...hop.entityByTrait };
  }
  into.states = { ...into.states, ...hop.states };
}
