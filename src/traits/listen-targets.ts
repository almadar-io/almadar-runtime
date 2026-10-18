/**
 * The traits whose declared `listens` react to an emitted event: the client's twin of
 * `orbital-core::collect_listener_targets`, for emits the bus carries outside a kernel dispatch. A listen's
 * `when` and its payload mapping run on the kernel's evaluator.
 *
 * @packageDocumentation
 */
import { applyListenMapping, kernelEvaluator, toWireValue } from '@almadar/core';
import type { BusEventSource, EventId, EventPayload, SExpr, TraitEventListener } from '@almadar/core';
import { parseListenSource } from '../events/identity/routing.js';
import type { IndexedTrait, TraitIndex } from './trait-index.js';

export interface CollectedListenerTarget {
  listenerTrait: string;
  /** The listener's index entry. */
  entry: IndexedTrait;
  /** The matched listener declaration (its `when` already held). */
  listener: TraitEventListener;
  triggers: string;
  triggersId?: EventId;
  payload: EventPayload | undefined;
}

/** A listen's `when` over the raw payload, before mapping; an evaluation error skips the delivery (kernel parity). */
function listenGuardHolds(guard: SExpr, payload: EventPayload | undefined): boolean {
  const outcome = kernelEvaluator().evaluateGuard({ payload: toWireValue(payload ?? {}) }, guard);
  return outcome.kind === 'value' && outcome.value;
}

export function collectListenerTargets(
  traitIndex: TraitIndex,
  sourceStamp: BusEventSource | undefined,
  event: string,
  payload: EventPayload | undefined,
): CollectedListenerTarget[] {
  const targets: CollectedListenerTarget[] = [];
  for (const [listenerName, listenerEntry] of traitIndex.byName) {
    for (const listener of listenerEntry.traitDef.listens ?? []) {
      const { bareEvent, matcher } = parseListenSource(listener, listenerEntry.orbitalName);
      if (bareEvent !== event || !matcher(sourceStamp)) continue;
      if (listener.guard !== undefined && !listenGuardHolds(listener.guard, payload)) continue;
      targets.push({
        listenerTrait: listenerName,
        entry: listenerEntry,
        listener,
        triggers: listener.triggers,
        ...(listener.triggersId !== undefined ? { triggersId: listener.triggersId } : {}),
        payload: applyListenMapping(listener.payloadMapping, payload),
      });
    }
  }
  return targets;
}
