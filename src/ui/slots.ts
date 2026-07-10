/**
 * Renderer-agnostic slot contract.
 *
 * Any UI library (React, Web Components, Vue, etc.) that wants to render an
 * Almadar orbital schema must provide an implementation of {@link SlotManager}.
 * The runtime itself is UI-framework blind: it only knows about UISlots and
 * pattern configs from @almadar/core.
 *
 * @packageDocumentation
 */

import type {
  UISlot,
  AnyPatternConfig,
  ResolvedPatternProps,
  EventSource,
  ResolvedTrait,
  SExpr,
} from '@almadar/core';

/**
 * Metadata that attributes a slot write to the trait/transition that produced it.
 *
 * Mirrors the shape previously in `@almadar/ui/types/slot-types`, but grounded
 * entirely in `@almadar/core` types so the contract lives in the runtime layer.
 */
export interface SlotSource extends EventSource {
  /** Trait that emitted the render-ui effect. */
  trait: string;
  /** State the trait was in when the effect fired. */
  state: string;
  /** Transition (or tick) that carried the effect. */
  transition: string;
  /** Effects executed during the transition. */
  effects: SExpr[];
  /** Resolved trait definition that owns the transition (optional attribution). */
  traitDefinition?: ResolvedTrait;
}

/**
 * One unit of content the runtime asks a renderer to place in a named slot.
 *
 * A `null` pattern means "clear this slot". Optional `props` carry resolved
 * pattern props (e.g. from a render-ui effect's 4th tuple element). `source`
 * is optional metadata for debug/verification attribution.
 */
export interface SlotContent {
  /** Target UI slot from the core UISlot union. */
  slot: UISlot;
  /** Pattern config to render, or null to clear the slot. */
  pattern: AnyPatternConfig | null;
  /** Resolved props merged on top of the pattern config. */
  props?: ResolvedPatternProps;
  /** Attribution metadata for tracing/debugging. */
  source?: SlotSource;
}

/**
 * Minimal slot-management contract every UI renderer must satisfy.
 *
 * The runtime's client effect handlers call `setContent`/`clearSlot` in
 * response to `render-ui` effects. The renderer owns the actual DOM/
 * component-tree update, subscription handling, and multi-source merging
 * policy (e.g. stacking N trait writes into one synthetic container).
 */
export interface SlotManager {
  /** Return the latest content for a slot, or undefined if empty. */
  getContent(slot: UISlot): SlotContent | undefined;

  /** Place (or replace) content for a slot. */
  setContent(content: SlotContent): void;

  /** Clear a slot by writing a null pattern. */
  clearSlot(slot: UISlot): void;

  /** Snapshot of all currently populated slots. */
  getAllSlots(): ReadonlyMap<UISlot, SlotContent>;

  /** Subscribe to slot changes. Returns an unsubscribe function. */
  subscribe(listener: (slot: UISlot, content: SlotContent | undefined) => void): () => void;
}

/**
 * Extended slot manager contract that supports the multi-source aggregation
 * and per-trait sidecar model used by the React `useUISlots` implementation.
 *
 * Renderers that need to support `@trait.X` embedding and multiple traits
 * writing the same slot should implement this interface. The base
 * {@link SlotManager} remains the minimal contract for simple renderers.
 */
export interface MultiSourceSlotManager extends SlotManager {
  /** Return the latest content a given trait rendered, or undefined if none. */
  getTraitContent(traitName: string): SlotContent | undefined;

  /** Subscribe to changes in a specific trait's render output. */
  subscribeTrait(
    traitName: string,
    listener: (content: SlotContent | undefined) => void,
  ): () => void;

  /**
   * Update the per-trait sidecar without writing to a slot.
   *
   * Used for embed-aware routing: when a trait is referenced via `@trait.X` by
   * a sibling layout, its render output should not stack into the layout's
   * slot; instead the layout embeds the trait's frame and the sidecar keeps
   * the trait's latest frame queryable.
   */
  updateTraitContent(traitName: string, content: Omit<SlotContent, 'source'>): void;
}

/**
 * Aggregate a slot's per-source content map into a single {@link SlotContent}.
 *
 * - 0 sources → `undefined` (empty slot).
 * - 1 source → that source's content verbatim.
 * - 2+ sources → a synthetic `stack` wrapper whose `children` are the
 *   pattern configs of each source in insertion order.
 *
 * This mirrors the React `useUISlots` aggregation behavior and is provided so
 * every renderer implements the same multi-source semantics.
 */
export function aggregateSlotContent(
  slot: UISlot,
  sources: ReadonlyMap<string, SlotContent>,
): SlotContent | undefined {
  const entries = Array.from(sources.values());
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0];

  const sourceKeys = Array.from(sources.keys());
  const children = entries.map((entry) => ({
    type: entry.pattern?.type ?? 'box',
    ...entry.props,
  }));

  return {
    slot,
    pattern: { type: 'stack', direction: 'vertical', gap: 'lg', children },
    props: { direction: 'vertical', gap: 'lg', children },
    source: entries[0].source,
  };
}

// ============================================================================
// Contract validators
// ============================================================================

import {
  RendererContractViolationError,
  type SlotContentValidationError,
} from './contract-errors.js';

/**
 * Internal reflection surface used only by contract validators. This is the
 * one place an open key/value type is unavoidable because we are inspecting
 * an arbitrary runtime value; it is not exposed in public APIs.
 */
interface ReflectedObject {
  [key: string]: unknown;
}

function isNonNullObject(value: unknown): value is ReflectedObject {
  return typeof value === 'object' && value !== null;
}

function assertHasFunctionMethods(
  label: string,
  value: ReflectedObject,
  methods: readonly string[],
): void {
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new RendererContractViolationError(`${label}.${method} must be a function`);
    }
  }
}

/**
 * Assert that a value satisfies the {@link SlotManager} contract at runtime.
 *
 * @throws RendererContractViolationError when the value is not a valid manager.
 */
export function assertIsSlotManager(value: unknown): asserts value is SlotManager {
  if (!isNonNullObject(value)) {
    throw new RendererContractViolationError('SlotManager must be a non-null object');
  }

  assertHasFunctionMethods('SlotManager', value, [
    'getContent',
    'setContent',
    'clearSlot',
    'getAllSlots',
    'subscribe',
  ]);
}

/**
 * Assert that a value satisfies the {@link MultiSourceSlotManager} contract.
 *
 * @throws RendererContractViolationError when the value is not a valid manager.
 */
export function assertIsMultiSourceSlotManager(
  value: unknown,
): asserts value is MultiSourceSlotManager {
  if (!isNonNullObject(value)) {
    throw new RendererContractViolationError('MultiSourceSlotManager must be a non-null object');
  }

  assertHasFunctionMethods('SlotManager', value, [
    'getContent',
    'setContent',
    'clearSlot',
    'getAllSlots',
    'subscribe',
  ]);
  assertHasFunctionMethods('MultiSourceSlotManager', value, [
    'getTraitContent',
    'subscribeTrait',
    'updateTraitContent',
  ]);
}

/**
 * Validate that a {@link SlotContent} value satisfies the runtime contract.
 *
 * Returns an array of validation errors; an empty array means the value is
 * valid. This lets renderer authors surface contract failures without
 * exceptions.
 */
export function validateSlotContent(content: SlotContent): SlotContentValidationError[] {
  const errors: SlotContentValidationError[] = [];

  if (content.slot === undefined || content.slot === null) {
    errors.push({ message: 'SlotContent.slot is required', path: 'slot' });
  }

  if (!('pattern' in content)) {
    errors.push({ message: 'SlotContent.pattern is required', path: 'pattern' });
  }

  return errors;
}

/**
 * Minimal adapter that turns a `SlotManager` into the shape expected by
 * {@link createClientEffectHandlers} in `ClientEffectHandlers.ts`.
 *
 * This keeps the legacy `SlotSetter.addPattern/clearSlot` surface working while
 * nudging new renderers toward the fuller `SlotManager` contract.
 */
export function createSlotSetter(manager: SlotManager): {
  addPattern: (slot: string, pattern: AnyPatternConfig, props?: ResolvedPatternProps) => void;
  clearSlot: (slot: string) => void;
} {
  return {
    addPattern: (slot: string, pattern: AnyPatternConfig, props?: ResolvedPatternProps) => {
      manager.setContent({
        slot: slot as UISlot,
        pattern,
        props,
      });
    },
    clearSlot: (slot: string) => {
      manager.clearSlot(slot as UISlot);
    },
  };
}
