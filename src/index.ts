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
  BindingContext,
  Effect,
  EffectContext,
  EffectResult,
  RuntimeConfig,
  ExecutionEnvironment,
  TransitionObserver,
} from "./types.js";

// Constants
export { HANDLER_MANIFEST } from "./types.js";

// EventBus
export { EventBus } from "./EventBus.js";

// TickScheduler — coalesced tick clock, client-safe (falls back off rAF in Node/SSR)
export { TickScheduler, createTickScheduler, type TickHandle } from "./TickScheduler.js";

// Cron — the one canonical cron parser/matcher every tick-scheduling engine delegates to
export {
  parseCron,
  parseCronField,
  isValidCronExpression,
  cronMatches,
  cronMinuteKey,
  type CronFields,
} from "./cron.js";

// Duration strings ('5s'/'1m'/'1h') — the other tick-interval shape, alongside cron
export { parseDurationString, isValidDurationString } from "./duration.js";

// BindingResolver
export {
  interpolateProps,
  interpolateValue,
  containsBindings,
  extractBindings,
  createContextFromBindings,
  createMinimalContext,
  type EvaluationContext,
} from "./BindingResolver.js";

// StateMachineCore
export {
  findInitialState,
  createInitialTraitState,
  findTransition,
  normalizeEventKey,
  processEvent,
  StateMachineManager,
  type ProcessEventOptions,
} from "./StateMachineCore.js";

// EffectExecutor
export {
  EffectExecutor,
  createTestExecutor,
  type EffectExecutorOptions,
} from "./EffectExecutor.js";

// Client Effect Handlers Factory
export {
  createClientEffectHandlers,
  type CreateClientEffectHandlersOptions,
  type ClientEventBus,
  type SlotSetter,
} from "./ClientEffectHandlers.js";

// Re-export types for server modules (for type-only imports in client code)
export type {
  RuntimeOrbitalSchema,
  RuntimeOrbital,
  RuntimeTrait,
  RegisteredOrbital,
  OrbitalEventRequest,
  OrbitalEventResponse,
  OrbitalServerRuntimeConfig,
} from "./OrbitalServerRuntime.js";

// Trait config-defaults extractor — used by client-side state machines
// (`@almadar/ui` useTraitStateMachine) to merge declared `config { }`
// defaults into the @config.X binding context, mirroring the server-side
// merge in OrbitalServerRuntime.executeEffects. Lives in the browser-safe
// `./config-defaults.js` (NOT OrbitalServerRuntime.js, which top-level-imports
// node `module`) precisely so this browser consumer doesn't pull node code.
export { collectDeclaredConfigDefaults, collectDeclaredEntityDefaults, normalizeCallSiteConfigToValues } from "./config-defaults.js";

// Storage contract + in-memory default — extracted from OrbitalServerRuntime
// so browser-side mock runtimes can use the same adapter interface.
export type { PersistenceAdapter } from "./PersistenceAdapter.js";
export { InMemoryPersistence } from "./PersistenceAdapter.js";

// Mock-data persistence adapter (faker-seeded) — browser-safe, for use in
// offline previews (`OrbPreview autoMock`) or dev harnesses.
export { MockPersistenceAdapter, createMockPersistence } from "./MockPersistenceAdapter.js";

// Server-side effect handlers factory — the `fetch`/`persist`/`set`/`ref`/
// `deref`/`swap!`/`atomic`/`callService` layer. Mirrors the handlers built
// inline in `OrbitalServerRuntime.executeEffects` so client-side offline
// previews run the same semantics against an `InMemoryPersistence`.
export {
  createServerEffectHandlers,
  type CreateServerEffectHandlersOptions,
  type ServerEffectResult,
} from "./ServerEffectHandlers.js";

export type { ServerBridgeConfig, ServerBridgeState } from "./ServerBridge.js";

export type { OsHandlerContext, OsHandlerResult } from "./createOsHandlers.js";

export type {
  EntityField,
  EntitySchema,
  MockPersistenceConfig,
} from "./MockPersistenceAdapter.js";

// Payload Validation (RCG-10)
export {
  validatePayloadShapes,
  buildEmitsFromTraits,
  validateEventPayload,
  formatPayloadValidationError,
  type PayloadMismatch,
  type PayloadValidationFailure,
} from "./PayloadValidator.js";

// Uses Integration (for `uses` system)
export {
  preprocessSchema,
  getIsolatedCollectionName,
  getNamespacedEvent,
  isNamespacedEvent,
  parseNamespacedEvent,
  type PreprocessedSchema,
  type EntitySharingMap,
  type EventNamespaceMap,
  type PreprocessOptions,
  type PreprocessResult,
} from "./UsesIntegration.js";

// Loader (for registerWithPreprocess consumers who need to construct a
// custom SchemaLoader — e.g. to map std imports onto a non-standard
// on-disk layout).
export {
  createUnifiedLoader,
  isBrowser,
  isElectron,
  isNode,
  type SchemaLoader,
  type LoadedSchema,
  type LoadedOrbital,
  type LoadResult,
  type ImportChainLike,
  type UnifiedLoaderOptions,
} from "./loader/index.js";

// Composition (runtime-side TS implementation of behavior/* operators)
export * as composition from "./composition/index.js";
export {
  composeBehaviors,
  applyEventWiring,
  detectLayoutStrategy,
  pipeBehaviors,
} from "./composition/index.js";
export type {
  ComposeBehaviorsInput,
  ComposeBehaviorsResult,
  EventWiringEntry,
  LayoutStrategy,
  PipeStep,
} from "./composition/index.js";

// Renderer-agnostic UI contract. React/Web Components/Vue renderers depend on
// this surface and implement the framework-specific pieces on top.
export * from "./ui/index.js";
