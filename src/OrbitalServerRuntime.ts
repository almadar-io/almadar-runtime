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
  Response,
  NextFunction,
} from "express";
import { EventBus } from "./EventBus.js";
import { eventRouteKey, buildSourceMatcher, type ListenSourceDescriptor as IdListenSourceDescriptor } from "./identity/routing.js";
import { createTickScheduler, type TickHandle, type TickScheduler } from "./TickScheduler.js";
import { isValidCronExpression } from "./cron.js";
import { parseDurationString } from "./duration.js";
import {
  StateMachineManager,
  processEvent,
  createInitialTraitState,
} from "./StateMachineCore.js";
import { EffectExecutor } from "./EffectExecutor.js";
import { createLogger } from '@almadar/logger';
// Same treatment for `createOsHandlers` (uses `fs`, `net`, `child_process`).
// The runtime auto-wires it in the constructor's Node-only branch — guarded
// by `isNodeEnv()` — and the eval-require keeps the import out of the
// browser bundle entirely.
import type {
  createOsHandlers as CreateOsHandlersFn,
  OsHandlerResult,
} from "./createOsHandlers.js";
import type {
  createAgentSubstrateHandlers as CreateAgentSubstrateHandlersFn,
  AgentSubstrateHandlerResult,
  SubstrateServices,
} from "./createAgentSubstrateHandlers.js";
import {
  validateEventPayload,
  formatPayloadValidationError,
  type PayloadValidationFailure,
} from "./PayloadValidator.js";

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
function nodeRequire<T = unknown>(modulePath: string): T {
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
const dynamicLog = createLogger("almadar:runtime:dynamic");
import type { SSEEvent } from '@almadar/server';
import {
  interpolateProps,
  createContextFromBindings,
  resolveCallSitePayloadCaptures,
} from "./BindingResolver.js";
import { evaluate, evaluateGuard } from "@almadar/evaluator";
import type {
  TraitDefinition,
  TraitState,
  EffectHandlers,
  BindingContext,
  EffectContext,
  Effect,
  EntityRow,
  EventPayload,
  EvaluationContextExtensions,
  RuntimeRenderPattern,
} from "./types.js";
import { collectDeclaredConfigDefaults, collectDeclaredEntityDefaults, normalizeCallSiteConfigToValues } from "./config-defaults.js";
// Backward-compat: `collectDeclaredConfigDefaults` used to live here. The package
// index now re-exports it from the browser-safe `./config-defaults.js` (so it
// doesn't drag this node-only module into a browser bundle), but keep the
// original export site for existing importers (tests, server consumers).
export { collectDeclaredConfigDefaults };
import type {
  FieldValue,
  OrbitalSchema,
  OrbitalDefinition,
  Entity,
  EntityField,
  EntityId,
  Trait,
  TraitTick,
  TraitConfig,
  TraitConfigValue,
  BusEventSource,
  PatternConfig,
  ResolvedPatternProps,
  SExpr,
  EventId,
} from "@almadar/core";

/**
 * Client-side effect tuple shipped in `OrbitalEventResponse.clientEffects`.
 * Restricted to the three effect kinds the client knows how to apply to the
 * UI: render-ui (slot mutation), navigate (route change), notify (toast).
 * Server-only effects (persist, set, fetch, ...) execute on the server and
 * surface their results via `effectResults` and `emittedEvents`, not here.
 *
 * Shape note: the wire form is broader than `RenderUIEffect` /
 * `NavigateEffect` / `NotifyEffect` from `@almadar/core/types/effect.ts` in
 * two places — the runtime appends an interpolated `props` object plus an
 * optional `priority` slot to render-ui (slot 4 + 5), and `navigate` /
 * `notify` may surface their optional argument as `undefined` rather than
 * absent. The local union spells those variants out explicitly so consumers
 * (ServerBridge.tsx parser, debugger inspector) get accurate completions
 * instead of `unknown[]`.
 *
 * `slot` is a plain `string` in this wire shape (not `UISlot`'s literal
 * union) because the runtime forwards the raw string from the trait's
 * `(render-ui slot ...)` SExpr without re-validating against the registry —
 * registry validation lives in `orbital validate` / `lolo` parse, not here.
 */
export type ClientRenderUITuple =
  | ['render-ui', string, PatternConfig | null]
  | ['render-ui', string, PatternConfig | null, ResolvedPatternProps]
  | ['render-ui', string, PatternConfig | null, ResolvedPatternProps | undefined, number | undefined];

export type ClientNavigateTuple =
  | ['navigate', string]
  | ['navigate', string, Record<string, string> | undefined];

export type ClientNotifyTuple =
  | ['notify', string, string | SExpr | undefined]
  | ['notify', string, string | SExpr | undefined, { type?: string }];

export type ClientEffectTuple =
  | ClientRenderUITuple
  | ClientNavigateTuple
  | ClientNotifyTuple;
import { isInlineTrait, isEntityCall, buildResolvedTraitConfigs, applyListenPayloadMapping } from "@almadar/core";
import { MockPersistenceAdapter } from "./MockPersistenceAdapter.js";
import {
  preprocessSchema,
  type PreprocessedSchema,
  type EntitySharingMap,
  type EventNamespaceMap,
} from "./UsesIntegration.js";
import {
  type SchemaLoader,
  createUnifiedLoader,
} from "./loader/index.js";
// `createOsHandlers` is type-imported at the top of this file and value-
// loaded via `nodeRequire` inside the constructor's Node-only branch.
// Removed the value-import here so the dist bundle has no static
// reference to `./createOsHandlers.js` and its fs/net/child_process
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
  entityData: Map<string, EntityRow>; // entityId -> data
  /**
   * Per-trait scalar state set by `(set @entity.X Y)`. Mirrors compiled's
   * `state.fields`. The trait's `@entity` binding is a three-layer merge:
   * declared entity field defaults < persistence entityData < this map.
   * Mutated only by the `set` effect handler.
   */
  traitFieldStates: Map<string, EntityRow>;
}

/**
 * Event sent from client to server
 */
export interface OrbitalEventRequest {
  event: string;
  /**
   * V4 dual-carry id sibling of `event` — the fired event's id, when known
   * (e.g. threaded from a `listens[].triggersId`). Optional; absent means
   * the state machine dispatches by name only (legacy).
   */
  eventId?: EventId;
  payload?: EventPayload;
  entityId?: string;
  /**
   * Scoped-listen delivery: dispatch to THIS trait only. A listens-matched
   * trigger is addressed to the listening trait; without this, a trigger
   * renamed to INIT broadcast orbital-wide and re-ran every trait's
   * initializer (R-SCOPED-LISTEN-INIT-RENAME-FREEZE re-fire cascade).
   */
  targetTrait?: string;
  /** User context for @user bindings (from Firebase auth) */
  user?: {
    uid: string;
    email?: string;
    displayName?: string;
    [key: string]: unknown;
  };
  /** Per-tab client identity (UUID) — excludes this request's origin from live-broadcast delivery. */
  clientId?: string;
}

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

/**
 * Response from event processing
 */
export interface OrbitalEventResponse {
  success: boolean;
  transitioned: boolean;
  states: Record<string, string>;
  /**
   * Events emitted during processing, in declaration order. Payloads are
   * typed against `@almadar/core`'s `EventPayload` — the recursive record of
   * primitive + nested EventPayload values the state machine already uses
   * internally. Kept as the single source of truth for emit-payload shape.
   *
   * Each entry carries a `source: BusEventSource` so the client-side
   * ServerBridge can re-broadcast on the qualified `UI:Orbital.Trait.EVENT`
   * bus key. Without source the re-broadcast skips the entry and downstream
   * listeners (e.g. ContactBrowse waiting for ContactLoaded after a fetch)
   * never fire — the dashboard-layout that ContactLoaded renders disappears.
   */
  emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }>;
  /** Client-side effects to execute (render-ui, navigate, notify) */
  clientEffects?: ClientEffectTuple[];
  /**
   * Same effects as `clientEffects`, paired with the producing trait name.
   * Consumers that need per-trait attribution (e.g. `<TraitFrame>` resolving
   * `@trait.X` bindings) read from this field; legacy consumers ignore it
   * and continue with the flat `clientEffects` array unchanged.
   *
   * Same length and ordering as `clientEffects`; entries are 1:1 by index.
   */
  clientEffectsByTrait?: Array<{ traitName: string; effect: ClientEffectTuple }>;
  /** Results from server-side effects (persist, call-service, set) */
  effectResults?: EffectResult[];
  error?: string;
}

/**
 * Result of a server-side effect execution.
 * Closes the circuit by returning effect outcomes to the client.
 */
export interface EffectResult {
  /** Effect type that was executed */
  effect: 'persist' | 'call-service' | 'set' | 'ref' | 'deref' | 'swap' | 'atomic';
  /** Action performed (e.g., 'create', 'update', 'delete' for persist) */
  action?: string;
  /** Entity type affected (for persist/set/ref/deref/swap) */
  entityType?: string;
  /** Result data from the effect (entity row for CRUD, summary for batch) */
  data?: EntityRow | { operations: EntityRow[]; completedCount: number; totalCount: number };
  /** Whether the effect succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

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
}

/**
 * Adapter for persisting entity data
 */
// `PersistenceAdapter` + `InMemoryPersistence` live in their own browser-safe
// module so the in-browser mock runtime can reuse the same storage contract
// without pulling in this server-only module's express dependency. Re-exported
// here so existing `import { PersistenceAdapter } from './OrbitalServerRuntime'`
// call sites keep working.
export type { PersistenceAdapter } from "./PersistenceAdapter.js";
export { InMemoryPersistence } from "./PersistenceAdapter.js";
import type { PersistenceAdapter } from "./PersistenceAdapter.js";
import { InMemoryPersistence } from "./PersistenceAdapter.js";

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
    const uses = (orbital as { uses?: unknown[] }).uses;
    if (Array.isArray(uses) && uses.length > 0) {
      return true;
    }
    const traits = (orbital as { traits?: unknown[] }).traits ?? [];
    for (const t of traits) {
      if (!t || typeof t !== 'object') continue;
      const obj = t as { ref?: unknown; stateMachine?: unknown };
      if (
        typeof obj.ref === 'string' &&
        obj.ref.includes('.') &&
        !obj.stateMachine
      ) {
        return true;
      }
    }
  }
  return false;
}

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
  private persistence: PersistenceAdapter;
  private listenerCleanups: Array<() => void> = [];
  private tickBindings: TickBinding[] = [];
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
  /** Wired by the hosting server (e.g. the playground SSE endpoint) via `setLiveBroadcastSink`. */
  private liveBroadcastSink: ((item: LiveBroadcastItem) => void) | null = null;
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

  constructor(config: OrbitalServerRuntimeConfig = {}) {
    this.config = {
      mode: 'mock', // Default to mock mode for preview
      autoPreprocess: false,
      namespaceEvents: true,
      ...config,
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
      });
      if (config.debug) {
        persistLog.debug('mock:init', { adapter: 'MockPersistenceAdapter' });
      }
    } else {
      this.persistence = config.persistence || new InMemoryPersistence();
    }

    // OS handlers (fs/net/child_process effects) are wired lazily on the first
    // event via ensureOsHandlers(). They live in the ESM-only
    // `./createOsHandlers.js`; the package is `type: module`, so a synchronous
    // require() of it throws ERR_REQUIRE_ESM in a Node consumer. A dynamic
    // import() loads it cleanly AND keeps it out of the browser graph
    // (isNodeEnv-guarded, lazy chunk) — same goal as the old eval-require, but
    // without the CJS hazard. Default to empty handlers until then.
    this.osHandlers = { handlers: {}, cleanup: () => {} };
  }

  /**
   * Lazily wire the OS-level effect handlers (fs/net/child_process), merging
   * them UNDER any user-provided handlers. Deferred out of the constructor
   * because `./createOsHandlers.js` is ESM and `require()`-ing it from a
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
        const { createOsHandlers } = (await import('./createOsHandlers.js')) as {
          createOsHandlers: typeof CreateOsHandlersFn;
        };
        this.osHandlers = createOsHandlers({
          emitEvent: (type, payload) => this.eventBus.emit(type, payload),
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
        const { createAgentSubstrateHandlers } = (await import('./createAgentSubstrateHandlers.js')) as {
          createAgentSubstrateHandlers: typeof CreateAgentSubstrateHandlersFn;
        };
        this.substrateHandlers = createAgentSubstrateHandlers({
          emitEvent: (type, payload) => this.eventBus.emit(type, payload),
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
  async register(schema: OrbitalSchema): Promise<void> {
    if (this.config.debug) {
      registerLog.debug('register:schema', { name: schema.name });
    }

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

    // Register all orbitals (await to ensure instance seeding completes)
    for (const orbital of schema.orbitals) {
      await this.registerOrbitalAsync(orbital);
    }

    // Set up cross-orbital event listeners
    this.setupEventListeners();

    // Set up scheduled ticks
    this.setupTicks();

    // Stash the post-preprocessing schema so HTTP layers (e.g. a playground
    // server's /api/schema handler) can serve the fully-resolved copy instead
    // of re-reading the raw .orb from disk. See getResolvedSchema().
    this.resolvedSchema = schema;
    this.resolvedTraitConfigs = buildResolvedTraitConfigs(schema);
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

    for (const orbital of schema.orbitals) {
      this.registerOrbital(orbital);
    }

    // Set up cross-orbital event listeners
    this.setupEventListeners();

    // Set up scheduled ticks
    this.setupTicks();

    this.resolvedSchema = schema;
    this.resolvedTraitConfigs = buildResolvedTraitConfigs(schema);
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
    // Unwrap preprocessed ref-traits: `preprocessSchema` keeps entries with
    // `config` or `linkedEntity` wrapped as `{ ref, linkedEntity, _resolved }`
    // (see UsesIntegration.ts:209-222) — the `_resolved` field carries the
    // fully inlined trait. `isInlineTrait` excludes anything with a `ref`
    // key, so without this unwrap every preprocessed atom would be dropped
    // and only the layout-owner survives (see Almadar_Std_Gaps.md §3.1b).
    // Unwrap preprocessed ref-traits while capturing their call-site `config`
    // for later binding-context injection. The wrapper has shape
    // `{ ref, name?, config?, linkedEntity?, _resolved: Trait }`; we keep the
    // config keyed by the resolved trait name so effects can read `@config.X`.
    const configByTrait = new Map<string, TraitConfig>();
    const unwrapped = (orbital.traits || []).map((t) => {
      if (t && typeof t === 'object' && 'ref' in t && '_resolved' in t) {
        const wrapper = t as {
          _resolved: Trait;
          config?: TraitConfig;
        };
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
    const traitDefs: TraitDefinition[] = inlineTraits.map((t: Trait) => {
      const sm = t.stateMachine;
      const states = sm?.states || [];
      const transitions = sm?.transitions || [];

      return {
        // V4 dual-carry: thread the trait id so the manager's id index is
        // populated for ledger-backed schemas (undefined → name-keyed only).
        ...(t.id !== undefined ? { id: t.id } : {}),
        name: t.name,
        states: states as TraitDefinition['states'],
        transitions: transitions as TraitDefinition['transitions'],
        listens: t.listens,
      };
    });

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

    const entityRef = orbital.entity;
    let entity: Entity;
    if (typeof entityRef === 'string') {
      entity = { name: entityRef, fields: [] };  // Fallback for string refs
    } else if (isEntityCall(entityRef)) {
      // EntityCall (Phase F): synthesize Entity placeholder from the call shape.
      // The compiler's inline phase produces a fully resolved Entity in OIR;
      // this branch is the runtime fallback when an unresolved EntityCall reaches us.
      const fallbackName = entityRef.name ?? entityRef.extends.replace(/\.entity$/, '');
      entity = {
        name: fallbackName,
        fields: entityRef.fields ?? [],
        ...(entityRef.persistence ? { persistence: entityRef.persistence } : {}),
        ...(entityRef.collection ? { collection: entityRef.collection } : {}),
      };
    } else {
      entity = entityRef;
    }

    this.orbitals.set(orbital.name, {
      schema: orbital,
      entity,
      traits: inlineTraits,
      configByTrait,
      manager,
      entityData: new Map(),
      traitFieldStates: new Map(),
    });

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
        this.persistence.registerEntity({ name: entity.name, id: entity.id, fields });
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
        this.persistence.registerEntity({ name: auxEntity.name, id: auxEntity.id, fields: auxFields });
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
   * Set up event listeners for cross-orbital communication
   */
  private setupEventListeners(): void {
    // Clean up existing listeners
    for (const cleanup of this.listenerCleanups) {
      cleanup();
    }
    this.listenerCleanups = [];

    // For each orbital's traits with `listens`
    for (const [orbitalName, registered] of this.orbitals) {
      for (const trait of registered.traits) {
        if (!trait.listens) continue;

        for (const listener of trait.listens) {
          // Split `listener.event` into { bareEvent, source }.
          // The .lolo parser encodes `Source EVENT`, `Orbital.Source EVENT`,
          // or `* EVENT` as `"Source.EVENT"`, `"Orbital.Source.EVENT"`,
          // `"*.EVENT"` respectively. If the explicit `listener.source` field
          // is present (new core schema), use it directly; otherwise parse the
          // legacy concatenated form so migrated and unmigrated schemas both work.
          const { bareEvent, matcher } = parseListenSource(listener, orbitalName);

          // V4 identity routing: subscribe under the event-id key when the
          // listen carries an `eventId` (rename-proof), else under the bare
          // event name (legacy). Source filtering happens inside the handler
          // closure so a single key can serve many listeners with different
          // scopes.
          const routeKey = eventRouteKey(bareEvent, listener.eventId);
          const cleanup = this.eventBus.on(routeKey, async (event) => {
            // Source filter: skip if the emit doesn't match our declared scope.
            if (!matcher(event.source)) return;
            if (this.config.debug) {
              xOrbitalLog.debug('listen:received', () => ({
                receiverOrbital: orbitalName,
                receiverTrait: trait.name,
                event: listener.event,
                sourceOrbital: event.source?.orbital ?? '?',
                sourceTrait: event.source?.trait ?? '?',
              }));
            }

            // Apply payload mapping (shared contract with the client wiring)
            const mappedPayload = applyListenPayloadMapping(
              listener.payloadMapping,
              event.payload as EventPayload | undefined,
            );

            // Forward entityId so the triggered trait can bind @entity.*
            // against the right row. Without this, cross-trait listens
            // auto-wiring would always dispatch with entityData={} and
            // every @entity.id would resolve to undefined.
            //
            // Priority (checked against the MAPPED payload first so the
            // schema's payloadMapping takes effect, then the raw emit
            // payload for listens without a mapping):
            //   1. mapped or raw payload.entityId
            //   2. mapped or raw payload.orbitalName (convention: the
            //      OrbitalProcess entity uses orbitalName as its id)
            const raw = event.payload as EventPayload | undefined;
            const mapped = mappedPayload as EventPayload | undefined;
            const pickId = (field: string): string | undefined =>
              (mapped?.[field] as string | undefined) ??
              (raw?.[field] as string | undefined);
            const forwardedEntityId = pickId("entityId") ?? pickId("orbitalName");

            // Trigger the mapped event. `triggersId` is the V4 dual-carry id
            // sibling of `triggers` — threading it lets the target
            // transition match by id even if its `event` name has since
            // diverged from `triggers` (mid-flight rename).
            await this.processOrbitalEvent(orbitalName, {
              event: listener.triggers,
              eventId: listener.triggersId,
              payload: mappedPayload as EventPayload,
              entityId: forwardedEntityId,
              targetTrait: trait.name,
            });
          });

          this.listenerCleanups.push(cleanup);
        }
      }
    }
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
    const entityType = registered.entity.name;
    const emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }> = [];

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
          const tickEffectResults: EffectResult[] = [];
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
          );

          if (this.config.debug) {
            effectLog.debug('tick:effects-executed', () => ({
              tick: tick.name,
              entityId: typeof entity.id === 'string' ? entity.id : undefined,
            }));
          }
        }
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
  unregisterAll(): void {
    // Clean up ticks
    this.cleanupTicks();

    // Clean up event listeners
    for (const cleanup of this.listenerCleanups) {
      cleanup();
    }
    this.listenerCleanups = [];

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
        this.persistence.registerEntity({ name: entity.name, id: entity.id, fields });
      }
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

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  /**
   * Process an event for an orbital
   *
   * @param onPush - Optional incremental-push callback. Called immediately
   * when an event is emitted or a client effect fires, before the promise
   * resolves. Used by the SSE streaming path to write items to the
   * response as they arrive rather than buffering and flushing at the end.
   */
  async processOrbitalEvent(
    orbitalName: string,
    request: OrbitalEventRequest,
    onPush?: (item: { type: 'event'; data: { event: string; payload?: EventPayload; source?: BusEventSource } } | { type: 'effect'; data: ClientEffectTuple }) => void,
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

    const registered = this.orbitals.get(orbitalName);
    if (!registered) {
      return {
        success: false,
        transitioned: false,
        states: {},
        emittedEvents: [],
        error: `Orbital not found: ${orbitalName}`,
      };
    }

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

    const { event, eventId, payload, entityId, user, clientId } = request;
    // Scoped-listen delivery: first-class request field, or the client
    // relay's `_targetTrait` payload sidecar (the `_activeTraits` pattern).
    const targetTrait =
      request.targetTrait ??
      ((payload as EventPayload | undefined)?.['_targetTrait'] as string | undefined);

    // API-boundary payload validation. Each trait declares a
    // `payloadSchema` per event in its `stateMachine.events` block
    // (lowered from the `.lolo` listens block). A field marked with
    // `!` (e.g. `data : ListItem!`) becomes `required: true`; this
    // check rejects the request when a required field is missing or
    // null. Without this, the persist effect happily writes empty
    // rows for `payload: {}` requests — exactly what produced the
    // junk-card artifact in the verifier's bus-replay coverage walk.
    // The compiled-path generated handler emits the equivalent
    // inline check (per-event required-field list inlined from
    // `OirEvent.payload_required_fields`) so guards behave
    // identically across paths.
    //
    // Use `registered.traits` (already-unwrapped `Trait[]`) instead
    // of `registered.schema.traits` (which holds the unprocessed
    // `TraitRef` wrappers with `_resolved` attached by
    // preprocessSchema). The unwrap was already done in
    // registerOrbitalAsync.
    const validationFailures: PayloadValidationFailure[] = [];
    for (const trait of registered.traits) {
      const eventSchema = trait.stateMachine?.events?.find((e) => e.key === event);
      if (eventSchema?.payloadSchema && eventSchema.payloadSchema.length > 0) {
        validationFailures.push(
          ...validateEventPayload(event, payload, eventSchema.payloadSchema),
        );
      }
    }
    if (validationFailures.length > 0) {
      return {
        success: false,
        transitioned: false,
        states: {},
        emittedEvents: [],
        error: formatPayloadValidationError(validationFailures),
      };
    }

    const emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }> = [];
    // Collect data fetched by `fetch` effects
    const fetchedData: { [entityType: string]: EntityRow | EntityRow[] } = {};
    // Collect client-side effects (render-ui, navigate, notify)
    const clientEffects: ClientEffectTuple[] = [];
    // Same effects, paired with their producing trait — populated in lockstep
    // by the helper inside executeEffects so consumers can attribute each
    // effect to the trait that emitted it (used by `<TraitFrame>`).
    const clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }> = [];
    // Collect server-side effect results (persist, call-service, set)
    const effectResults: EffectResult[] = [];

    // Extract active traits filter from payload (sent by client for page-specific execution)
    const activeTraits = (payload as EventPayload | undefined)?._activeTraits as string[] | undefined;
    // Remove _activeTraits from payload before processing (internal use only)
    const cleanPayload = payload ? { ...payload } : undefined;
    if (cleanPayload) {
      delete (cleanPayload as EventPayload & { _activeTraits?: unknown })._activeTraits;
      delete (cleanPayload as EventPayload & { _targetTrait?: unknown })._targetTrait;
    }

    // Get entity data if entityId provided
    let entityData: EntityRow = {};
    if (entityId) {
      const stored = await this.persistence.getById(
        registered.entity.name,
        entityId,
      );
      if (stored) {
        entityData = stored;
      }
    }

    // Build per-trait entity overrides from `traitFieldStates` (mutated by
    // `(set @entity.X Y)` effects). For [runtime] entities with no persistence
    // row, this is the only way `@entity.X` references in guards get resolved
    // to the values prior transitions committed — matches the runtime UI hook
    // behavior so guard outcomes are identical across both paths.
    const entityByTrait: Record<string, EntityRow> = {};
    for (const [name, fields] of registered.traitFieldStates) {
      if (fields && Object.keys(fields).length > 0) {
        entityByTrait[name] = fields;
      }
    }

    // Process event through state machine
    const results = registered.manager.sendEvent(
      event,
      cleanPayload,
      entityData,
      entityByTrait,
      eventId,
      targetTrait,
    );

    // Filter results to only active traits (if specified)
    const filteredResults = activeTraits && activeTraits.length > 0
      ? results.filter(({ traitName }) => activeTraits.includes(traitName))
      : results;

    if (this.config.debug && activeTraits) {
      busLog.debug('dispatch:filter-traits', () => ({
        total: results.length,
        active: filteredResults.length,
        activeTraits: activeTraits.join(','),
      }));
    }

    // Execute effects only for active traits
    for (const { traitName, result } of filteredResults) {
      if (result.effects.length > 0) {
        await this.executeEffects(
          registered,
          traitName,
          result.effects as Effect[],
          cleanPayload,
          entityData,
          entityId,
          emittedEvents,
          fetchedData,
          clientEffects,
          effectResults,
          user,
          clientEffectsByTrait,
          onPush,
          clientId,
        );
      }
    }

    // V2 Phase 6: auto-refetch on ref-subscribed entities is gone. The
    // `ref` operator is deprecated; entities flow through explicit fetch+emit
    // listeners now. Downstream re-reads are triggered by the listener wiring
    // in the state machine (listen on the LOADED emit), not by the server
    // re-fetching after every mutation.

    // NOTE (VG31-duplicate, 4.10.0): the server-side re-emit that used to
    // live here fanned SAVE/CONFIRM_REMOVE onto the server bus so
    // `setupListeners()` could dispatch cascade triggers (DO_CREATE,
    // DO_DELETE). That was RIGHT when the runtime was server-only, but the
    // runtime playground now has matching cross-trait listens wiring on
    // the CLIENT (@almadar/ui 3.7.0+ useTraitStateMachine). With both
    // sides listening, every SAVE fired DO_CREATE twice — once from the
    // client's re-broadcast → onEventProcessed → server persist, and once
    // from the server's own bus listener → server persist. Two "Mock
    // name" rows appeared per click instead of one. Leaving the re-emit
    // out here is safe: the client posts DO_CREATE/DO_DELETE to the
    // server directly via bridge.sendEvent, and the server processes
    // those directly — the server-side listens fan-out is redundant in
    // the playground topology.

    // Build current states
    const states: Record<string, string> = {};
    for (const [name, state] of registered.manager.getAllStates()) {
      states[name] = state.currentState;
    }

    const response: OrbitalEventResponse = {
      success: true,
      transitioned: results.length > 0,
      states,
      emittedEvents,
    };

    // V2 Phase 6: `response.data` is gone. Fetched entities are surfaced via
    // typed emit payloads on `emittedEvents` and through the rendered effect
    // tree instead of a sidecar record bag.

    // Include client effects if any
    if (clientEffects.length > 0) {
      response.clientEffects = clientEffects;
    }

    // Per-trait attribution sidecar — same effects as `clientEffects`, paired
    // 1:1 with the trait that produced each one.
    if (clientEffectsByTrait.length > 0) {
      response.clientEffectsByTrait = clientEffectsByTrait;
    }

    // Include server effect results if any
    if (effectResults.length > 0) {
      response.effectResults = effectResults;
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
   * Execute effects from a transition
   */
  private async executeEffects(
    registered: RegisteredOrbital,
    traitName: string,
    effects: Effect[],
    payload: EventPayload | undefined,
    entityData: EntityRow,
    entityId: string | undefined,
    emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }>,
    fetchedData: { [entityType: string]: EntityRow | EntityRow[] },
    clientEffects: ClientEffectTuple[],
    effectResults: EffectResult[],
    user?: OrbitalEventRequest["user"],
    clientEffectsByTrait?: Array<{ traitName: string; effect: ClientEffectTuple }>,
    onPush?: (item: { type: 'event'; data: { event: string; payload?: EventPayload; source?: BusEventSource } } | { type: 'effect'; data: ClientEffectTuple }) => void,
    /** Per-request originating client (from `OrbitalEventRequest.clientId`); absent for ticks. Carried through to persist-envelope broadcast items so the sink can exclude the origin. */
    originClientId?: string,
  ): Promise<void> {
    const entityType = registered.entity.name;

    // Push to both the flat `clientEffects` array (legacy wire shape) and the
    // tagged `clientEffectsByTrait` sidecar in lockstep. Closure captures
    // `traitName` from this invocation's scope, so cascade emits — which run
    // through their own executeEffects call with their own traitName —
    // attribute correctly.
    const pushClientEffect = (effect: ClientEffectTuple): void => {
      clientEffects.push(effect);
      clientEffectsByTrait?.push({ traitName, effect });
      onPush?.({ type: 'effect', data: effect });
    };

    // Forward refs - assigned after construction, used by fetch/atomic handlers
    let bindingsRef: BindingContext | null = null;
    let contextRef: EffectContext | null = null;

    const handlers: EffectHandlers = {
      emit: (event, eventPayload, source, fromPersistSuccess) => {
        if (this.config.debug) {
          busLog.debug('emit:dispatch', () => ({
            event,
            payloadJson: JSON.stringify(eventPayload ?? null),
            sourceOrbital: source?.orbital,
            sourceTrait: source?.trait,
          }));
        }
        // Forward the source stamp to the bus. If the caller didn't supply
        // one (legacy callers), synthesize one from the handler's lexical
        // closure so source-scoped listeners still match.
        //
        // V4 identity: stamp the emitting orbital/trait/event IDS (when the
        // schema carries them) so id-scoped listeners match after a rename,
        // and route delivery under the event-id key. All three are optional
        // dual-carry — absent → name stamp + name routing (legacy).
        const emittingTrait = registered.traits.find((t) => t.name === traitName);
        const emitContract = emittingTrait?.emits?.find((e) => e.event === event);
        const stamp: BusEventSource = source ?? {
          orbital: registered.schema.name,
          trait: traitName,
        };
        if (stamp.orbitalId === undefined && registered.schema.id !== undefined) {
          stamp.orbitalId = registered.schema.id;
        }
        if (stamp.traitId === undefined && emittingTrait?.id !== undefined) {
          stamp.traitId = emittingTrait.id;
        }
        if (stamp.eventId === undefined && emitContract?.eventId !== undefined) {
          stamp.eventId = emitContract.eventId;
        }
        this.eventBus.emit(event, eventPayload, stamp, eventRouteKey(event, stamp.eventId));
        const emittedItem = { event, payload: eventPayload, source: stamp };
        emittedEvents.push(emittedItem);
        onPush?.({ type: 'event', data: emittedItem });
        effectLog.debug("emit:push", {
          event,
          cumulativeEmittedCount: emittedEvents.length,
          sourceTrait: stamp.trait,
          sourceOrbital: stamp.orbital,
        });
        xOrbitalLog.info('emit:server', {
          event,
          sourceOrbital: stamp.orbital,
          sourceTrait: stamp.trait,
          dispatchOrbital: registered.schema.name,
        });
        // Live-push (docs/Almadar_Live_Push.md): broadcast ONLY the
        // persist-envelope success emit, positionally signaled by
        // EffectExecutor's persist case — reuses the exact `stamp` object
        // already pushed to `emittedEvents` so the broadcast payload is
        // identical to the origin's response.
        if (fromPersistSuccess) {
          busLog.debug('live-broadcast:sink-call', {
            event,
            sourceOrbital: stamp.orbital,
            sourceTrait: stamp.trait,
            originClientId,
            sinkWired: this.liveBroadcastSink !== null,
          });
          this.liveBroadcastSink?.({ event, payload: eventPayload, source: stamp, originClientId });
        }
      },

      set: async (targetId, field, value) => {
        // `(set @entity.X Y)` writes to per-trait scalar state, not
        // persistence. Persistence writes only via explicit
        // `(persist update ...)`. Mirrors compiled's `state.fields` reducer.
        let fieldState = registered.traitFieldStates.get(traitName);
        if (!fieldState) {
          fieldState = {} as EntityRow;
          registered.traitFieldStates.set(traitName, fieldState);
        }
        fieldState[field] = value as FieldValue;
        effectResults.push({
          effect: 'set',
          entityType,
          data: { id: targetId || entityId || '', field, value: value as FieldValue },
          success: true,
        });
      },

      persist: async (action, targetEntityType, data) => {
        // ----------------------------------------------------------------
        // Batch mode: ["persist", "batch", [...operations]]
        // Each operation: ["create", "collection", {...data}],
        //                 ["update", "collection", "id", {...data}],
        //                 ["delete", "collection", "id"]
        // ----------------------------------------------------------------
        if (action === 'batch') {
          const operations = (data as EntityRow | undefined)?.operations as unknown[] | undefined;
          if (!Array.isArray(operations) || operations.length === 0) {
            effectResults.push({
              effect: 'persist',
              action: 'batch',
              success: false,
              error: 'Batch requires a non-empty operations array',
            });
            return;
          }

          const batchResults: Array<EntityRow> = [];
          // Track completed ops for rollback on failure (best-effort)
          const completed: Array<{ action: string; entityType: string; id?: string }> = [];
          let batchFailed = false;
          let batchError = '';

          for (const op of operations) {
            if (!Array.isArray(op) || op.length < 2) {
              batchFailed = true;
              batchError = `Invalid batch operation format: ${JSON.stringify(op)}`;
              break;
            }

            const [opAction, opEntityType, ...opRest] = op as [string, string, ...unknown[]];

            try {
              switch (opAction) {
                case 'create': {
                  const createData = (opRest[0] as EntityRow) || {};
                  const { id: newId } = await this.persistence.create(opEntityType, createData);
                  batchResults.push({ action: 'create', entityType: opEntityType, id: newId, ...createData });
                  completed.push({ action: 'create', entityType: opEntityType, id: newId });
                  break;
                }
                case 'update': {
                  const updateId = opRest[0] as string;
                  const updateData = (opRest[1] as EntityRow) || {};
                  await this.persistence.update(opEntityType, updateId, updateData);
                  const updated = await this.persistence.getById(opEntityType, updateId);
                  batchResults.push({ action: 'update', entityType: opEntityType, id: updateId, ...(updated || updateData) });
                  completed.push({ action: 'update', entityType: opEntityType, id: updateId });
                  break;
                }
                case 'delete': {
                  const deleteId = opRest[0] as string;
                  // Snapshot before delete for potential rollback info
                  await this.persistence.delete(opEntityType, deleteId);
                  batchResults.push({ action: 'delete', entityType: opEntityType, id: deleteId, deleted: true });
                  completed.push({ action: 'delete', entityType: opEntityType, id: deleteId });
                  break;
                }
                default:
                  batchFailed = true;
                  batchError = `Unknown batch operation action: ${opAction}`;
                  break;
              }
            } catch (err) {
              batchFailed = true;
              batchError = `Batch operation [${opAction}, ${opEntityType}] failed: ${err instanceof Error ? err.message : String(err)}`;
              break;
            }

            if (batchFailed) break;
          }

          effectResults.push({
            effect: 'persist',
            action: 'batch',
            data: {
              operations: batchResults,
              completedCount: completed.length,
              totalCount: operations.length,
            },
            success: !batchFailed,
            ...(batchFailed ? { error: batchError } : {}),
          });
          return;
        }

        // ----------------------------------------------------------------
        // Single operation mode: create / update / delete
        // ----------------------------------------------------------------
        const type = targetEntityType || entityType;
        let resultData: EntityRow | undefined;
        const sizeBefore = (await this.persistence.list(type)).length;

        try {
          // Validate relation cardinality before create/update
          if (action === 'create' || action === 'update') {
            this.validateRelationCardinality(type, data || {});
          }

          switch (action) {
            case "create": {
              const { id } = await this.persistence.create(type, data || {});
              resultData = { id, ...(data || {}) };
              break;
            }
            case "update":
              if (data?.id || entityId) {
                const updateId = (data?.id as string) || entityId!;
                await this.persistence.update(type, updateId, data || {});
                // Return the updated entity
                const updated = await this.persistence.getById(type, updateId);
                resultData = updated || { id: updateId, ...(data || {}) };
              }
              break;
            case "delete": {
              // `(persist delete Entity @payload.id)` resolves to a raw
              // id STRING as the 4th arg, not `{id: ...}`. Accept both
              // shapes — the .lolo authoring form is string, and batch
              // callers may pass {id} too — so VG31-delete's cascade
              // doesn't silently no-op when `data` is a scalar id.
              const directId = typeof data === 'string' ? data : undefined;
              const nestedId = typeof data === 'object' && data !== null
                ? (data.id as string | undefined)
                : undefined;
              const deleteId = directId ?? nestedId ?? entityId;
              if (deleteId) {
                // Enforce onDelete relation rules before deleting
                await this.enforceOnDeleteRules(type, deleteId);
                await this.persistence.delete(type, deleteId);
                resultData = { id: deleteId, deleted: true };
              }
              break;
            }
          }

          const sizeAfter = (await this.persistence.list(type)).length;
          effectLog.debug("persist:store-mutate", {
            action,
            entityType: type,
            resultId: resultData?.id as string | undefined,
            sizeBefore,
            sizeAfter,
            delta: sizeAfter - sizeBefore,
          });

          effectResults.push({
            effect: 'persist',
            action,
            entityType: type,
            data: resultData,
            success: true,
          });
        } catch (err) {
          effectLog.error("persist:store-mutate-error", {
            action,
            entityType: type,
            error: err instanceof Error ? err.message : String(err),
          });
          effectResults.push({
            effect: 'persist',
            action,
            entityType: type,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      callService: async (service, action, params) => {
        try {
          let result = null;
          // Custom handlers can override this
          if (this.config.effectHandlers?.callService) {
            result = await this.config.effectHandlers.callService(
              service,
              action,
              params,
            );
          } else if (this.config.mode === 'mock') {
            // Mock mode: return a useful default so service-atom chains
            // (e.g. std-service-stripe createPaymentIntent → PAYMENT_CREATED
            // → confirmPayment → PAYMENT_CONFIRMED) advance instead of
            // stalling at an empty payload. Fields cover the common
            // service-result shapes:
            //   - `id` / `clientSecret` for payment-intent style results
            //   - `success` / `status` for boolean-ish action results
            //   - `result` (object) for actions that wrap a result
            //   - echo `params` so consumers reading the request shape see it
            const mockId = `mock_${service}_${action}_${Math.random().toString(36).slice(2, 10)}`;
            const paramsEcho: Partial<EntityRow> = {};
            if (params) {
              for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null || v instanceof Date)) {
                  paramsEcho[k] = v;
                }
              }
            }
            result = {
              id: mockId,
              clientSecret: `secret_${mockId}`,
              success: true,
              status: 'succeeded',
              ...paramsEcho,
            } as EntityRow;
          } else {
            effectLog.warn('call-service:not-configured', { service, action });
          }

          effectResults.push({
            effect: 'call-service',
            action: `${service}.${action}`,
            data: result as EntityRow | undefined,
            success: true,
          });

          return result;
        } catch (err) {
          effectResults.push({
            effect: 'call-service',
            action: `${service}.${action}`,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      },

      fetch: async (fetchEntityType, options) => {
        try {
          xOrbitalLog.info('fetch:enter', () => ({
            entityType: fetchEntityType,
            hasOptions: options !== undefined && options !== null,
            optionsKeys: options ? Object.keys(options).join(',') : '',
            filterType: typeof options?.filter,
            filterIsArray: Array.isArray(options?.filter),
            filterJson: JSON.stringify(options?.filter ?? null).slice(0, 300),
            payloadJson: JSON.stringify(bindingsRef?.payload ?? null).slice(0, 300),
          }));
          let result: EntityRow | EntityRow[] | null = null;
          let total = 0;

          if (options?.id) {
            // Single entity fetch
            const entity = await this.persistence.getById(fetchEntityType, options.id);
            if (entity) {
              // Populate relations if include specified
              if (options?.include && options.include.length > 0) {
                await this.populateRelations([entity], fetchEntityType, options.include);
              }
              // Always store as array for consistent access via FetchedDataContext
              fetchedData[fetchEntityType] = [entity];
              result = entity;
              total = 1;
            }
          } else {
            // Collection fetch
            let entities = await this.persistence.list(fetchEntityType);

            // Apply filter SExpression if provided. Mirrors
            // ServerEffectHandlers.fetch. Each row is evaluated against
            // the predicate with @entity bound to the row, @payload to
            // the inbound event payload, and @current to the row.
            if (options?.filter !== undefined && options.filter !== null) {
              const predicate = options.filter as SExpr;
              entities = entities.filter((entity) => {
                const ctx = createContextFromBindings(
                  { entity, payload: bindingsRef?.payload, current: entity },
                  false,
                );
                try {
                  return Boolean(evaluate(predicate, ctx));
                } catch (err) {
                  effectLog.error('fetch:filter-eval-error', {
                    entityType: fetchEntityType,
                    error: err instanceof Error ? err : String(err),
                  });
                  return false;
                }
              });
            }

            // Capture total AFTER filter, BEFORE offset/limit — paginating
            // consumers need the count of rows matching the filter, not
            // just the slice length.
            total = entities.length;

            // Apply pagination
            if (options?.offset && options.offset > 0) {
              entities = entities.slice(options.offset);
            }
            if (options?.limit && options.limit > 0) {
              entities = entities.slice(0, options.limit);
            }

            // Populate relations if include specified
            if (options?.include && options.include.length > 0) {
              await this.populateRelations(entities, fetchEntityType, options.include);
            }

            fetchedData[fetchEntityType] = entities;
            result = entities;
          }

          return result === null
            ? null
            : { rows: result, total };
        } catch (error) {
          effectLog.error('fetch:error', {
            entityType: fetchEntityType,
            error: error instanceof Error ? error : String(error),
          });
          return null;
        }
      },

      // Resource operators: ref, deref, swap, watch, atomic

      ref: async (refEntityType, options) => {
        // ref is identical to fetch on the server: query persistence, populate fetchedData
        try {
          return await handlers.fetch!(refEntityType, options);
        } catch (error) {
          effectLog.error('ref:error', {
            entityType: refEntityType,
            error: error instanceof Error ? error : String(error),
          });
          return null;
        }
      },

      deref: async (derefEntityType, options) => {
        // deref is identical to fetch on the server: one-shot read
        try {
          let result: EntityRow | EntityRow[] | null = null;
          let total = 0;

          if (options?.id) {
            const entity = await this.persistence.getById(derefEntityType, options.id);
            if (entity) {
              fetchedData[derefEntityType] = [entity];
              result = entity;
              total = 1;
            }
          } else {
            const entities = await this.persistence.list(derefEntityType);
            fetchedData[derefEntityType] = entities;
            result = entities;
            total = entities.length;
          }

          effectResults.push({
            effect: 'deref',
            entityType: derefEntityType,
            success: true,
          });

          return result === null ? null : { rows: result, total };
        } catch (error) {
          effectResults.push({
            effect: 'deref',
            entityType: derefEntityType,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      swap: async (swapEntityType, swapEntityId, transform) => {
        // Read-modify-write: read entity, apply transform S-expression, write back
        try {
          const current = await this.persistence.getById(swapEntityType, swapEntityId);
          if (!current) {
            effectResults.push({
              effect: 'swap',
              entityType: swapEntityType,
              success: false,
              error: `Entity ${swapEntityType}/${swapEntityId} not found`,
            });
            return null;
          }

          // Evaluate the transform S-expression with @current binding
          const ctx = createContextFromBindings({
            current,
            entity: entityData,
            payload,
          }, false, this.config.contextExtensions);

          let newData: EntityRow;
          if (Array.isArray(transform)) {
            // S-expression transform: evaluate with @current bound to the entity
            const result = evaluate(
              transform as Parameters<typeof evaluate>[0],
              ctx,
            );
            // The result should be a record (the transformed entity)
            if (result && typeof result === 'object' && !Array.isArray(result)) {
              newData = result as EntityRow;
            } else {
              // If transform returned a non-object, treat it as a partial update
              newData = current;
            }
          } else if (typeof transform === 'object' && transform !== null) {
            // Plain object merge: simple field updates
            newData = { ...current, ...(transform as EntityRow) };
          } else {
            effectResults.push({
              effect: 'swap',
              entityType: swapEntityType,
              success: false,
              error: 'swap! transform must be an S-expression or object',
            });
            return null;
          }

          // Write back (without version check for now, full OCC in future pass)
          await this.persistence.update(swapEntityType, swapEntityId, newData);

          effectResults.push({
            effect: 'swap',
            entityType: swapEntityType,
            data: { id: swapEntityId, ...newData },
            success: true,
          });

          return newData;
        } catch (error) {
          effectResults.push({
            effect: 'swap',
            entityType: swapEntityType,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      watch: (_watchEntityType, _watchOptions) => {
        // Watch is a no-op on server. Client subscribes to real-time updates.
        if (this.config.debug) {
          effectLog.debug('watch:noop-server', { entityType: _watchEntityType });
        }
      },

      atomic: async (atomicEffects) => {
        // Execute inner effects sequentially. If any fails, mark all as failed.
        // Full transaction/rollback support is a future enhancement.
        let atomicFailed = false;
        let atomicError = '';

        const atomicExecutor = new EffectExecutor({
          handlers,
          bindings: bindingsRef ?? {},
          context: contextRef ?? { traitName, orbitalName: registered.schema.name, state: 'unknown', transition: 'unknown' },
          debug: this.config.debug,
          contextExtensions: this.config.contextExtensions,
        });

        for (const innerEffect of atomicEffects) {
          if (atomicFailed) break;
          try {
            await atomicExecutor.execute(innerEffect);
          } catch (err) {
            atomicFailed = true;
            atomicError = err instanceof Error ? err.message : String(err);
          }
        }

        if (atomicFailed) {
          // Mark the atomic block as failed
          effectResults.push({
            effect: 'atomic',
            success: false,
            error: `Atomic block failed: ${atomicError}`,
          });
        } else {
          effectResults.push({
            effect: 'atomic',
            success: true,
            data: { innerCount: atomicEffects.length },
          });
        }
      },

      // Client-side effects - collect for forwarding to client
      renderUI: (slot, pattern, props, priority) => {
        // Snapshot the resolved row reference (if any) so the log can
        // tell whether successive render-ui pushes for the same slot
        // carry the SAME row object (stable, no remount expected) or a
        // freshly-cloned one (would invalidate Form's normalizedInitialData
        // memo and reset typed values). We read `pattern.entity` because
        // form-section binds the row to `entity: @payload.row`.
        const patternNode: RuntimeRenderPattern | null =
          pattern !== null && typeof pattern === 'object' && !Array.isArray(pattern)
            ? (pattern as RuntimeRenderPattern)
            : null;
        const patternEntity = patternNode?.entity;
        const entityRow: EntityRow | null =
          patternEntity !== null && typeof patternEntity === 'object' && !Array.isArray(patternEntity)
            ? (patternEntity as EntityRow)
            : null;
        const patternTypeRaw = patternNode?.['type'];
        renderLog.debug('renderUI:push', {
          trait: traitName,
          slot,
          patternType: typeof patternTypeRaw === 'string' ? patternTypeRaw : undefined,
          entityRowId: typeof entityRow?.id === 'string' ? entityRow.id : undefined,
          entityIsObject: entityRow !== null,
        });
        pushClientEffect(['render-ui', slot, pattern, props, priority]);
      },
      navigate: (path, params) => {
        pushClientEffect(['navigate', path, params]);
      },

      notify: (message, type) => {
        if (this.config.debug) {
          effectLog.info('notify', { type, message });
        }
        // Forward notify to client as a client effect
        pushClientEffect(['notify', message, { type }]);
      },

      log: (message, level) => {
        if (level === 'error') {
          dynamicLog.error(message);
        } else if (level === 'warn') {
          dynamicLog.warn(message);
        } else {
          dynamicLog.debug(message);
        }
      },

      // Allow custom handlers to override
      ...this.config.effectHandlers,
    };

    const state = registered.manager.getState(traitName);
    // Build binding context with @entity AND @EntityName aliases.
    // @entity is the standard binding root. @EntityName (e.g., @SpriteEntity)
    // is used by some behaviors for explicit entity references in render-ui patterns.
    // The compiled app resolves @EntityName at compile time; the interpreter
    // needs it in the runtime binding context.
    //
    // NOTE: fetchedData is populated by fetch effects DURING execution.
    // The syncFetchedBindings() helper is called from the fetch handler
    // to update bindings after each fetch, so render-ui effects that
    // run after fetch see the correct @EntityName.field values.
    const bindings: BindingContext = {
      entity: entityData,
      payload,
      state: state?.currentState || "unknown",
      user, // @user bindings from Firebase auth
    };

    // Call-site `config: { ... }` injection. Reference-resolver captures the
    // trait ref's config block into RegisteredOrbital.configByTrait at
    // registration time (see registerOrbitalAsync). Here we surface it on the
    // binding context so render-ui patterns can read `@config.icon`,
    // `@config.title`, `@config.fields`, etc. — the mechanism that lets a
    // molecule parameterize an imported atom's UI without duplicating the
    // render-ui body.
    // Defaults from the trait's DECLARED config schema must merge BEHIND the
    // call-site override so atoms verified standalone (no consumer override)
    // still see their declared icon/title/fields/mode values. Without this,
    // `@config.icon` resolved to undefined → Icon fell back to "?", and
    // `@config.title` rendered as empty. The compiled path's Solution-1 in
    // backend.rs emits `DEFAULT_<TRAIT>_CONFIG` + `mergedConfig`; the runtime
    // path needs the same merge or std-modal/std-confirmation render bare in
    // playground while the compiled bundle renders correctly.
    const traitDef = registered.traits.find((t) => t.name === traitName);
    const declaredDefaults = collectDeclaredConfigDefaults(traitDef);
    // An embedded sub-trait (e.g. std-browse's `DataGrid1`) never gets an
    // entry in `configByTrait` — that map is only populated for `_resolved`-
    // wrapped ref traits (see registerOrbitalAsync), and an inline atom
    // sub-trait pulled in via `@trait.X` isn't one. Its OWN declared config
    // (`declaredDefaults` above) is the only source, and for a `@config.X`
    // forward field that's the literal unresolved string. `resolvedTraitConfigs`
    // (built once at register() via `buildResolvedTraitConfigs`) chains that
    // forward through to the trait that actually embeds it — merge it in
    // ahead of `callSiteOverride` (a real call-site override still wins).
    const resolvedDefaults = this.resolvedTraitConfigs[traitName];
    const callSiteOverrideRaw = registered.configByTrait.get(traitName);
    // Drop unresolved `@config.X` forwards from the call-site config before it
    // spreads last: for an embedded sub-trait rendered from a state-machine
    // transition (e.g. std-health-score's inline DataGrid `fields={@config.
    // fields}`), the call-site value IS the literal forward string, the same
    // one `resolvedDefaults` already substituted to a concrete value. Spread
    // raw, it would clobber the resolved array back to `"@config.fields"` and
    // push an unresolved frame over the bridge — the server half of the
    // render oscillation. A concrete override (a real array/scalar) still wins.
    // Call-site payload capture: a `@callsitePayload.<field>` override is a
    // snapshot of THIS effect's triggering event payload, captured at the
    // composing call site. Resolve it against `payload` (in scope here) to the
    // literal before it merges into the child's config — the child then sees a
    // plain value via its `@config.<knob>` read, never a payload ref.
    const callSiteOverride = callSiteOverrideRaw
      ? resolveCallSitePayloadCaptures(
          Object.fromEntries(
            Object.entries(callSiteOverrideRaw).filter(
              ([, v]) => !(typeof v === 'string' && v.startsWith('@config.')),
            ),
          ),
          payload,
        )
      : undefined;
    if (declaredDefaults || resolvedDefaults || callSiteOverride) {
      bindings.config = {
        ...(declaredDefaults ?? {}),
        ...(resolvedDefaults ?? {}),
        ...(callSiteOverride ?? {}),
      };
    }

    // `@entity` resolves to a three-layer merge (outermost wins):
    //   1. Declared entity field defaults (schema `default:` values)  — base
    //   2. entityData from persistence (already in bindings.entity above)     — middle
    //   3. Explicit `(set @entity.X Y)` scalar state (traitFieldStates)       — top
    // Without layer 1, behaviors that render `@entity.title` on first load
    // (before any event fires a `(set)`) see undefined → blank UI even though
    // the entity schema declares a sensible default. Mirrors the `@config`
    // merge applied above (declared defaults < call-site override). RC-2.
    const entityFieldDefaults = collectDeclaredEntityDefaults(registered.entity);
    const traitFieldState = registered.traitFieldStates.get(traitName);
    if (entityFieldDefaults || traitFieldState) {
      bindings.entity = {
        ...(entityFieldDefaults ?? {}),
        ...(bindings.entity ?? {}),
        ...(traitFieldState ?? {}),
      };
    }

    // Add initial named entity binding
    if (entityType) {
      bindings[entityType] = bindings.entity ?? entityData;
    }

    // Wire forward refs so fetch/atomic handlers can access bindings and context
    bindingsRef = bindings;

    const context: EffectContext = {
      traitName,
      orbitalName: registered.schema.name,
      state: state?.currentState || "unknown",
      transition: "unknown",
      entityId,
    };
    contextRef = context;

    const executor = new EffectExecutor({
      handlers,
      bindings,
      context,
      debug: this.config.debug,
      contextExtensions: this.config.contextExtensions,
    });

    await executor.executeAll(effects);
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
            const nonStrings = value.filter((v: unknown) => typeof v !== 'string');
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
                  update[fieldName] = fkValue.filter((id: unknown) => id !== deletedId);
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
    router.get("/:orbital", (req: Request, res: Response) => {
      const orbitalName = req.params.orbital as string;
      const registered = this.orbitals.get(orbitalName);
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

/**
 * Parse a `TraitEventListener`'s event key into its bare event name and a
 * source-matcher predicate.
 *
 * Supports both authoring layers:
 *
 * 1. **New core schema**: `listener.source` is an explicit object describing
 *    the scope (`any` / `trait` / `orbital`). Used as-is.
 * 2. **Legacy concatenated string** in `listener.event`:
 *    - `"*.EVENT"`            → `{ kind: "any" }`, bare = EVENT
 *    - `"Trait.EVENT"`        → `{ kind: "trait", trait: "Trait" }`, bare = EVENT
 *    - `"Orbital.Trait.EVENT"`→ `{ kind: "orbital", orbital, trait }`, bare = EVENT
 *    - `"EVENT"`              → `{ kind: "any" }`, bare = EVENT (no prefix
 *      means "I don't know where it came from, accept any").
 *
 * The matcher is invoked on every emit that matches the bare event key; it
 * returns `true` iff the emit's source metadata matches the listener's scope.
 *
 * `listenerOrbital` is the orbital that owns the listener; it's used to
 * resolve intra-orbital trait references for `{ kind: "trait" }` scopes.
 */
function parseListenSource(
  listener: { event: string; source?: unknown },
  listenerOrbital: string,
): {
  bareEvent: string;
  matcher: (source: EventSourceMeta | undefined) => boolean;
} {
  // 1. Explicit source field from the new core schema (preferred). Carries
  //    V4 dual-carry `traitId`/`orbitalId` when the schema has ids, so the
  //    matcher can compare ids (rename-proof) instead of names.
  const explicit = (listener as { source?: IdListenSourceDescriptor }).source;
  if (explicit && typeof explicit === 'object') {
    return {
      bareEvent: listener.event,
      matcher: buildSourceMatcher(explicit, listenerOrbital),
    };
  }

  // 2. Fall back to parsing the legacy concatenated string (no ids present).
  const key = listener.event;
  const parts = key.split('.');
  if (parts.length === 1) {
    // Bare `EVENT` — no source prefix. Accept any source (this is the
    // safest default; callers who want strict scoping should author the
    // full two-segment form).
    return { bareEvent: key, matcher: () => true };
  }

  if (parts.length === 2) {
    const [sourceOrStar, eventName] = parts;
    if (sourceOrStar === '*') {
      return { bareEvent: eventName, matcher: () => true };
    }
    // Single-segment source: intra-orbital trait reference.
    return {
      bareEvent: eventName,
      matcher: buildSourceMatcher(
        { kind: 'trait', trait: sourceOrStar },
        listenerOrbital,
      ),
    };
  }

  if (parts.length >= 3) {
    const eventName = parts[parts.length - 1];
    const trait = parts[parts.length - 2];
    const orbital = parts.slice(0, parts.length - 2).join('.');
    return {
      bareEvent: eventName,
      matcher: buildSourceMatcher({ kind: 'orbital', orbital, trait }, listenerOrbital),
    };
  }

  // Unreachable given the split above — defensive default.
  return { bareEvent: key, matcher: () => true };
}

/** Shape of `RuntimeEvent.source` (names + V4 dual-carry ids). */
type EventSourceMeta = BusEventSource;
