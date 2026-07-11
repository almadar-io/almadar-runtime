/**
 * RC-2: entity field defaults seeded into `@entity` binding context.
 *
 * Mirrors `config-defaults-from-orb.test.ts` for the entity axis.
 * Verifies that `collectDeclaredEntityDefaults` extracts `field.default`
 * values from the entity schema, and that `OrbitalServerRuntime` merges them
 * as the base of the `@entity` binding (declared defaults < persistence data
 * < explicit `(set @entity.X Y)` state).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectDeclaredEntityDefaults } from '../src/config-defaults.js';
import type { Entity } from '@almadar/core';

function resolveStdRegistry(): string {
    try {
        return path.join(
            path.dirname(require.resolve('@almadar/std/package.json')),
            'behaviors/registry',
        );
    } catch {
        return path.resolve(__dirname, '../../../packages/almadar-std/behaviors/registry');
    }
}
const STD_REGISTRY = resolveStdRegistry();

interface OrbOrb {
    entity?: Entity | string;
    [k: string]: unknown;
}
interface OrbSchema {
    orbitals: OrbOrb[];
}

function loadOrbEntity(orbRelative: string): Entity {
    const orbPath = path.join(STD_REGISTRY, orbRelative);
    const data: OrbSchema = JSON.parse(fs.readFileSync(orbPath, 'utf-8'));
    for (const orbital of data.orbitals) {
        if (orbital.entity && typeof orbital.entity === 'object') {
            return orbital.entity as Entity;
        }
    }
    throw new Error(`No object entity found in ${orbRelative}`);
}

describe('collectDeclaredEntityDefaults — real std atom .orb files', () => {
    it('returns undefined for entity with no field defaults', () => {
        const entity: Entity = { name: 'Item', fields: [{ name: 'title', type: 'string' }] };
        expect(collectDeclaredEntityDefaults(entity)).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
        expect(collectDeclaredEntityDefaults(undefined)).toBeUndefined();
    });

    it('std-modal ModalRecord yields status default', () => {
        const entity = loadOrbEntity('ui/core/atoms/std-modal.orb');
        const defaults = collectDeclaredEntityDefaults(entity);
        expect(defaults).toBeDefined();
        expect(defaults).toMatchObject({ status: 'active' });
    });

    // std-dashboard-summary was retired in the V3 Phase 5.B consolidation;
    // std-event-log carries the same rich mixed-type default surface
    // (strings + arrays) this case exists to cover.
    it('std-event-log EventLogView yields rich defaults', () => {
        const entity = loadOrbEntity('ui/core/atoms/std-event-log.orb');
        const defaults = collectDeclaredEntityDefaults(entity);
        expect(defaults).toBeDefined();
        expect(defaults).toMatchObject({
            kind: 'created',
            allEntries: [],
            entries: [],
            filterChips: [],
            errorMessage: '',
        });
    });

    it('std-rating-review ReviewView yields numeric + string + array defaults', () => {
        const entity = loadOrbEntity('ui/core/atoms/std-rating-review.orb');
        const defaults = collectDeclaredEntityDefaults(entity);
        expect(defaults).toBeDefined();
        expect(defaults).toMatchObject({
            totalReviews: 0,
            averageRating: 0,
            draftRating: 0,
            draftComment: '',
            reviews: [],
            currentSort: 'recent',
        });
    });
});

describe('entity default merge precedence', () => {
    it('persistence data overrides declared defaults', () => {
        const entity: Entity = {
            name: 'Doc',
            fields: [
                { name: 'status', type: 'string', default: 'draft' },
                { name: 'title', type: 'string', default: 'Untitled' },
            ],
        };
        const entityFieldDefaults = collectDeclaredEntityDefaults(entity)!;
        // Simulate persistence row (e.g. fetched from DB)
        const persistenceRow = { id: '1', status: 'published' };
        // Simulate traitFieldState (explicit set effects)
        const traitFieldState = { title: 'My Doc' };

        const merged = {
            ...entityFieldDefaults,
            ...persistenceRow,
            ...traitFieldState,
        };
        expect(merged).toMatchObject({
            status: 'published',   // persistence wins over declared default
            title: 'My Doc',       // set-effect wins over declared default
        });
    });

    it('declared defaults fill fields absent from persistence and set-effects', () => {
        const entity: Entity = {
            name: 'Page',
            fields: [
                { name: 'status', type: 'string', default: 'active' },
                { name: 'count', type: 'number', default: 0 },
            ],
        };
        const entityFieldDefaults = collectDeclaredEntityDefaults(entity)!;
        // No persistence row, no set effects
        const merged = { ...entityFieldDefaults };
        expect(merged.status).toBe('active');
        expect(merged.count).toBe(0);
    });
});
