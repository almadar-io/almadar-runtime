/**
 * Unified Runtime Types
 *
 * Platform-agnostic interfaces for trait execution on client or server.
 *
 * @packageDocumentation
 */

// ============================================================================
// Event Bus Types
// ============================================================================

/**
 * Event structure for cross-trait communication
 */
export interface RuntimeEvent {
    /** Event type (e.g., "ORDER_CONFIRMED", "TraitName.EVENT_NAME") */
    type: string;
    /** Event payload data */
    payload?: Record<string, unknown>;
    /** Timestamp when event was emitted */
    timestamp: number;
    /** Source information for debugging */
    source?: {
        orbital?: string;
        trait?: string;
        transition?: string;
        tick?: string;
    };
}

export type EventListener = (event: RuntimeEvent) => void;
export type Unsubscribe = () => void;

/**
 * Event bus interface for pub/sub communication
 */
export interface IEventBus {
    /** Emit an event */
    emit(type: string, payload?: Record<string, unknown>, source?: RuntimeEvent['source']): void;
    /** Subscribe to an event */
    on(type: string, listener: EventListener): Unsubscribe;
    /** Subscribe to ALL events (wildcard listener) */
    onAny(listener: EventListener): Unsubscribe;
    /** Check if there are listeners for an event */
    hasListeners(type: string): boolean;
    /** Get all registered event types */
    getRegisteredEvents(): string[];
    /** Clear all listeners */
    clear(): void;
}

// ============================================================================
// State Machine Types
// ============================================================================

/**
 * State of a single trait's state machine
 */
export interface TraitState {
    /** Trait name */
    traitName: string;
    /** Current state name */
    currentState: string;
    /** Previous state (null if initial) */
    previousState: string | null;
    /** Last event that caused a transition */
    lastEvent: string | null;
    /** Custom context data */
    context: Record<string, unknown>;
}

/**
 * Result of processing an event through a state machine
 */
export interface TransitionResult {
    /** Whether a transition was executed */
    executed: boolean;
    /** New state after transition (same as current if not executed) */
    newState: string;
    /** Previous state before transition */
    previousState: string;
    /** Effects to execute (empty if guard failed or no transition found) */
    effects: unknown[];
    /** The transition that was executed (undefined if none) */
    transition?: {
        from: string;
        to: string;
        event: string;
    };
    /** Guard evaluation result (undefined if no guard) */
    guardResult?: boolean;
}

/**
 * Minimal trait definition for state machine processing
 */
export interface TraitDefinition {
    name: string;
    states: Array<{ name: string; isInitial?: boolean }>;
    transitions: Array<{
        from: string | string[];
        to: string;
        event: string;
        guard?: unknown;
        effects?: unknown[];
    }>;
    /** Cross-trait event listeners (optional) */
    listens?: Array<{
        event: string;
        triggers: string;
        payloadMapping?: Record<string, unknown>;
    }>;
}

// ============================================================================
// Effect Handler Types
// ============================================================================

/**
 * Effect handlers interface - platform-specific implementations
 *
 * Client: React hooks, DOM, router
 * Server: Express, database, integrators
 */
export interface EffectHandlers {
    /** Emit an event to the event bus */
    emit: (event: string, payload?: Record<string, unknown>) => void;

    /** Persist data (create/update/delete) */
    persist: (
        action: 'create' | 'update' | 'delete',
        entityType: string,
        data?: Record<string, unknown>
    ) => Promise<void>;

    /** Set a field value on an entity */
    set: (entityId: string, field: string, value: unknown) => void;

    /** Call an external service */
    callService: (
        service: string,
        action: string,
        params?: Record<string, unknown>
    ) => Promise<unknown>;

    /** Fetch entity data (server only) - returns data for client-side rendering */
    fetch?: (
        entityType: string,
        options?: {
            id?: string;
            filter?: unknown;
            limit?: number;
            offset?: number;
        }
    ) => Promise<Record<string, unknown> | Record<string, unknown>[] | null>;

    /** Spawn a new entity instance */
    spawn?: (entityType: string, props?: Record<string, unknown>) => void;

    /** Despawn (delete) an entity instance */
    despawn?: (entityId: string) => void;

    // Platform-specific handlers (optional)

    /** Render UI to a slot (client only) */
    renderUI?: (
        slot: string,
        pattern: unknown,
        props?: Record<string, unknown>,
        priority?: number
    ) => void;

    /** Navigate to a route (client only) */
    navigate?: (path: string, params?: Record<string, unknown>) => void;

    /** Show a notification (client: toast, server: log) */
    notify?: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;

    /** Log a message */
    log?: (message: string, level?: 'log' | 'warn' | 'error', data?: unknown) => void;
}

// ============================================================================
// Binding Context Types
// ============================================================================

/**
 * Context for resolving bindings like @entity.field, @payload.value
 */
export interface BindingContext {
    /** Current entity data */
    entity?: Record<string, unknown>;
    /** Event payload data */
    payload?: Record<string, unknown>;
    /** Current state name */
    state?: string;
    /** Trait-level state/config */
    config?: Record<string, unknown>;
    /** Additional custom bindings */
    [key: string]: unknown;
}

// ============================================================================
// Effect Types
// ============================================================================

/**
 * S-expression effect array
 * First element is the operator, rest are arguments
 */
export type Effect = [string, ...unknown[]];

/**
 * Effect execution context
 */
export interface EffectContext {
    /** Trait name */
    traitName: string;
    /** Current state */
    state: string;
    /** Transition description */
    transition: string;
    /** Linked entity name */
    linkedEntity?: string;
    /** Entity ID (if available) */
    entityId?: string;
}
