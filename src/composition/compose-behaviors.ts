/**
 * Compose Behaviors
 *
 * Main entry point for composing multiple orbital definitions into
 * a single OrbitalSchema application. Handles event wiring, layout
 * strategy detection, and page generation.
 *
 * @packageDocumentation
 */

import type { OrbitalDefinition, OrbitalSchema, Page } from '@almadar/core';
import type { EventWiringEntry } from './event-wiring.js';
import { applyEventWiring } from './event-wiring.js';
import type { LayoutStrategy } from './layout-strategy.js';
import { detectLayoutStrategy } from './layout-strategy.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for composing behaviors into an application.
 */
export interface ComposeBehaviorsInput {
    /** Application name */
    appName: string;
    /** Orbital definitions to compose */
    orbitals: OrbitalDefinition[];
    /** Layout strategy override, or 'auto' to detect */
    layoutStrategy?: LayoutStrategy | 'auto';
    /** Cross-orbital event wiring */
    eventWiring?: EventWiringEntry[];
    /** Optional entity name mappings (original -> renamed) */
    entityMappings?: Record<string, string>;
}

/**
 * Result of composing behaviors.
 */
export interface ComposeBehaviorsResult {
    /** The composed OrbitalSchema */
    schema: OrbitalSchema;
    /** Layout metadata */
    layout: { strategy: LayoutStrategy; pageCount: number };
    /** Wiring metadata */
    wiring: { connections: number };
}

// ============================================================================
// Page Generation
// ============================================================================

function toKebabCase(name: string): string {
    return name
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
}

/**
 * Generate pages for each orbital based on the layout strategy.
 *
 * For strategies that produce one page per orbital (sidebar, tabs, wizard-flow),
 * each orbital gets a page at `/<kebab-name>` with `isInitial` on the first.
 *
 * For 'dashboard', all orbitals share a single page.
 * For 'single', the lone orbital gets a single root page.
 */
function generatePages(
    orbitals: OrbitalDefinition[],
    strategy: LayoutStrategy,
): Page[] {
    switch (strategy) {
        case 'single': {
            const orbital = orbitals[0];
            const name = orbital?.name ?? 'Main';
            return [
                {
                    name: `${name}Page`,
                    path: '/',
                    isInitial: true,
                    primaryEntity: getEntityName(orbital),
                },
            ];
        }

        case 'dashboard': {
            return [
                {
                    name: 'DashboardPage',
                    path: '/',
                    viewType: 'dashboard',
                    isInitial: true,
                },
            ];
        }

        case 'sidebar':
        case 'tabs':
        case 'wizard-flow': {
            return orbitals.map((orbital, index) => ({
                name: `${orbital.name}Page`,
                path: index === 0 ? '/' : `/${toKebabCase(orbital.name)}`,
                isInitial: index === 0,
                primaryEntity: getEntityName(orbital),
            }));
        }
    }
}

/**
 * Extract entity name from an orbital definition.
 * Handles both inline entities and string references.
 */
function getEntityName(orbital: OrbitalDefinition | undefined): string | undefined {
    if (!orbital) return undefined;
    const entity = orbital.entity;
    if (typeof entity === 'string') {
        // Reference like "Alias.entity" - extract the alias as entity name
        return entity.replace('.entity', '');
    }
    return entity.name;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compose multiple orbital definitions into a single application schema.
 *
 * Steps:
 * 1. Apply event wiring (adds emits/listens to traits)
 * 2. Detect or use provided layout strategy
 * 3. Generate pages based on the strategy
 * 4. Build the final OrbitalSchema
 */
export function composeBehaviors(
    input: ComposeBehaviorsInput,
): ComposeBehaviorsResult {
    const {
        appName,
        orbitals: rawOrbitals,
        layoutStrategy: strategyInput,
        eventWiring,
    } = input;

    // Step 1: Apply event wiring
    const wiredOrbitals =
        eventWiring && eventWiring.length > 0
            ? applyEventWiring(rawOrbitals, eventWiring)
            : rawOrbitals;

    // Step 2: Determine layout strategy
    const strategy: LayoutStrategy =
        !strategyInput || strategyInput === 'auto'
            ? detectLayoutStrategy(wiredOrbitals, eventWiring)
            : strategyInput;

    // Step 3: Generate pages
    const pages = generatePages(wiredOrbitals, strategy);

    // Step 4: Assign generated pages to orbitals (merge, don't replace existing)
    const orbitalsWithPages = wiredOrbitals.map((orbital, index) => {
        // If the orbital already has pages, keep them
        if (orbital.pages && orbital.pages.length > 0) {
            return orbital;
        }

        // Assign the generated page for this orbital
        const page = strategy === 'dashboard' || strategy === 'single'
            ? pages[0]
            : pages[index];

        return {
            ...orbital,
            pages: page ? [page] : [],
        };
    });

    // Step 5: Build the schema
    const schema: OrbitalSchema = {
        name: appName,
        version: '1.0.0',
        orbitals: orbitalsWithPages,
    };

    return {
        schema,
        layout: {
            strategy,
            pageCount: pages.length,
        },
        wiring: {
            connections: eventWiring?.length ?? 0,
        },
    };
}
