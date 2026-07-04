import { describe, expect, it } from 'vitest';
import { normalizeCallSiteConfigToValues } from '../src/config-defaults.js';

describe('normalizeCallSiteConfigToValues', () => {
    it('returns undefined for undefined input', () => {
        expect(normalizeCallSiteConfigToValues(undefined)).toBeUndefined();
    });

    it('returns undefined for an empty config object', () => {
        expect(normalizeCallSiteConfigToValues({})).toBeUndefined();
    });

    it('passes plain scalar values through unchanged', () => {
        const out = normalizeCallSiteConfigToValues({
            name: 'Almadar',
            count: 42,
            enabled: false,
            empty: null,
        });
        expect(out).toEqual({
            name: 'Almadar',
            count: 42,
            enabled: false,
            empty: null,
        });
    });

    it('passes plain array and object values through unchanged', () => {
        const out = normalizeCallSiteConfigToValues({
            navItems: [{ href: '/', label: 'Home' }],
            theme: { primary: '#0070f3' },
            tags: [],
        });
        expect(out).toEqual({
            navItems: [{ href: '/', label: 'Home' }],
            theme: { primary: '#0070f3' },
            tags: [],
        });
    });

    it('flattens ConfigFieldDeclaration objects to their default values', () => {
        const out = normalizeCallSiteConfigToValues({
            appName: { type: 'string', default: 'Almadar' },
            layoutMode: { type: 'string', default: 'topnav' },
            navItems: { type: '[object]', default: [{ href: '/', label: 'Home' }] },
        });
        expect(out).toEqual({
            appName: 'Almadar',
            layoutMode: 'topnav',
            navItems: [{ href: '/', label: 'Home' }],
        });
    });

    it('handles a mix of plain values and declarations', () => {
        const out = normalizeCallSiteConfigToValues({
            appName: { type: 'string', default: 'Almadar' },
            customClass: 'w-full',
            navItems: [{ href: '/', label: 'Home' }],
        });
        expect(out).toEqual({
            appName: 'Almadar',
            customClass: 'w-full',
            navItems: [{ href: '/', label: 'Home' }],
        });
    });

    it('passes objects that lack a default slot through unchanged (not treated as declarations)', () => {
        const out = normalizeCallSiteConfigToValues({
            appName: { type: 'string', default: 'Almadar' },
            metadata: { type: 'info' },
        });
        expect(out).toEqual({
            appName: 'Almadar',
            metadata: { type: 'info' },
        });
    });

    it('preserves falsy defaults', () => {
        const out = normalizeCallSiteConfigToValues({
            emptyString: { type: 'string', default: '' },
            zero: { type: 'number', default: 0 },
            flag: { type: 'bool', default: false },
            emptyList: { type: '[string]', default: [] },
            nullValue: { type: 'string', default: null },
        });
        expect(out).toEqual({
            emptyString: '',
            zero: 0,
            flag: false,
            emptyList: [],
            nullValue: null,
        });
    });

    it('does not mutate the input', () => {
        const input = {
            appName: { type: 'string', default: 'Almadar' },
        };
        normalizeCallSiteConfigToValues(input);
        expect(input.appName).toEqual({ type: 'string', default: 'Almadar' });
    });
});
