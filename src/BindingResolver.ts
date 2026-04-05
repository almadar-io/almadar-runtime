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
import { isKnownOperator } from '@almadar/operators';
import type { BindingContext, EntityRow, PatternProps } from './types.js';
import { createLogger } from './logger.js';

const bindLog = createLogger('almadar:runtime:bindings');

// Re-export for convenience
export { createMinimalContext, type EvaluationContext };

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
    const result: PatternProps = {};
    for (const [key, value] of Object.entries(props)) {
        result[key] = interpolateValue(value, ctx) as PatternProps[string];
    }
    return result;
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
 */
function isPureBinding(value: string): boolean {
    return /^@[\w]+(?:\.[\w]+)*$/.test(value);
}

/**
 * Interpolate embedded bindings in a string.
 */
function interpolateEmbeddedBindings(value: string, ctx: EvaluationContext): string {
    return value.replace(/@[\w]+(?:\.[\w]+)*/g, (match) => {
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
        return [];
    }

    if (isSExpression(value)) {
        return evaluate(value as Parameters<typeof evaluate>[0], ctx);
    }

    return value.map((item) => interpolateValue(item, ctx));
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
 */
export function createContextFromBindings(
    bindings: BindingContext,
    strictBindings?: boolean
): EvaluationContext {
    const ctx = createMinimalContext(
        bindings.entity || {},
        bindings.payload || {},
        bindings.state || 'idle'
    );
    if (strictBindings) {
        ctx.strictBindings = true;
    }
    // Copy named entity bindings (e.g., @SpriteEntity) into singletons
    // so resolveBinding can resolve @EntityName.field
    for (const [key, value] of Object.entries(bindings)) {
        if (key !== 'entity' && key !== 'payload' && key !== 'state' && key !== 'config' && key !== 'user' && value != null) {
            ctx.singletons.set(key, value as EntityRow);
        }
    }
    return ctx;
}
