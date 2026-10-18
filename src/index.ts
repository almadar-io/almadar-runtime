/**
 * Unified Runtime - Platform-Agnostic Trait Execution Core
 *
 * This module exports the shared runtime components that can be used
 * on both client (browser) and server (Node.js) environments.
 *
 * NOTE: Server-only modules (OrbitalServerRuntime, ServerBridge) are NOT exported here
 * because they import Node.js dependencies (express) that cannot run in browsers.
 * Import them directly when needed:
 *   import { OrbitalServerRuntime } from '@kflow-builder/shared/runtime/OrbitalServerRuntime.js';
 *   import { ServerBridge } from '@kflow-builder/shared/runtime/ServerBridge.js';
 *
 * @packageDocumentation
 */

// Types
export type {
  RuntimeEvent,
  EventListener,
  Unsubscribe,
  IEventBus,
  TraitState,
  TransitionResult,
  TraitDefinition,
  EffectHandlers,
  HttpEffectReport,
  BrowserFileMeta,
  BrowserFilePickerOptions,
  BrowserGeolocationOptions,
  BrowserGeolocationPosition,
  BindingContext,
  ConfigContext,
  Effect,
  EffectContext,
  EffectResult,
  RuntimeConfig,
  ExecutionEnvironment,
  TransitionObserver,
  RollbackCause,
  EvaluationContextExtensions,
  ServiceCallContext,
} from "./types.js";

// Constants
export { HANDLER_MANIFEST, isEffectTuple } from "./types.js";
export type { EntityRow } from "./types.js";

// EventBus
export { EventBus } from "./events/EventBus.js";

// TickScheduler — coalesced tick clock, client-safe (falls back off rAF in Node/SSR)
export { TickScheduler, createTickScheduler, type TickHandle } from "./time/TickScheduler.js";

// Cron — the one canonical cron parser/matcher every tick-scheduling engine delegates to
export {
  parseCron,
  parseCronField,
  isValidCronExpression,
  cronMatches,
  cronMinuteKey,
  type CronFields,
} from "./time/cron.js";

// Duration strings ('5s'/'1m'/'1h') — the other tick-interval shape, alongside cron
export { parseDurationString, isValidDurationString } from "./time/duration.js";


// The client's record of each trait's state, as the kernel reports it
export {
  findInitialState,
  createInitialTraitState,
  findMatchingTransitions,
  findTransition,
  normalizeEventKey,
  tickEventKey,
  StateBook,
  LIFECYCLE_EVENTS,
  UNMOUNT_EVENT,
} from "./traits/state-book.js";


// identity/routing — `listens {}` source-matching (`parseListenSource`),
// shared by OrbitalServerRuntime's cross-trait fan-out and any
// stateless-server caller building the same cross-orbital cascade (Fix A2).
export {
  eventRouteKey,
  buildSourceMatcher,
  parseListenSource,
  type ListenSourceDescriptor,
  type RouteSourceMeta,
} from "./events/identity/routing.js";

// trait-index — the ONE per-trait evaluation index builder (resolved
// linkedEntity, merged config, frame keys, V4 ids) shared by the unified
// browser client and the hosts.
export {
  browserLegEvents,
  buildTraitIndex,
  buildTraitIndexForOrbital,
  type IndexedTrait,
  type TraitIndexOptions,
  type TraitIndex,
} from "./traits/trait-index.js";

// emit-stamp — the ONE emit-source stamper (V4 identity triple +
// originClientId); G-RUNTIME-030's hole stays closed by having one owner.
export {
  stampEmitSource,
  type StampEmitIdentity,
} from "./events/emit-stamp.js";

// The traits whose `listens` react to an emit the bus carries outside a kernel dispatch
export { collectListenerTargets, type CollectedListenerTarget } from "./traits/listen-targets.js";


export { InFlightCalls, type KeyedCallOutcome } from "./effects/in-flight-calls.js";
export { embedOnDevice, onDeviceHandlers, OnDeviceModelFailure, promptOnDevice } from "./effects/on-device-model.js";



// Client-role server leg (P3) and the one event transport (P5)
export { ServerLegCollector, type EffectDelegate, type DelegateTarget } from "./effects/server-leg.js";
export {
  createHttpTransport,
  createInProcessTransport,
  deriveCarriesCircuitState,
  encodeJsonBody,
  COMPRESSED_BODY_MIN_BYTES,
  type EventTransport,
  type PushTarget,
  type HostDispatchListener,
  type EventTransportRegisterResult,
  type AccessTokenProvider,
  type HttpTransportOptions,
  type InProcessTransportOptions,
  type OrbitalEvaluator,
} from "./server/EventTransport.js";

// The one resolve of a row-set reference against a store (browser store resolver in `@almadar/ui`, JS server engine).
export { resolveRowSetFromStore, resolveRowSetFromRows, type RowSetStore } from "./effects/row-set-resolve.js";

// CircuitStore — the browser client's trait states and frames; `snapshot`/`restore` back an optimistic rollback.
export {
  createMemoryCircuitStore,
  type CircuitStore,
  type TraitSnapshot,
} from "./evaluation/circuit-store.js";

// The client-kernel contract `@almadar/ui`'s kernel client implements.
export type {
  ClientDispatchHooks,
  ClientKernel,
  ClientKernelOutcome,
  ClientMountHooks,
  ClientMountOutcome,
} from "./evaluation/client-kernel.js";
export { TraitMountError } from "./evaluation/trait-mount-error.js";

// Re-export types for server modules (for type-only imports in client code)
export type {
  RuntimeOrbitalSchema,
  RuntimeOrbital,
  RuntimeTrait,
  RegisteredOrbital,
  OrbitalEventRequest,
  OrbitalEventResponse,
  OrbitalServerRuntimeConfig,
} from "./server/OrbitalServerRuntime.js";

// Trait config-defaults extractor — used by client-side state machines
// (`@almadar/ui` useTraitStateMachine) to merge declared `config { }`
// defaults into the @config.X binding context, mirroring the server-side
// merge in OrbitalServerRuntime.executeEffects. Lives in the browser-safe
// `./traits/config-defaults.js` (NOT OrbitalServerRuntime.js, which top-level-imports
// node `module`) precisely so this browser consumer doesn't pull node code.
export { collectDeclaredConfigDefaults, collectDeclaredEntityDefaults, normalizeCallSiteConfigToValues } from "./traits/config-defaults.js";

// `[persistent: x, local]` entities: the browser store seed rule and the
// transports that run their data in-process (the adapters live in `@almadar/db`).
export { seedBrowserStore } from "./entities/seedBrowserStore.js";
export { createLocalStoreTransport, localStorePersistence, openLocalKernel, type LocalKernelOptions } from "./evaluation/local-store-transport.js";
export { dispatchDeclaredInput } from "./evaluation/declared-input-dispatch.js";
export { dispatchInbound } from "./evaluation/inbound-dispatch.js";
export { createChannelTransport, holdUntilServed, serveChannel, type ChannelMessage, type ChannelTransportOptions, type ServedChannel, type TransportChannel } from "./server/channel-transport.js";
export type { LocalStoreTransportOptions } from "./evaluation/local-store-transport.js";
export { createResidenceTransport } from "./evaluation/residence-transport.js";
export type { ResidenceTransportOptions } from "./evaluation/residence-transport.js";
export { browserStoreName, openBrowserHost, openBrowserStore, openBrowserStoreTransport, openBundledBrowserStore } from "./evaluation/browser-store-transport.js";
export type { BrowserHost, BrowserHostOptions, BrowserStoreTransportOptions, InputDispatchListener } from "./evaluation/browser-store-transport.js";

// Resolved-schema → TraitDefinition[] parsing — extracted from
// OrbitalServerRuntime.registerOrbitalAsync so a stateless per-request
// caller (no OrbitalServerRuntime instance) can parse a schema the same way.
export {
  parseOrbitalTraits,
  findEntityAmongOrbitals,
  type ParsedOrbitalTraits,
} from "./traits/OrbitalTraitParsing.js";

export type { ServerBridgeConfig, ServerBridgeState } from "./server/ServerBridge.js";


// Payload Validation (RCG-10)
export {
  validatePayloadShapes,
  buildEmitsFromTraits,
  validateEventPayload,
  formatPayloadValidationError,
  type PayloadMismatch,
  type PayloadValidationFailure,
} from "./traits/PayloadValidator.js";

// Loader of resolved program files (lazy pages).
export {
  createUnifiedLoader,
  createHttpLoader,
  loadLazyPage,
  isBrowser,
  isElectron,
  isNode,
  type SchemaLoader,
  type LoadedSchema,
  type LoadedOrbital,
  type LoadResult,
  type ImportChainLike,
  type UnifiedLoaderOptions,
} from "./entities/loader/index.js";

// Composition (runtime-side TS implementation of behavior/* operators)
export * as composition from "./effects/composition/index.js";
export {
  composeBehaviors,
  applyEventWiring,
  detectLayoutStrategy,
  pipeBehaviors,
} from "./effects/composition/index.js";
export type {
  ComposeBehaviorsInput,
  ComposeBehaviorsResult,
  EventWiringEntry,
  LayoutStrategy,
  PipeStep,
} from "./effects/composition/index.js";

// Renderer-agnostic UI contract. React/Web Components/Vue renderers depend on
// this surface and implement the framework-specific pieces on top.
export * from "./ui/index.js";

export { AwaitingRegistry } from './evaluation/awaiting.js';

// Host ports: the encrypted credential store a host installs and the `call-service` providers it plugs in.
export * from "./host/credentials/index.js";
export { registerServiceProvider, unregisterServiceProvider, registeredServices, callRegisteredService, ServiceCallError, type ServiceCallErrorCode, type ServiceProvider } from "./host/service-provider.js";
export { callServiceByMode, defaultCallService, mockCallService } from "./effects/defaultCallService.js";
