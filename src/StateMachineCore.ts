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
    RuntimeConfig,
    TransitionObserver,
    EntityRow,
    EventPayload,
    ConfigContext,
    EvaluationContextExtensions,
} from './types.js';
import { interpolateValue, createContextFromBindings } from './BindingResolver.js';
import { evaluateGuard } from '@almadar/evaluator';
import { createLogger } from './logger.js';

const smLog = createLogger('almadar:runtime:sm');

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
    payload?: EventPayload;
    /** Entity data for binding resolution */
    entityData?: EntityRow;
    /**
     * Guard evaluation error handling mode. (RCG-02)
     * - "permissive": Guard errors allow the transition (default, backwards-compatible)
     * - "strict": Guard errors block the transition
     */
    guardMode?: "strict" | "permissive";
    /**
     * When true, log warnings when bindings resolve to undefined. (RCG-01)
     */
    strictBindings?: boolean;
    /**
     * Additional fields to spread onto EvaluationContext for guard evaluation.
     * Used to inject module contexts (e.g., { agent: AgentContext }).
     */
    contextExtensions?: EvaluationContextExtensions;
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
    const {
        traitState, trait, eventKey, payload, entityData,
        guardMode = 'permissive',
        strictBindings = false,
        contextExtensions,
    } = options;
    const normalizedEvent = normalizeEventKey(eventKey);

    // Find transition from current state
    const transition = findTransition(trait, traitState.currentState, normalizedEvent);

    if (!transition) {
        smLog.debug('noTransition', { trait: trait.name, event: normalizedEvent, currentState: traitState.currentState });
        return {
            executed: false,
            newState: traitState.currentState,
            previousState: traitState.currentState,
            effects: [],
        };
    }

    smLog.debug('processEvent', { trait: trait.name, event: normalizedEvent, currentState: traitState.currentState, to: transition.to });

    // Evaluate guard if present
    if (transition.guard) {
        const ctx = createContextFromBindings({
            entity: entityData,
            payload,
            state: traitState.currentState,
        }, strictBindings, contextExtensions);

        try {
            const guardPasses = evaluateGuard(
                transition.guard as Parameters<typeof evaluateGuard>[0],
                ctx
            );
            smLog.debug('guard:evaluate', { trait: trait.name, event: normalizedEvent, guardResult: guardPasses });
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
            if (guardMode === 'strict') {
                // RCG-02: In strict mode, guard errors block the transition
                console.error(
                    `[StateMachineCore] Guard error blocks transition ` +
                    `${traitState.currentState}→${transition.to} (${normalizedEvent}):`,
                    error
                );
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
            // Permissive mode: allow transition despite guard error (original behavior)
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
/** Entry in a per-trait event queue. */
export interface QueuedEvent {
    eventKey: string;
    payload?: EventPayload;
    entityData?: EntityRow;
}

export class StateMachineManager {
    private traits: Map<string, TraitDefinition> = new Map();
    private states: Map<string, TraitState> = new Map();
    private config: RuntimeConfig;
    private observer?: TransitionObserver;

    // Actor-model per-trait queues
    private queues: Map<string, QueuedEvent[]> = new Map();
    private processing: Set<string> = new Set();

    constructor(
        traits: TraitDefinition[] = [],
        config: RuntimeConfig = {},
        observer?: TransitionObserver
    ) {
        this.config = config;
        this.observer = observer;
        for (const trait of traits) {
            this.addTrait(trait);
        }
    }

    /**
     * Set the transition observer for runtime verification.
     * Wire this to `verificationRegistry.recordTransition()` to enable
     * automatic verification tracking.
     */
    setObserver(observer: TransitionObserver): void {
        this.observer = observer;
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
        payload?: EventPayload,
        entityData?: EntityRow
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
                guardMode: this.config.guardMode,
                strictBindings: this.config.strictBindings,
                contextExtensions: this.config.contextExtensions,
            });

            if (result.executed) {
                // Update state
                this.states.set(traitName, {
                    ...traitState,
                    currentState: result.newState,
                    previousState: result.previousState,
                    lastEvent: normalizeEventKey(eventKey),
                    context: { ...traitState.context, ...payload } as ConfigContext,
                });

                results.push({ traitName, result });

                // Notify observer (for verificationRegistry wiring)
                if (this.observer && result.transition) {
                    this.observer.onTransition({
                        traitName,
                        from: result.transition.from,
                        to: result.transition.to,
                        event: result.transition.event,
                        guardResult: result.guardResult,
                        // Effects will be traced when executed — placeholder here
                        effects: [],
                    });
                }
            }
        }

        return results;
    }

    // ========================================================================
    // Actor-Model Queue API (opt-in, does not affect sendEvent)
    // ========================================================================

    /**
     * Enqueue an event into every trait's per-trait queue.
     *
     * Events are not processed immediately. Call `drainQueue()` for each
     * trait to process them sequentially (actor-model guarantee: one event
     * at a time per trait, effects fully awaited before the next event).
     */
    enqueueEvent(
        eventKey: string,
        payload?: EventPayload,
        entityData?: EntityRow
    ): void {
        for (const [traitName] of this.traits) {
            const queue = this.queues.get(traitName) ?? [];
            queue.push({ eventKey, payload, entityData });
            this.queues.set(traitName, queue);
        }
    }

    /**
     * Drain a single trait's event queue, processing events sequentially.
     *
     * This is the core actor loop: each event is fully processed (including
     * awaiting all effects) before the next event is dequeued. If the queue
     * is already being drained for this trait, this call is a no-op (the
     * running drain will pick up newly enqueued events).
     *
     * @param traitName - Which trait's queue to drain
     * @param executeEffects - Async callback to run effects for a successful transition
     */
    async drainQueue(
        traitName: string,
        executeEffects: (
            traitName: string,
            result: TransitionResult,
            payload?: EventPayload
        ) => Promise<void>
    ): Promise<void> {
        if (this.processing.has(traitName)) return;
        this.processing.add(traitName);

        const queue = this.queues.get(traitName) ?? [];
        while (queue.length > 0) {
            const entry = queue.shift()!;
            const trait = this.traits.get(traitName);
            const traitState = this.states.get(traitName);
            if (!trait || !traitState) continue;

            const result = processEvent({
                traitState,
                trait,
                eventKey: entry.eventKey,
                payload: entry.payload,
                entityData: entry.entityData,
                guardMode: this.config.guardMode,
                strictBindings: this.config.strictBindings,
                contextExtensions: this.config.contextExtensions,
            });

            if (result.executed) {
                this.states.set(traitName, {
                    ...traitState,
                    currentState: result.newState,
                    previousState: result.previousState,
                    lastEvent: normalizeEventKey(entry.eventKey),
                    context: { ...traitState.context, ...entry.payload } as ConfigContext,
                });

                if (this.observer && result.transition) {
                    this.observer.onTransition({
                        traitName,
                        from: result.transition.from,
                        to: result.transition.to,
                        event: result.transition.event,
                        guardResult: result.guardResult,
                        effects: [],
                    });
                }

                // Await effects before processing the next event in this trait's queue
                await executeEffects(traitName, result, entry.payload);
            }
        }

        this.processing.delete(traitName);
    }

    /**
     * Check whether a trait's queue is currently being drained.
     */
    isProcessing(traitName: string): boolean {
        return this.processing.has(traitName);
    }

    /**
     * Get the number of pending events in a trait's queue.
     */
    getQueueLength(traitName: string): number {
        return this.queues.get(traitName)?.length ?? 0;
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
