/**
 * Unified Runtime Types
 *
 * Platform-agnostic interfaces for trait execution on client or server.
 *
 * @packageDocumentation
 */

import type {
    EntityRow,
    EventPayload,
    FetchResult,
    ServiceParams,
    ResolvedPatternProps,
    AgentContext,
    BusEvent,
    BusEventSource,
    BusEventListener,
    Unsubscribe as CoreUnsubscribe,
    PatternConfig,
    SExpr,
    FieldValue,
    LlmContext,
    WorkspaceContext,
    SessionContext,
    MemoryContext,
    TraceContext,
    IntegrationContext,
    Orbital,
    ServiceCallResult,
} from '@almadar/core';

// ============================================================================
// Runtime Data Types (re-exported from @almadar/core)
// ============================================================================

export type { EntityRow, EventPayload, FetchResult, ServiceParams };

/** Alias for ResolvedPatternProps to avoid breaking internal consumers */
export type PatternProps = ResolvedPatternProps;

/**
 * Value a render-ui pattern prop can carry AFTER interpolation. Mirrors
 * `FieldValue` but extends with `RuntimeRenderPattern` so nested pattern
 * configs (children, slot props that are themselves render-ui nodes)
 * round-trip without an `unknown` escape hatch.
 */
export type RuntimePatternValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | EntityRow
    | EntityRow[]
    | readonly RuntimePatternValue[]
    | RuntimeRenderPattern;

/**
 * Shape of a render-ui pattern AFTER interpolation, as the runtime hands
 * it to `EffectHandlers.renderUI`. Different from `ResolvedPatternProps`
 * (`@almadar/core`) because the post-interpolation pattern carries
 * resolved EntityRow values (e.g. `{ entity: <row> }` from `@payload.row`)
 * not just primitives. Used by render-ui observability helpers to narrow
 * safely without `unknown` casts.
 */
export interface RuntimeRenderPattern {
    readonly [prop: string]: RuntimePatternValue;
}

/**
 * Configuration context.
 *
 * Re-export of `TraitConfig` from `@almadar/core` for the runtime's binding
 * and state-machine layers. Supports scalar, array, and nested-object values
 * so `config.fields = ["name", "description"]` and similar authoring shapes
 * flow through the binding context without type widening.
 */
import type { TraitConfig } from '@almadar/core';
export type ConfigContext = TraitConfig;

// ============================================================================
// Event Bus Types
// ============================================================================

/**
 * Event structure for cross-trait communication.
 * Re-export of `BusEvent` from `@almadar/core` so runtime + ui + codegen
 * all agree on the bus envelope shape. `RuntimeEvent` is kept as a type
 * alias for anyone importing by the old name.
 */
export type RuntimeEvent = BusEvent;
export type EventListener = BusEventListener;
export type Unsubscribe = CoreUnsubscribe;

/**
 * Event bus interface for pub/sub communication
 */
export interface IEventBus {
    /** Emit an event */
    emit(type: string, payload?: EventPayload, source?: BusEventSource): void;
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
    context: ConfigContext;
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
    effects: SExpr[];
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
        effects?: SExpr[];
        /** Compensating transition when effects fail (RCG-04) */
        onEffectError?: {
            to: string;
            effects?: SExpr[];
        };
    }>;
    /** Cross-trait event listeners (optional) */
    listens?: Array<{
        event: string;
        triggers: string;
        payloadMapping?: EventPayload;
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
    /**
     * Emit an event to the event bus.
     *
     * `source` carries the emitter's identity (orbital + trait) so that
     * source-scoped listeners (`TraitName EVENT -> TRIGGER` and
     * `Orbital.TraitName EVENT -> TRIGGER` in .lolo) can filter incoming
     * events by their originating trait. Omitted when the emit is
     * synthesized by a non-trait context (e.g. test harness).
     */
    emit: (event: string, payload?: EventPayload, source?: RuntimeEvent['source']) => void;

    /** Persist data (create/update/delete/batch) */
    persist: (
        action: 'create' | 'update' | 'delete' | 'batch',
        entityType: string,
        data?: EntityRow
    ) => Promise<void>;

    /** Set a field value on an entity */
    set: (entityId: string, field: string, value: FieldValue) => void;

    /** Call an external service */
    callService: (
        service: string,
        action: string,
        params?: ServiceParams
    ) => Promise<EventPayload | null>;

    /** Fetch entity data (server only) - returns data for client-side rendering.
     *
     * Always returns a `FetchResult` (`{rows, total}`) on success. `total`
     * is the count of rows matching the `filter` BEFORE `offset`/`limit`
     * are applied so a paginating caller can compute totalPages without
     * a second round-trip. Single-id fetches return `total: 1`. `null`
     * means "not found / failed".
     */
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
    ) => Promise<FetchResult | null>;

    /** Stream an LLM or HTTP response (server only).
     *
     * Calls `onChunk` per incoming chunk; resolves with the final aggregated
     * result on completion. The executor fires `emit.on_message` per chunk and
     * `emit.success` on resolution. `null` means stream failed before any chunk.
     */
    fetchStream?: (
        entityType: string,
        options: {
            id?: string;
            filter?: unknown;
        } | undefined,
        onChunk: (chunk: unknown) => void,
    ) => Promise<unknown>;

    /** Spawn a new entity instance */
    spawn?: (entityType: string, props?: EntityRow) => void;

    /** Despawn (delete) an entity instance */
    despawn?: (entityId: string) => void;

    /** Send an orbital event to the server over WebSocket (client-only).
     *
     * Produces the wire message `{ type: 'ORBITAL_EVENT', payload: { orbital, event, payload, entityId? } }`
     * which `setupEventBroadcast` decodes → server bus → `processOrbitalEvent`.
     */
    sendServer?: (event: string, payload?: EventPayload) => void;

    // Platform-specific handlers (optional)

    /** Render UI to a slot (client only). `pattern` is the post-interpolation
     * `PatternConfig` from the trait's `(render-ui slot pattern)` SExpr, or
     * `null` when the trait clears the slot (`render-ui slot null`). */
    renderUI?: (
        slot: string,
        pattern: PatternConfig | null,
        props?: PatternProps,
        priority?: number
    ) => void;

    /** Navigate to a route (client only) */
    navigate?: (path: string, params?: { [key: string]: string }) => void;

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
    ) => Promise<FetchResult | null>;

    /** Deref: one-shot data read (server: same as fetch) */
    deref?: (
        entityType: string,
        options?: {
            id?: string;
            filter?: unknown;
        }
    ) => Promise<FetchResult | null>;

    /** Swap!: atomic read-modify-write on an entity */
    swap?: (
        entityType: string,
        entityId: string,
        transform: unknown,
    ) => Promise<EntityRow | null>;

    /** Watch: client-side reactive subscription (no-op on server) */
    watch?: (
        entityType: string,
        options?: { id?: string; filter?: unknown; limit?: number },
    ) => void;

    /** Atomic: execute inner effects as a transaction */
    atomic?: (
        effects: SExpr[],
    ) => Promise<void>;

    // === Composition handlers (compile-time, optional) ===
    /** Compose multiple orbitals into one schema. Compile-time only. */
    composeBehaviors?: (config: { appName: string; orbitals: unknown[]; layoutStrategy?: string; eventWiring?: unknown[]; entityMappings?: Record<string, string> }) => Promise<unknown> | unknown;
    /** Apply cross-orbital event wiring. Compile-time only. */
    applyEventWiring?: (orbitals: unknown[], wiring: unknown[]) => Promise<unknown[]> | unknown[];
    /** Auto-detect layout strategy. Compile-time only. */
    detectLayoutStrategy?: (orbitals: unknown[], wiring?: unknown[]) => Promise<string> | string;
    /** Left-to-right behavior pipeline. Compile-time only. */
    pipeBehaviors?: (seed: unknown, ...steps: Array<(prev: unknown) => unknown>) => Promise<unknown> | unknown;

    // OS trigger handlers (server-side only)
    //
    // Each handler may accept an optional `emit` config — when present, the
    // handler fires `emit.on_message` in place of the hardcoded event name
    // (e.g. `OS_FILE_MODIFIED`). Hardcoded fallback is preserved so existing
    // schemas without `emit:` keep working.
    /** Watch file system for changes matching glob pattern */
    osWatchFiles?: (
        glob: string,
        options: { recursive?: boolean; debounce?: number },
        emit?: OsEmitConfig,
    ) => void;
    /** Monitor a process by name */
    osWatchProcess?: (name: string, subcommand?: string, emit?: OsEmitConfig) => void;
    /** Monitor a port for open/close */
    osWatchPort?: (port: number, protocol: string, emit?: OsEmitConfig) => void;
    /** Intercept HTTP responses matching pattern */
    osWatchHttp?: (urlPattern: string, method?: string, emit?: OsEmitConfig) => void;
    /** Register a cron schedule */
    osWatchCron?: (expression: string, emit?: OsEmitConfig) => void;
    /** Register an OS signal handler */
    osWatchSignal?: (signal: string, emit?: OsEmitConfig) => void;
    /** Watch an environment variable for changes */
    osWatchEnv?: (variable: string, emit?: OsEmitConfig) => void;
    /** Configure debounce for an OS event type */
    osDebounce?: (ms: number, eventType: string) => void;

    // === Browser device handlers (client-side only) ===
    //
    // User-initiated, async device APIs. The executor wraps each in
    // `runSubstrate`, so a resolved value fires `emit.success` with the
    // uniform `{ result }` payload and a rejection fires `emit.failure`
    // with `{ error }`. Absent on the server (→ unsupported warning).

    /** browser/open-file-picker — resolves with `{ files }` inside `result` */
    browserOpenFilePicker?: (options?: BrowserFilePickerOptions) => Promise<{ files: BrowserFileMeta[] }>;
    /** browser/clipboard-read — resolves with `{ text }` inside `result` */
    browserClipboardRead?: () => Promise<{ text: string }>;
    /** browser/clipboard-write — resolves with `{ text }` (echo) inside `result` */
    browserClipboardWrite?: (text: string) => Promise<{ text: string }>;
    /** browser/geolocation-current — resolves with the position inside `result` */
    browserGeolocationCurrent?: (options?: BrowserGeolocationOptions) => Promise<BrowserGeolocationPosition>;

    // === Agent substrate handlers (server-side only) ===
    // These back the effect-position substrate operators that fire events
    // and return typed ServiceCallResult members.

    /** compose/compose-all — compose multiple orbitals into one schema */
    substrateComposeAll?: (config: { appName: string; orbitals: Orbital[]; layoutStrategy?: string }) => Promise<ServiceCallResult | null>;
    /** compose/compose-children — compose children under a parent */
    substrateComposeChildren?: (parentName: string, children: Orbital[]) => Promise<ServiceCallResult | null>;
    /** behavior/instantiate — instantiate a behavior at runtime (meta `uses`) */
    substrateInstantiate?: (parentName: string, behavior: string, params?: TraitConfig) => Promise<ServiceCallResult | null>;
    /** behavior/call — call a method on an instantiated behavior */
    substrateCall?: (behavior: string, method: string, params?: TraitConfig) => Promise<ServiceCallResult | null>;
    /** validate/validate — validate an orbital, fires VALIDATED_OK/ERROR */
    substrateValidate?: (orbitalName: string) => Promise<ServiceCallResult | null>;
    /** lolo/emit-body — emit lolo source for an orbital */
    substrateEmitBody?: (orbitalName: string, loloSource: string) => Promise<ServiceCallResult | null>;
}

/**
 * Author-configured `emit:` block threaded into `os/watch-*` handlers.
 * Narrower than @almadar/core's `EmitConfig` — only the keys streaming
 * operators meaningfully fire.
 */
export type OsEmitConfig = Pick<import('@almadar/core').EmitConfig, 'on_message' | 'failure'>;

// ============================================================================
// Browser Device Handler Types (client host path)
// ============================================================================
//
// Structural device shapes with no equivalent in @almadar/core (file metadata,
// geolocation). Primitives only — no `unknown` — so they flow into the
// uniform `{ result }` emit payload (EventPayload-compatible) without casts.

/** Options for `browser/open-file-picker`. */
export interface BrowserFilePickerOptions {
    /** Allow selecting multiple files. */
    multiple?: boolean;
    /** MIME type filter (e.g. "image/*"). Best-effort; host may ignore. */
    accept?: string;
}

/** Metadata for a file chosen via `browser/open-file-picker`. */
export interface BrowserFileMeta {
    name: string;
    size: number;
    type: string;
    lastModified: number;
}

/** Options for `browser/geolocation-current` (subset of PositionOptions). */
export interface BrowserGeolocationOptions {
    enableHighAccuracy?: boolean;
    timeout?: number;
    maximumAge?: number;
}

/** Position returned by `browser/geolocation-current`. */
export interface BrowserGeolocationPosition {
    latitude: number;
    longitude: number;
    accuracy: number;
}

// ============================================================================
// Binding Context Types
// ============================================================================

/**
 * Context for resolving bindings like @entity.field, @payload.value
 */
export interface BindingContext {
    /** Current entity data */
    entity?: EntityRow;
    /** Event payload data */
    payload?: EventPayload;
    /** Current state name */
    state?: string;
    /** Trait-level state/config */
    config?: ConfigContext;
    /**
     * Local variables introduced by a `let` form, keyed by bare name and
     * referenced via `@<name>` (the canonical evaluator convention — same as
     * `createChildContext` in `@almadar/evaluator`). Carried on the context so
     * a `let` body's effects resolve their value expressions against the
     * `let`-bound locals.
     */
    locals?: Map<string, unknown>;
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
    /** Orbital that owns the firing trait. Used to stamp the source
     * metadata on emits so source-scoped listens (`TraitName EVENT` for
     * intra-orbital, `Orbital.TraitName EVENT` for cross-orbital) can
     * filter by emitter identity. */
    orbitalName?: string;
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

    /**
     * Additional fields to spread onto every EvaluationContext.
     * Used to inject module contexts (e.g., { agent: AgentContext }).
     * The evaluator dispatches agent/* operators to ctx.agent.
     */
    contextExtensions?: EvaluationContextExtensions;
}

/**
 * Typed extensions that get spread onto every EvaluationContext.
 * Each field here corresponds to an optional field on EvaluationContext.
 */
export interface EvaluationContextExtensions {
    /** Agent context for agent/* operators (memory, LLM, tools, session) */
    agent?: AgentContext;
    /** Substrate contexts for the new operator namespaces */
    llm?: LlmContext;
    workspace?: WorkspaceContext;
    session?: SessionContext;
    memory?: MemoryContext;
    trace?: TraceContext;
    integration?: IntegrationContext;
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
    client: ["render-ui", "render", "navigate", "notify", "emit", "set", "log", "ref", "deref", "watch", "send-server", "browser/open-file-picker", "browser/clipboard-read", "browser/clipboard-write", "browser/geolocation-current"],
    server: ["persist", "fetch", "fetch-stream", "call-service", "emit", "set", "spawn", "despawn", "log", "ref", "deref", "swap!", "atomic", "os/watch-files", "os/watch-process", "os/watch-port", "os/watch-http", "os/watch-cron", "os/watch-signal", "os/watch-env", "os/debounce"],
    test: [
        "render-ui", "render", "navigate", "notify", "emit", "set",
        "persist", "fetch", "call-service", "spawn", "despawn", "log",
        "ref", "deref", "swap!", "watch", "atomic", "send-server",
        "browser/open-file-picker", "browser/clipboard-read", "browser/clipboard-write", "browser/geolocation-current",
    ],
    ssr: ["render-ui", "render", "fetch", "emit", "set", "log", "ref", "deref"],
};
