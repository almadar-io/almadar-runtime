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
// `@almadar/server` below.
import type { AsyncLocalStorage as BracketAsyncLocalStorage } from "node:async_hooks";

/** One context's hold on the runtime event queue; released while it awaits a service. */
interface EventQueueHold {
  held: boolean;
  release: () => void;
}
import { identitySourceOf, resolveViewer, type VerifiedUser } from "@almadar/auth";
import { EventBus } from "../events/EventBus.js";
import { eventRouteKey } from "../events/identity/routing.js";
import { stampEmitSource } from "../events/emit-stamp.js";
import { evaluateOnKernel } from "../kernel/engine.js";
import { createTickScheduler, type TickHandle, type TickScheduler } from "../time/TickScheduler.js";
import { isValidCronExpression } from "../time/cron.js";
import { parseDurationString } from "../time/duration.js";
import {
  LIFECYCLE_EVENTS,
  UNMOUNT_EVENT,
  tickEventKey,
} from "../traits/state-book.js";
import { parseOrbitalTraits } from "../traits/OrbitalTraitParsing.js";
import { createLogger } from '@almadar/logger';
import type { createProgramHandlers as CreateProgramHandlersFn } from "../effects/createProgramHandlers.js";

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

import { setupSSE, sendSSEEvent, sendSSEDone, closeSSE } from './sse.js';
import type {
  TraitState,
  EffectHandlers,
  EntityRow,
  EventPayload,
  EvaluationContextExtensions,
  TransitionObserver,
} from "../types.js";
import { collectDeclaredConfigDefaults } from "../traits/config-defaults.js";
// Backward-compat: `collectDeclaredConfigDefaults` used to live here. The package
// index now re-exports it from the browser-safe `../traits/config-defaults.js` (so it
// doesn't drag this node-only module into a browser bundle), but keep the
// original export site for existing importers (tests, server consumers).
export { collectDeclaredConfigDefaults };
import type {
  OrbitalSchema,
  MessageCatalogs,
  OrbitalDefinition,
  Entity,
  Trait,
  TraitTick,
  TraitConfig,
  BusEventSource,
  UserContext,
  ServiceHostPorts,
} from "@almadar/core";
import { entityAccessPolicies } from "@almadar/core/mock";
import { orbitalInlineEntities, RowSetRefSchema, type RowQueryPage } from "@almadar/core";

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
import { applyRowAccess, inlineTraitRefs, installKernelEvaluator } from "@almadar/core";
import type {
  OrbitalEventRequest,
  OrbitalEventResponse,
  ClientEffectTuple,
  ExternalInput,
  ExternalInputRequest,
  InboundAnswer,
  InboundDelivery,
} from "@almadar/core";
import { externalInputsOf, inboundOnlyMessage, inboundOnlyTrait, readableEntitiesOf } from "@almadar/core";
import { dispatchDeclaredInput } from "../evaluation/declared-input-dispatch.js";
import { dispatchInbound } from "../evaluation/inbound-dispatch.js";
import { isEntityCall, normalizeUserContext, personaFromIdentityRow, resolveDefaultViewer, DEFAULT_VIEWER
} from "@almadar/core";
import { ownerFieldsFromSchema, identityEntityName, identityEntitiesOf } from "@almadar/core/mock";
import { InFlightCalls } from "../effects/in-flight-calls.js";
import { defaultCallService, mockCallService } from "../effects/defaultCallService.js";
import { createHttpPorts, createHttpSecrets, kernelOsCompletions, kernelOsGrants, KernelEngine, type HttpPorts, type HttpPortsOptions, type KernelHostPorts, type KernelModule, type OsGrantPort, type OsHostPort } from "../kernel/index.js";
export type { KernelModule } from "../kernel/index.js";
import { installPolicyOwnerGates } from "../entities/policyOwnerGates.js";
import { MockPersistenceAdapter } from "@almadar/db/mock";
import { seedBrowserStore } from "../entities/seedBrowserStore.js";
import type * as ProgramHostModule from "../host/node.js";
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
/** One registered orbital as the API lists it. */
export interface OrbitalSummary {
  name: string;
  entity: string | undefined;
  traits: string[];
}

/** One registered orbital as the API describes it: its entity and each trait's current state, states and events. */
export interface OrbitalInfo {
  name: string;
  entity: Entity;
  traits: { name: string; currentState: string | undefined; states: string[]; events: string[] }[];
}

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
  /** `clientId` of the request that produced this emit. */
  originClientId?: string;
  /**
   * `peers`: every OTHER client (persist envelopes, tick relay). `origin`:
   * only the requesting client, while its request is still running (a
   * `call-service`'s live `emit.onMessage`).
   */
  target: 'peers' | 'origin';
}

/**
 * The result of a dispatch the host ran on its own — a follow-on step's `call-service`
 * outcome, run after the request that started the call had answered — for the tab that
 * asked (`originClientId`). Handed to the host-dispatch sink (`setHostDispatchSink`).
 */
export interface HostDispatchItem {
  orbitalName: string;
  request: OrbitalEventRequest;
  response: OrbitalEventResponse;
  originClientId?: string;
}

// `OrbitalEventResponse` — response from event processing — is owned by
// `@almadar/core` (re-exported above).

/**
 * Loader configuration for resolving `uses` imports
 */
export interface LoaderConfig {
  /** Where `orb` resolves a registered program's imports from, when no `programHost` names it. */
  basePath: string;
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
  /** Where a registered program with imports is resolved from (`orb resolve`). */
  loaderConfig?: LoaderConfig;
  /**
   * Additional fields to spread onto every EvaluationContext.
   * Use this to inject module contexts (e.g., { agent: AgentContext }).
   * The evaluator dispatches agent/* operators to ctx.agent.
   */
  contextExtensions?: EvaluationContextExtensions;
  /**
   * The program host behind behavior/catalog|describe|source and
   * program/read|print|eval: the project root `orb` runs from. Absent means
   * those effects fail explicitly ("no program host configured").
   */
  programHost?: { cwd: string; orbBin?: string };
  /**
   * The persona a preview or verification run is looking at the app AS.
   *
   * `@user.id` / `@user.role` are what an app's ownership scoping and role
   * gates resolve against, so with no user every predicate takes its negative
   * branch and every owner filter matches nothing. A dev host (playground,
   * runtime-verify) sets it to make both branches reachable.
   *
   * Never an HTTP request's identity: `router()` resolves every request from
   * its verified token (or anonymous). It is the viewer for in-process calls,
   * ticks and the mock seeder's owner stamps.
   */
  defaultUser?: UserContext;
  /**
   * A host TOOL's runtime (not an app's) acting as one declared principal for
   * every HTTP request, e.g. the playground's integrations console acting as
   * the machine's operator. App runtimes leave it unset.
   */
  principal?: UserContext;
  /**
   * Seeded columns that hold a user id, as `Entity.field` pairs (e.g.
   * `RosterEntry.memberId`). In mock mode the `defaultUser` is assigned to
   * every other seeded row of each named column, so a scoped view has real
   * rows and a second persona sees the complement. Explicit by design — the
   * seeder never guesses an owner column from its name.
   */
  mockOwnerFields?: string[];
  /**
   * The initialised `@almadar/kernel` module that decides execution and whose I/O this runtime answers with its
   * persistence, service and program-host adapters. Absent, the runtime loads the installed `@almadar/kernel` itself
   * (`loadInstalledKernel`) when a program is first registered.
   */
  kernel?: KernelModule;
  /**
   * What the `http` effect runs on: the kernel's request driver (`loadHttpKernel`), and optionally the secret store,
   * pinned fetch and resolver. The program's `egress` is read from the registered schema. Absent, an `http` effect
   * fails with `HTTP_KERNEL_UNAVAILABLE`.
   */
  http?: Omit<HttpPortsOptions, 'egress'>;
  /**
   * Builds the `os` host of the kernel engine from the grant port backed by the kernel (`createNodeOsHost` from
   * `@almadar/runtime/kernelOsNode`). Absent, every `os` ask is denied, as the native host does with none.
   */
  osHost?: (grants: OsGrantPort) => OsHostPort;
  /** The clock the kernel's `clock` ask is answered from, in epoch milliseconds; absent, the system clock. */
  clock?: () => number;
}

/**
 * Adapter for persisting entity data
 */
import type { PersistenceAdapter, RowSetRef } from '@almadar/core';
import { InMemoryPersistence, stampSeedTimestamps } from '@almadar/db/mock';

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
/** A program with imports registered where `orb` cannot run (a browser): resolve it first (`orb resolve`). */
export class UnresolvedProgramError extends Error {
  constructor(schemaName: string) {
    super(`program "${schemaName}" has unresolved imports and this host cannot run orb: register its resolved form (orb resolve)`);
    this.name = 'UnresolvedProgramError';
  }
}

/** A resolved program keeps its `uses` declarations; only a trait still carried as a bare reference is unresolved. */
function needsResolving(schema: OrbitalSchema): boolean {
  for (const orbital of schema.orbitals) {
    for (const t of orbital.traits ?? []) {
      if (typeof t === 'object' && 'ref' in t && t.ref.includes('.') && t._resolved === undefined) {
        return true;
      }
    }
  }
  return false;
}

export { inlineNavItems } from '../evaluation/render-sigils.js';

/**
 * Internal tick binding for tracking active ticks
 */
interface TickBinding {
  orbitalName: string;
  traitName: string;
  tick: RuntimeTraitTick;
  handle: TickHandle;
}

/** What `register` takes beside the schema: the program's catalogs and the `uses lazy` behaviors the server runs alongside it. */
export interface RegisterOptions {
  messages?: MessageCatalogs;
  lazy?: readonly OrbitalSchema[];
}

/** `orb resolve` writes each declared locale's merged catalog beside a `.orb` as `<stem>.<locale>.json`. */
async function readSidecarCatalogs(
  readFile: (path: string, encoding: 'utf-8') => Promise<string>,
  orbPath: string,
  locales: readonly string[],
): Promise<MessageCatalogs> {
  const messages: MessageCatalogs = {};
  const stem = orbPath.replace(/\.orb$/, '');
  for (const locale of locales) {
    const catalogPath = `${stem}.${locale}.json`;
    let catalogRaw: string;
    try {
      catalogRaw = await readFile(catalogPath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`registerFromFile: ${orbPath} declares locale "${locale}" but its catalog ${catalogPath} could not be read: ${msg}`);
    }
    messages[locale] = JSON.parse(catalogRaw) as Record<string, string>;
  }
  return messages;
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
  /** The kernel running the registered program; null before a program is registered. */
  private kernelEngine: KernelEngine | null = null;
  /** The `os` handles of the program the kernel runs; closed when that program is replaced, reset or dropped. */
  private kernelOs: OsHostPort | undefined;
  /** `orbital::trait` → the clients that have it mounted (Runtime Spec Clause 8.3). */
  private readonly mountedBy = new Map<string, Set<string>>();
  // One coalesced clock for every tick this runtime registers — replaces
  // "one setInterval per tick" with a single accumulator loop so ticks due
  // in the same pass fire together instead of on independent timers.
  private readonly tickScheduler: TickScheduler = createTickScheduler();
  private readonly transitionObservers = new Set<TransitionObserver>();
  private readonly transitionFanout: TransitionObserver = {
    onTransition: (trace) => { for (const o of this.transitionObservers) o.onTransition(trace); },
    onRollback: (trace) => { for (const o of this.transitionObservers) o.onRollback?.(trace); },
  };
  private programHandlersPromise: Promise<void> | null = null;
  private resolvedSchema: OrbitalSchema | null = null;

  /** The program's declared `locales`, in declared order; the first is the default. */
  private appLocales: readonly string[] = [];
  /** Merged message catalogs of every registered program (keys are behavior-qualified). */
  private messages: MessageCatalogs = {};
  /** Wired by the hosting server (e.g. the playground SSE endpoint) via `setLiveBroadcastSink`. */
  private liveBroadcastSink: ((item: LiveBroadcastItem) => void) | null = null;
  private hostDispatchSink: ((item: HostDispatchItem) => void) | null = null;
  /**
   * Tick-broadcast relay (T6): newest pending item per
   * (originClientId, orbital, event), flushed to the live-broadcast sink on
   * the `tickRelayIntervalMs` cadence — other tabs get the latest position
   * at snapshot rate, never 1:1 with emissions.
   */
  private readonly tickRelayPending = new Map<string, LiveBroadcastItem>();
  private tickRelayTimer: ReturnType<typeof setInterval> | null = null;
  constructor(config: OrbitalServerRuntimeConfig = {}) {
    this.config = {
      mode: 'mock', // Default to mock mode for preview
      ...config,
      // `@user` is never Null. A host that named no viewer (no ALMADAR_PERSONA,
      // no auth yet) otherwise renders every `viewerName: @user.name` blank, so
      // the app cannot say who you are. DEFAULT_VIEWER carries an empty `role`,
      // so no `@user.role` guard changes outcome — see its doc in @almadar/core.
      defaultUser: config.defaultUser ?? DEFAULT_VIEWER,
    };
    this.viewerNamedByHost = config.defaultUser !== undefined;
    this.eventBus = new EventBus();

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

  }

  /**
   * Lazily wire the program host handlers (behavior/* and program/* effects),
   * merging them UNDER any user-provided handlers. Only when `programHost`
   * is configured; otherwise the effects fail explicitly.
   */
  private async ensureProgramHandlers(): Promise<void> {
    if (!isNodeEnv()) return;
    const host = this.config.programHost;
    if (host === undefined) return;
    if (!this.programHandlersPromise) {
      this.programHandlersPromise = (async () => {
        const { createProgramHandlers } = (await import('../effects/createProgramHandlers.js')) as {
          createProgramHandlers: typeof CreateProgramHandlersFn;
        };
        this.config.effectHandlers = {
          ...createProgramHandlers(host),
          ...this.config.effectHandlers,
        };
      })();
    }
    return this.programHandlersPromise;
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

  async register(schema: OrbitalSchema, options: RegisterOptions = {}): Promise<void> {
    if (this.registrationMutationDepth > 0) {
      // Inside a withRegistrationMutation bracket — ordering is guaranteed
      // by the callback's awaits; chaining onto the bracket epoch would
      // deadlock. See registrationMutationDepth.
      await this.doRegister(schema, options);
      return;
    }
    const previous = this.registrationEpoch ?? Promise.resolve();
    // Chain on BOTH fulfillment and rejection: a failed previous mutation
    // must not wedge the queue for the next schema.
    const epoch = previous.then(
      () => this.doRegister(schema, options),
      () => this.doRegister(schema, options),
    );
    this.registrationEpoch = epoch;
    await epoch;
  }

  private async doRegister(schema: OrbitalSchema, options: RegisterOptions): Promise<void> {
    // The policy gates the mock seeder installs evaluate on the kernel from the first seeded row.
    installKernelEvaluator(await this.kernelModule());
    if (this.config.debug) {
      registerLog.debug('register:schema', { name: schema.name });
    }
    this.appLocales = schema.locales ?? [];
    for (const [locale, catalog] of Object.entries(options.messages ?? {})) {
      this.messages[locale] = { ...this.messages[locale], ...catalog };
    }

    // A program with imports is resolved by `orb`, the one resolver, from the configured base path; a host with
    // no `orb` to run (a browser) registers only resolved programs.
    if (needsResolving(schema)) schema = await this.resolveWithOrb(schema);

    // BEFORE the loop: registerOrbital seeds each entity eagerly
    // (MockPersistenceAdapter.registerEntity -> seed), so owner columns, the
    // owner gate and the identity-first order must all be in place first.
    this.prepareMockSeeding(schema);

    // Register all orbitals (await to ensure instance seeding completes)
    // Lazy pages' orbitals run here too; only the served schema keeps them lazy for the client.
    const lazyOrbitals = (options.lazy ?? []).flatMap((lazy) => lazy.orbitals);
    const executed: OrbitalSchema = lazyOrbitals.length > 0 ? { ...schema, orbitals: [...schema.orbitals, ...lazyOrbitals] } : schema;
    for (const orbital of executed.orbitals) {
      await this.registerOrbitalAsync(orbital);
    }

    // Set up scheduled ticks
    this.setupTicks();
    await this.openKernel(executed);

    // Stash the post-preprocessing schema so HTTP layers (e.g. a playground
    // server's /api/schema handler) can serve the fully-resolved copy instead
    // of re-reading the raw .orb from disk. See getResolvedSchema().
    this.resolvedSchema = schema;
    this.flushPendingOwnerRestamp();
  }

  /**
   * Everything the mock seeder needs before the first entity seeds: the owner
   * columns derived from the `[identity]` entity (twin of `seed.rs`
   * `owner_fields_from_schema`), the `@create` owner gate, and the shared seed
   * order's first step, the `[identity]` entity itself — its rows are the
   * persona roster and the first draws of the seeded stream on every path
   * (`seed.rs` `seed_sample_data_as`, the compiled `seedMockData.ts`).
   */
  private prepareMockSeeding(schema: OrbitalSchema): void {
    if (!(this.persistence instanceof MockPersistenceAdapter)) return;
    const derived = ownerFieldsFromSchema(schema);
    if (derived.length > 0) {
      this.persistence.addOwnerFields(derived);
      persistLog.debug('mock:identity-owner-fields', {
        identity: identityEntityName(schema),
        columns: derived,
      });
    }
    this.installOwnerGate(schema);
    // A viewer nobody named is the app's first declared persona (the compiled seeder and the
    // Rust probes resolve it the same way): seed the roster unstamped, then stamp for them.
    if (!this.viewerNamedByHost) this.persistence.restampOwner(undefined);
    this.seedIdentityEntity(schema);
    if (!this.viewerNamedByHost) {
      const identity = identityEntitiesOf(schema.orbitals ?? [])[0]?.name;
      const roster = identity
        ? this.persistence.rowsOf(identity).map((row) => personaFromIdentityRow(row)).filter((p): p is UserContext => p !== undefined)
        : [];
      const viewer = resolveDefaultViewer(roster);
      this.config.defaultUser = viewer;
      this.persistence.restampOwner(viewer.id);
    }
  }

  private seedIdentityEntity(schema: OrbitalSchema): void {
    if (this.config.mode !== 'mock' || !(this.persistence instanceof MockPersistenceAdapter)) return;
    const identity = identityEntitiesOf(schema.orbitals ?? [])[0];
    if (!identity?.name || !identity.fields) return;
    if (identity.instances && identity.instances.length > 0) return;
    this.persistence.registerEntity({
      name: identity.name,
      id: identity.id,
      collection: identity.collection,
      fields: identity.fields.filter((f): f is typeof f & { name: string } => typeof f.name === 'string' && f.name.length > 0),
      persistence: identity.persistence,
      identity: true,
    });
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
  /** The registered program's name, or null when nothing is registered (none yet, or after `unregisterAll`). */
  registeredSchemaName(): string | null {
    return this.orbitals.size > 0 ? (this.resolvedSchema?.name ?? null) : null;
  }

  getResolvedSchema(): OrbitalSchema | null {
    return this.resolvedSchema;
  }

  /** The registered program's message catalogs (locale → qualified key → message), for a host's client. */
  getMessages(): MessageCatalogs {
    return this.messages;
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
    const locales = schema.locales ?? [];
    const messages = await readSidecarCatalogs(readFile, path, locales);
    // `orb resolve` writes each `uses lazy` behavior (and its catalogs) at the page's `orbRef`, relative to the program.
    const { dirname, join } = await import('node:path');
    const lazy: OrbitalSchema[] = [];
    for (const page of schema.lazyPages ?? []) {
      const lazyPath = join(dirname(path), page.orbRef);
      let lazyRaw: string;
      try {
        lazyRaw = await readFile(lazyPath, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`registerFromFile: ${path} declares lazy page ${page.path} but its behavior ${page.orbRef} could not be read: ${msg}`);
      }
      const lazySchema = JSON.parse(lazyRaw) as OrbitalSchema;
      if (!lazySchema.orbitals.some((o) => o.name === page.orbital)) {
        throw new Error(`registerFromFile: lazy page ${page.path} expects orbital "${page.orbital}" in ${page.orbRef}, found: ${lazySchema.orbitals.map((o) => o.name).join(', ')}`);
      }
      lazy.push(lazySchema);
      for (const [locale, catalog] of Object.entries(await readSidecarCatalogs(readFile, lazyPath, locales))) {
        messages[locale] = { ...messages[locale], ...catalog };
      }
    }
    await this.register(schema, { messages, lazy });
  }

  /** A program with imports resolved by `orb` from the configured base path (Node only: the one resolver is the compiler). */
  private async resolveWithOrb(schema: OrbitalSchema): Promise<OrbitalSchema> {
    if (!isNodeEnv()) throw new UnresolvedProgramError(schema.name);
    const { programResolveSchema } = (await import('../host/node.js')) as typeof ProgramHostModule;
    const cwd = this.config.programHost?.cwd ?? this.config.loaderConfig?.basePath ?? process.cwd();
    if (this.config.debug) registerLog.debug('register:resolve-with-orb', { name: schema.name, cwd });
    return programResolveSchema(schema, { cwd, ...(this.config.programHost?.orbBin !== undefined ? { orbBin: this.config.programHost.orbBin } : {}) });
  }

  /** Tells the store each server-persisted entity's declared `[persistent: tbl]` collection, so its rows live under that name (EXEC-STORE-1). */
  private bindDeclaredCollections(entities: readonly Entity[]): void {
    for (const entity of entities) {
      if (entity.name && entity.collection && entity.local !== true && entity.persistence !== 'runtime') {
        this.persistence.bindCollection?.(entity.name, entity.collection);
      }
    }
  }

  /**
   * Register a single orbital
   */
  private async registerOrbitalAsync(orbital: OrbitalDefinition): Promise<void> {
    // Trait unwrap + config-by-trait + entity resolution — shared with the
    // stateless per-request transition path, see OrbitalTraitParsing.ts.
    const { inlineTraits, configByTrait, entity } = parseOrbitalTraits(orbital);

    this.orbitals.set(orbital.name, {
      schema: orbital,
      entity,
      traits: inlineTraits,
      configByTrait,
    });

    this.bindDeclaredCollections(entity === undefined ? [] : [entity]);

    // A browser-stored entity seeds by the browser store's own rule: its
    // `instances`, else mock rows only when it declares `mock`.
    if (entity?.local === true && !(this.config.mode === 'mock' && this.persistence instanceof MockPersistenceAdapter)) {
      await seedBrowserStore(this.persistence, [entity]);
    } else if (entity?.name && entity.instances && Array.isArray(entity.instances)) {
      const instances = entity.instances;
      if (instances.length > 0) {
        persistLog.debug('seed:start', { entity: entity.name, count: instances.length });

        // Seed each instance (await to ensure they're created)
        const seededAt = new Date().toISOString();
        const results = await Promise.all(
          instances.map(async (instance) => {
            try {
              const result = await this.persistence.create(entity.name, stampSeedTimestamps(instance, seededAt));
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
    } else if (this.config.mode === 'mock' && this.persistence instanceof MockPersistenceAdapter && (entity?.local !== true || entity.seedMock === true)) {
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
          identity: entity.identity,
        });
        if (this.config.debug) {
          persistLog.debug('mock:seeded', { entity: entity.name, count: this.persistence.count(entity.name) });
        }
      }
    }

    this.bindDeclaredCollections(
      (orbital.auxiliaryEntities ?? []).filter((ref): ref is Entity => typeof ref !== 'string' && !isEntityCall(ref)),
    );

    // Gap #22 — register + mock-seed auxiliary entities. These are imported
    // atom entities surfaced when a trait reference omits the `-> Entity`
    // rebind at the molecule's call site, registered on the resolved
    // schema's `auxiliaryEntities` field by the inline phase. Without this
    // block, `(fetch SearchResult ...)` from a trait whose linkedEntity is
    // an imported atom hits an unregistered persistence entry and returns
    // empty, breaking the entity-as-UI-state contract those slim atoms rely
    // on. Mock-mode seeding mirrors the primary entity branch above.
    const auxiliaryEntities = orbital.auxiliaryEntities;
    if (auxiliaryEntities !== undefined && !(this.config.mode === 'mock' && this.persistence instanceof MockPersistenceAdapter)) {
      const localAux = auxiliaryEntities.filter((ref): ref is Entity => typeof ref !== 'string' && !isEntityCall(ref) && ref.local === true);
      await seedBrowserStore(this.persistence, localAux);
    }
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
        if (auxEntity.local === true && auxEntity.seedMock !== true) continue;
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
          identity: auxEntity.identity,
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

  /** The adapters the kernel's I/O is answered with: this runtime's persistence, services and program host. */
  private httpPorts(egress: readonly string[] = this.resolvedSchema?.egress ?? []): HttpPorts | undefined {
    const options = this.config.http;
    return options === undefined ? undefined : createHttpPorts({ ...options, egress });
  }

  private kernelPorts(egress: readonly string[]): KernelHostPorts {
    const http = this.httpPorts(egress);
    return {
      ...(http !== undefined ? { http } : {}),
      ...(this.config.clock !== undefined ? { now: this.config.clock } : {}),
      ...(this.kernelOs !== undefined ? { os: this.kernelOs } : {}),
      ...(this.kernelOs !== undefined && this.config.kernel !== undefined ? { osCompletions: kernelOsCompletions(this.config.kernel) } : {}),
      persistence: this.persistence,
      inFlightCalls: this.inFlightCalls,
      callService: (service, action, params, context) => {
        const provider = this.config.effectHandlers?.callService;
        if (provider !== undefined) return provider(service, action, params, context);
        if (this.config.mode === 'mock') return mockCallService(service, action);
        return defaultCallService(service, action, params, context);
      },
      programEffect: () => this.config.effectHandlers?.programEffect,
      servicePorts: (caller, user, message) => this.servicePorts(caller, user, message),
      deliverLive: (site, payload, originClientId) => this.deliverLiveMessage(site, payload, originClientId),
      deferCallOutcome: () => this.hostDispatchSink === null ? undefined : (call) => this.runDeferredOutcome(call.orbital, {
        event: call.event,
        ...(call.payload !== undefined ? { payload: call.payload } : {}),
        targetTrait: call.traitName,
        ...(call.entityId !== undefined ? { entityId: call.entityId } : {}),
        ...(call.originClientId !== undefined ? { clientId: call.originClientId } : {}),
        ...(call.user !== undefined ? { user: call.user } : {}),
        ...(call.locale !== undefined ? { locale: call.locale } : {}),
      }),
    };
  }

  /** One live message of a running `call-service`, stamped as its calling trait, to the requesting tab only. */
  private deliverLiveMessage(site: { orbital: string; trait: string; event: string }, payload: EventPayload, originClientId: string | undefined): void {
    const registered = this.orbitals.get(site.orbital);
    const callingTrait = registered?.traits.find((t) => t.name === site.trait);
    const stamp = stampEmitSource(undefined, {
      orbitalName: site.orbital,
      traitName: site.trait,
      orbitalId: registered?.schema.id,
      traitId: callingTrait?.id,
      emitContractEventId: callingTrait?.emits?.find((e) => e.event === site.event)?.eventId,
      originClientId,
    });
    this.eventBus.emit(site.event, payload, stamp, eventRouteKey(site.event, stamp.eventId));
    this.liveBroadcastSink?.({ event: site.event, payload, source: stamp, originClientId, target: 'origin' });
  }

  /** The kernel module this runtime runs on: the one the host handed in, else the installed `@almadar/kernel`. */
  private async kernelModule(): Promise<KernelModule> {
    if (this.config.kernel !== undefined) return this.config.kernel;
    const { loadInstalledKernel } = await import('../kernel/load-node.js');
    this.config.kernel = await loadInstalledKernel();
    return this.config.kernel;
  }

  /** (Re)open the kernel on the program just registered. */
  private async openKernel(registered: OrbitalSchema): Promise<void> {
    const kernel = await this.kernelModule();
    const schema: OrbitalSchema = { ...registered, orbitals: inlineTraitRefs(registered.orbitals) };
    for (const orbital of schema.orbitals) {
      for (const trait of orbital.traits ?? []) {
        if (typeof trait === 'object' && 'ref' in trait && !('stateMachine' in trait)) {
          throw new Error(`OrbitalServerRuntime: the kernel takes an orb-resolved program, but trait "${trait.ref}" of orbital "${orbital.name}" is still a reference`);
        }
      }
    }
    this.kernelEngine?.dispose();
    this.kernelOs?.close();
    this.kernelOs = this.config.osHost?.(kernelOsGrants(kernel, () => this.requireKernelEngine()));
    this.kernelEngine = KernelEngine.open(kernel, schema, this.kernelPorts(registered.egress ?? []));
    this.kernelEngine.setMessages(this.appLocales, this.messages);
    this.seedKernelRuntimeMock();
    this.syncTickMount();
  }

  /** A mock store seeds every entity; the `[runtime]` rows the kernel holds itself are seeded in the kernel. */
  private seedKernelRuntimeMock(): void {
    if (this.config.mode !== 'mock' || !(this.persistence instanceof MockPersistenceAdapter)) return;
    this.kernelEngine?.seedRuntimeMock(this.config.defaultUser?.id);
  }

  private requireKernelEngine(): KernelEngine {
    if (this.kernelEngine === null) throw new Error('OrbitalServerRuntime: an os ask arrived with no kernel program registered');
    return this.kernelEngine;
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
          this.registerTick(orbitalName, trait.name, tick);
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
        void this.executeTick(orbitalName, traitName, tick);
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
      void this.executeTick(orbitalName, traitName, tick);
    });

    this.tickBindings.push({
      orbitalName,
      traitName,
      tick,
      handle,
    });
  }

  /** A tick: the host owns the timer, the kernel decides whether and over which rows it fires. */
  private async executeTick(orbitalName: string, traitName: string, tick: RuntimeTraitTick): Promise<void> {
    const response = await this.processOrbitalEvent(orbitalName, {
      event: tickEventKey(tick.name),
      runTick: { trait: traitName, tick: tick.name },
      targetTrait: traitName,
    });
    if (!response.success) {
      effectLog.error('tick:execute-error', { tick: tick.name, error: response.error ?? 'the kernel refused the tick' });
    }
  }

  /** Tell the kernel which traits some client has mounted, so it can pause the other traits' ticks. */
  private syncTickMount(): void {
    if (this.kernelEngine === null) return;
    const traits = new Set<string>();
    for (const key of this.mountedBy.keys()) traits.add(key.split('::')[1] ?? '');
    this.kernelEngine.setTickMount([...traits]);
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
    const traits = request.mount !== undefined
      ? request.mount.map((m) => m.trait)
      : request.targetTrait !== undefined ? [request.targetTrait] : (request.traits ?? []).map((t) => t.trait);
    for (const traitName of traits) {
      const key = `${orbitalName}::${traitName}`;
      const clients = this.mountedBy.get(key) ?? new Set<string>();
      if (mounted) clients.add(client);
      else clients.delete(client);
      if (clients.size > 0) this.mountedBy.set(key, clients);
      else this.mountedBy.delete(key);
    }
    this.syncTickMount();
  }

  /** Drop every mount a disconnected client held, so its traits' mount-scoped ticks pause. */
  releaseClient(clientId: string): void {
    for (const [key, clients] of this.mountedBy) {
      clients.delete(clientId);
      if (clients.size === 0) this.mountedBy.delete(key);
    }
    this.syncTickMount();
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
    this.kernelEngine?.dispose();
    this.kernelEngine = null;
    this.kernelOs?.close();
    this.kernelOs = undefined;
    this.eventBus.clear();
    this.messages = {};
    this.appLocales = [];

    // Clear mock persistence so the next registerFromFile re-seeds from
    // the schema instead of inheriting rows the previous walk created.
    // Without this, runtime-verify's state walk keeps every SAVE's
    // persist-create row across test sessions — the grid accumulates
    // "Mock name" rows that are never pruned, and empty cards from
    // partial walk-step payloads stay visible forever.
    if (this.persistence instanceof MockPersistenceAdapter) {
      this.persistence.clearAll();
    }

    this.programHandlersPromise = null;

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
    if (this.resolvedSchema) this.seedIdentityEntity(this.resolvedSchema);
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
          identity: entity.identity,
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
          identity: auxRef.identity,
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
    this.kernelEngine?.reset();
    this.seedKernelRuntimeMock();
    this.kernelOs?.close();
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

  /** Wire where a host-run dispatch's result goes (see `HostDispatchItem`); a fresh call replaces the previous sink. */
  setHostDispatchSink(sink: (item: HostDispatchItem) => void): void {
    this.hostDispatchSink = sink;
  }

  /** Run a follow-on step's call outcome as its own dispatch, and hand its result to the host-dispatch sink. */
  private runDeferredOutcome(orbitalName: string, request: OrbitalEventRequest): void {
    void this.processOrbitalEvent(orbitalName, request).then(
      (response) => this.hostDispatchSink?.({ orbitalName, request, response, ...(request.clientId !== undefined ? { originClientId: request.clientId } : {}) }),
      (error: Error) => effectLog.error('deferred-outcome:failed', { orbitalName, event: request.event, trait: request.targetTrait, error: error.message }),
    );
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
    this.viewerNamedByHost = true;
    if (
      this.persistence instanceof MockPersistenceAdapter &&
      user?.id !== undefined &&
      user.id !== previousId
    ) {
      this.restampOwnerGated(user);
    }
  }

  /** Whether the host named the viewer (constructor or `setDefaultUser`). If not, the viewer is
   *  the app's first declared persona, resolved as soon as its roster is seeded. */
  private viewerNamedByHost = false;

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
   * gate — the authority on who may author a row, unless `@read` scopes the
   * owner column by ownership (then its owner-readers own the rows). Consulted by BOTH
   * `restampOwner` (persona switches) and `seed()` (a client connect
   * re-registers, and the deterministic reseed re-stamps with the current
   * ownerId — gating only the switch path would leak right there). Reads the
   * CURRENT default user at evaluation time so one installation covers every
   * later switch. Installed before the first seed, so the initial rows are
   * gated exactly as every reseed is.
   */
  private installOwnerGate(schema: OrbitalSchema): void {
    if (!(this.persistence instanceof MockPersistenceAdapter)) return;
    installPolicyOwnerGates(this.persistence, schema, () => this.config.defaultUser);
  }


  /** Flush a persona switch that arrived before the schema was resolved. */
  private flushPendingOwnerRestamp(): void {
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
      target: 'peers',
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
  /**
   * `@user` for an HTTP request: the user the host's auth middleware verified (`req.authUser`),
   * resolved against the program's `[identity]` entity, or the anonymous viewer; a tool runtime's
   * declared `principal` instead. A request never borrows `config.defaultUser`.
   */
  async viewerOf(verified: VerifiedUser | undefined): Promise<UserContext> {
    if (this.config.principal !== undefined) return this.config.principal;
    const source = this.resolvedSchema ? identitySourceOf(this.resolvedSchema) : { kind: 'none' as const };
    return resolveViewer(verified ?? null, source, this.persistence);
  }

  /**
   * `reference` resolved for `user` against the store as it is now: the rows that still match its query and the
   * viewer's `@read`, in the reference's order, `total` re-counted. The kernel resolves through its server
   * resolve flight. A client reaches it with
   * `POST /:orbital/../resolve-rows` as the signed-in viewer.
   */
  async resolveRows(reference: RowSetRef, user: UserContext): Promise<RowQueryPage> {
    const schema = this.resolvedSchema;
    const owner = schema?.orbitals.find((orbital) => orbitalInlineEntities(orbital).some((entity) => entity.name === reference.entityType));
    if (schema === null || owner === undefined) throw new Error(`${reference.entityType}: no registered orbital declares this entity`);
    return this.requireKernelEngine().resolveRows(reference, { orbital: owner.name, user });
  }

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

  /** The registered orbitals as `GET /` lists them. */
  listOrbitalSummaries(): OrbitalSummary[] {
    return Array.from(this.orbitals.entries()).map(([name, reg]) => ({
      name,
      entity: reg.entity?.name,
      traits: (reg.traits || []).map((t) => t.name),
    }));
  }

  /** One orbital as `GET /:orbital` describes it, awaiting an in-flight swap first (G-RUNTIME-038); `undefined` when it is not registered. */
  async describeOrbital(orbitalName: string): Promise<OrbitalInfo | undefined> {
    const registered = await this.resolveRegisteredOrbital(orbitalName);
    if (!registered) return undefined;
    const states: Record<string, string> = {};
    for (const trait of registered.traits) {
      const currentState = this.kernelEngine?.stateOf(trait.name) ?? '';
      if (currentState !== '') states[trait.name] = currentState;
    }
    return {
      name: orbitalName,
      entity: registered.entity,
      traits: registered.traits.map((t) => ({
        name: t.name,
        currentState: states[t.name],
        states: (t.stateMachine?.states || []).map((s) => s.name),
        events: [...new Set((t.stateMachine?.transitions || []).map((tr) => tr.event))],
      })),
    };
  }

  /** An entity's full row set as `GET /:orbital/entities/:entityType` answers it (verification and tooling only); `undefined` when the orbital is not registered. */
  async entityRows(orbitalName: string, entityType: string): Promise<EntityRow[] | undefined> {
    const registered = await this.resolveRegisteredOrbital(orbitalName);
    if (!registered) return undefined;
    return this.persistence.list(entityType);
  }

  /** The program's declared external inputs: what an outside client may send which trait. */
  listExternalInputs(): ExternalInput[] {
    return this.resolvedSchema ? externalInputsOf(this.resolvedSchema) : [];
  }

  /**
   * The outside-client input channel: an API caller, an agent acting as the
   * user, an MCP client. Only a declared external input of the target trait is
   * dispatched — through `processOrbitalEvent`, so guards, entity policies and
   * cascades apply exactly as for a click. Anything else is refused with
   * `not-an-external-input`. The app's own UI keeps using `processOrbitalEvent`.
   */
  /**
   * The running app lent to one `call-service` provider as the caller: the
   * declared inputs, the input channel as `user`, and the rows `user` may read
   * (the entity's `@read` policy, the same rule a `fetch` effect applies).
   */
  servicePorts(
    caller: { orbital: string; trait: string },
    user: UserContext | undefined,
    message: (payload: EventPayload) => void = () => {},
  ): ServiceHostPorts {
    return {
      caller,
      message,
      inputs: () => this.listExternalInputs(),
      readableEntities: () => (this.resolvedSchema ? readableEntitiesOf(this.resolvedSchema) : []),
      dispatchInput: (orbital, request) =>
        this.dispatchExternalInput(orbital, { ...request, ...(user !== undefined ? { user } : {}) }),
      read: async (entity) => {
        const readPolicy = this.resolvedSchema ? entityAccessPolicies(this.resolvedSchema, entity)?.read : undefined;
        return applyRowAccess(await this.persistence.list(entity), readPolicy, undefined, { user });
      },
    };
  }

  async dispatchExternalInput(
    orbitalName: string,
    request: ExternalInputRequest,
    onPush?: (item: PushItem) => void,
  ): Promise<OrbitalEventResponse> {
    return dispatchDeclaredInput(this.resolvedSchema, orbitalName, request, (orbital, req) => this.processOrbitalEvent(orbital, req, onPush));
  }

  /**
   * An inbound delivery (`/api/hooks/<name>`): the runtime decides whether the name is served, runs
   * the handler through `processOrbitalEvent` and answers; the host only carries the bytes.
   */
  /**
   * An event that is an inbound hook's is delivered only by `deliverInbound`: the app's own event
   * route refuses it, as the input channel refuses an event that is no declared input.
   */
  refuseInboundOnly(orbitalName: string, request: Pick<OrbitalEventRequest, 'event' | 'targetTrait'>): OrbitalEventResponse | undefined {
    const trait = this.resolvedSchema ? inboundOnlyTrait(this.resolvedSchema, orbitalName, request.targetTrait, request.event) : undefined;
    if (trait === undefined) return undefined;
    return {
      success: false,
      transitioned: false,
      states: {},
      emittedEvents: [],
      error: inboundOnlyMessage(trait, request.event),
      rejections: [{ code: 'inbound-only-event', trait, event: request.event }],
    };
  }

  async deliverInbound(name: string, delivery: InboundDelivery, onPush?: (item: PushItem) => void): Promise<InboundAnswer> {
    return dispatchInbound(this.resolvedSchema, name, delivery, (orbital, req) => this.processOrbitalEvent(orbital, req, onPush), (credential) => (this.httpPorts()?.secrets ?? createHttpSecrets()).get(credential, undefined));
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
    // Wire substrate effect handlers before any effect runs.
    await this.ensureProgramHandlers();

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
    if (request.mount !== undefined || (LIFECYCLE_EVENTS as readonly string[]).includes(request.event)) {
      this.recordMount(orbitalName, request, true);
    }

    const response = await this.enqueueEvent((queueHold) =>
      this.evaluateForOrbital(registered, request, onPush, queueHold),
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
    queueHold?: EventQueueHold,
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
      traitStates: JSON.stringify(registered.traits.map((trait) => ({ traitName: trait.name, currentState: this.kernelEngine?.stateOf(trait.name) ?? '' }))),
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
    if (request.locale !== undefined && this.appLocales.length > 0 && !this.appLocales.includes(request.locale)) {
      throw new Error(`locale "${request.locale}" is not one of the program's declared locales [${this.appLocales.join(', ')}]`);
    }

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
    const isDelegatedLeg = (request.targetTrait !== undefined || request.mount !== undefined) &&
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
    const response = await evaluateOnKernel(
      { engine: this.requireKernelEngine(), orbital: registered.schema.name, outsideEventQueue: <T,>(work: () => Promise<T>): Promise<T> => this.outsideEventQueue(queueHold, work) },
      serverRequest,
      viewer,
      request.locale,
    );

    // The kernel's cascade already crosses orbitals: there is nothing for the host to relay.
    this.publishKernelResponse(response, onPush, request.clientId);
    return response;
  }

  /**
   * Feed the host sinks from a kernel response: the kernel answers a dispatch whole, so each emit reaches the
   * event bus (the public firehose) and `onPush` once the dispatch is done, in the order the response carries them.
   */
  private publishKernelResponse(response: OrbitalEventResponse, onPush: ((item: PushItem) => void) | undefined, originClientId?: string): void {
    for (const hop of response.transitions ?? []) {
      this.transitionFanout.onTransition({ traitName: hop.trait, from: hop.from, to: hop.to, event: hop.event, ...(hop.guardResult !== undefined ? { guardResult: hop.guardResult } : {}), effects: hop.effects });
    }
    for (const emitted of response.emittedEvents) {
      this.eventBus.emit(emitted.event, emitted.payload, emitted.source, eventRouteKey(emitted.event, emitted.source?.eventId));
      if (emitted.source?.persistSuccess === true) {
        const { persistSuccess: _mark, ...source } = emitted.source;
        this.liveBroadcastSink?.({ event: emitted.event, ...(emitted.payload !== undefined ? { payload: emitted.payload } : {}), source, ...(originClientId !== undefined ? { originClientId } : {}), target: 'peers' });
      }
      onPush?.({ type: 'event', data: emitted });
    }
    for (const effect of response.clientEffects ?? []) onPush?.({ type: 'effect', data: effect });
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

  /** This app's in-flight keyed `call-service`s, shared by every transition it runs (`cancel-call`). */
  private readonly inFlightCalls = new InFlightCalls();

  /** Wait for the queue, then hold it until the returned release is called. FIFO. */
  private acquireEventQueue(): Promise<() => void> {
    const previous = this.eventQueue;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.eventQueue = previous.then(() => held);
    return previous.then(() => release);
  }

  /**
   * Hold the queue for `run`, handing it the hold so the work it reaches can
   * release it (`outsideEventQueue`). The hold is passed explicitly rather than
   * carried in async context: this runtime also runs in the browser (the orb
   * website), which has no AsyncLocalStorage.
   */
  private async enqueueEvent<T>(run: (hold: EventQueueHold) => Promise<T>): Promise<T> {
    const hold: EventQueueHold = { held: true, release: await this.acquireEventQueue() };
    try {
      return await run(hold);
    } finally {
      if (hold.held) hold.release();
    }
  }

  /**
   * Run `work` with this context's queue hold released, then re-acquire it (in
   * FIFO order behind whatever queued meanwhile). Dispatches that land while
   * released run as their own dispatches; their commits and the held run's
   * later commit follow server-arrival last-write-wins. Outside a hold, `work`
   * just runs.
   */
  private async outsideEventQueue<T>(hold: EventQueueHold | undefined, work: () => Promise<T>): Promise<T> {
    if (hold === undefined || !hold.held) return work();
    hold.held = false;
    hold.release();
    try {
      return await work();
    } finally {
      hold.release = await this.acquireEventQueue();
      hold.held = true;
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
      res.json({ success: true, orbitals: this.listOrbitalSummaries() });
    });

    // Declared external inputs (before `/:orbital`, which would capture "inputs").
    router.get("/inputs", (_req: Request, res: Response) => {
      res.json({ success: true, inputs: this.listExternalInputs() });
    });

    // Outside-client input channel: only a declared external input, as the
    // authenticated user — a `user` in the body is never trusted.
    router.post("/:orbital/inputs", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orbitalName = req.params.orbital as string;
        const user = await this.viewerOf(req.authUser);
        const body = req.body as Partial<ExternalInputRequest>;
        const result = await this.dispatchExternalInput(orbitalName, {
          targetTrait: String(body.targetTrait ?? ""),
          event: String(body.event ?? ""),
          ...(body.payload !== undefined ? { payload: body.payload } : {}),
          ...(body.entityId !== undefined ? { entityId: body.entityId } : {}),
          user,
        });
        const refused = result.rejections?.some((r) => r.code === "not-an-external-input") === true;
        res.status(refused ? 403 : 200).json(result);
      } catch (error) {
        next(error);
      }
    });

    // Get orbital info
    router.get("/:orbital", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orbital = await this.describeOrbital(req.params.orbital as string);
        if (!orbital) {
          res.status(404).json({ success: false, error: "Orbital not found" });
          return;
        }
        res.json({ success: true, orbital });
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
      const entityType = req.params.entityType as string;
      this.entityRows(req.params.orbital as string, entityType)
        .then((rows) => {
          if (!rows) {
            res.status(404).json({ success: false, error: "Orbital not found" });
            return;
          }
          res.json({ success: true, entityType, rows });
        })
        .catch(next);
    });

    // A row-set reference resolved for the signed-in viewer (rows-by-reference markers on a server-hosted store).
    router.post("/resolve-rows", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = RowSetRefSchema.safeParse(req.body?.ref);
        if (!parsed.success) {
          res.status(400).json({ success: false, error: parsed.error.message });
          return;
        }
        const user = await this.viewerOf(req.authUser);
        res.json(await this.resolveRows(parsed.data, user));
      } catch (error) {
        next(error);
      }
    });

    // Send event to orbital - this is the ONLY data access point
    // All reads go through `fetch` effects with guard enforcement
    // All writes go through `persist` effects with guard enforcement
    router.post(
      "/:orbital/events",
      async (req: Request, res: Response, next: NextFunction) => {
        const refusal = this.refuseInboundOnly(req.params.orbital as string, req.body as OrbitalEventRequest);
        if (refusal !== undefined) {
          res.status(403).json(refusal);
          return;
        }
        const wantsStream =
          req.query['stream'] === 'true' ||
          (req.headers['accept'] ?? '').includes('text/event-stream');

        if (!wantsStream) {
          try {
            const orbitalName = req.params.orbital as string;
            const user = await this.viewerOf(req.authUser);
            const result = await this.processOrbitalEvent(orbitalName, { ...req.body, user });
            res.json(result);
          } catch (error) {
            next(error);
          }
          return;
        }

        // SSE streaming path — true incremental: each emitted event or client
        // effect is written to the stream immediately via onPush as it fires,
        // before processOrbitalEvent resolves.
        setupSSE(res);
        try {
          const orbitalName = req.params.orbital as string;
          const user = await this.viewerOf(req.authUser);

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

  /** Observe every executed hop (listener deliveries included) on every orbital; returns the unsubscribe. */
  observeTransitions(observer: TransitionObserver): () => void {
    this.transitionObservers.add(observer);
    return () => { this.transitionObservers.delete(observer); };
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

    const kernel = this.kernelEngine;
    if (kernel === null) return undefined;
    const stateOf = (name: string): TraitState | undefined => {
      const currentState = kernel.stateOf(name);
      return currentState === '' ? undefined : { traitName: name, currentState, previousState: null, lastEvent: null, context: {} };
    };
    if (traitName) return stateOf(traitName);
    const states: Record<string, TraitState> = {};
    for (const trait of registered.traits) {
      const state = stateOf(trait.name);
      if (state !== undefined) states[trait.name] = state;
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

declare global {
  namespace Express {
    interface Request {
      authUser?: VerifiedUser;
    }
  }
}
