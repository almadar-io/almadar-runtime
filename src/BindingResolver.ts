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
import type { BindingContext, EntityRow, EventPayload, PatternProps, EvaluationContextExtensions, RuntimePatternValue } from './types.js';
import type { TraitConfigObject, TraitConfigValue, RenderChildrenMap, RenderBindingMarker } from '@almadar/core';
import { containsEntityBinding, containsPayloadBinding, RENDER_BINDING_MARKER } from '@almadar/core';
import type { SExpr } from '@almadar/core';
import { createLogger, setNamespaceLevel } from '@almadar/logger';

const bindLog = createLogger('almadar:runtime:bindings');
// Per-eval firehose: logs every binding resolve + sexpr eval, so a running
// `ticks` loop emits hundreds/sec. Default its floor to WARN; opt back in with
// setNamespaceLevel('almadar:runtime:bindings', 'DEBUG').
setNamespaceLevel('almadar:runtime:bindings', 'WARN');
// Low-volume (per config-forward leaf per flush, not per eval) — its own
// namespace so the defer path stays observable while the firehose is floored.
const deferLog = createLogger('almadar:runtime:defer');
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

/**
 * Call-site payload capture grammar. Mirrors the Rust orbital-core
 * `CALLSITE_PAYLOAD_PREFIX` (`@callsitePayload.`). A composed trait's call-site
 * config value of this form is a snapshot of the COMPOSING effect's triggering
 * event payload, captured at the call site — deliberately distinct from
 * `@payload.` so it is never evaluated in the child's own INIT scope.
 */
export const CALLSITE_PAYLOAD_PREFIX = '@callsitePayload.';

/** Narrow an arbitrary resolved payload value to a `TraitConfigValue` (total;
 * `undefined` → `null`, `Date` → ISO string) so a captured literal merges into
 * the child's typed config without a cast. */
function payloadValueToConfigValue(v: unknown): TraitConfigValue {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(payloadValueToConfigValue);
    if (typeof v === 'object') {
        const obj: Record<string, TraitConfigValue> = {};
        for (const [k, val] of Object.entries(v)) obj[k] = payloadValueToConfigValue(val);
        return obj;
    }
    return String(v);
}

/**
 * Resolve call-site payload captures in a child trait's call-site config
 * against the COMPOSING effect's triggering event payload. Each value of the
 * form `@callsitePayload.<field>` becomes the literal read from `payload`
 * (snapshot semantics — the child sees a plain value, never a payload ref).
 * Non-capture entries pass through untouched. Returns a new object; the input
 * is not mutated.
 */
export function resolveCallSitePayloadCaptures(
    config: TraitConfigObject,
    payload: EventPayload | undefined,
): TraitConfigObject {
    let ctx: EvaluationContext | undefined;
    const out: Record<string, TraitConfigValue> = {};
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'string' && value.startsWith(CALLSITE_PAYLOAD_PREFIX)) {
            const field = value.slice(CALLSITE_PAYLOAD_PREFIX.length);
            if (!ctx) ctx = createMinimalContext({}, payload ?? {}, 'idle');
            out[key] = payloadValueToConfigValue(resolveBinding(`@payload.${field}`, ctx));
        } else {
            out[key] = value;
        }
    }
    return out;
}

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

/**
 * Value a deferred render-ui prop tree can carry: interpolated runtime
 * values, raw pass-through S-expressions (`fn` lambdas), render-time
 * binding markers, and nested arrays/records of the same. No `unknown`
 * escape hatch.
 */
export type DeferredPatternValue =
    | RuntimePatternValue
    | RenderBindingMarker
    | SExpr
    | Date
    | readonly DeferredPatternValue[]
    | { readonly [prop: string]: DeferredPatternValue };

/**
 * Carry `@entity`-dependent prop leaves into slot content as
 * `RenderBindingMarker`s instead of resolving them at flush time — the
 * renderer (`@almadar/ui`'s SlotContentRenderer) evaluates each marker
 * against the live entity store on every React render, the same model the
 * compiled shell uses. Everything else resolves eagerly through the same
 * `interpolateValue` path the non-deferring executor uses:
 * - payload-referencing leaves stay eager (`@payload` is event-scoped and
 *   does not exist at render time);
 * - `fn` render lambdas pass through raw (they are already render-time);
 * - literal arrays (children lists) and plain objects recurse per item.
 */
export function deferEntityBindings(value: SExpr, ctx: EvaluationContext, configHops = 0): DeferredPatternValue {
    if (typeof value === 'string') {
        if (containsEntityBinding(value) && !containsPayloadBinding(value)) {
            return { [RENDER_BINDING_MARKER]: true, expression: value };
        }
        // A whole-string `@config.X` forward can UNCOVER an `@entity` ref —
        // a call-site knob like `value: @entity.draft` or a render tree in
        // `feedBodyContent`. Eagerly interpolating the hop evaluates the
        // uncovered ref too, freezing the knob at its flush-time value (the
        // chat composer's controlled input snapped back to "" on every
        // keystroke). Resolve the hop by LOOKUP (no evaluation) and defer
        // the uncovered value like any other raw leaf. Bounded hops guard
        // against a self-referencing forward.
        if (value.startsWith('@config.') && !value.includes(' ') && configHops < 8) {
            const hop = ctx.config?.[value.slice('@config.'.length)];
            deferLog.debug('defer:config-hop', () => ({
                forward: value,
                hopType: typeof hop,
                hopPreview: typeof hop === 'string' ? hop : Array.isArray(hop) ? 'array' : hop === undefined ? 'undefined' : 'object',
            }));
            if (hop !== undefined && hop !== value) {
                return deferEntityBindings(hop as SExpr, ctx, configHops + 1);
            }
        }
        return interpolateValue(value, ctx) as RuntimePatternValue | Date;
    }
    if (Array.isArray(value)) {
        if (value.length === 3 && value[0] === 'fn' && typeof value[1] === 'string') {
            return value;
        }
        if (isSExpression(value)) {
            if (containsEntityBinding(value) && !containsPayloadBinding(value)) {
                return { [RENDER_BINDING_MARKER]: true, expression: value };
            }
            return interpolateValue(value, ctx) as RuntimePatternValue | Date;
        }
        return value.map((item) => deferEntityBindings(item, ctx));
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, DeferredPatternValue> = {};
        for (const [key, item] of Object.entries(value as Record<string, SExpr>)) {
            out[key] = deferEntityBindings(item, ctx);
        }
        return out;
    }
    return value;
}

// ============================================================================
// String Interpolation
// ============================================================================

/**
 * Config bindings currently being recursed into (synchronous stack). A cyclic
 * `@config.X` forward (knob default referencing itself through a call-site
 * chain) would otherwise recurse forever; on re-entry the raw resolved value
 * is returned instead.
 */
const inFlightConfigRecursions = new Set<string>();

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
        // A `render-ui`-typed config knob overridden at the call site arrives
        // as an object tree that still carries bindings (`@config.*`,
        // `@payload.*`, `?data` rewrites). The single-pass identity contract
        // protects entity rows, so recursion is scoped to CONFIG-rooted
        // bindings whose resolved tree still contains bindings — entity/
        // payload resolutions keep their identity semantics untouched.
        if (
            value.startsWith('@config.') &&
            resolved !== null &&
            typeof resolved === 'object' &&
            containsBindings(resolved) &&
            !inFlightConfigRecursions.has(value)
        ) {
            inFlightConfigRecursions.add(value);
            try {
                bindLog.debug('resolve:config-recurse', { binding: value });
                return interpolateValue(resolved, ctx);
            } finally {
                inFlightConfigRecursions.delete(value);
            }
        }
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
        // Dynamic-collection children entry (`["array/map", <expr>, ["fn", …]]`):
        // evaluate the collection at render time — the evaluator's `array/map`
        // binds the lambda param as the per-item `@item` scope and reduces the
        // RenderUINode body — then splice the resolved nodes flat into the host
        // list so components receive a plain RenderUINode[].
        if (Array.isArray(item) && isRenderChildrenMap(item)) {
            // The guard pins the operator-headed call shape; RenderItemLambda's
            // body is render-node data, not statically SExpr — the evaluator
            // only needs the verified call structure.
            const expanded = evaluate(item as SExpr, ctx);
            if (Array.isArray(expanded)) {
                for (const node of expanded) mapped.push(node);
            }
            anyChanged = true;
            continue;
        }
        const interpolated = interpolateValue(item, ctx);
        mapped.push(interpolated);
        if (interpolated !== item) anyChanged = true;
    }
    return anyChanged ? mapped : value;
}

/**
 * Narrow an array element to a dynamic-collection children entry
 * (`["array/map", <collectionExpr>, ["fn", <param>, <RenderUINode>]]`) — the
 * canonical, verbatim IR for map-in-`children:`. Structural, no name/heuristic
 * match beyond the pinned operator + lambda head.
 */
function isRenderChildrenMap(value: unknown[]): value is RenderChildrenMap {
    if (value.length !== 3 || value[0] !== 'array/map') return false;
    const lambda = value[2];
    return (
        Array.isArray(lambda) &&
        lambda.length === 3 &&
        lambda[0] === 'fn' &&
        typeof lambda[1] === 'string'
    );
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
    // Carry the authenticated viewer so `@user.id` / `@user.role` resolve.
    // Omitting this made every `@user` read undefined no matter what the
    // request carried — ownership filters matched no rows and role gates were
    // inert in the interpreter while the compiled path honoured them
    // (R-USER-DROPPED-IN-BINDING-CONTEXT).
    if (bindings.user) {
        ctx.user = bindings.user;
    }
    // Carry `let`-bound locals onto the evaluator context so `@<name>`
    // references inside the `let` body resolve. Mirrors the evaluator's own
    // `createChildContext(parent, locals)` — same Map shape, same lookup path
    // in `resolveBinding` (`ctx.locals?.has(root)`).
    if (bindings.locals) {
        ctx.locals = bindings.locals;
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
