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
import type { Trait, TraitEventContract, Event, OrbitalDefinition, Orbital } from '@almadar/core';
import { ReferenceResolver, resolveConfigRefEmitNames } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';

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
        const { trait: resolved, errors, resolvedKnobs } = resolveConfigRefEmitNames(trait);
        expect(errors).toEqual([]);
        expect(resolved).toBe(trait);
        expect(resolvedKnobs).toEqual([]);
    });

    // Ledger (j): the rewrite also mirrors onto `stateMachine.events[*].key` —
    // L1 lowering unions emit keys into the events registry, so the raw
    // `@config.<knob>` token appears there too.
    it('mirrors the resolved literal onto the matching `stateMachine.events[].key` entry, and returns the resolved knob name', () => {
        const event: Event = { key: '@config.action', name: 'Action' };
        const trait = makeTrait({
            emits: [refEmit],
            config: { action: { type: 'string', default: 'ACTION' } },
            stateMachine: { states: [], events: [event], transitions: [] },
        });
        const { trait: resolved, errors, resolvedKnobs } = resolveConfigRefEmitNames(trait, { action: 'CREATE' });
        expect(errors).toEqual([]);
        expect(resolvedKnobs).toEqual(['action']);
        expect(resolved.stateMachine!.events[0]!.key).toBe('CREATE');
    });

    it('leaves a `stateMachine.events[].key` entry untouched when it does not match the raw `@config.` token', () => {
        const event: Event = { key: 'SAVED', name: 'Saved' };
        const trait = makeTrait({
            emits: [refEmit],
            config: { action: { type: 'string', default: 'ACTION' } },
            stateMachine: { states: [], events: [event], transitions: [] },
        });
        const { trait: resolved } = resolveConfigRefEmitNames(trait, { action: 'CREATE' });
        expect(resolved.stateMachine!.events[0]!.key).toBe('SAVED');
    });
});

// Ledger (j), second half: a LATER `events:` rename of an already-resolved
// `@config.<knob>` emit name folds back onto the knob's OWN declared
// default — not just the emit/events-catalog entries `resolveConfigRefEmitNames`
// itself touches. Exercised through `ReferenceResolver.resolve()` (the two
// `resolveTraitRefString` branches this reuses `resolveConfigRefEmitNames` +
// the fold), since the fold only matters once a call site can supply both a
// `config` override AND an `events` rename together.
describe('ReferenceResolver — events rename folds back onto a resolved knob\'s declared default (ledger (j))', () => {
    function atomsOrbital(): Orbital {
        return {
            name: 'Atoms',
            entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
            traits: [
                {
                    name: 'ActionButton',
                    scope: 'instance',
                    // The knob forwards to WHOEVER supplies it (a call-site
                    // `config` override here — never resolved to a literal by
                    // this trait's own scope), so `renameEventsInDeclaredConfig`
                    // (the ordinary rename pass inside `applyEventRenames`)
                    // deliberately skips it — it only ever rewrites a NON-`@`
                    // declared default.
                    config: { action: { type: 'event', default: '@config.action' } },
                    emits: [{ event: '@config.action', scope: 'external' }],
                    stateMachine: {
                        states: [{ name: 'idle', isInitial: true }],
                        events: [{ key: 'INIT', name: 'Init' }],
                        transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
                    },
                },
            ],
            pages: [],
        };
    }

    function makeAtomsLoader(): SchemaLoader {
        const orbital = atomsOrbital();
        return {
            async load(): Promise<LoadResult<LoadedSchema>> {
                return { success: false, error: 'not used' };
            },
            async loadOrbital() {
                return { success: true, data: { orbital, sourcePath: './atoms.orb', importPath: 'Atoms' } };
            },
            resolvePath(p: string) {
                return { success: true, data: p };
            },
            clearCache() {
                /* no-op */
            },
            getCacheStats() {
                return { size: 0 };
            },
        };
    }

    it('folds the renamed value onto `config[knob].default`, not just the emit and events catalog', async () => {
        const resolver = new ReferenceResolver({ basePath: '.', loader: makeAtomsLoader() });
        const orbital: OrbitalDefinition = {
            name: 'Consumer',
            uses: [{ from: './atoms.orb', as: 'Atoms' }],
            entity: { name: 'ConsumerEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
            traits: [
                {
                    ref: 'Atoms.traits.ActionButton',
                    config: { action: 'DEFAULT_ACTION' },
                    events: { DEFAULT_ACTION: 'RENAMED_ACTION' },
                },
            ],
            pages: [],
        };

        const result = await resolver.resolve(orbital);

        expect(result.success).toBe(true);
        if (!result.success) return;
        const button = result.data.traits.find((rt) => rt.trait.name === 'ActionButton');
        expect(button).toBeDefined();
        expect(button!.trait.emits?.[0]?.event).toBe('RENAMED_ACTION');
        expect(button!.trait.config!.action.default).toBe('RENAMED_ACTION');
    });
});
