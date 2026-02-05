/**
 * EffectExecutor - Platform-Agnostic Effect Dispatch
 *
 * Routes S-expression effects to appropriate handlers.
 * Platform-specific adapters provide handler implementations.
 *
 * @packageDocumentation
 */

import type { EffectHandlers, Effect, EffectContext } from './types.js';
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
    bindings: BindingContext
): unknown[] {
    const ctx = createContextFromBindings(bindings);
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

    constructor(options: EffectExecutorOptions) {
        this.handlers = options.handlers;
        this.bindings = options.bindings;
        this.context = options.context;
        this.debug = options.debug ?? false;
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
        const resolvedArgs = resolveArgs(args, this.bindings);

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
                const action = args[0] as 'create' | 'update' | 'delete';
                const entityType = args[1] as string;
                const data = args[2] as Record<string, unknown> | undefined;
                await this.handlers.persist(action, entityType, data);
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
                    const options = args[1] as {
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
                // Condition should already be resolved by binding resolution
                const condition = args[0];
                const thenEffect = args[1];
                const elseEffect = args[2];

                if (condition) {
                    await this.execute(thenEffect);
                } else if (elseEffect) {
                    await this.execute(elseEffect);
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
