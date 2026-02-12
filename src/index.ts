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
} from "./types.js";

// EventBus
export { EventBus } from "./EventBus.js";

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
  OrbitalEventRequest,
  OrbitalEventResponse,
  OrbitalServerRuntimeConfig,
  PersistenceAdapter,
} from "./OrbitalServerRuntime.js";

export type { ServerBridgeConfig, ServerBridgeState } from "./ServerBridge.js";

export type {
  EntityField,
  EntitySchema,
  MockPersistenceConfig,
} from "./MockPersistenceAdapter.js";

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
