/**
 * StateMachineCore - Platform-Agnostic State Machine Logic
 *
 * Pure TypeScript implementation of trait state machine execution.
 * Extracts the core logic from useTraitStateMachine for use on
 * both client and server.
 *
 * @packageDocumentation
 */

import type {
    TraitState,
    TraitDefinition,
    TransitionResult,
    BindingContext,
} from './types.js';
import { interpolateValue, createContextFromBindings } from './BindingResolver.js';
import { evaluateGuard } from '@almadar/evaluator';

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Find the initial state for a trait definition.
 */
export function findInitialState(trait: TraitDefinition): string {
    // Guard against missing or empty states array
    if (!trait.states || trait.states.length === 0) {
        console.warn(`[StateMachine] Trait "${trait.name}" has no states defined, using "unknown"`);
        return 'unknown';
    }
    const markedInitial = trait.states.find((s) => s.isInitial)?.name;
    const firstState = trait.states[0]?.name;
    return markedInitial || firstState || 'unknown';
}

/**
 * Create initial trait state for a trait definition.
 */
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
 * Find a matching transition from the current state for the given event.
 */
export function findTransition(
    trait: TraitDefinition,
    currentState: string,
    eventKey: string
): TraitDefinition['transitions'][0] | undefined {
    // Guard against missing transitions array
    if (!trait.transitions || trait.transitions.length === 0) {
        return undefined;
    }
    return trait.transitions.find((t) => {
        // Handle array 'from' (multiple source states)
        if (Array.isArray(t.from)) {
            return t.from.includes(currentState) && t.event === eventKey;
        }
        return t.from === currentState && t.event === eventKey;
    });
}

/**
 * Normalize event key - strip UI: prefix if present.
 */
export function normalizeEventKey(eventKey: string): string {
    if (!eventKey) return '';
    return eventKey.startsWith('UI:') ? eventKey.slice(3) : eventKey;
}

// ============================================================================
// State Machine Processor
// ============================================================================

/**
 * Options for processing an event through the state machine.
 */
export interface ProcessEventOptions {
    /** Current trait state */
    traitState: TraitState;
    /** Trait definition */
    trait: TraitDefinition;
    /** Event key to process */
    eventKey: string;
    /** Event payload */
    payload?: Record<string, unknown>;
    /** Entity data for binding resolution */
    entityData?: Record<string, unknown>;
}

/**
 * Process an event through a trait's state machine.
 *
 * This is a pure function that:
 * 1. Finds matching transitions
 * 2. Evaluates guards
 * 3. Returns the transition result (but does not execute effects)
 *
 * @returns TransitionResult with effects to execute
 *
 * @example
 * ```ts
 * const result = processEvent({
 *   traitState: { traitName: 'Cart', currentState: 'empty', ... },
 *   trait: cartTraitDefinition,
 *   eventKey: 'ADD_ITEM',
 *   payload: { productId: '123' },
 * });
 *
 * if (result.executed) {
 *   // Execute effects
 *   for (const effect of result.effects) {
 *     effectExecutor.execute(effect);
 *   }
 *   // Update state
 *   traitState.currentState = result.newState;
 * }
 * ```
 */
export function processEvent(options: ProcessEventOptions): TransitionResult {
    const { traitState, trait, eventKey, payload, entityData } = options;
    const normalizedEvent = normalizeEventKey(eventKey);

    // Find transition from current state
    const transition = findTransition(trait, traitState.currentState, normalizedEvent);

    if (!transition) {
        return {
            executed: false,
            newState: traitState.currentState,
            previousState: traitState.currentState,
            effects: [],
        };
    }

    // Evaluate guard if present
    if (transition.guard) {
        const ctx = createContextFromBindings({
            entity: entityData,
            payload,
            state: traitState.currentState,
        });

        try {
            const guardPasses = evaluateGuard(
                transition.guard as Parameters<typeof evaluateGuard>[0],
                ctx
            );
            if (!guardPasses) {
                return {
                    executed: false,
                    newState: traitState.currentState,
                    previousState: traitState.currentState,
                    effects: [],
                    transition: {
                        from: traitState.currentState,
                        to: transition.to,
                        event: normalizedEvent,
                    },
                    guardResult: false,
                };
            }
        } catch (error) {
            // On error, allow transition (fail-open for better UX)
            console.error('[StateMachineCore] Guard evaluation error:', error);
        }
    }

    // Transition should execute
    return {
        executed: true,
        newState: transition.to,
        previousState: traitState.currentState,
        effects: transition.effects || [],
        transition: {
            from: traitState.currentState,
            to: transition.to,
            event: normalizedEvent,
        },
        guardResult: transition.guard ? true : undefined,
    };
}

// ============================================================================
// State Machine Manager
// ============================================================================

/**
 * Stateful manager for multiple trait state machines.
 *
 * Platform-agnostic - can be used directly on server or wrapped
 * in a React hook on client.
 *
 * @example
 * ```ts
 * const manager = new StateMachineManager([cartTrait, userTrait]);
 *
 * // Process event
 * const results = manager.sendEvent('ADD_ITEM', { productId: '123' });
 *
 * // Get current states
 * const cartState = manager.getState('Cart');
 * ```
 */
export class StateMachineManager {
    private traits: Map<string, TraitDefinition> = new Map();
    private states: Map<string, TraitState> = new Map();

    constructor(traits: TraitDefinition[] = []) {
        for (const trait of traits) {
            this.addTrait(trait);
        }
    }

    /**
     * Add a trait to the manager.
     */
    addTrait(trait: TraitDefinition): void {
        this.traits.set(trait.name, trait);
        this.states.set(trait.name, createInitialTraitState(trait));
    }

    /**
     * Remove a trait from the manager.
     */
    removeTrait(traitName: string): void {
        this.traits.delete(traitName);
        this.states.delete(traitName);
    }

    /**
     * Get current state for a trait.
     */
    getState(traitName: string): TraitState | undefined {
        return this.states.get(traitName);
    }

    /**
     * Get all current states.
     */
    getAllStates(): Map<string, TraitState> {
        return new Map(this.states);
    }

    /**
     * Check if a trait can handle an event from its current state.
     */
    canHandleEvent(traitName: string, eventKey: string): boolean {
        const trait = this.traits.get(traitName);
        const state = this.states.get(traitName);
        if (!trait || !state) return false;

        return !!findTransition(trait, state.currentState, normalizeEventKey(eventKey));
    }

    /**
     * Send an event to all traits.
     *
     * @returns Array of transition results (one per trait that had a matching transition)
     */
    sendEvent(
        eventKey: string,
        payload?: Record<string, unknown>,
        entityData?: Record<string, unknown>
    ): Array<{ traitName: string; result: TransitionResult }> {
        const results: Array<{ traitName: string; result: TransitionResult }> = [];

        for (const [traitName, trait] of this.traits) {
            const traitState = this.states.get(traitName);
            if (!traitState) continue;

            const result = processEvent({
                traitState,
                trait,
                eventKey,
                payload,
                entityData,
            });

            if (result.executed) {
                // Update state
                this.states.set(traitName, {
                    ...traitState,
                    currentState: result.newState,
                    previousState: result.previousState,
                    lastEvent: normalizeEventKey(eventKey),
                    context: { ...traitState.context, ...payload },
                });

                results.push({ traitName, result });
            }
        }

        return results;
    }

    /**
     * Reset a trait to its initial state.
     */
    resetTrait(traitName: string): void {
        const trait = this.traits.get(traitName);
        if (trait) {
            this.states.set(traitName, createInitialTraitState(trait));
        }
    }

    /**
     * Reset all traits to initial states.
     */
    resetAll(): void {
        for (const [traitName, trait] of this.traits) {
            this.states.set(traitName, createInitialTraitState(trait));
        }
    }
}
