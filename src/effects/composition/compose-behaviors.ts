/**
 * Compose Behaviors
 *
 * Main entry point for composing multiple orbital definitions into
 * a single OrbitalSchema application. Handles event wiring, layout
 * strategy detection, and page generation.
 *
 * @packageDocumentation
 */

import type { IdentityLedger, LedgerEntry, OrbitalDefinition, OrbitalSchema, Page } from '@almadar/core';
import type { EventWiringEntry } from './event-wiring.js';
import { applyEventWiring } from './event-wiring.js';
import type { LayoutStrategy } from './layout-strategy.js';
import { detectLayoutStrategy } from './layout-strategy.js';

/** True when an input is a whole OrbitalSchema (carries an `orbitals` array). */
function isSchema(input: OrbitalDefinition | OrbitalSchema): input is OrbitalSchema {
    return 'orbitals' in input && Array.isArray((input as OrbitalSchema).orbitals);
}

/** Unwrap OrbitalSchema | OrbitalDefinition inputs to a flat OrbitalDefinition[]. */
function asDefinitions(inputs: (OrbitalDefinition | OrbitalSchema)[]): OrbitalDefinition[] {
    return inputs.flatMap(input =>
        isSchema(input) ? (input.orbitals as OrbitalDefinition[]) : [input],
    );
}

/**
 * Union the identity ledgers of the schema-shaped inputs (V4 Phase 6, runtime
 * mirror of the Rust compose ledger merge). Bare OrbitalDefinition inputs and
 * ledger-less schemas contribute nothing (pre-V4 back-compat: no ledger in →
 * no ledger out). Entries are keyed by id; first occurrence in input order wins
 * for a duplicate id — the rows share one identity, so a `curName` divergence
 * across slices resolves deterministically to the earliest input's row. Output
 * entries are sorted by id for stable, order-independent composition.
 */
function mergeLedgers(inputs: (OrbitalDefinition | OrbitalSchema)[]): IdentityLedger | undefined {
    const merged = new Map<string, LedgerEntry>();
    let sawLedger = false;
    for (const input of inputs) {
        if (!isSchema(input) || input.ledger === undefined) continue;
        sawLedger = true;
        for (const [id, entry] of Object.entries(input.ledger.entries)) {
            if (!merged.has(id)) merged.set(id, entry);
        }
    }
    if (!sawLedger) return undefined;
    const entries: Record<string, LedgerEntry> = {};
    for (const [id, entry] of [...merged.entries()].sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )) {
        entries[id] = entry;
    }
    return { schemaVersion: 1, entries };
}

/**
 * Composed `schemaVersion` = max over the schema-shaped inputs that declare one
 * (the newest IR version any slice carries; collapses to the shared value when
 * uniform). Undefined when no input declares a version — pre-V4 stays unversioned.
 */
function mergeSchemaVersions(inputs: (OrbitalDefinition | OrbitalSchema)[]): number | undefined {
    let max: number | undefined;
    for (const input of inputs) {
        if (!isSchema(input) || input.schemaVersion === undefined) continue;
        max = max === undefined ? input.schemaVersion : Math.max(max, input.schemaVersion);
    }
    return max;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Input for composing behaviors into an application.
 */
export interface ComposeBehaviorsInput {
    /** Application name */
    appName: string;
    /** Orbital definitions (or schemas) to compose */
    orbitals: (OrbitalDefinition | OrbitalSchema)[];
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
        orbitals: rawInputs,
        layoutStrategy: strategyInput,
        eventWiring,
    } = input;

    // Unwrap any OrbitalSchema inputs to OrbitalDefinition[]
    const rawOrbitals = asDefinitions(rawInputs);

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

    // Step 5: Union identity information from the schema-shaped inputs.
    const ledger = mergeLedgers(rawInputs);
    const schemaVersion = mergeSchemaVersions(rawInputs);

    // Step 6: Build the schema. Identity keys are added only when present so
    // ledger-less inputs compose byte-identically to the pre-V4 output.
    const schema: OrbitalSchema = {
        name: appName,
        version: '1.0.0',
        orbitals: orbitalsWithPages,
        ...(schemaVersion !== undefined ? { schemaVersion } : {}),
        ...(ledger !== undefined ? { ledger } : {}),
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
