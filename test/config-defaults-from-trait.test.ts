/**
 * Trait declared-config-defaults extraction.
 *
 * `collectDeclaredConfigDefaults` is the seam that reads an atom's
 * `config { ... }` schema (with per-field `default:` values) and turns
 * it into the flat `{ key: defaultValue, ... }` map that gets merged
 * into `bindings.config` for `@config.X` resolution.
 *
 * Anchor: gap #20 — std-filter / std-browse atoms ship configs typed
 * `object = []` and `[object] = []`, and at runtime the literal string
 * `"@config.fields"` reaches DOM (instead of the resolved array).
 * Pre-fix this test pinned down `[string] = []` and `string = "X"` as
 * the only working types; the runtime fix lifts every config field
 * type to first-class.
 */

import { describe, it, expect } from 'vitest';
import { collectDeclaredConfigDefaults } from '../src/OrbitalServerRuntime.js';

// The runtime treats the trait declaration loaded from .orb structurally
// (not via the strict @almadar/core type). These tests build that
// structural shape directly so they cover the same path the runtime
// uses without requiring a full OrbitalSchema.
function makeTrait(config: Record<string, { type: string; default?: unknown }>) {
    return {
        name: 'TestTrait',
        category: 'interaction' as const,
        stateMachine: { states: [], events: [], transitions: [] },
        config,
    } as unknown as Parameters<typeof collectDeclaredConfigDefaults>[0];
}

describe('collectDeclaredConfigDefaults', () => {
    it('returns undefined when trait is undefined', () => {
        expect(collectDeclaredConfigDefaults(undefined)).toBeUndefined();
    });

    it('returns undefined when trait has no config schema', () => {
        const trait = { name: 'T', category: 'interaction' as const, stateMachine: { states: [], events: [], transitions: [] } } as unknown as Parameters<typeof collectDeclaredConfigDefaults>[0];
        expect(collectDeclaredConfigDefaults(trait)).toBeUndefined();
    });

    it('returns undefined when no field has a default', () => {
        const trait = makeTrait({ icon: { type: 'string' } });
        expect(collectDeclaredConfigDefaults(trait)).toBeUndefined();
    });

    it('extracts string defaults', () => {
        const trait = makeTrait({
            placeholder: { type: 'string', default: 'Search…' },
            event: { type: 'string', default: 'SEARCH' },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            placeholder: 'Search…',
            event: 'SEARCH',
        });
    });

    it('extracts number defaults', () => {
        const trait = makeTrait({
            pageSize: { type: 'number', default: 10 },
            totalPages: { type: 'number', default: 0 },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            pageSize: 10,
            totalPages: 0,
        });
    });

    it('extracts [string] array defaults — std-modal `fields : [string] = []`', () => {
        const trait = makeTrait({
            fields: { type: '[string]', default: [] },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({ fields: [] });
    });

    it('extracts populated [string] array defaults', () => {
        const trait = makeTrait({
            fields: { type: '[string]', default: ['name', 'description'] },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            fields: ['name', 'description'],
        });
    });

    it('extracts [object] array defaults — std-browse `fields : [object] = []`', () => {
        const trait = makeTrait({
            fields: { type: '[object]', default: [] },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({ fields: [] });
    });

    it('extracts populated [object] array defaults', () => {
        const fields = [
            { name: 'name', label: 'Name', variant: 'h4' },
            { name: 'description', label: 'Description', variant: 'caption' },
        ];
        const trait = makeTrait({
            fields: { type: '[object]', default: fields },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({ fields });
    });

    it('extracts object (non-array) defaults', () => {
        const trait = makeTrait({
            theme: { type: 'object', default: { primary: '#0070f3' } },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            theme: { primary: '#0070f3' },
        });
    });

    it('extracts mixed-type configs preserving each value', () => {
        const trait = makeTrait({
            placeholder: { type: 'string', default: 'Search…' },
            event: { type: 'string', default: 'SEARCH' },
            fields: { type: '[object]', default: [{ name: 'a' }] },
            pageSize: { type: 'number', default: 25 },
            enabled: { type: 'bool', default: true },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            placeholder: 'Search…',
            event: 'SEARCH',
            fields: [{ name: 'a' }],
            pageSize: 25,
            enabled: true,
        });
    });

    it('skips fields whose default is the JS undefined sentinel', () => {
        const trait = makeTrait({
            placeholder: { type: 'string', default: 'Search…' },
            event: { type: 'string', default: undefined },
        });
        // `event` is dropped; only declared defaults survive into the
        // merge map. Call-site overrides supply missing fields.
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            placeholder: 'Search…',
        });
    });

    it('handles falsy defaults — empty string, zero, false, empty array — without dropping them', () => {
        const trait = makeTrait({
            placeholder: { type: 'string', default: '' },
            count: { type: 'number', default: 0 },
            flag: { type: 'bool', default: false },
            list: { type: '[string]', default: [] },
        });
        expect(collectDeclaredConfigDefaults(trait)).toEqual({
            placeholder: '',
            count: 0,
            flag: false,
            list: [],
        });
    });
});
