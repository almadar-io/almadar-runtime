/**
 * Computed Event Interface Resolver
 *
 * Computes the orbital-level event interface from trait-level declarations.
 * This implements the trait-centric event model where:
 * - Traits declare their events via `emits` and `listens`
 * - Orbital `emits`/`listens` are COMPUTED by aggregating from traits
 * - External events are namespaced as "TraitName.EVENT_NAME"
 *
 * @packageDocumentation
 */

import type {
    OrbitalDefinition,
    Trait,
    TraitRef,
    TraitEventContract,
    TraitEventListener,
    ComputedEventContract,
    ComputedEventListener,
    EventSource,
    EventPayloadField,
} from '@almadar/core';
import { isInlineTrait, getTraitName } from '@almadar/core';
import { namespaceEvent } from '../utils/event-namespace.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of computing the orbital event interface
 */
export interface ComputedEventInterface {
    /** Namespaced events this orbital emits externally */
    emits: ComputedEventContract[];
    /** Events this orbital listens to from other orbitals */
    listens: ComputedEventListener[];
}

/**
 * Trait resolver function - resolves trait references to full Trait definitions
 */
export type TraitResolver = (ref: TraitRef) => Trait | undefined;

// ============================================================================
// Main Function
// ============================================================================

/**
 * Compute the orbital event interface from trait-level declarations.
 *
 * This function:
 * 1. Iterates over all traits attached to the orbital
 * 2. Collects external `emits` from each trait (with namespacing)
 * 3. Collects external `listens` from each trait
 * 4. Includes tick-emitted events
 * 5. Applies the `exposes` filter if present
 *
 * @param orbital - The orbital definition
 * @param traitResolver - Function to resolve trait references to full Trait definitions
 * @returns Computed event interface with namespaced emits and listens
 */
export function computeOrbitalEventInterface(
    orbital: OrbitalDefinition,
    traitResolver: TraitResolver
): ComputedEventInterface {
    const emits: ComputedEventContract[] = [];
    const listens: ComputedEventListener[] = [];

    // Track seen events to avoid duplicates
    const seenEmits = new Set<string>();
    const seenListens = new Set<string>();

    for (const traitRef of orbital.traits || []) {
        // Get the full trait definition
        let trait: Trait | undefined;

        if (isInlineTrait(traitRef)) {
            trait = traitRef as Trait;
        } else {
            trait = traitResolver(traitRef);
        }

        if (!trait) {
            continue;
        }

        // Collect external emits from trait
        collectTraitEmits(trait, emits, seenEmits, orbital.exposes);

        // Collect tick-emitted events
        collectTickEmits(trait, emits, seenEmits, orbital.exposes);

        // Collect external listens from trait
        collectTraitListens(trait, listens, seenListens);
    }

    return { emits, listens };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Collect external emits from a trait's `emits` array
 */
function collectTraitEmits(
    trait: Trait,
    emits: ComputedEventContract[],
    seenEmits: Set<string>,
    exposes?: string[]
): void {
    for (const emit of trait.emits || []) {
        // Only include external-scoped events
        if (emit.scope !== 'external') {
            continue;
        }

        const namespacedEvent = namespaceEvent(trait.name, emit.event);

        // Apply exposes filter if present
        if (exposes && !exposes.includes(namespacedEvent)) {
            continue;
        }

        // Skip duplicates
        if (seenEmits.has(namespacedEvent)) {
            continue;
        }
        seenEmits.add(namespacedEvent);

        emits.push({
            event: namespacedEvent,
            originalEvent: emit.event,
            source: {
                trait: trait.name,
            },
            description: emit.description,
            payload: emit.payload,
        });
    }
}

/**
 * Collect events emitted by ticks
 *
 * Ticks can emit events via their effects. If a tick declares `emits: ["EVENT_NAME"]`,
 * those events should be included in the computed interface if they are external.
 */
function collectTickEmits(
    trait: Trait,
    emits: ComputedEventContract[],
    seenEmits: Set<string>,
    exposes?: string[]
): void {
    // Build map of trait-level emit contracts for lookup
    const traitEmitContracts = new Map<string, TraitEventContract>();
    for (const emit of trait.emits || []) {
        traitEmitContracts.set(emit.event, emit);
    }

    for (const tick of trait.ticks || []) {
        for (const tickEventName of tick.emits || []) {
            // Look up the event contract from trait.emits
            const contract = traitEmitContracts.get(tickEventName);

            // Only include if the event is external
            if (!contract || contract.scope !== 'external') {
                continue;
            }

            const namespacedEvent = namespaceEvent(trait.name, tickEventName);

            // Apply exposes filter if present
            if (exposes && !exposes.includes(namespacedEvent)) {
                continue;
            }

            // Skip if already added (from trait.emits processing)
            if (seenEmits.has(namespacedEvent)) {
                continue;
            }
            seenEmits.add(namespacedEvent);

            emits.push({
                event: namespacedEvent,
                originalEvent: tickEventName,
                source: {
                    trait: trait.name,
                    tick: tick.name,
                },
                description: contract.description,
                payload: contract.payload,
            });
        }
    }
}

/**
 * Collect external listens from a trait's `listens` array
 */
function collectTraitListens(
    trait: Trait,
    listens: ComputedEventListener[],
    seenListens: Set<string>
): void {
    for (const listen of trait.listens || []) {
        // Only include external-scoped listeners
        if (listen.scope !== 'external') {
            continue;
        }

        // Create a unique key for deduplication
        const listenKey = `${trait.name}:${listen.event}:${listen.triggers}`;

        // Skip duplicates
        if (seenListens.has(listenKey)) {
            continue;
        }
        seenListens.add(listenKey);

        listens.push({
            event: listen.event,
            source: {
                trait: trait.name,
            },
            triggers: listen.triggers,
            guard: listen.guard,
            payloadMapping: listen.payloadMapping,
        });
    }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an orbital has any cross-orbital communication
 */
export function hasExternalEvents(orbital: OrbitalDefinition): boolean {
    const hasEmits = orbital.emits !== undefined && orbital.emits.length > 0;
    const hasListens = orbital.listens !== undefined && orbital.listens.length > 0;
    return hasEmits || hasListens;
}

/**
 * Get all event names emitted by an orbital (namespaced)
 */
export function getOrbitalEmitNames(orbital: OrbitalDefinition): string[] {
    return (orbital.emits || []).map(e => e.event);
}

/**
 * Get all event names listened to by an orbital
 */
export function getOrbitalListenNames(orbital: OrbitalDefinition): string[] {
    return (orbital.listens || []).map(l => l.event);
}

/**
 * Find which trait emits a given event
 */
export function findEmitSource(
    orbital: OrbitalDefinition,
    eventName: string
): EventSource | undefined {
    const emitContract = (orbital.emits || []).find(e => e.event === eventName);
    return emitContract?.source;
}

/**
 * Find which trait listens to a given event
 */
export function findListenSource(
    orbital: OrbitalDefinition,
    eventName: string
): EventSource | undefined {
    const listener = (orbital.listens || []).find(l => l.event === eventName);
    return listener?.source;
}
