/**
 * Event Wiring
 *
 * Applies cross-orbital event wiring to orbital definitions.
 * Adds emits/listens declarations to traits so they can communicate
 * across orbital boundaries.
 *
 * @packageDocumentation
 */

import type {
    OrbitalDefinition,
    Trait,
    TraitEventContract,
    TraitEventListener,
} from '@almadar/core';
import { isInlineTrait } from '@almadar/core';

// ============================================================================
// Types
// ============================================================================

/**
 * A single event wiring entry connecting two traits across orbitals.
 */
export interface EventWiringEntry {
    /** Source trait name or orbital name */
    from: string;
    /** Event name (UPPER_SNAKE_CASE) */
    event: string;
    /** Target trait name or orbital name */
    to: string;
    /** Event to trigger on the listener side */
    triggers: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find a trait by name across all orbitals.
 * Only inline traits can be mutated; string/ref traits are skipped.
 * Returns the inline Trait object if found, or null.
 */
function findInlineTrait(
    orbitals: OrbitalDefinition[],
    name: string,
): Trait | null {
    for (const orbital of orbitals) {
        for (const traitRef of orbital.traits) {
            if (isInlineTrait(traitRef) && traitRef.name === name) {
                return traitRef;
            }
        }
    }
    return null;
}

/**
 * Check if an emit already exists in the list.
 * @internal
 */
function hasEmit(emits: TraitEventContract[], event: string): boolean {
    return emits.some((e) => e.event === event);
}

/**
 * Check if a listen already exists in the list.
 * @internal
 */
function hasListen(
    listens: TraitEventListener[],
    event: string,
    triggers: string,
): boolean {
    return listens.some((l) => l.event === event && l.triggers === triggers);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply event wiring to orbital definitions.
 *
 * For each wiring entry:
 * 1. Find the source trait and add an external emit (if not already present)
 * 2. Find the target trait and add an external listen (if not already present)
 *
 * Returns a new array of orbitals with wiring applied (deep-cloned).
 */
export function applyEventWiring(
    orbitals: OrbitalDefinition[],
    wiring: EventWiringEntry[],
): OrbitalDefinition[] {
    // Deep clone to avoid mutating input
    const cloned: OrbitalDefinition[] = JSON.parse(
        JSON.stringify(orbitals),
    ) as OrbitalDefinition[];

    for (const entry of wiring) {
        // Wire the source: add emit
        const sourceTrait = findInlineTrait(cloned, entry.from);
        if (sourceTrait) {
            if (!sourceTrait.emits) {
                sourceTrait.emits = [];
            }
            if (!hasEmit(sourceTrait.emits, entry.event)) {
                sourceTrait.emits.push({
                    event: entry.event,
                    scope: 'external',
                });
            }
        }

        // Wire the target: add listen
        const targetTrait = findInlineTrait(cloned, entry.to);
        if (targetTrait) {
            if (!targetTrait.listens) {
                targetTrait.listens = [];
            }
            if (!hasListen(targetTrait.listens, entry.event, entry.triggers)) {
                targetTrait.listens.push({
                    event: entry.event,
                    triggers: entry.triggers,
                    scope: 'external',
                });
            }
        }
    }

    return cloned;
}
