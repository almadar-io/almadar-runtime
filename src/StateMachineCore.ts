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
import type { EventId, UserContext } from '@almadar/core';
import { interpolateValue, createContextFromBindings } from './BindingResolver.js';
import { evaluateGuard } from '@almadar/evaluator';
import { createLogger } from '@almadar/logger';

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
        smLog.warn('trait-has-no-states', { trait: trait.name });
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
 * Find every transition matching the current state + event key (in
 * declaration order). Used by `processEvent` to disambiguate guarded
 * sibling transitions: when several transitions share the same
 * `from`/`event` and differ by guard (e.g. retry under attempts<3 vs
 * give-up under attempts>=3), the runtime must consider all of them and
 * pick the first whose guard passes.
 *
 * V4 id-primary dispatch: when the caller supplies `eventId` AND the
 * candidate transition carries its own `eventId`, the two ids are
 * compared instead of the name strings — this lets a transition still
 * fire after its `event` name diverges from the fired event's name (a
 * rename mid-flight), as long as the id lineage matches. Either side
 * missing an id falls back to the existing name comparison so id-free
 * schemas dispatch exactly as before.
 */
export function findMatchingTransitions(
    trait: TraitDefinition,
    currentState: string,
    eventKey: string,
    eventId?: EventId
): TraitDefinition['transitions'] {
    if (!trait.transitions || trait.transitions.length === 0) {
        return [];
    }
    return trait.transitions.filter((t) => {
        const fromMatches = Array.isArray(t.from)
            ? t.from.includes(currentState)
            : t.from === currentState;
        if (!fromMatches) return false;
        if (eventId && t.eventId) {
            return t.eventId === eventId;
        }
        return t.event === eventKey;
    });
}

/**
 * Find a matching transition from the current state for the given event.
 *
 * **Guard-unaware**: returns the first transition matching `from` /
 * `event` regardless of any attached guard. Use `findMatchingTransitions`
 * when multiple sibling transitions share the same `from`/`event` and
 * disambiguate by guard.
 */
export function findTransition(
    trait: TraitDefinition,
    currentState: string,
    eventKey: string,
    eventId?: EventId
): TraitDefinition['transitions'][0] | undefined {
    return findMatchingTransitions(trait, currentState, eventKey, eventId)[0];
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
    /**
     * V4 dual-carry id sibling of `eventKey` — the id of the fired event,
     * when known. Threaded to `findMatchingTransitions` for id-primary
     * matching; absent means name-only dispatch (legacy).
     */
    eventId?: EventId;
    /** Event payload */
    payload?: EventPayload;
    /** Entity data for binding resolution */
    entityData?: EntityRow;
    /**
     * Trait config for `@config.X` resolution inside guard expressions.
     * Surfaced on the EvaluationContext so guards can write mode-aware
     * predicates — e.g. std-modal's OPEN can require `@payload.row` only
     * when `@config.mode === "edit"`. The validator (sigil_context.rs)
     * allows `@config` in guard context as of v3.12.0; this field is
     * the runtime side of the same contract. Threaded by the caller
     * (typically `OrbitalServerRuntime.processEvent` reading from the
     * trait's `RegisteredOrbital.configByTrait`).
     */
    config?: ConfigContext;
    /**
     * Authenticated viewer for `@user.X` resolution inside guard expressions.
     * The validator admits `@user` in guard context alongside `@config`; this
     * is the runtime side of that contract. Without it a role gate
     * (`when ["=", @user.role, "admin"]`) can never pass, because the guard's
     * EvaluationContext has no user to compare against.
     */
    user?: UserContext;
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
        traitState, trait, eventKey, eventId, payload, entityData,
        config,
        user,
        guardMode = 'permissive',
        strictBindings = false,
        contextExtensions,
    } = options;
    const normalizedEvent = normalizeEventKey(eventKey);

    // Find every transition matching from/event so we can pick the first
    // whose guard passes. This supports the standard "retry vs give-up"
    // pattern where two transitions share from/event and differ by guard
    // (e.g. attempts<3 → idle vs attempts>=3 → failed).
    const candidates = findMatchingTransitions(trait, traitState.currentState, normalizedEvent, eventId);

    if (candidates.length === 0) {
        smLog.debug('noTransition', { trait: trait.name, event: normalizedEvent, currentState: traitState.currentState });
        return {
            executed: false,
            newState: traitState.currentState,
            previousState: traitState.currentState,
            effects: [],
        };
    }

    // Try each candidate in declaration order; pick the first whose
    // guard passes (or that has no guard). Guard errors fall through to
    // the next candidate in permissive mode, block in strict mode.
    let lastFailedGuardTransition: TraitDefinition['transitions'][0] | undefined;

    for (const transition of candidates) {
        smLog.debug('processEvent', { trait: trait.name, event: normalizedEvent, currentState: traitState.currentState, to: transition.to });

        // ABSENT means unguarded — never falsy. Resolve constant-folds
        // config-driven guards (`when @config.selfFetch` with a false call-site
        // value becomes the literal `false`), and `!guard` promoted exactly
        // those always-blocked arms to always-fire.
        if (transition.guard === undefined || transition.guard === null) {
            // Unguarded transition wins immediately.
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
            };
        }

        const ctx = createContextFromBindings({
            entity: entityData,
            payload,
            state: traitState.currentState,
            // Surface call-site config so `@config.X` resolves inside
            // guard expressions (matches the validator's allowed sigil
            // list as of v3.12.0). createContextFromBindings already
            // propagates `bindings.config` to ctx.config when present —
            // we just need to pass it through here.
            config,
            user,
        }, strictBindings, contextExtensions);

        try {
            const guardPasses = evaluateGuard(
                transition.guard as Parameters<typeof evaluateGuard>[0],
                ctx
            );
            smLog.debug('guard:evaluate', { trait: trait.name, event: normalizedEvent, guardResult: guardPasses });
            if (guardPasses) {
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
                    guardResult: true,
                };
            }
            // Guard failed — try the next candidate.
            lastFailedGuardTransition = transition;
        } catch (error) {
            if (guardMode === 'strict') {
                // RCG-02: In strict mode, guard errors block the transition
                smLog.error('guard-error-blocks-transition', {
                    from: traitState.currentState,
                    to: transition.to,
                    event: normalizedEvent,
                    error: error instanceof Error ? error : String(error),
                });
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
            // Permissive mode: log and allow (treat as guard pass).
            smLog.error('guard-evaluation-error', {
                error: error instanceof Error ? error : String(error),
            });
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
                guardResult: true,
            };
        }
    }

    // No candidate's guard passed.
    return {
        executed: false,
        newState: traitState.currentState,
        previousState: traitState.currentState,
        effects: [],
        transition: lastFailedGuardTransition
            ? {
                from: traitState.currentState,
                to: lastFailedGuardTransition.to,
                event: normalizedEvent,
            }
            : undefined,
        guardResult: false,
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
    /** V4 dual-carry id sibling of `eventKey` — see `sendEvent` doc. */
    eventId?: EventId;
    payload?: EventPayload;
    entityData?: EntityRow;
    /** Per-trait entity overrides (see `sendEvent` doc). */
    entityByTrait?: Record<string, EntityRow>;
    /** Authenticated viewer at enqueue time, for `@user` guard resolution. */
    user?: UserContext;
}

/**
 * Default scope used when an event arrives without a specific entityId.
 * Single-entity orbitals (the common case for UI traits) all share this
 * scope, so the public API stays identical to the pre-multi-entity world.
 */
const SINGLETON_SCOPE = '__singleton__';

function scopeOf(entityData?: EntityRow): string {
    const id = entityData && (entityData['id'] as string | undefined);
    return id ?? SINGLETON_SCOPE;
}

function compositeKey(traitName: string, scope: string): string {
    return `${traitName}::${scope}`;
}

export class StateMachineManager {
    private traits: Map<string, TraitDefinition> = new Map();
    /**
     * V4 identity index: trait id → trait name. Populated for traits that
     * carry an `id` (ledger-backed schemas). Lets callers resolve a trait's
     * state by its stable id, which survives a mid-session rename — the
     * name-keyed maps are re-pointed on rename via {@link renameTrait}, but
     * an id holder never has to observe the rename at all. Empty for legacy
     * id-free schemas, where every lookup stays name-keyed (unchanged).
     */
    private traitIdToName: Map<string, string> = new Map();
    /**
     * Per-trait call-site config, surfaced to guard expressions so
     * `@config.X` resolves at runtime. Populated by the orbital's
     * registration step (see `OrbitalServerRuntime.registerOrbital`'s
     * `configByTrait` projection). Empty for atom-scope traits whose
     * call-site config wasn't supplied — guards that read `@config.X`
     * in that case will see `undefined` and short-circuit accordingly.
     */
    private traitConfigs: Map<string, ConfigContext> = new Map();
    /**
     * State map keyed by `${traitName}::${entityId | __singleton__}`.
     *
     * Each entity instance of an orbital gets its own copy of every
     * trait's state machine. This is what enables N parallel subagents
     * (one OrbitalProcess row per dispatched orbital) to all run their
     * own Build/Validate/Fix cycle without colliding on shared trait
     * state — the original cause of GAP-AGB-2.
     *
     * Initial state is created lazily on first event for each scope, so
     * adding a trait does not pre-allocate state for every potential
     * entity (and there's no need to know entity ids up front).
     */
    private states: Map<string, TraitState> = new Map();
    private config: RuntimeConfig;
    private observer?: TransitionObserver;

    // Actor-model queues, also keyed by `${traitName}::${entityId}` so
    // each entity gets its own actor loop and concurrent subagents do
    // not serialize through a shared queue.
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
        if (trait.id !== undefined) {
            this.traitIdToName.set(trait.id, trait.name);
        }
        // Lazy: state for each entity scope is created on first event.
    }

    /**
     * Resolve a trait by its V4 id. Returns undefined when no trait carries
     * that id (legacy schema, or unknown id). Exact-match only — no name
     * similarity.
     */
    getTraitById(traitId: string): TraitDefinition | undefined {
        const name = this.traitIdToName.get(traitId);
        return name === undefined ? undefined : this.traits.get(name);
    }

    /**
     * Get a trait's current state by its V4 id (id-first lookup). Falls back
     * to `undefined` when the id is unknown. The id survives a rename, so a
     * holder of the id reads the right state without ever seeing the new name.
     */
    getStateById(traitId: string, entityId?: string): TraitState | undefined {
        const name = this.traitIdToName.get(traitId);
        return name === undefined ? undefined : this.getState(name, entityId);
    }

    /**
     * Apply a mid-session trait rename: re-point the name-keyed maps from
     * `oldName` to `newName`, preserving live state, queues, and the id
     * index. A no-op when the trait isn't registered under `oldName`. This
     * is the interpreter-side of a ledger `curName` edit for the trait's own
     * name-keyed storage; id-keyed references need no update.
     */
    renameTrait(oldName: string, newName: string): void {
        const trait = this.traits.get(oldName);
        if (!trait || oldName === newName) return;
        const renamed: TraitDefinition = { ...trait, name: newName };
        this.traits.delete(oldName);
        this.traits.set(newName, renamed);
        if (renamed.id !== undefined) {
            this.traitIdToName.set(renamed.id, newName);
        }
        const remap = <V>(m: Map<string, V>): void => {
            const prefix = `${oldName}::`;
            for (const key of [...m.keys()]) {
                if (key.startsWith(prefix)) {
                    const scope = key.slice(prefix.length);
                    const v = m.get(key)!;
                    m.delete(key);
                    m.set(`${newName}::${scope}`, v);
                }
            }
        };
        remap(this.states);
        remap(this.queues);
        // `processing` is a Set of composite keys.
        const prefix = `${oldName}::`;
        for (const key of [...this.processing]) {
            if (key.startsWith(prefix)) {
                this.processing.delete(key);
                this.processing.add(`${newName}::${key.slice(prefix.length)}`);
            }
        }
        const cfg = this.traitConfigs.get(oldName);
        if (cfg !== undefined) {
            this.traitConfigs.set(newName, cfg);
            this.traitConfigs.delete(oldName);
        }
    }

    /**
     * Bind the call-site config for a trait so guard `@config.X`
     * resolves at runtime. Typically called by the orbital
     * registration step right after `addTrait`. Idempotent; passing
     * `undefined` clears the binding.
     */
    setTraitConfig(traitName: string, config: ConfigContext | undefined): void {
        if (config === undefined) {
            this.traitConfigs.delete(traitName);
        } else {
            this.traitConfigs.set(traitName, config);
        }
    }

    /**
     * Remove a trait from the manager.
     */
    removeTrait(traitName: string): void {
        const removed = this.traits.get(traitName);
        if (removed?.id !== undefined) {
            this.traitIdToName.delete(removed.id);
        }
        this.traits.delete(traitName);
        // Drop every per-entity state row for this trait.
        const prefix = `${traitName}::`;
        for (const key of [...this.states.keys()]) {
            if (key.startsWith(prefix)) this.states.delete(key);
        }
        for (const key of [...this.queues.keys()]) {
            if (key.startsWith(prefix)) this.queues.delete(key);
        }
        for (const key of [...this.processing]) {
            if (key.startsWith(prefix)) this.processing.delete(key);
        }
    }

    /**
     * Get-or-init the state row for a (trait, entityId) pair.
     * Returns undefined if the trait isn't registered.
     */
    private getOrInitState(
        traitName: string,
        scope: string
    ): TraitState | undefined {
        const trait = this.traits.get(traitName);
        if (!trait) return undefined;
        const key = compositeKey(traitName, scope);
        let state = this.states.get(key);
        if (!state) {
            state = createInitialTraitState(trait);
            this.states.set(key, state);
        }
        return state;
    }

    /**
     * Get current state for a trait.
     *
     * For single-entity orbitals, omit `entityId` — returns the singleton
     * scope. For multi-entity orbitals (e.g. agent OrbitalSubagent), pass
     * the entity row id to look up that specific instance's state.
     */
    getState(traitName: string, entityId?: string): TraitState | undefined {
        const scope = entityId ?? SINGLETON_SCOPE;
        const key = compositeKey(traitName, scope);
        const existing = this.states.get(key);
        if (existing) return existing;
        // Lazy init for read-then-no-event scenarios (e.g. ticks).
        return this.getOrInitState(traitName, scope);
    }

    /**
     * Get a flat traitName→state map. For multi-entity orbitals this
     * returns one entry per trait collapsed onto the singleton scope (or
     * the first observed scope if singleton is empty). Use
     * `getAllStatesByScope()` to get the full per-entity view.
     */
    getAllStates(): Map<string, TraitState> {
        const out = new Map<string, TraitState>();
        for (const traitName of this.traits.keys()) {
            const singleton = this.states.get(compositeKey(traitName, SINGLETON_SCOPE));
            if (singleton) {
                out.set(traitName, singleton);
                continue;
            }
            // Fall back to the first observed entity scope for this trait.
            for (const [key, state] of this.states) {
                if (key.startsWith(`${traitName}::`)) {
                    out.set(traitName, state);
                    break;
                }
            }
        }
        return out;
    }

    /**
     * Get every per-entity state row, grouped by trait. Useful for
     * inspecting parallel subagent state.
     */
    getAllStatesByScope(): Map<string, Map<string, TraitState>> {
        const grouped = new Map<string, Map<string, TraitState>>();
        for (const [key, state] of this.states) {
            const sep = key.indexOf('::');
            if (sep < 0) continue;
            const traitName = key.slice(0, sep);
            const scope = key.slice(sep + 2);
            let bucket = grouped.get(traitName);
            if (!bucket) {
                bucket = new Map();
                grouped.set(traitName, bucket);
            }
            bucket.set(scope, state);
        }
        return grouped;
    }

    /**
     * Check if a trait can handle an event from its current state.
     */
    canHandleEvent(traitName: string, eventKey: string, entityId?: string, eventId?: EventId): boolean {
        const trait = this.traits.get(traitName);
        const state = this.getOrInitState(traitName, entityId ?? SINGLETON_SCOPE);
        if (!trait || !state) return false;

        return !!findTransition(trait, state.currentState, normalizeEventKey(eventKey), eventId);
    }

    /**
     * Send an event to all traits.
     *
     * `entityByTrait` lets callers supply per-trait entity rows for guard
     * evaluation when traits accumulate scalar state via `(set @entity.X)`
     * effects across transitions. The runtime UI hook builds this map from
     * its `traitFieldStatesRef` before each dispatch so guards reading
     * `@entity.X` see prior step writes — required for [runtime] entities
     * that have no persistence row to reload.
     *
     * `eventId` is the V4 dual-carry id sibling of `eventKey` (see
     * {@link ProcessEventOptions.eventId}) — additive and optional, threaded
     * through to `processEvent` for id-primary transition matching.
     *
     * @returns Array of transition results (one per trait that had a matching transition)
     */
    sendEvent(
        eventKey: string,
        payload?: EventPayload,
        entityData?: EntityRow,
        entityByTrait?: Record<string, EntityRow>,
        eventId?: EventId,
        // When set, the event dispatches to THIS trait only — the scoped-
        // listen delivery contract. A listen's trigger is addressed to the
        // LISTENING trait; broadcasting it orbital-wide made a trigger
        // renamed to INIT re-run every trait's initializer (the
        // R-SCOPED-LISTEN-INIT-RENAME-FREEZE re-fire cascade: the source's
        // own INIT refetched, re-emitted, re-triggered — a permanent loop).
        targetTrait?: string,
        // Authenticated viewer for `@user.X` guard resolution — per-request,
        // so it is a parameter rather than manager config.
        user?: UserContext,
        // Page-scoped execution set (`_activeTraits`): when set, traits
        // outside it neither transition nor mutate state. Effect filtering
        // alone left off-page FSMs silently advancing on name-shared events
        // (R-TABLEVIEW-LOADED-UNSCOPED cross-page half). `targetTrait` is
        // more specific and bypasses this set.
        allowedTraits?: ReadonlySet<string>
    ): Array<{ traitName: string; result: TransitionResult }> {
        const results: Array<{ traitName: string; result: TransitionResult }> = [];
        const scope = scopeOf(entityData);

        for (const [traitName, trait] of this.traits) {
            if (targetTrait !== undefined) {
                if (traitName !== targetTrait) continue;
            } else if (allowedTraits !== undefined && !allowedTraits.has(traitName)) {
                continue;
            }
            const traitState = this.getOrInitState(traitName, scope);
            if (!traitState) continue;
            const key = compositeKey(traitName, scope);

            const perTraitEntity = entityByTrait?.[traitName] ?? entityData;

            const result = processEvent({
                traitState,
                trait,
                eventKey,
                eventId,
                payload,
                entityData: perTraitEntity,
                config: this.traitConfigs.get(traitName),
                user,
                guardMode: this.config.guardMode,
                strictBindings: this.config.strictBindings,
                contextExtensions: this.config.contextExtensions,
            });

            if (result.executed) {
                // Update state for THIS entity's scope only — concurrent
                // entities of the same trait keep independent state.
                this.states.set(key, {
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
        entityData?: EntityRow,
        entityByTrait?: Record<string, EntityRow>,
        eventId?: EventId,
        user?: UserContext
    ): void {
        const scope = scopeOf(entityData);
        for (const [traitName] of this.traits) {
            const key = compositeKey(traitName, scope);
            const queue = this.queues.get(key) ?? [];
            queue.push({ eventKey, eventId, payload, entityData, entityByTrait, user });
            this.queues.set(key, queue);
        }
    }

    /**
     * Drain a single (trait, entity) pair's event queue, processing
     * events sequentially. Pass `entityId` to drain a specific entity
     * instance; omit it to drain the singleton scope.
     */
    async drainQueue(
        traitName: string,
        executeEffects: (
            traitName: string,
            result: TransitionResult,
            payload?: EventPayload
        ) => Promise<void>,
        entityId?: string
    ): Promise<void> {
        const scope = entityId ?? SINGLETON_SCOPE;
        const key = compositeKey(traitName, scope);
        if (this.processing.has(key)) return;
        this.processing.add(key);

        const queue = this.queues.get(key) ?? [];
        while (queue.length > 0) {
            const entry = queue.shift()!;
            const trait = this.traits.get(traitName);
            const traitState = this.getOrInitState(traitName, scope);
            if (!trait || !traitState) continue;

            const perTraitEntity =
                entry.entityByTrait?.[traitName] ?? entry.entityData;

            const result = processEvent({
                traitState,
                trait,
                eventKey: entry.eventKey,
                eventId: entry.eventId,
                payload: entry.payload,
                entityData: perTraitEntity,
                config: this.traitConfigs.get(traitName),
                user: entry.user,
                guardMode: this.config.guardMode,
                strictBindings: this.config.strictBindings,
                contextExtensions: this.config.contextExtensions,
            });

            if (result.executed) {
                this.states.set(key, {
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

        this.processing.delete(key);
    }

    /**
     * Check whether a trait's queue is currently being drained.
     */
    isProcessing(traitName: string, entityId?: string): boolean {
        return this.processing.has(compositeKey(traitName, entityId ?? SINGLETON_SCOPE));
    }

    /**
     * Get the number of pending events in a trait's queue.
     */
    getQueueLength(traitName: string, entityId?: string): number {
        return this.queues.get(compositeKey(traitName, entityId ?? SINGLETON_SCOPE))?.length ?? 0;
    }

    /**
     * Reset a trait to its initial state.
     *
     * If `entityId` is provided, resets only that entity's scope.
     * Otherwise resets every entity scope known for the trait.
     */
    resetTrait(traitName: string, entityId?: string): void {
        const trait = this.traits.get(traitName);
        if (!trait) return;
        if (entityId) {
            this.states.set(compositeKey(traitName, entityId), createInitialTraitState(trait));
            return;
        }
        const prefix = `${traitName}::`;
        for (const key of [...this.states.keys()]) {
            if (key.startsWith(prefix)) {
                this.states.set(key, createInitialTraitState(trait));
            }
        }
    }

    /**
     * Reset all traits to initial states (every entity scope).
     */
    resetAll(): void {
        for (const [traitName, trait] of this.traits) {
            const prefix = `${traitName}::`;
            for (const key of [...this.states.keys()]) {
                if (key.startsWith(prefix)) {
                    this.states.set(key, createInitialTraitState(trait));
                }
            }
        }
    }
}
