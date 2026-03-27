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
        /** Compensating transition when effects fail (RCG-04) */
        onEffectError?: {
            to: string;
            effects?: unknown[];
        };
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

    /** Persist data (create/update/delete/batch) */
    persist: (
        action: 'create' | 'update' | 'delete' | 'batch',
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
            /** Relation fields to include (populate) in the response */
            include?: string[];
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

    // Resource operators (ref/deref/swap!/watch/atomic)

    /** Ref: declarative data subscription (server: same as fetch) */
    ref?: (
        entityType: string,
        options?: {
            id?: string;
            filter?: unknown;
            limit?: number;
            offset?: number;
            include?: string[];
        }
    ) => Promise<Record<string, unknown> | Record<string, unknown>[] | null>;

    /** Deref: one-shot data read (server: same as fetch) */
    deref?: (
        entityType: string,
        options?: {
            id?: string;
            filter?: unknown;
        }
    ) => Promise<Record<string, unknown> | Record<string, unknown>[] | null>;

    /** Swap!: atomic read-modify-write on an entity */
    swap?: (
        entityType: string,
        entityId: string,
        transform: unknown,
    ) => Promise<Record<string, unknown> | null>;

    /** Watch: client-side reactive subscription (no-op on server) */
    watch?: (
        entityType: string,
        options?: Record<string, unknown>,
    ) => void;

    /** Atomic: execute inner effects as a transaction */
    atomic?: (
        effects: unknown[],
    ) => Promise<void>;

    // OS trigger handlers (server-side only)
    /** Watch file system for changes matching glob pattern */
    osWatchFiles?: (glob: string, options: Record<string, unknown>) => void;
    /** Monitor a process by name */
    osWatchProcess?: (name: string, subcommand?: string) => void;
    /** Monitor a port for open/close */
    osWatchPort?: (port: number, protocol: string) => void;
    /** Intercept HTTP responses matching pattern */
    osWatchHttp?: (urlPattern: string, method?: string) => void;
    /** Register a cron schedule */
    osWatchCron?: (expression: string) => void;
    /** Register an OS signal handler */
    osWatchSignal?: (signal: string) => void;
    /** Watch an environment variable for changes */
    osWatchEnv?: (variable: string) => void;
    /** Configure debounce for an OS event type */
    osDebounce?: (ms: number, eventType: string) => void;
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

// ============================================================================
// Effect Result Types (RCG-04)
// ============================================================================

/**
 * Result of executing a single effect, with status tracking.
 */
export interface EffectResult {
    /** Effect operator (e.g., "persist", "render-ui") */
    type: string;
    /** Effect arguments */
    args: unknown[];
    /** Whether the effect executed successfully */
    status: "executed" | "failed" | "skipped";
    /** Error message if failed */
    error?: string;
    /** Execution duration in milliseconds */
    durationMs?: number;
}

// ============================================================================
// Runtime Configuration (RCG-01, RCG-02, RCG-05)
// ============================================================================

/**
 * Runtime configuration for strictness and safety modes.
 *
 * These options control how the runtime handles edge cases:
 * - `strictBindings`: Log warnings when bindings resolve to undefined (RCG-01)
 * - `guardMode`: Control whether guard errors block or allow transitions (RCG-02)
 * - `maxEventDepth`: Prevent infinite event loops (RCG-05)
 */
export interface RuntimeConfig {
    /**
     * When true, log warnings when bindings like @entity.field resolve to undefined.
     * Helps detect typos and missing fields early. (RCG-01)
     * @default false
     */
    strictBindings?: boolean;

    /**
     * Guard evaluation error handling mode. (RCG-02)
     * - "permissive": Guard errors allow the transition (current default behavior)
     * - "strict": Guard errors block the transition
     * @default "permissive"
     */
    guardMode?: "strict" | "permissive";

    /**
     * Maximum event emission depth before triggering circuit breaker. (RCG-05)
     * Prevents infinite loops from circular emit/listen chains.
     * @default 10
     */
    maxEventDepth?: number;
}

// ============================================================================
// Handler Manifest Types (RCG-03)
// ============================================================================

/**
 * Execution context for handler manifest validation.
 * Defines which effect handlers should be available in each environment.
 */
export type ExecutionEnvironment = "client" | "server" | "test" | "ssr";

// ============================================================================
// Transition Observer Types (Verification Registry Wiring)
// ============================================================================

/**
 * Observer interface for recording transition and effect traces.
 * Implement this to wire in the verificationRegistry or other monitoring tools.
 *
 * The runtime calls these hooks automatically when transitions execute and
 * effects complete, enabling runtime verification without tight coupling.
 */
export interface TransitionObserver {
    /**
     * Called after a transition is processed (whether or not it executed).
     */
    onTransition(trace: {
        traitName: string;
        from: string;
        to: string;
        event: string;
        guardResult?: boolean;
        effects: Array<{
            type: string;
            args: unknown[];
            status: "executed" | "failed" | "skipped";
            error?: string;
            durationMs?: number;
        }>;
    }): void;
}

/**
 * Maps execution environments to their available effect handlers.
 */
export const HANDLER_MANIFEST: Record<ExecutionEnvironment, string[]> = {
    client: ["render-ui", "render", "navigate", "notify", "emit", "set", "log", "ref", "deref", "watch"],
    server: ["persist", "fetch", "call-service", "emit", "set", "spawn", "despawn", "log", "ref", "deref", "swap!", "atomic", "os/watch-files", "os/watch-process", "os/watch-port", "os/watch-http", "os/watch-cron", "os/watch-signal", "os/watch-env", "os/debounce"],
    test: [
        "render-ui", "render", "navigate", "notify", "emit", "set",
        "persist", "fetch", "call-service", "spawn", "despawn", "log",
        "ref", "deref", "swap!", "watch", "atomic",
    ],
    ssr: ["render-ui", "render", "fetch", "emit", "set", "log", "ref", "deref"],
};
