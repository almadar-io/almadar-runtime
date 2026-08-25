/**
 * @almadar/runtime/ui
 *
 * Renderer-agnostic UI contract and helpers. Any UI library that renders
 * Almadar orbital schemas depends on this surface and implements the
 * framework-specific pieces (component registry, slot state binding,
 * event wiring) on top of it.
 *
 * @packageDocumentation
 */

// Slot contract
export type {
  SlotContent,
  SlotSource,
  SlotManager,
  MultiSourceSlotManager,
} from './slots';
export {
  createSlotSetter,
  aggregateSlotContent,
  assertIsSlotManager,
  assertIsMultiSourceSlotManager,
  validateSlotContent,
} from './slots';

// Callback-prop wrapper for pattern event bindings
export { wrapCallbackForEvent } from './wrapCallbackForEvent';

// Preview/mock schema prep — pure schema + EntityData manipulation
export {
  buildMockData,
  adjustSchemaForMockData,
  prepareSchemaForPreview,
  type PreparedPreviewSchema,
} from './prepareSchemaForPreview';

// Trait → orbital mapping for qualified UI bus keys
export {
  buildOrbitalsByTrait,
  type ResolvedPageTraits,
} from './orbitalsByTrait';

// @trait.X static analysis for embed-aware routing
export {
  collectTraitRefsFromResolvedTrait,
  collectEmbeddedTraits,
} from './embedded-traits';

// Perf primitives (framework-free ring + timing)
export {
  PERF_NAMESPACE,
  perfStart,
  perfEnd,
  perfTime,
  perfTimeAsync,
  perfGauge,
  clearPerf,
  pushPerfEntry,
  perfStore,
  type PerfEntry,
  type PerfDetail,
  type PerfDetailValue,
} from './perf';

// Contract enforcement
export {
  RendererContractViolationError,
  type SlotContentValidationError,
} from './contract-errors';

// Renderer-agnostic `window.__orbitalVerification` bridge — every UI
// library populates the same observation point via these helpers so the
// Playwright verifiers stay renderer-blind.
export {
  ensureVerificationApi,
  getOrbitalVerification,
  bindEventBus,
  bindTraitStateGetter,
  type VerificationBus,
} from './verification';
