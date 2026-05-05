/**
 * EffectExecutor - Platform-Agnostic Effect Dispatch
 *
 * Routes S-expression effects to appropriate handlers.
 * Platform-specific adapters provide handler implementations.
 *
 * @packageDocumentation
 */

import type { EmitConfig, FetchOptions, PatternConfig } from '@almadar/core';
import type {
    EffectHandlers,
    Effect,
    EffectContext,
    EffectResult,
    ExecutionEnvironment,
} from './types.js';
import { HANDLER_MANIFEST } from './types.js';
import { interpolateValue, createContextFromBindings } from './BindingResolver.js';
import type { BindingContext, EntityRow, EventPayload, FetchResult, ServiceParams, PatternProps, EvaluationContextExtensions } from './types.js';
import { createLogger } from './logger.js';

const effectLog = createLogger('almadar:runtime:effects');

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
    /** Additional fields to spread onto EvaluationContext (e.g., { agent: AgentContext }) */
    contextExtensions?: EvaluationContextExtensions;
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
    strictBindings?: boolean,
    contextExtensions?: EvaluationContextExtensions,
): unknown[] {
    const ctx = createContextFromBindings(bindings, strictBindings, contextExtensions);
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
    private contextExtensions?: EvaluationContextExtensions;

    constructor(options: EffectExecutorOptions) {
        this.handlers = options.handlers;
        this.bindings = options.bindings;
        this.context = options.context;
        this.debug = options.debug ?? false;
        this.strictBindings = options.strictBindings ?? false;
        this.contextExtensions = options.contextExtensions;
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
        const handlerMap: { [op: string]: ((...args: never[]) => unknown) | undefined } = {
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
            'behavior/compose': this.handlers.composeBehaviors,
            'behavior/wire': this.handlers.applyEventWiring,
            'behavior/detect-layout': this.handlers.detectLayoutStrategy,
            'behavior/pipe': this.handlers.pipeBehaviors,
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

        // `set` with an `@entity.<field>` path literal uses that first arg as a
        // binding PATH, not as a value to resolve. Skip interpolating args[0] so
        // dispatch('set', ...) can parse the field name from the path. This
        // applies to both the bare 3-elem form AND the 4-elem form with a
        // trailing `emit:` options object (added by close-the-circuit Stage 2).
        // The purely positional 4-elem form (entityId, field, value) falls
        // through the normal resolve path below.
        const isSetPathForm =
            operator === 'set' &&
            args.length >= 2 &&
            typeof args[0] === 'string' &&
            (args[0] as string).startsWith('@entity.');

        // Resource-fetch operators carry a `filter` SExpression in args[1]
        // that the handler evaluates per-row against the fetched collection.
        // Pre-interpolation collapses it to a single constant boolean (e.g.
        // `(or (= "active" "") (= (object/get @entity "status") "active"))`
        // becomes literal `true` or `false` against the OUTER trait's bound
        // entity), so the handler then applies the same constant to every
        // row — no narrowing. Preserve the filter SExpression verbatim;
        // resolve the rest of the options object normally.
        const isFetchLike =
            (operator === 'fetch' ||
                operator === 'ref' ||
                operator === 'deref' ||
                operator === 'os/watch-collection' ||
                operator === 'os/watch') &&
            args.length >= 2 &&
            args[1] !== null &&
            typeof args[1] === 'object' &&
            !Array.isArray(args[1]);

        let resolvedArgs: unknown[];
        if (isCompound) {
            resolvedArgs = args;
        } else if (isSetPathForm) {
            const ctx = createContextFromBindings(this.bindings, this.strictBindings, this.contextExtensions);
            // Preserve args[0] (the @entity.<path> literal); resolve the rest.
            resolvedArgs = [args[0], ...args.slice(1).map((a) => interpolateValue(a, ctx))];
        } else if (isFetchLike) {
            const ctx = createContextFromBindings(this.bindings, this.strictBindings, this.contextExtensions);
            const opts = args[1] as FetchOptions;
            const resolvedOpts: FetchOptions = {
                ...(opts.id !== undefined && { id: interpolateValue(opts.id, ctx) as string }),
                ...(opts.filter !== undefined && { filter: opts.filter }),
                ...(opts.limit !== undefined && { limit: interpolateValue(opts.limit, ctx) as number }),
                ...(opts.offset !== undefined && { offset: interpolateValue(opts.offset, ctx) as number }),
                ...(opts.include !== undefined && { include: interpolateValue(opts.include, ctx) as string[] }),
                ...(opts.emit !== undefined && { emit: interpolateValue(opts.emit, ctx) as FetchOptions['emit'] }),
            };
            resolvedArgs = [
                interpolateValue(args[0], ctx),
                resolvedOpts,
                ...args.slice(2).map((a) => interpolateValue(a, ctx)),
            ];
        } else {
            resolvedArgs = resolveArgs(args, this.bindings, this.strictBindings, this.contextExtensions);
        }

        effectLog.debug('execute', { operator, argCount: resolvedArgs.length, context: this.context.traitName });

        if (this.debug) {
            console.log('[EffectExecutor] Executing:', operator, resolvedArgs);
        }

        try {
            await this.dispatch(operator, resolvedArgs);
            effectLog.debug('execute:result', { operator, success: true });
        } catch (error) {
            effectLog.warn('execute:error', { operator, error: error instanceof Error ? error.message : String(error) });
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
                : resolveArgs(rawArgs, this.bindings, this.strictBindings, this.contextExtensions);

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
    // `emit:` config extraction — close-the-circuit on async/reactive ops.
    //
    // `fetch`, `persist`, `call-service`, `set`, `ref`, `os/watch-*` may carry
    // an `emit:` key in their options object. After the effect's work finishes,
    // the runtime fires the author-configured bus event so downstream state
    // machines can branch on success/failure without stitching async/sequence.
    //
    // See `docs/Almadar_Std_Gaps.md` §3.1 and the emit-config plan for the
    // semantics. The compiled-path shell does the same work in generated JS.
    // ==========================================================================

    private extractEmitConfig(rawOpt: unknown): EmitConfig | undefined {
        if (!rawOpt || typeof rawOpt !== 'object' || Array.isArray(rawOpt)) {
            return undefined;
        }
        const obj = rawOpt as { emit?: unknown };
        const emitBlock = obj.emit;
        if (!emitBlock || typeof emitBlock !== 'object' || Array.isArray(emitBlock)) {
            return undefined;
        }
        // Narrow to the known-keys shape so we don't need a Record index.
        // Resolver accepts both snake_case and camelCase; mirror that here.
        const block = emitBlock as {
            success?: unknown;
            failure?: unknown;
            on_change?: unknown;
            onChange?: unknown;
            on_message?: unknown;
            onMessage?: unknown;
        };
        const asStr = (v: unknown): string | undefined =>
            typeof v === 'string' ? v : undefined;
        return {
            success: asStr(block.success),
            failure: asStr(block.failure),
            on_change: asStr(block.on_change) ?? asStr(block.onChange),
            on_message: asStr(block.on_message) ?? asStr(block.onMessage),
        };
    }

    /** Build the source metadata stamp for an emit fired from this trait. */
    private sourceStamp(): import('./types.js').RuntimeEvent['source'] {
        return {
            orbital: this.context.orbitalName,
            trait: this.context.traitName,
            transition: this.context.transition,
        };
    }

    private emitSuccess(
        emit: EmitConfig | undefined,
        key: 'success' | 'on_change' | 'on_message',
        payload: unknown,
    ): void {
        const eventName = emit?.[key];
        if (eventName) {
            this.handlers.emit(eventName, payload as EventPayload | undefined, this.sourceStamp());
        }
    }

    private emitFailure(
        emit: EmitConfig | undefined,
        err: unknown,
    ): void {
        if (!emit?.failure) return;
        const error = err instanceof Error ? err.message : String(err);
        this.handlers.emit(emit.failure, { error } as EventPayload, this.sourceStamp());
    }

    /**
     * Narrow the generic emit config into the `os/watch-*` handler surface
     * (only `on_message` + `failure` are meaningful for streaming ops).
     * Returns `undefined` when neither field is set so handlers can test
     * with a single `if (emit)` guard.
     */
    private osEmit(
        emit: EmitConfig | undefined,
    ): import('./types.js').OsEmitConfig | undefined {
        if (!emit || (!emit.on_message && !emit.failure)) return undefined;
        return {
            on_message: emit.on_message,
            failure: emit.failure,
        };
    }

    // ==========================================================================
    // Effect Dispatch
    // ==========================================================================

    private async dispatch(operator: string, args: unknown[]): Promise<void> {
        switch (operator) {
            // === Universal Effects ===

            case 'emit': {
                const event = args[0] as string;
                const payload = args[1] as EventPayload | undefined;
                this.handlers.emit(event, payload, this.sourceStamp());
                break;
            }

            case 'set': {
                // Two accepted forms (operators.json declares maxArity:2 → 3-elem canonical;
                // 4-elem historically accepted for back-compat with consumers that resolve
                // the entity id externally):
                //   3-elem: ['set', '@entity.<field>', value]   — parse the field out of the path
                //   4-elem: ['set', entityId, field, value]     — caller supplies entity id + field
                //   +emit:  ['set', '@entity.<field>', value, { emit: {...} }]
                // bindings.entity is EntityRow | undefined from @almadar/core —
                // use it directly instead of casting to a record.
                const entity: EntityRow | undefined = this.bindings.entity;
                let entityId: string | undefined;
                let field: string;
                let value: unknown;
                let emitCfg: EmitConfig | undefined;

                // Distinguish path-based (`@entity.<field>`) from explicit 4-elem forms.
                // The path form's 3rd arg may carry `emit:` options; the 4-elem
                // form's 4th arg may carry the same. `args.length` alone is
                // ambiguous once `emit:` arrives, so use the path prefix as the
                // discriminator.
                if (typeof args[0] === 'string' && (args[0] as string).startsWith('@entity.')) {
                    const path = args[0] as string;
                    field = path.slice('@entity.'.length);
                    value = args[1];
                    emitCfg = this.extractEmitConfig(args[2]);
                    entityId = typeof entity?.['id'] === 'string' ? (entity['id'] as string) : undefined;
                    // Auto-seed entity.id from @payload.id when the trait's
                    // entity context is empty. Row-click patterns (e.g.
                    // std-confirmation's REQUEST) open a modal for a specific
                    // row, then `(set @entity.pendingId @payload.id)` to
                    // remember which one — but the trait's entity starts
                    // empty, so the old "bail with missing-entity-id" path
                    // silently dropped the set and every subsequent
                    // `@entity.*` read returned undefined. Compiled path
                    // already has this implicit contract (server dispatches
                    // with the payload's row identified). Mirror it here so
                    // runtime and compiled render the same @entity.* values.
                    if (!entityId) {
                        const payload = this.bindings.payload;
                        const payloadId = payload && typeof payload === 'object' && 'id' in payload
                            ? (payload as EventPayload).id
                            : undefined;
                        if (typeof payloadId === 'string') {
                            entityId = payloadId;
                            // Seed a minimal entity so follow-up reads in the
                            // same transition (and the mirror write below)
                            // see a real row.
                            if (!entity) {
                                this.bindings.entity = { id: payloadId } as EntityRow;
                            } else {
                                entity['id'] = payloadId;
                            }
                            effectLog.debug('set:auto-seed-entity-id', { path, id: payloadId });
                        } else {
                            // No persistable entity id (and the payload
                            // doesn't carry one — typical for instance-scoped
                            // notification traits whose SHOW payload is
                            // `{ message, notificationType }`, and for
                            // [runtime] entities like wizards that accumulate
                            // scalar state across transitions). Update the
                            // in-memory binding AND still dispatch through
                            // handlers.set so the per-trait scalar-state
                            // wrapper in useTraitStateMachine populates
                            // `traitFieldStatesRef` — guards in subsequent
                            // sendEvent calls read `@entity.X` from there.
                            // Without the handlers.set call, the wrapper
                            // never runs and step-skip guards always fail.
                            effectLog.debug('set:in-memory-mirror-only', { path });
                            if (!entity) {
                                this.bindings.entity = {} as EntityRow;
                            }
                            (this.bindings.entity as EntityRow)[field] =
                                value as EntityRow[string];
                            this.handlers.set(entityId, field, value);
                            this.emitSuccess(emitCfg, 'success', value);
                            break;
                        }
                    }
                } else {
                    entityId = args[0] as string;
                    field = args[1] as string;
                    value = args[2];
                    emitCfg = this.extractEmitConfig(args[3]);
                }

                this.handlers.set(entityId, field, value);
                // Mirror the write into the in-memory bindings so later
                // effects in the same transition (and any `when`/`if`
                // guards evaluated against @entity.*) observe the new
                // value. Without this, a transition that increments a
                // counter and then conditionally emits on the counter
                // reads the pre-increment value.
                //
                // Match by id when both sides have one. When the
                // in-memory entity is "rowless" (id-less), still mirror —
                // a path-form set against the singleton in-memory entity
                // is the only one that landed here without an id, and
                // dropping the mirror would let the compiled vs runtime
                // paths diverge on the very next render.
                if (entity && (entity['id'] === entityId || !entity['id'])) {
                    // EntityRow indexes to FieldValue; the effect's value is
                    // runtime-shaped `unknown`. The set handler above already
                    // persisted the real type-checked write — this mirror
                    // write is for in-memory binding reads only.
                    entity[field] = value as EntityRow[string];
                }
                // set is synchronous — fire success immediately with the new value.
                this.emitSuccess(emitCfg, 'success', value);
                break;
            }

            case 'persist': {
                const action = args[0] as 'create' | 'update' | 'delete' | 'batch';
                // Optional trailing options object carrying `emit:` — detected
                // by having an `emit` key, never by position (so inline data
                // payloads for create/update are not mistaken for options).
                const last = args[args.length - 1];
                const emitCfg = last && typeof last === 'object' && !Array.isArray(last) && 'emit' in (last as object)
                    ? this.extractEmitConfig(last)
                    : undefined;
                effectLog.debug('persist:dispatch', {
                    action,
                    argCount: args.length,
                    argTypes: args.map((a) => Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a).join(','),
                    traitName: this.context.traitName,
                    transition: this.context.transition,
                });
                effectLog.debug('persist:emit-config', {
                    action,
                    hasEmitCfg: emitCfg !== undefined,
                    success: emitCfg?.success,
                    failure: emitCfg?.failure,
                });
                try {
                    if (action === 'batch') {
                        // Batch mode: ["persist", "batch", [...operations]]
                        const operations = args[1] as unknown[];
                        await this.handlers.persist('batch', '', { operations } as EntityRow);
                        effectLog.debug('persist:success', {
                            action,
                            entityType: 'batch',
                            opCount: operations.length,
                            willEmit: emitCfg?.success,
                        });
                        this.emitSuccess(emitCfg, 'success', operations);
                        effectLog.debug('persist:emit-fired', { action, eventName: emitCfg?.success });
                    } else {
                        const entityType = args[1] as string;
                        const data = args[2] as EntityRow | undefined;
                        await this.handlers.persist(action, entityType, data);
                        // persist() returns void — best available success payload
                        // is the data that went in, which matches the interpreted
                        // runtime's existing @entity reactivity contract.
                        const dataId = typeof data === 'string'
                            ? data
                            : (data && typeof data === 'object' ? ((data as { id?: unknown }).id as string | undefined) : undefined);
                        effectLog.debug('persist:success', {
                            action,
                            entityType,
                            dataId,
                            willEmit: emitCfg?.success,
                        });
                        this.emitSuccess(emitCfg, 'success', data);
                        effectLog.debug('persist:emit-fired', { action, eventName: emitCfg?.success });
                    }
                } catch (err) {
                    effectLog.error('persist:error', {
                        action,
                        entityType: action === 'batch' ? 'batch' : (args[1] as string),
                        error: err instanceof Error ? err.message : String(err),
                    });
                    this.emitFailure(emitCfg, err);
                    throw err;
                }
                break;
            }

            case 'call-service': {
                const service = args[0] as string;
                const action = args[1] as string;
                const params = args[2] as ServiceParams | undefined;
                // Optional trailing options object carrying `emit:` at args[3].
                const emitCfg = this.extractEmitConfig(args[3]);
                try {
                    const result = await this.handlers.callService(service, action, params);
                    this.emitSuccess(emitCfg, 'success', result);
                } catch (err) {
                    this.emitFailure(emitCfg, err);
                    throw err;
                }
                break;
            }

            case 'fetch': {
                if (this.handlers.fetch) {
                    const entityType = args[0] as string;
                    const rawOpt = args[1];
                    // Support both shorthand ['fetch', 'Entity', 'id-value']
                    // and full options ['fetch', 'Entity', { id: 'id-value', emit: {...} }]
                    const options = typeof rawOpt === 'string'
                        ? { id: rawOpt }
                        : rawOpt as {
                            id?: string;
                            filter?: unknown;
                            limit?: number;
                            offset?: number;
                            include?: string[];
                        } | undefined;
                    const emitCfg = this.extractEmitConfig(rawOpt);
                    try {
                        const result = await this.handlers.fetch(entityType, options);
                        // Authors read fetched records via `@payload.data`. The
                        // sibling `totalCount` is the pre-pagination row count so
                        // paginating consumers can compute totalPages without a
                        // second round-trip. `result === null` means "not found";
                        // emit success with `data: null, totalCount: 0` so the
                        // payload shape stays stable.
                        const payload: EventPayload = result
                            ? { data: result.rows, totalCount: result.total }
                            : { data: null, totalCount: 0 };
                        this.emitSuccess(emitCfg, 'success', payload);
                    } catch (err) {
                        this.emitFailure(emitCfg, err);
                        throw err;
                    }
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
                const refEmitCfg = this.extractEmitConfig(rawRefOpt);
                try {
                    let result: FetchResult | null = null;
                    if (this.handlers.ref) {
                        result = await this.handlers.ref(refEntityType, refOptions);
                    } else if (this.handlers.fetch) {
                        result = await this.handlers.fetch(refEntityType, refOptions);
                    } else {
                        this.logUnsupported('ref');
                    }
                    // Interpreted runtime fires `on_change` once on the initial
                    // subscribe. Match fetch's payload shape so paginating
                    // subscribers receive the same {data, totalCount} contract.
                    const refPayload: EventPayload = result
                        ? { data: result.rows, totalCount: result.total }
                        : { data: null, totalCount: 0 };
                    this.emitSuccess(refEmitCfg, 'on_change', refPayload);
                } catch (err) {
                    this.emitFailure(refEmitCfg, err);
                    throw err;
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
                    const watchOptions = args[1] as { id?: string; filter?: unknown; limit?: number } | undefined;
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
                    const props = args[1] as EntityRow | undefined;
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
                    // The render-ui SExpr's pattern slot carries either a
                    // resolved `PatternConfig` (post-interpolation) or `null`
                    // when the trait is clearing the slot. Anything else is
                    // a schema bug — runtime keeps the type narrow so
                    // downstream renderers don't have to re-validate.
                    const patternRaw = args[1];
                    const pattern: PatternConfig | null =
                        patternRaw === null
                            ? null
                            : (patternRaw as PatternConfig);
                    const props = args[2] as PatternProps | undefined;
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
                    const params = args[1] as { [key: string]: string } | undefined;
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
                const ctx = createContextFromBindings(this.bindings, false, this.contextExtensions);
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
            //
            // Each may carry `emit:` inside a trailing options object. The
            // executor extracts it and passes it to the handler so the
            // hardcoded fallback name (e.g. OS_CRON_FIRE) is replaced by the
            // author-configured event.
            case 'os/watch-files': {
                if (this.handlers.osWatchFiles) {
                    const glob = args[0] as string;
                    // options may carry emit: — strip it before passing to the handler.
                    const rawOptions = args[1] as
                        | { recursive?: boolean; debounce?: number; emit?: unknown }
                        | undefined;
                    const emitCfg = this.extractEmitConfig(rawOptions);
                    const options = rawOptions
                        ? { recursive: rawOptions.recursive, debounce: rawOptions.debounce }
                        : {};
                    this.handlers.osWatchFiles(glob, options, this.osEmit(emitCfg));
                } else {
                    this.logUnsupported('os/watch-files');
                }
                break;
            }
            case 'os/watch-process': {
                if (this.handlers.osWatchProcess) {
                    const emitCfg = this.extractEmitConfig(args[2]);
                    this.handlers.osWatchProcess(
                        args[0] as string,
                        args[1] as string | undefined,
                        this.osEmit(emitCfg),
                    );
                } else {
                    this.logUnsupported('os/watch-process');
                }
                break;
            }
            case 'os/watch-port': {
                if (this.handlers.osWatchPort) {
                    const emitCfg = this.extractEmitConfig(args[2]);
                    this.handlers.osWatchPort(
                        args[0] as number,
                        (args[1] as string) ?? 'tcp',
                        this.osEmit(emitCfg),
                    );
                } else {
                    this.logUnsupported('os/watch-port');
                }
                break;
            }
            case 'os/watch-http': {
                if (this.handlers.osWatchHttp) {
                    const emitCfg = this.extractEmitConfig(args[2]);
                    this.handlers.osWatchHttp(
                        args[0] as string,
                        args[1] as string | undefined,
                        this.osEmit(emitCfg),
                    );
                } else {
                    this.logUnsupported('os/watch-http');
                }
                break;
            }
            case 'os/watch-cron': {
                if (this.handlers.osWatchCron) {
                    const emitCfg = this.extractEmitConfig(args[1]);
                    this.handlers.osWatchCron(args[0] as string, this.osEmit(emitCfg));
                } else {
                    this.logUnsupported('os/watch-cron');
                }
                break;
            }
            case 'os/watch-signal': {
                if (this.handlers.osWatchSignal) {
                    const emitCfg = this.extractEmitConfig(args[1]);
                    this.handlers.osWatchSignal(args[0] as string, this.osEmit(emitCfg));
                } else {
                    this.logUnsupported('os/watch-signal');
                }
                break;
            }
            case 'os/watch-env': {
                if (this.handlers.osWatchEnv) {
                    const emitCfg = this.extractEmitConfig(args[1]);
                    this.handlers.osWatchEnv(args[0] as string, this.osEmit(emitCfg));
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

            // === Composition operators (compile-time, optional) ===

            case 'behavior/compose': {
                if (this.handlers.composeBehaviors) {
                    const config = args[0] as { appName: string; orbitals: unknown[]; layoutStrategy?: string; eventWiring?: unknown[]; entityMappings?: Record<string, string> };
                    await this.handlers.composeBehaviors(config);
                } else {
                    this.logUnsupported('behavior/compose');
                }
                break;
            }

            case 'behavior/wire': {
                if (this.handlers.applyEventWiring) {
                    const wireOrbitals = args[0] as unknown[];
                    const wireEntries = args[1] as unknown[];
                    await this.handlers.applyEventWiring(wireOrbitals, wireEntries);
                } else {
                    this.logUnsupported('behavior/wire');
                }
                break;
            }

            case 'behavior/detect-layout': {
                if (this.handlers.detectLayoutStrategy) {
                    const layoutOrbitals = args[0] as unknown[];
                    const layoutWiring = args[1] as unknown[] | undefined;
                    await this.handlers.detectLayoutStrategy(layoutOrbitals, layoutWiring);
                } else {
                    this.logUnsupported('behavior/detect-layout');
                }
                break;
            }

            case 'behavior/pipe': {
                if (this.handlers.pipeBehaviors) {
                    const [pipeSeed, ...pipeSteps] = args;
                    await this.handlers.pipeBehaviors(
                        pipeSeed,
                        ...(pipeSteps as Array<(prev: unknown) => unknown>),
                    );
                } else {
                    this.logUnsupported('behavior/pipe');
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
