/**
 * The client's record of each trait's state, as the kernel reports it. The kernel decides every transition;
 * this book only holds the states its responses carry, so a render can read them synchronously.
 *
 * @packageDocumentation
 */
import { LIFECYCLE_EVENTS } from '@almadar/core';
import type { EventId } from '@almadar/core';
import type { RollbackCause, TraitDefinition, TraitState, TransitionObserver } from '../types.js';

export { LIFECYCLE_EVENTS };

/** Wire-only event a client sends when a trait leaves the page; the server stops counting it as mounted. */
export const UNMOUNT_EVENT = '$UNMOUNT';

/** The state a trait starts in: the one marked initial, else the first declared. */
export function findInitialState(trait: TraitDefinition): string {
  const markedInitial = trait.states?.find((s) => s.isInitial)?.name;
  return markedInitial ?? trait.states?.[0]?.name ?? 'unknown';
}

export function createInitialTraitState(trait: TraitDefinition): TraitState {
  return {
    traitName: trait.name,
    currentState: findInitialState(trait),
    previousState: null,
    lastEvent: null,
    context: {},
  };
}

/**
 * Every transition out of `currentState` on the event, in declaration order. An event id is compared with a
 * transition's own id when both carry one, so an arm still matches after its event was renamed.
 */
export function findMatchingTransitions(
  trait: TraitDefinition,
  currentState: string,
  eventKey: string,
  eventId?: EventId,
): TraitDefinition['transitions'] {
  return (trait.transitions ?? []).filter((t) => {
    const fromMatches = Array.isArray(t.from) ? t.from.includes(currentState) : t.from === currentState;
    if (!fromMatches) return false;
    if (eventId && t.eventId) return t.eventId === eventId;
    return t.event === eventKey;
  });
}

/** The first transition out of `currentState` on the event, ignoring guards. */
export function findTransition(
  trait: TraitDefinition,
  currentState: string,
  eventKey: string,
  eventId?: EventId,
): TraitDefinition['transitions'][0] | undefined {
  return findMatchingTransitions(trait, currentState, eventKey, eventId)[0];
}

/** An event key without its `UI:` bus prefix. */
export function normalizeEventKey(eventKey: string): string {
  if (!eventKey) return '';
  return eventKey.startsWith('UI:') ? eventKey.slice(3) : eventKey;
}

/** The event a tick firing carries on the wire (`OrbitalEventRequest.event` of a `runTick` leg). */
export function tickEventKey(tickName: string): string {
  return `$TICK_${tickName}`;
}

const SINGLETON_SCOPE = '__singleton__';

const key = (traitName: string, entityId: string | undefined): string => `${traitName}::${entityId ?? SINGLETON_SCOPE}`;

export class StateBook {
  private readonly traits = new Map<string, TraitDefinition>();
  private readonly states = new Map<string, TraitState>();

  constructor(traits: readonly TraitDefinition[] = [], private readonly observer?: TransitionObserver) {
    for (const trait of traits) this.traits.set(trait.name, trait);
  }

  /** The trait's state, its initial state until the kernel reports one; `undefined` for a trait not on the page. */
  getState(traitName: string, entityId?: string): TraitState | undefined {
    const recorded = this.states.get(key(traitName, entityId));
    if (recorded !== undefined) return recorded;
    const trait = this.traits.get(traitName);
    return trait === undefined ? undefined : createInitialTraitState(trait);
  }

  /** Each trait's singleton-scope state. */
  getAllStates(): Map<string, TraitState> {
    const out = new Map<string, TraitState>();
    for (const name of this.traits.keys()) {
      const state = this.getState(name);
      if (state !== undefined) out.set(name, state);
    }
    return out;
  }

  /** Whether the trait has an arm on the event from its current state. */
  canHandleEvent(traitName: string, eventKey: string, entityId?: string, eventId?: EventId): boolean {
    const trait = this.traits.get(traitName);
    const state = this.getState(traitName, entityId);
    if (trait === undefined || state === undefined) return false;
    return findTransition(trait, state.currentState, normalizeEventKey(eventKey), eventId) !== undefined;
  }

  /**
   * The lifecycle event an embedded child can be repainted with: the one it handles from its current state,
   * provided every matching arm stays in that state and only renders.
   */
  repaintLifecycleEvent(traitName: string, entityId?: string): string | undefined {
    const trait = this.traits.get(traitName);
    const state = this.getState(traitName, entityId);
    if (trait === undefined || state === undefined) return undefined;
    for (const event of LIFECYCLE_EVENTS) {
      const arms = findMatchingTransitions(trait, state.currentState, event);
      if (arms.length === 0) continue;
      const repaints = arms.every((t) => t.to === state.currentState
        && (t.effects ?? []).every((effect) => Array.isArray(effect) && effect[0] === 'render-ui'));
      return repaints ? event : undefined;
    }
    return undefined;
  }

  /** Record the state the kernel reports. No-op for a trait not on the page. */
  seedState(traitName: string, currentState: string, entityId?: string): void {
    const trait = this.traits.get(traitName);
    if (trait === undefined) return;
    const existing = this.states.get(key(traitName, entityId)) ?? createInitialTraitState(trait);
    this.states.set(key(traitName, entityId), { ...existing, currentState, previousState: existing.currentState });
  }

  /** Undo an optimistic commit, reporting the hop back to the observer. */
  rollbackState(traitName: string, toState: string, entityId: string | undefined, cause: RollbackCause): void {
    const from = this.getState(traitName, entityId)?.currentState;
    this.seedState(traitName, toState, entityId);
    if (from !== undefined && from !== toState) this.observer?.onRollback?.({ traitName, from, to: toState, cause });
  }
}
