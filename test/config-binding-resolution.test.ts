/**
 * Config Binding Resolution — `@config.X` substitution coverage.
 *
 * Anchor: gap surfaced during gap #20 (slim core atoms). std-modal's
 * `fields : [string] = []` config substitutes correctly at runtime; the
 * std-filter / std-browse atoms with `[object] = []` or `object = []`
 * configs surfaced with the literal string `"@config.fields"` reaching
 * DOM, crashing DataGrid's `.map()`. These tests pin down the contract
 * for every config field type the lolo type system supports — primitive
 * scalars, primitive arrays, object arrays, and nested objects — so any
 * future regression in `BindingResolver.interpolateProps` lights up
 * immediately at the unit-test layer instead of as a runtime crash.
 *
 * Tests use the BindingResolver directly (no orbital, no playground) so
 * they isolate the substitution logic from any cross-cutting plumbing.
 */

import { describe, it, expect } from 'vitest';
import {
    interpolateProps,
    interpolateValue,
    createContextFromBindings,
    type BindingContext,
} from '../src/BindingResolver.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(config: Record<string, unknown>) {
    const bindings: BindingContext = {
        entity: {} as unknown as BindingContext['entity'],
        payload: {},
        state: 'idle',
        config,
    };
    return createContextFromBindings(bindings);
}

// ============================================================================
// Primitive scalars (already work today — pinning the contract)
// ============================================================================

describe('@config.X — primitive scalars', () => {
    it('resolves @config.<string> to the string value', () => {
        const ctx = makeCtx({ placeholder: 'Search…' });
        const result = interpolateProps({ placeholder: '@config.placeholder' }, ctx);
        expect(result.placeholder).toBe('Search…');
    });

    it('resolves @config.<number> to the number value', () => {
        const ctx = makeCtx({ pageSize: 25 });
        const result = interpolateProps({ pageSize: '@config.pageSize' }, ctx);
        expect(result.pageSize).toBe(25);
    });

    it('resolves @config.<bool> to the boolean value', () => {
        const ctx = makeCtx({ enabled: false });
        const result = interpolateProps({ enabled: '@config.enabled' }, ctx);
        expect(result.enabled).toBe(false);
    });

    it('passes through unresolved @config.<missing> as undefined', () => {
        const ctx = makeCtx({});
        const result = interpolateProps({ placeholder: '@config.placeholder' }, ctx);
        // Per the resolver contract: missing bindings resolve to undefined
        // so consumers that supply their own defaults (`?? "fallback"`)
        // still work.
        expect(result.placeholder).toBeUndefined();
    });
});

// ============================================================================
// Primitive arrays (std-modal pattern: `fields : [string] = []`)
// ============================================================================

describe('@config.X — primitive arrays', () => {
    it('resolves @config.<[string]> to the string array', () => {
        const ctx = makeCtx({ fields: ['name', 'description', 'status'] });
        const result = interpolateProps({ fields: '@config.fields' }, ctx);
        expect(result.fields).toEqual(['name', 'description', 'status']);
    });

    it('resolves @config.<[string]> default of [] to an empty array', () => {
        const ctx = makeCtx({ fields: [] });
        const result = interpolateProps({ fields: '@config.fields' }, ctx);
        expect(result.fields).toEqual([]);
    });

    it('resolves @config.<[number]> to the number array', () => {
        const ctx = makeCtx({ pageSizes: [10, 25, 50] });
        const result = interpolateProps({ pageSizes: '@config.pageSizes' }, ctx);
        expect(result.pageSizes).toEqual([10, 25, 50]);
    });
});

// ============================================================================
// Object arrays (gap #20 root cause: std-browse/std-filter)
// ============================================================================

describe('@config.X — object arrays', () => {
    it('resolves @config.<[object]> to the object array', () => {
        const ctx = makeCtx({
            fields: [
                { name: 'name', label: 'Name', variant: 'h4' },
                { name: 'description', label: 'Description', variant: 'caption' },
            ],
        });
        const result = interpolateProps({ fields: '@config.fields' }, ctx);
        expect(result.fields).toEqual([
            { name: 'name', label: 'Name', variant: 'h4' },
            { name: 'description', label: 'Description', variant: 'caption' },
        ]);
    });

    it('resolves @config.<[object]> default of [] to an empty array — never the literal "@config.X" string', () => {
        const ctx = makeCtx({ filters: [] });
        const result = interpolateProps({ filters: '@config.filters' }, ctx);
        expect(result.filters).toEqual([]);
        expect(result.filters).not.toBe('@config.filters');
    });

    it('preserves nested object identity inside the array', () => {
        const filterDef = { field: 'status', label: 'Status', options: ['active', 'inactive', 'pending'], filterType: 'select' };
        const ctx = makeCtx({ filters: [filterDef] });
        const result = interpolateProps({ filters: '@config.filters' }, ctx);
        expect(Array.isArray(result.filters)).toBe(true);
        expect((result.filters as unknown[])[0]).toEqual(filterDef);
    });
});

// ============================================================================
// Nested objects (`object = {}`)
// ============================================================================

describe('@config.X — nested objects', () => {
    it('resolves @config.<object> to the object value', () => {
        const ctx = makeCtx({ theme: { primary: '#0070f3', accent: '#ff4081' } });
        const result = interpolateProps({ theme: '@config.theme' }, ctx);
        expect(result.theme).toEqual({ primary: '#0070f3', accent: '#ff4081' });
    });

    it('resolves nested @config.<object>.<path> to the field value', () => {
        const ctx = makeCtx({ theme: { primary: '#0070f3' } });
        const value = interpolateValue('@config.theme.primary', ctx);
        expect(value).toBe('#0070f3');
    });
});

// ============================================================================
// Inside complex render-ui patterns (the actual std-filter / std-browse shape)
// ============================================================================

describe('@config.X — inside render-ui pattern shapes', () => {
    it('resolves filter-group `filters: [object]` from config', () => {
        const ctx = makeCtx({
            filters: [{ field: 'status', label: 'Status', options: ['active'], filterType: 'select' }],
        });
        const pattern = {
            type: 'filter-group',
            entity: 'FilteredListItem',
            filters: '@config.filters',
        };
        const result = interpolateProps(pattern, ctx);
        expect(result.type).toBe('filter-group');
        expect(result.entity).toBe('FilteredListItem');
        expect(Array.isArray(result.filters)).toBe(true);
        expect((result.filters as unknown[]).length).toBe(1);
    });

    it('resolves data-grid `fields: [object]` and `pageSize: number` from config', () => {
        const ctx = makeCtx({
            fields: [
                { name: 'name', variant: 'h4' },
                { name: 'description', variant: 'caption' },
            ],
            pageSize: 25,
        });
        const pattern = {
            type: 'data-grid',
            entity: '@payload.data',
            fields: '@config.fields',
            pageSize: '@config.pageSize',
        };
        const result = interpolateProps(pattern, ctx);
        expect(result.fields).toEqual(ctx.config?.fields);
        expect(result.pageSize).toBe(25);
        // The `entity: @payload.data` binding has no payload to resolve
        // against here (we only set ctx.config), so it returns undefined —
        // confirms config and payload roots are independent.
        expect(result.entity).toBeUndefined();
    });
});
