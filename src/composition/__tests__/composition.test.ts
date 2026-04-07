/**
 * Composition Module Tests
 *
 * Unit tests for the runtime composition layer (`composeBehaviors`,
 * `applyEventWiring`, `detectLayoutStrategy`, `pipeBehaviors`).
 */

import { describe, expect, it } from 'vitest';
import type { OrbitalDefinition, Trait } from '@almadar/core';
import {
    composeBehaviors,
    applyEventWiring,
    detectLayoutStrategy,
    pipeBehaviors,
    type EventWiringEntry,
    type LayoutStrategy,
} from '../index.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeTrait(name: string, linkedEntity = 'TestEntity'): Trait {
    return {
        name,
        linkedEntity,
        category: 'interaction',
    };
}

function makeOrbital(name: string, traitNames: string[] = []): OrbitalDefinition {
    return {
        name,
        entity: {
            name: `${name}Entity`,
            fields: [],
        },
        traits: traitNames.map((tn) => makeTrait(tn)),
        pages: [],
    };
}

// ============================================================================
// composeBehaviors
// ============================================================================

describe('composeBehaviors', () => {
    it('composes a single orbital into a single-page schema', () => {
        const orbital = makeOrbital('Cart');
        const result = composeBehaviors({
            appName: 'OneApp',
            orbitals: [orbital],
        });

        expect(result.schema.name).toBe('OneApp');
        expect(result.schema.version).toBe('1.0.0');
        expect(result.schema.orbitals).toHaveLength(1);
        expect(result.layout.strategy).toBe('single');
        expect(result.layout.pageCount).toBe(1);
        expect(result.wiring.connections).toBe(0);

        const pages = result.schema.orbitals[0]?.pages ?? [];
        expect(pages).toHaveLength(1);
    });

    it('composes 2 orbitals into a tabs layout', () => {
        const orbitals = [makeOrbital('Cart'), makeOrbital('Checkout')];
        const result = composeBehaviors({
            appName: 'TwoApp',
            orbitals,
        });

        expect(result.schema.orbitals).toHaveLength(2);
        expect(result.layout.strategy).toBe('tabs');
        expect(result.layout.pageCount).toBe(2);

        // Each orbital gets its own page assigned
        for (const o of result.schema.orbitals) {
            expect(o.pages?.length ?? 0).toBeGreaterThan(0);
        }
    });

    it('composes 5 orbitals into a sidebar layout', () => {
        const orbitals = [
            makeOrbital('Cart'),
            makeOrbital('Checkout'),
            makeOrbital('Catalog'),
            makeOrbital('Account'),
            makeOrbital('Support'),
        ];
        const result = composeBehaviors({
            appName: 'FiveApp',
            orbitals,
        });

        expect(result.schema.orbitals).toHaveLength(5);
        expect(result.layout.strategy).toBe('sidebar');
        expect(result.layout.pageCount).toBe(5);
    });
});

// ============================================================================
// applyEventWiring
// ============================================================================

describe('applyEventWiring', () => {
    it('returns unchanged orbitals when there are 0 entries', () => {
        const orbitals = [makeOrbital('Cart', ['CartTrait'])];
        const wired = applyEventWiring(orbitals, []);

        expect(wired).toHaveLength(1);
        const trait = wired[0]?.traits[0];
        expect(trait && typeof trait === 'object' && 'name' in trait).toBe(true);
        if (trait && typeof trait === 'object' && 'name' in trait) {
            expect(trait.emits ?? []).toHaveLength(0);
            expect(trait.listens ?? []).toHaveLength(0);
        }
    });

    it('applies a single wiring entry by adding emit and listen', () => {
        const orbitals = [
            makeOrbital('Cart', ['CartTrait']),
            makeOrbital('Checkout', ['CheckoutTrait']),
        ];
        const wiring: EventWiringEntry[] = [
            {
                from: 'CartTrait',
                event: 'CHECKOUT_REQUESTED',
                to: 'CheckoutTrait',
                triggers: 'BEGIN_CHECKOUT',
            },
        ];

        const wired = applyEventWiring(orbitals, wiring);

        const cartTrait = wired[0]?.traits[0];
        if (cartTrait && typeof cartTrait === 'object' && 'name' in cartTrait) {
            expect(cartTrait.emits).toEqual([
                { event: 'CHECKOUT_REQUESTED', scope: 'external' },
            ]);
        }

        const checkoutTrait = wired[1]?.traits[0];
        if (checkoutTrait && typeof checkoutTrait === 'object' && 'name' in checkoutTrait) {
            expect(checkoutTrait.listens).toEqual([
                {
                    event: 'CHECKOUT_REQUESTED',
                    triggers: 'BEGIN_CHECKOUT',
                    scope: 'external',
                },
            ]);
        }
    });

    it('applies 3 wiring entries without duplicating', () => {
        const orbitals = [
            makeOrbital('A', ['TraitA']),
            makeOrbital('B', ['TraitB']),
            makeOrbital('C', ['TraitC']),
        ];
        const wiring: EventWiringEntry[] = [
            { from: 'TraitA', event: 'EVT_1', to: 'TraitB', triggers: 'TRIG_1' },
            { from: 'TraitB', event: 'EVT_2', to: 'TraitC', triggers: 'TRIG_2' },
            // Duplicate of the first - must not double-apply
            { from: 'TraitA', event: 'EVT_1', to: 'TraitB', triggers: 'TRIG_1' },
        ];

        const wired = applyEventWiring(orbitals, wiring);

        const traitA = wired[0]?.traits[0];
        if (traitA && typeof traitA === 'object' && 'name' in traitA) {
            // Only one EVT_1 emit despite duplicate wiring entry
            expect(traitA.emits).toEqual([
                { event: 'EVT_1', scope: 'external' },
            ]);
        }

        const traitB = wired[1]?.traits[0];
        if (traitB && typeof traitB === 'object' && 'name' in traitB) {
            // Only one TRIG_1 listen
            expect(traitB.listens).toEqual([
                {
                    event: 'EVT_1',
                    triggers: 'TRIG_1',
                    scope: 'external',
                },
            ]);
            // And one EVT_2 emit (B emits to C)
            expect(traitB.emits).toEqual([
                { event: 'EVT_2', scope: 'external' },
            ]);
        }

        const traitC = wired[2]?.traits[0];
        if (traitC && typeof traitC === 'object' && 'name' in traitC) {
            expect(traitC.listens).toEqual([
                {
                    event: 'EVT_2',
                    triggers: 'TRIG_2',
                    scope: 'external',
                },
            ]);
        }
    });

    it('does not mutate the input orbitals', () => {
        const orbitals = [makeOrbital('Cart', ['CartTrait'])];
        const wiring: EventWiringEntry[] = [
            {
                from: 'CartTrait',
                event: 'X',
                to: 'CartTrait',
                triggers: 'X',
            },
        ];

        applyEventWiring(orbitals, wiring);

        const trait = orbitals[0]?.traits[0];
        if (trait && typeof trait === 'object' && 'name' in trait) {
            expect(trait.emits).toBeUndefined();
            expect(trait.listens).toBeUndefined();
        }
    });
});

// ============================================================================
// detectLayoutStrategy
// ============================================================================

describe('detectLayoutStrategy', () => {
    it('returns "single" for one orbital', () => {
        const result: LayoutStrategy = detectLayoutStrategy([makeOrbital('Solo')]);
        expect(result).toBe('single');
    });

    it('returns "tabs" for 3 orbitals with no wiring', () => {
        const result = detectLayoutStrategy([
            makeOrbital('A'),
            makeOrbital('B'),
            makeOrbital('C'),
        ]);
        expect(result).toBe('tabs');
    });

    it('returns "sidebar" for 6 orbitals', () => {
        const result = detectLayoutStrategy([
            makeOrbital('A'),
            makeOrbital('B'),
            makeOrbital('C'),
            makeOrbital('D'),
            makeOrbital('E'),
            makeOrbital('F'),
        ]);
        expect(result).toBe('sidebar');
    });

    it('returns "wizard-flow" when 3+ orbitals form a sequential chain via wiring', () => {
        const orbitals = [
            makeOrbital('A', ['TraitA']),
            makeOrbital('B', ['TraitB']),
            makeOrbital('C', ['TraitC']),
        ];
        const wiring: EventWiringEntry[] = [
            { from: 'TraitA', event: 'NEXT', to: 'TraitB', triggers: 'GO' },
            { from: 'TraitB', event: 'NEXT', to: 'TraitC', triggers: 'GO' },
        ];

        const result = detectLayoutStrategy(orbitals, wiring);
        expect(result).toBe('wizard-flow');
    });
});

// ============================================================================
// pipeBehaviors
// ============================================================================

describe('pipeBehaviors', () => {
    it('applies 2 steps left-to-right', () => {
        const result = pipeBehaviors(
            1,
            (n) => (n as number) + 1,
            (n) => (n as number) * 10,
        );
        expect(result).toBe(20);
    });

    it('applies 4 steps left-to-right', () => {
        const order: string[] = [];
        const result = pipeBehaviors(
            'seed',
            (v) => {
                order.push('a');
                return `${v as string}-a`;
            },
            (v) => {
                order.push('b');
                return `${v as string}-b`;
            },
            (v) => {
                order.push('c');
                return `${v as string}-c`;
            },
            (v) => {
                order.push('d');
                return `${v as string}-d`;
            },
        );
        expect(order).toEqual(['a', 'b', 'c', 'd']);
        expect(result).toBe('seed-a-b-c-d');
    });

    it('returns the seed unchanged when given no steps', () => {
        const result = pipeBehaviors(42);
        expect(result).toBe(42);
    });
});
