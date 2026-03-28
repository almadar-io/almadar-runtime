/**
 * EffectExecutor - Platform-Agnostic Effect Dispatch
 *
 * Routes S-expression effects to appropriate handlers.
 * Platform-specific adapters provide handler implementations.
 *
 * @packageDocumentation
 */

import type {
    EffectHandlers,
    Effect,
    EffectContext,
    EffectResult,
    ExecutionEnvironment,
} from './types.js';
import { HANDLER_MANIFEST } from './types.js';
import { interpolateValue, createContextFromBindings } from './BindingResolver.js';
import type { BindingContext } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Full executor options with handlers and context.
 */
export interface EffectExecutorOptions {
    /** Effect handlers (platform-specific) */
    handlers: EffectHandlers;
    /** Binding context for resolving @entity.field references */
    bindings: BindingContext;
    /** Effect execution context (trait name, state, etc.) */
    context: EffectContext;
    /** Enable debug logging */
    debug?: boolean;
    /** When true, log warnings when bindings resolve to undefined (RCG-01) */
    strictBindings?: boolean;
}

// ============================================================================
// Effect Parsing
// ============================================================================

/**
 * Parse an effect into operator and arguments.
 */
function parseEffect(effect: unknown): { operator: string; args: unknown[] } | null {
    if (!Array.isArray(effect) || effect.length === 0) {
        return null;
    }

    const [operator, ...args] = effect;
    if (typeof operator !== 'string') {
        return null;
    }

    return { operator, args };
}

/**
 * Resolve all bindings in effect arguments.
 */
function resolveArgs(
    args: unknown[],
    bindings: BindingContext,
    strictBindings?: boolean
): unknown[] {
    const ctx = createContextFromBindings(bindings, strictBindings);
    return args.map((arg) => interpolateValue(arg, ctx));
}

// ============================================================================
// Effect Executor
// ============================================================================

/**
 * EffectExecutor - Routes effects to handlers.
 *
 * @example
 * ```ts
 * const executor = new EffectExecutor({
 *   handlers: {
 *     emit: (event, payload) => eventBus.emit(event, payload),
 *     persist: async (action, entity, data) => { ... },
 *     set: (id, field, value) => { ... },
 *     callService: async (service, action, params) => { ... },
 *   },
 *   bindings: { entity: { name: 'Product' }, payload: { id: '123' } },
 *   context: { traitName: 'Cart', state: 'active', transition: 'idle->active' },
 * });
 *
 * // Execute a single effect
 * executor.execute(['emit', 'ITEM_ADDED', { count: 1 }]);
 *
 * // Execute multiple effects
 * executor.executeAll([
 *   ['set', 'item', 'quantity', 5],
 *   ['emit', 'QUANTITY_UPDATED'],
 * ]);
 * ```
 */
export class EffectExecutor {
    private handlers: EffectHandlers;
    private bindings: BindingContext;
    private context: EffectContext;
    private debug: boolean;
    private strictBindings: boolean;

    constructor(options: EffectExecutorOptions) {
        this.handlers = options.handlers;
        this.bindings = options.bindings;
        this.context = options.context;
        this.debug = options.debug ?? false;
        this.strictBindings = options.strictBindings ?? false;
    }

    // ==========================================================================
    // Handler Manifest Validation (RCG-03)
    // ==========================================================================

    /**
     * Validate that all effect types used in a schema have handlers registered.
     * Call this at runtime startup to catch missing handler setup immediately.
     *
     * @param usedEffectTypes - Effect operator names used in the loaded schemas
     * @param environment - Execution environment for context-aware error messages
     * @returns Array of missing handler errors (empty if all handlers are available)
     *
     * @example
     * ```ts
     * const missing = EffectExecutor.validateHandlers(
     *   ['persist', 'render-ui', 'fetch'],
     *   executor.getRegisteredHandlers(),
     *   'client'
     * );
     * if (missing.length > 0) {
     *   console.error('Missing handlers:', missing);
     * }
     * ```
     */
    static validateHandlers(
        usedEffectTypes: string[],
        registeredHandlers: string[],
        environment?: ExecutionEnvironment
    ): string[] {
        const errors: string[] = [];
        const expectedHandlers = environment
            ? HANDLER_MANIFEST[environment]
            : undefined;

        for (const effectType of usedEffectTypes) {
            if (!registeredHandlers.includes(effectType)) {
                let message = `Effect "${effectType}" is used in schema but no handler is registered.`;
                if (expectedHandlers && !expectedHandlers.includes(effectType)) {
                    message += ` Effect "${effectType}" is not expected in "${environment}" environment.`;
                }
                errors.push(message);
            }
        }

        return errors;
    }

    /**
     * Get list of effect operators that have handlers registered.
     */
    getRegisteredHandlers(): string[] {
        const registered: string[] = [];
        const handlerMap: Record<string, unknown> = {
            'emit': this.handlers.emit,
            'persist': this.handlers.persist,
            'set': this.handlers.set,
            'call-service': this.handlers.callService,
            'fetch': this.handlers.fetch,
            'spawn': this.handlers.spawn,
            'despawn': this.handlers.despawn,
            'render-ui': this.handlers.renderUI,
            'render': this.handlers.renderUI,
            'navigate': this.handlers.navigate,
            'notify': this.handlers.notify,
            'log': this.handlers.log,
            'ref': this.handlers.ref,
            'deref': this.handlers.deref,
            'swap!': this.handlers.swap,
            'watch': this.handlers.watch,
            'atomic': this.handlers.atomic,
        };
        for (const [name, handler] of Object.entries(handlerMap)) {
            if (handler) {
                registered.push(name);
            }
        }
        // Compound operators are always available
        registered.push('do', 'when');
        return registered;
    }

    /**
     * Execute a single effect.
     */
    async execute(effect: unknown): Promise<void> {
        const parsed = parseEffect(effect);
        if (!parsed) {
            if (this.debug) {
                console.warn('[EffectExecutor] Invalid effect format:', effect);
            }
            return;
        }

        const { operator, args } = parsed;

        // Compound operators ('do', 'when') contain nested effects as arguments.
        // Skip resolveArgs for these — each nested effect will be resolved
        // individually when this.execute() recurses into it via dispatch().
        const isCompound = operator === 'do' || operator === 'when';
        const resolvedArgs = isCompound ? args : resolveArgs(args, this.bindings, this.strictBindings);

        if (this.debug) {
            console.log('[EffectExecutor] Executing:', operator, resolvedArgs);
        }

        try {
            await this.dispatch(operator, resolvedArgs);
        } catch (error) {
            console.error('[EffectExecutor] Error executing effect:', operator, error);
            throw error;
        }
    }

    /**
     * Execute multiple effects in sequence.
     */
    async executeAll(effects: unknown[]): Promise<void> {
        for (const effect of effects) {
            await this.execute(effect);
        }
    }

    /**
     * Execute multiple effects in parallel.
     */
    async executeParallel(effects: unknown[]): Promise<void> {
        await Promise.all(effects.map((effect) => this.execute(effect)));
    }

    // ==========================================================================
    // Effect Execution with Results (RCG-04)
    // ==========================================================================

    /**
     * Execute effects and return detailed results for each.
     * Enables compensating transitions by reporting which effects failed.
     *
     * Unlike `executeAll`, this method does NOT throw on effect errors.
     * Instead, it captures errors in the returned `EffectResult[]` array.
     */
    async executeWithResults(effects: unknown[]): Promise<EffectResult[]> {
        const results: EffectResult[] = [];

        for (const effect of effects) {
            const parsed = parseEffect(effect);
            if (!parsed) {
                results.push({
                    type: 'unknown',
                    args: [],
                    status: 'skipped',
                    error: 'Invalid effect format',
                });
                continue;
            }

            const start = Date.now();
            const { operator, args: rawArgs } = parsed;
            const isCompound = operator === 'do' || operator === 'when';
            const resolvedArgs = isCompound
                ? rawArgs
                : resolveArgs(rawArgs, this.bindings, this.strictBindings);

            try {
                await this.dispatch(operator, resolvedArgs);
                results.push({
                    type: operator,
                    args: resolvedArgs,
                    status: 'executed',
                    durationMs: Date.now() - start,
                });
            } catch (error) {
                const errorMessage = error instanceof Error
                    ? error.message
                    : String(error);
                results.push({
                    type: operator,
                    args: resolvedArgs,
                    status: 'failed',
                    error: errorMessage,
                    durationMs: Date.now() - start,
                });
            }
        }

        return results;
    }

    // ==========================================================================
    // Effect Dispatch
    // ==========================================================================

    private async dispatch(operator: string, args: unknown[]): Promise<void> {
        switch (operator) {
            // === Universal Effects ===

            case 'emit': {
                const event = args[0] as string;
                const payload = args[1] as Record<string, unknown> | undefined;
                this.handlers.emit(event, payload);
                break;
            }

            case 'set': {
                const [entityId, field, value] = args as [string, string, unknown];
                this.handlers.set(entityId, field, value);
                break;
            }

            case 'persist': {
                const action = args[0] as 'create' | 'update' | 'delete' | 'batch';
                if (action === 'batch') {
                    // Batch mode: ["persist", "batch", [...operations]]
                    // Each operation: ["create", "collection", {...}],
                    //                 ["update", "collection", "id", {...}],
                    //                 ["delete", "collection", "id"]
                    const operations = args[1] as unknown[];
                    await this.handlers.persist('batch', '', { operations } as Record<string, unknown>);
                } else {
                    const entityType = args[1] as string;
                    const data = args[2] as Record<string, unknown> | undefined;
                    await this.handlers.persist(action, entityType, data);
                }
                break;
            }

            case 'call-service': {
                const service = args[0] as string;
                const action = args[1] as string;
                const params = args[2] as Record<string, unknown> | undefined;
                await this.handlers.callService(service, action, params);
                break;
            }

            case 'fetch': {
                if (this.handlers.fetch) {
                    const entityType = args[0] as string;
                    const rawOpt = args[1];
                    // Support both shorthand ['fetch', 'Entity', 'id-value']
                    // and full options ['fetch', 'Entity', { id: 'id-value' }]
                    const options = typeof rawOpt === 'string'
                        ? { id: rawOpt }
                        : rawOpt as {
                            id?: string;
                            filter?: unknown;
                            limit?: number;
                            offset?: number;
                            include?: string[];
                        } | undefined;
                    await this.handlers.fetch(entityType, options);
                } else {
                    this.logUnsupported('fetch');
                }
                break;
            }

            // === Resource Operators ===

            case 'ref': {
                const refEntityType = args[0] as string;
                const rawRefOpt = args[1];
                const refOptions = typeof rawRefOpt === 'string'
                    ? { id: rawRefOpt }
                    : rawRefOpt as {
                        id?: string;
                        filter?: unknown;
                        limit?: number;
                        offset?: number;
                        include?: string[];
                    } | undefined;
                if (this.handlers.ref) {
                    await this.handlers.ref(refEntityType, refOptions);
                } else if (this.handlers.fetch) {
                    await this.handlers.fetch(refEntityType, refOptions);
                } else {
                    this.logUnsupported('ref');
                }
                break;
            }

            case 'deref': {
                const derefEntityType = args[0] as string;
                const rawDerefOpt = args[1];
                const derefOptions = typeof rawDerefOpt === 'string'
                    ? { id: rawDerefOpt }
                    : rawDerefOpt as {
                        id?: string;
                        filter?: unknown;
                    } | undefined;
                if (this.handlers.deref) {
                    await this.handlers.deref(derefEntityType, derefOptions);
                } else if (this.handlers.fetch) {
                    await this.handlers.fetch(derefEntityType, derefOptions);
                } else {
                    this.logUnsupported('deref');
                }
                break;
            }

            case 'swap!': {
                if (this.handlers.swap) {
                    const swapEntityType = args[0] as string;
                    const swapEntityId = args[1] as string;
                    const swapTransform = args[2];
                    await this.handlers.swap(swapEntityType, swapEntityId, swapTransform);
                } else {
                    this.logUnsupported('swap!');
                }
                break;
            }

            case 'watch': {
                if (this.handlers.watch) {
                    const watchEntityType = args[0] as string;
                    const watchOptions = args[1] as Record<string, unknown> | undefined;
                    this.handlers.watch(watchEntityType, watchOptions);
                } else {
                    // Watch is a no-op on server - just log in debug mode
                    if (this.debug) {
                        console.log('[EffectExecutor] watch is a no-op on server:', args[0]);
                    }
                }
                break;
            }

            case 'atomic': {
                if (this.handlers.atomic) {
                    const atomicEffects = args as unknown[];
                    await this.handlers.atomic(atomicEffects);
                } else {
                    // Fallback: execute inner effects sequentially
                    const atomicEffects = args as unknown[];
                    for (const inner of atomicEffects) {
                        await this.execute(inner);
                    }
                }
                break;
            }

            case 'spawn': {
                if (this.handlers.spawn) {
                    const entityType = args[0] as string;
                    const props = args[1] as Record<string, unknown> | undefined;
                    this.handlers.spawn(entityType, props);
                } else {
                    this.logUnsupported('spawn');
                }
                break;
            }

            case 'despawn': {
                if (this.handlers.despawn) {
                    const entityId = args[0] as string;
                    this.handlers.despawn(entityId);
                } else {
                    this.logUnsupported('despawn');
                }
                break;
            }

            case 'log': {
                if (this.handlers.log) {
                    const message = args[0] as string;
                    const level = args[1] as 'log' | 'warn' | 'error' | undefined;
                    const data = args[2];
                    this.handlers.log(message, level, data);
                } else {
                    console.log(args[0], args.slice(1));
                }
                break;
            }

            // === Client-Only Effects ===

            case 'render-ui':
            case 'render': {
                if (this.handlers.renderUI) {
                    const slot = args[0] as string;
                    const pattern = args[1];
                    const props = args[2] as Record<string, unknown> | undefined;
                    const priority = args[3] as number | undefined;
                    this.handlers.renderUI(slot, pattern, props, priority);
                } else {
                    this.logUnsupported('render-ui');
                }
                break;
            }

            case 'navigate': {
                if (this.handlers.navigate) {
                    const path = args[0] as string;
                    const params = args[1] as Record<string, unknown> | undefined;
                    this.handlers.navigate(path, params);
                } else {
                    this.logUnsupported('navigate');
                }
                break;
            }

            case 'notify': {
                if (this.handlers.notify) {
                    const message = args[0] as string;
                    const type = (args[1] as 'success' | 'error' | 'warning' | 'info') || 'info';
                    this.handlers.notify(message, type);
                } else {
                    console.log(`[Notify:${args[1] || 'info'}] ${args[0]}`);
                }
                break;
            }

            // === Compound Effects ===

            case 'do': {
                // Sequential execution of nested effects
                const nestedEffects = args as unknown[];
                for (const nested of nestedEffects) {
                    await this.execute(nested);
                }
                break;
            }

            case 'when': {
                // Conditional effect: ['when', condition, thenEffect, elseEffect?]
                // Only the condition needs binding resolution — then/else are
                // nested effects that will be resolved when execute() recurses.
                const ctx = createContextFromBindings(this.bindings);
                const condition = interpolateValue(args[0], ctx);
                const thenEffect = args[1];
                const elseEffect = args[2];

                if (condition) {
                    await this.execute(thenEffect);
                } else if (elseEffect) {
                    await this.execute(elseEffect);
                }
                break;
            }

            // OS trigger operators (server-side only)
            case 'os/watch-files': {
                if (this.handlers.osWatchFiles) {
                    const glob = args[0] as string;
                    const options = args[1] as Record<string, unknown> | undefined;
                    this.handlers.osWatchFiles(glob, options ?? {});
                } else {
                    this.logUnsupported('os/watch-files');
                }
                break;
            }
            case 'os/watch-process': {
                if (this.handlers.osWatchProcess) {
                    this.handlers.osWatchProcess(args[0] as string, args[1] as string | undefined);
                } else {
                    this.logUnsupported('os/watch-process');
                }
                break;
            }
            case 'os/watch-port': {
                if (this.handlers.osWatchPort) {
                    this.handlers.osWatchPort(args[0] as number, (args[1] as string) ?? 'tcp');
                } else {
                    this.logUnsupported('os/watch-port');
                }
                break;
            }
            case 'os/watch-http': {
                if (this.handlers.osWatchHttp) {
                    this.handlers.osWatchHttp(args[0] as string, args[1] as string | undefined);
                } else {
                    this.logUnsupported('os/watch-http');
                }
                break;
            }
            case 'os/watch-cron': {
                if (this.handlers.osWatchCron) {
                    this.handlers.osWatchCron(args[0] as string);
                } else {
                    this.logUnsupported('os/watch-cron');
                }
                break;
            }
            case 'os/watch-signal': {
                if (this.handlers.osWatchSignal) {
                    this.handlers.osWatchSignal(args[0] as string);
                } else {
                    this.logUnsupported('os/watch-signal');
                }
                break;
            }
            case 'os/watch-env': {
                if (this.handlers.osWatchEnv) {
                    this.handlers.osWatchEnv(args[0] as string);
                } else {
                    this.logUnsupported('os/watch-env');
                }
                break;
            }
            case 'os/debounce': {
                if (this.handlers.osDebounce) {
                    this.handlers.osDebounce(args[0] as number, args[1] as string);
                } else {
                    this.logUnsupported('os/debounce');
                }
                break;
            }

            default: {
                if (this.debug) {
                    console.warn('[EffectExecutor] Unknown operator:', operator);
                }
            }
        }
    }

    private logUnsupported(operator: string): void {
        if (this.debug) {
            console.warn(
                `[EffectExecutor] Effect "${operator}" not supported on this platform`
            );
        }
    }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a minimal EffectExecutor for testing or simple scenarios.
 */
export function createTestExecutor(
    overrides: Partial<EffectHandlers> = {}
): EffectExecutor {
    const noopAsync = async () => { };
    const noop = () => { };

    return new EffectExecutor({
        handlers: {
            emit: overrides.emit ?? noop,
            persist: overrides.persist ?? noopAsync,
            set: overrides.set ?? noop,
            callService: overrides.callService ?? (async () => ({})),
            ...overrides,
        },
        bindings: {},
        context: {
            traitName: 'TestTrait',
            state: 'test',
            transition: 'test->test',
        },
        debug: true,
    });
}
