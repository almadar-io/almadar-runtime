/**
 * Config defaults extracted from a real `.orb` file.
 *
 * Bridges the unit tests:
 *   - `config-binding-resolution.test.ts` (BindingResolver works)
 *   - `config-defaults-from-trait.test.ts` (extractor works on
 *     hand-built trait shapes)
 *
 * with the real-world shape: a trait loaded from a registry `.orb`.
 * If both unit layers pass but this fails, the gap is in how the
 * trait's `config` schema survives the .orb ↔ JS round-trip.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectDeclaredConfigDefaults } from '../src/OrbitalServerRuntime.js';

function resolveStdRegistry(): string {
    try {
        return path.join(
            path.dirname(require.resolve('@almadar/std/package.json')),
            'behaviors/registry',
        );
    } catch {
        // monorepo fallback
        return path.resolve(__dirname, '../../../packages/almadar-std/behaviors/registry');
    }
}
const STD_REGISTRY = resolveStdRegistry();

interface OrbTrait {
    name: string;
    config?: Record<string, { type: string; default?: unknown }>;
    [k: string]: unknown;
}
interface OrbSchema {
    orbitals: Array<{ traits: OrbTrait[] }>;
}

function loadAtomTrait(orbRelative: string, traitName: string): OrbTrait {
    const orbPath = path.join(STD_REGISTRY, orbRelative);
    const data: OrbSchema = JSON.parse(fs.readFileSync(orbPath, 'utf-8'));
    for (const orbital of data.orbitals) {
        for (const t of orbital.traits) {
            if (t.name === traitName) return t;
        }
    }
    throw new Error(`Trait ${traitName} not found in ${orbRelative}`);
}

describe('config defaults from real std atom .orb files', () => {
    it('std-modal ModalRecordModal exposes typed config defaults', () => {
        const trait = loadAtomTrait('ui/core/atoms/std-modal.orb', 'ModalRecordModal');
        const defaults = collectDeclaredConfigDefaults(
            trait as unknown as Parameters<typeof collectDeclaredConfigDefaults>[0],
        );
        expect(defaults).toBeDefined();
        // std-modal ships `fields : [string] = []`, `icon : string =
        // "layout-panel-top"`, `title : string = "Details"`, `mode :
        // string = "create"`. Pin every key so a future schema edit
        // that drops a default surfaces here, not at runtime as an
        // empty modal title.
        expect(defaults).toMatchObject({
            fields: [],
            icon: 'layout-panel-top',
            title: 'Details',
            mode: 'create',
        });
    });

    it('std-search SearchResultSearch exposes string config defaults', () => {
        const trait = loadAtomTrait('ui/core/atoms/std-search.orb', 'SearchResultSearch');
        const defaults = collectDeclaredConfigDefaults(
            trait as unknown as Parameters<typeof collectDeclaredConfigDefaults>[0],
        );
        expect(defaults).toBeDefined();
        expect(defaults).toMatchObject({
            placeholder: 'Search…',
            event: 'SEARCH',
        });
    });

    it('std-pagination PagedItemPagination exposes number + string config defaults', () => {
        const trait = loadAtomTrait(
            'ui/core/atoms/std-pagination.orb',
            'PagedItemPagination',
        );
        const defaults = collectDeclaredConfigDefaults(
            trait as unknown as Parameters<typeof collectDeclaredConfigDefaults>[0],
        );
        expect(defaults).toBeDefined();
        expect(defaults).toMatchObject({
            pageSize: 10,
            event: 'PAGE',
        });
    });
});
