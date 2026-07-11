/**
 * `@config.<knob>` emit-name resolution (Option B).
 *
 * An emits declaration may reference a string-typed config knob as the
 * event name: `emits { @config.action -> external { id : string } }`.
 * The resolver substitutes the knob's effective value per trait instance
 * (call-site override if supplied, else the declared default) BEFORE
 * event renames apply. Unresolvable refs (unknown knob / non-string /
 * no default) are errors — mirror of ORB_EMIT_CONFIG_REF_INVALID.
 */

import { describe, it, expect } from 'vitest';
import type { Trait, TraitEventContract } from '@almadar/core';
import { resolveConfigRefEmitNames } from '../src/resolver/reference-resolver.js';

function makeTrait(overrides: Partial<Trait>): Trait {
    return {
        name: 'ButtonRender',
        scope: 'instance',
        stateMachine: { states: [], events: [], transitions: [] },
        ...overrides,
    };
}

const refEmit: TraitEventContract = {
    event: '@config.action',
    scope: 'external',
    payloadSchema: [{ name: 'id', type: 'string' }],
};

describe('resolveConfigRefEmitNames', () => {
    it('resolves to the declared default when no call site exists (standalone)', () => {
        const trait = makeTrait({
            emits: [refEmit],
            config: { action: { type: 'string', default: 'ACTION' } },
        });
        const { trait: resolved, errors } = resolveConfigRefEmitNames(trait);
        expect(errors).toEqual([]);
        expect(resolved.emits?.[0]?.event).toBe('ACTION');
        expect(resolved.emits?.[0]?.scope).toBe('external');
    });

    it('resolves to the call-site override when supplied', () => {
        const trait = makeTrait({
            emits: [refEmit],
            config: { action: { type: 'string', default: 'ACTION' } },
        });
        const { trait: resolved, errors } = resolveConfigRefEmitNames(trait, {
            action: 'CREATE',
        });
        expect(errors).toEqual([]);
        expect(resolved.emits?.[0]?.event).toBe('CREATE');
    });

    it('leaves literal event names untouched', () => {
        const trait = makeTrait({
            emits: [{ event: 'SAVED', scope: 'external' }, refEmit],
            config: { action: { type: 'string', default: 'ACTION' } },
        });
        const { trait: resolved, errors } = resolveConfigRefEmitNames(trait, {
            action: 'CREATE',
        });
        expect(errors).toEqual([]);
        expect(resolved.emits?.map((e) => e.event)).toEqual(['SAVED', 'CREATE']);
    });

    it('errors on an unknown knob', () => {
        const trait = makeTrait({
            emits: [refEmit],
            config: { other: { type: 'string', default: 'X' } },
        });
        const { errors } = resolveConfigRefEmitNames(trait);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('unknown-knob');
        expect(errors[0]).toContain('@config.action');
    });

    it('errors on a non-string knob', () => {
        const trait = makeTrait({
            emits: [refEmit],
            config: { action: { type: 'number', default: 3 } },
        });
        const { errors } = resolveConfigRefEmitNames(trait);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('not-string');
    });

    it('errors on a knob without a default', () => {
        const trait = makeTrait({
            emits: [refEmit],
            config: { action: { type: 'string' } },
        });
        const { errors } = resolveConfigRefEmitNames(trait);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('no-default');
    });

    it('is a no-op (same reference) when no emit carries a ref', () => {
        const trait = makeTrait({
            emits: [{ event: 'SAVED', scope: 'external' }],
        });
        const { trait: resolved, errors } = resolveConfigRefEmitNames(trait);
        expect(errors).toEqual([]);
        expect(resolved).toBe(trait);
    });
});
