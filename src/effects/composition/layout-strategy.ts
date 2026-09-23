/**
 * Layout Strategy Detection
 *
 * Auto-detects the best layout strategy for a composed application
 * based on the number of orbitals and their event wiring topology.
 *
 * @packageDocumentation
 */

import type { OrbitalDefinition } from '@almadar/core';
import type { EventWiringEntry } from './event-wiring.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Layout strategy for the composed application.
 *
 * - 'single': One orbital, one page
 * - 'tabs': 2-4 orbitals with no sequential chain
 * - 'sidebar': 5+ orbitals (navigation-heavy)
 * - 'dashboard': Single page with all orbitals visible
 * - 'wizard-flow': Sequential event chain detected (A -> B -> C)
 */
export type LayoutStrategy =
    | 'sidebar'
    | 'tabs'
    | 'dashboard'
    | 'wizard-flow'
    | 'single';

// ============================================================================
// Chain Detection
// ============================================================================

/**
 * Detect whether the event wiring forms a sequential chain.
 *
 * A sequential chain exists when orbital A's `from` feeds into B's `to`,
 * and B's `from` feeds into C's `to`, forming A -> B -> C.
 *
 * We build a directed graph from wiring entries and look for a chain
 * that covers 3+ nodes (the minimum for a meaningful wizard flow).
 */
function hasSequentialChain(wiring: EventWiringEntry[]): boolean {
    if (wiring.length < 2) {
        return false;
    }

    // Build adjacency: from -> Set<to>
    const adjacency = new Map<string, Set<string>>();
    const allTargets = new Set<string>();

    for (const entry of wiring) {
        let targets = adjacency.get(entry.from);
        if (!targets) {
            targets = new Set<string>();
            adjacency.set(entry.from, targets);
        }
        targets.add(entry.to);
        allTargets.add(entry.to);
    }

    // Find roots (nodes that are sources but never targets)
    const roots: string[] = [];
    for (const from of adjacency.keys()) {
        if (!allTargets.has(from)) {
            roots.push(from);
        }
    }

    // If no clear root, try all sources
    const starts = roots.length > 0 ? roots : [...adjacency.keys()];

    // Walk from each start and measure chain length
    for (const start of starts) {
        let current = start;
        let length = 1;
        const visited = new Set<string>([current]);

        while (true) {
            const nexts = adjacency.get(current);
            if (!nexts || nexts.size === 0) break;

            // Follow the first unvisited successor (linear chain)
            let advanced = false;
            for (const next of nexts) {
                if (!visited.has(next)) {
                    visited.add(next);
                    current = next;
                    length++;
                    advanced = true;
                    break;
                }
            }

            if (!advanced) break;
        }

        // A chain of 3+ nodes qualifies as wizard-flow
        if (length >= 3) {
            return true;
        }
    }

    return false;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Detect the best layout strategy based on orbital count and event wiring.
 *
 * Heuristic:
 * 1. Sequential event chain detected -> 'wizard-flow'
 * 2. 1 orbital -> 'single'
 * 3. 2-4 orbitals -> 'tabs'
 * 4. 5+ orbitals -> 'sidebar'
 */
export function detectLayoutStrategy(
    orbitals: OrbitalDefinition[],
    eventWiring?: EventWiringEntry[],
): LayoutStrategy {
    // Check for sequential chain first (takes priority)
    if (eventWiring && eventWiring.length > 0 && hasSequentialChain(eventWiring)) {
        return 'wizard-flow';
    }

    const count = orbitals.length;

    if (count <= 1) {
        return 'single';
    }

    if (count <= 4) {
        return 'tabs';
    }

    return 'sidebar';
}
