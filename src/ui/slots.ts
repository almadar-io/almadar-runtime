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
  /** Resolved trait definition that owns the transition. */
  traitDefinition: ResolvedTrait;
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
