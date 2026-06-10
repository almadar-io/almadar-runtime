/**
 * BindingResolver - Platform-Agnostic Binding Resolution
 *
 * Resolves binding references like @entity.field, @payload.value, @state
 * in props and values. Works on both client and server.
 *
 * Uses the shared S-expression evaluator for actual resolution.
 *
 * @packageDocumentation
 */

import {
    evaluate,
    resolveBinding,
    createMinimalContext,
    type EvaluationContext,
} from '@almadar/evaluator';
// Import from the browser-safe `@almadar/std/registry` subpath (pure operator
// metadata) rather than the `@almadar/std` index — the index also bundles the
// node-only registry LOADER (createRequire/fs/path), which has no place in the
// runtime interpreter that ships to the renderer.
import { isKnownStdOperator as isKnownOperator } from '@almadar/std/registry';
import type { BindingContext, EntityRow, PatternProps, EvaluationContextExtensions } from './types.js';
import { createLogger } from '@almadar/logger';

const bindLog = createLogger('almadar:runtime:bindings');
// See OrbitalServerRuntime — same `almadar:runtime:render-ui` namespace,
// instantiated here so interpolation of pattern objects can report
// whether the resolved row reference matches what arrived in ctx.
const renderLog = createLogger('almadar:runtime:render-ui');

// Re-export for convenience
export { createMinimalContext, type EvaluationContext };

/**
 * Binding roots whose values only exist in client UI state and therefore
 * cannot be resolved server-side. These bindings round-trip through the
 * server unchanged; the client (`@almadar/ui`) substitutes them at render
 * time.
 *
 * `trait` — `@trait.<TraitName>[.<slot>]` — resolves via `<TraitFrame>` to
 * the referenced trait's current `render-ui` output. See
 * `docs/Almadar_Std_Gaps.md` §3.8.
 */
export const CLIENT_ONLY_BINDING_ROOTS: ReadonlySet<string> = new Set(['trait']);

/** Return true when the binding's root segment is reserved for client-only resolution. */
function isClientOnlyBinding(value: string): boolean {
    if (!value.startsWith('@')) return false;
    const afterAt = value.slice(1);
    const firstDot = afterAt.indexOf('.');
    const root = firstDot === -1 ? afterAt : afterAt.slice(0, firstDot);
    return CLIENT_ONLY_BINDING_ROOTS.has(root);
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Interpolate binding references in props.
 *
 * @param props - Props object with potential binding references
 * @param ctx - Evaluation context with bindings
 * @returns New props object with resolved values
 *
 * @example
 * ```ts
 * const ctx = createContextFromBindings({ name: 'Project Alpha', count: 42 });
 * const props = {
 *   title: '@entity.name',
 *   total: ['+', '@entity.count', 10],
 * };
 * const result = interpolateProps(props, ctx);
 * // { title: 'Project Alpha', total: 52 }
 * ```
 */
export function interpolateProps(
    props: PatternProps,
    ctx: EvaluationContext
): PatternProps {
    // Identity-preserving walk: if no key produced a different value
    // from the input, return the ORIGINAL `props` reference instead of
    // a fresh clone. Pre-fix every render-ui evaluation deep-cloned
    // pattern objects (and the resolved entity rows nested inside),
    // which gave Form's `entity` prop a fresh JS reference per pass
    // and silently fired the `[normalizedInitialData]` reset useEffect
    // mid-edit, wiping typed values. The compiled path uses a stable
    // `lastPayload.row` from `useReducer` and never hit this; the
    // runtime path now matches that semantic — pure data passes through
    // by reference, only branches that actually resolve a binding (or
    // an sexpr) yield a new value.
    const result: PatternProps = {};
    let anyChanged = false;
    for (const [key, value] of Object.entries(props)) {
        const interpolated = interpolateValue(value, ctx) as PatternProps[string];
        result[key] = interpolated;
        if (interpolated !== value) anyChanged = true;
    }
    // When a pattern carries an `entity: @payload.row` binding, log
    // whether the resolved row matches the same JS reference still
    // present on ctx.payload.row. Originally added to confirm the
    // clone hypothesis; kept as permanent observability so future
    // regressions of this contract surface immediately.
    const entityBindingRaw = props['entity'];
    const typeBindingRaw = props['type'];
    const patternType = typeof typeBindingRaw === 'string' ? typeBindingRaw : undefined;
    if (typeof entityBindingRaw === 'string') {
        renderLog.debug('interpolateProps:entity', () => {
            const resolvedEntity = result['entity'];
            const resolvedRow: EntityRow | null =
                resolvedEntity !== null && typeof resolvedEntity === 'object' && !Array.isArray(resolvedEntity)
                    ? (resolvedEntity as EntityRow)
                    : null;
            const ctxRow = ctx.payload['row'];
            const ctxPayloadKeys = Object.keys(ctx.payload).join(',');
            const payloadDataRaw = ctx.payload['data'];
            const payloadDataLen = Array.isArray(payloadDataRaw) ? payloadDataRaw.length : null;
            const ctxEntityRaw = ctx.entity as EntityRow | EntityRow[] | null;
            const ctxEntityLen = Array.isArray(ctxEntityRaw) ? ctxEntityRaw.length : null;
            const resolvedLen = Array.isArray(resolvedEntity) ? resolvedEntity.length : null;
            return {
                patternType,
                entityBinding: entityBindingRaw,
                resolvedIsObject: resolvedRow !== null,
                resolvedIsArray: Array.isArray(resolvedEntity),
                resolvedLen,
                resolvedEqualsCtxRow: ctxRow !== undefined && resolvedRow !== null && resolvedRow === ctxRow,
                resolvedRowId: resolvedRow?.id,
                ctxPayloadKeys,
                ctxPayloadDataLen: payloadDataLen,
                ctxEntityIsArray: Array.isArray(ctxEntityRaw),
                ctxEntityLen,
            };
        });
    }
    if (patternType === 'form-section' || patternType === 'form') {
        bindLog.debug('form-binding', () => {
            const modeRaw = result['mode'];
            const submitRaw = result['submitEvent'];
            const cancelRaw = result['cancelEvent'];
            return {
                patternType,
                mode: typeof modeRaw === 'string' ? modeRaw : undefined,
                submitEvent: typeof submitRaw === 'string' ? submitRaw : undefined,
                cancelEvent: typeof cancelRaw === 'string' ? cancelRaw : undefined,
                entity: JSON.stringify(result['entity'] ?? null),
                fields: JSON.stringify(result['fields'] ?? null),
            };
        });
    }
    return anyChanged ? result : props;
}

/**
 * Interpolate a single value.
 */
export function interpolateValue(value: unknown, ctx: EvaluationContext): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        return interpolateString(value, ctx);
    }

    if (Array.isArray(value)) {
        return interpolateArray(value, ctx);
    }

    if (typeof value === 'object') {
        return interpolateProps(value as PatternProps, ctx);
    }

    return value;
}

// ============================================================================
// String Interpolation
// ============================================================================

/**
 * Interpolate a string value.
 */
function interpolateString(value: string, ctx: EvaluationContext): unknown {
    // Pure binding - resolve directly
    if (value.startsWith('@') && isPureBinding(value)) {
        // Client-only bindings (currently `@trait.*`) round-trip through
        // the server unchanged — the client's render layer substitutes the
        // referenced trait's current frame via `<TraitFrame>`.
        if (isClientOnlyBinding(value)) {
            bindLog.debug('passthrough:client-only', { binding: value });
            return value;
        }
        const resolved = resolveBinding(value, ctx);
        bindLog.debug('resolve', { binding: value, resolvedType: typeof resolved });
        return resolved;
    }

    // Embedded bindings
    if (value.includes('@')) {
        return interpolateEmbeddedBindings(value, ctx);
    }

    return value;
}

/**
 * Check if a string is a pure binding (no embedded text).
 *
 * Accepts bracket-index segments anywhere in the path —
 * `@config.sections[0].bullets`, `@payload.rows[2]`, etc. — so the
 * binding is fully consumed by `resolveBinding` instead of falling
 * through to `interpolateEmbeddedBindings` which would stop at the
 * first `[`, partially resolve, and string-concat the suffix.
 */
function isPureBinding(value: string): boolean {
    return /^@[\w]+(?:\[\d+\])*(?:\.[\w]+(?:\[\d+\])*)*$/.test(value);
}

/**
 * Interpolate embedded bindings in a string.
 */
function interpolateEmbeddedBindings(value: string, ctx: EvaluationContext): string {
    // Match bindings with optional bracket-index segments
    // (`@config.sections[0].bullets`, `@payload.rows[2]`) so the regex
    // captures the WHOLE binding before delegating to resolveBinding —
    // pre-fix the regex stopped at the first `[`, which left the
    // suffix dangling and string-concatenated junk onto the resolved
    // prefix (the SplitSection `bullets` crash).
    return value.replace(/@[\w]+(?:\[\d+\])*(?:\.[\w]+(?:\[\d+\])*)*/g, (match) => {
        // Client-only bindings round-trip verbatim; see CLIENT_ONLY_BINDING_ROOTS.
        if (isClientOnlyBinding(match)) {
            return match;
        }
        const resolved = resolveBinding(match, ctx);
        return resolved !== undefined ? String(resolved) : match;
    });
}

// ============================================================================
// Array Interpolation
// ============================================================================

/**
 * Interpolate an array value.
 */
function interpolateArray(value: unknown[], ctx: EvaluationContext): unknown {
    if (value.length === 0) {
        // Preserve identity for empty arrays too — same rationale as
        // `interpolateProps` below.
        return value;
    }

    // Per-item render lambdas (`["fn", argName, body]`) are
    // structurally SExpressions — `fn` is a registered control-category
    // operator — but they must NOT be evaluated here. The renderer
    // (`@almadar/ui`'s `renderPatternProps`) is the consumer that
    // converts them into React render props at render time, when each
    // row's `arg` is actually known. Evaluating now produces an
    // unserialisable function value that gets stripped to `undefined`
    // when crossing the server bridge, which is exactly the gap that
    // left std-search/std-filter `renderItem` undefined and the
    // Filter atom's chips empty. Preserve the raw array (with deep
    // recursion into the body so nested `@<arg>.*` placeholders and
    // any other inner SExpressions stay intact) instead.
    if (Array.isArray(value) && value.length === 3 && value[0] === 'fn'
        && typeof value[1] === 'string') {
        return value;
    }

    if (isSExpression(value)) {
        const result = evaluate(value as Parameters<typeof evaluate>[0], ctx);
        bindLog.debug('sexpr:eval', () => ({
            operator: typeof value[0] === 'string' ? value[0] : '<non-string>',
            argCount: value.length - 1,
            inputJson: JSON.stringify(value).slice(0, 300),
            resultType: typeof result,
            resultJson: typeof result === 'object' && result !== null
                ? JSON.stringify(result).slice(0, 2000)
                : String(result),
        }));
        return result;
    }

    // Identity-preserving map: only return a new array if any item
    // actually changed during interpolation. Otherwise the original
    // array reference passes through unchanged. Mirrors
    // `interpolateProps`' identity rule so e.g. an entity-row array
    // (`entity: @payload.data` resolved to `[row1, row2, ...]`)
    // doesn't get cloned every render-ui evaluation. The element type
    // is the input array's own element type — no `unknown` annotation
    // beyond the function's existing public surface.
    const mapped: typeof value = [];
    let anyChanged = false;
    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const interpolated = interpolateValue(item, ctx);
        mapped.push(interpolated);
        if (interpolated !== item) anyChanged = true;
    }
    return anyChanged ? mapped : value;
}

/**
 * Check if an array is an S-expression.
 */
function isSExpression(value: unknown[]): boolean {
    if (value.length === 0) return false;

    const first = value[0];
    if (typeof first !== 'string') return false;

    if (isKnownOperator(first)) return true;
    if (first.includes('/')) return true;
    if (first === 'lambda' || first === 'let') return true;

    return false;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a value contains any binding references.
 */
export function containsBindings(value: unknown): boolean {
    if (typeof value === 'string') {
        return value.includes('@');
    }

    if (Array.isArray(value)) {
        return value.some(containsBindings);
    }

    if (value !== null && typeof value === 'object') {
        return Object.values(value as PatternProps).some(containsBindings);
    }

    return false;
}

/**
 * Extract all binding references from a value.
 */
export function extractBindings(value: unknown): string[] {
    const bindings: string[] = [];

    function collect(v: unknown): void {
        if (typeof v === 'string') {
            const matches = v.match(/@[\w]+(?:\.[\w]+)*/g);
            if (matches) {
                bindings.push(...matches);
            }
        } else if (Array.isArray(v)) {
            v.forEach(collect);
        } else if (v !== null && typeof v === 'object') {
            Object.values(v as PatternProps).forEach(collect);
        }
    }

    collect(value);
    return [...new Set(bindings)];
}

/**
 * Create an EvaluationContext from a BindingContext.
 *
 * @param bindings - Binding context with entity, payload, state data
 * @param strictBindings - When true, log warnings for undefined binding paths (RCG-01)
 * @param contextExtensions - Optional fields to spread onto the context (e.g., { agent: AgentContext })
 */
export function createContextFromBindings(
    bindings: BindingContext,
    strictBindings?: boolean,
    contextExtensions?: EvaluationContextExtensions,
): EvaluationContext {
    const ctx = createMinimalContext(
        bindings.entity || {},
        bindings.payload || {},
        bindings.state || 'idle'
    );
    if (strictBindings) {
        ctx.strictBindings = true;
    }
    // Surface the call-site trait config on the context so `@config.X`
    // bindings resolve in render-ui patterns. See OrbitalServerRuntime's
    // executeEffects where `bindings.config` is populated from
    // RegisteredOrbital.configByTrait.
    if (bindings.config) {
        ctx.config = bindings.config;
    }
    // V2 Phase 6: the `@EntityName.field` cross-entity binding path via
    // `ctx.singletons` is gone. Cross-trait data flow routes through the
    // event bus (listen on an `[external]` Event<T> emit and read via
    // `@payload.<field>`). Named bindings are no longer copied into the
    // singleton lookup table.
    // Spread context extensions (e.g., agent: AgentContext) onto the evaluation context.
    // This is how ctx.agent gets populated for agent/* operator dispatch.
    if (contextExtensions) {
        Object.assign(ctx, contextExtensions);
    }
    return ctx;
}
