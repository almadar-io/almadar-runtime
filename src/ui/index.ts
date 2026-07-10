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
} from './slots';
export { createSlotSetter } from './slots';

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
  clearPerf,
  pushPerfEntry,
  perfStore,
  type PerfEntry,
  type PerfDetail,
  type PerfDetailValue,
} from './perf';
