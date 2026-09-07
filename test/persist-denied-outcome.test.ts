/**
 * C1-V1: `OrbitalServerRuntime.EffectResult.denied` — a persist rejected
 * by an access policy, or that resolves no row key, must be stamped
 * `denied: true` so the verification trace can fail unconditionally
 * instead of falling back to a row-count heuristic.
 *
 * Mutates `trait-wars.orb`'s `Unit` entity in-memory before registering
 * (rather than authoring a new fixture) — DEPLOY_HERO's create effect on
 * `Unit` is already exercised by `gap-analysis.test.ts`'s "create echoes
 * the client-supplied id" contract; this file only adds an access policy
 * on top of that same effect to force the denial branches.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, 'fixtures/trait-wars.orb');

// `JSON.parse`'s inferred type (no annotation) mirrors gap-analysis.test.ts's
// `traitWarsSchema` — the fixture is untyped .orb JSON.
function loadSchema() {
    return JSON.parse(readFileSync(schemaPath, 'utf-8'));
}

const DEPLOY_PAYLOAD = {
    heroId: 'denied-hero-1',
    name: 'Denied Hero',
    characterType: 'hero',
    attack: 15,
    defense: 10,
    health: 100,
};

describe('OrbitalServerRuntime persist denial', () => {
    it('stamps denied:true when the declared @create policy rejects the write', async () => {
        const schema = loadSchema();
        const battleOrbital = schema.orbitals.find(
            (o: Record<string, unknown>) => o.name === 'TacticalBattle',
        );
        // Literal-false policy — denies every create regardless of bindings.
        battleOrbital.entity.create_policy = ['=', 'a', 'b'];

        const runtime = new OrbitalServerRuntime({ debug: false });
        await runtime.register(schema);
        await runtime.processOrbitalEvent('TacticalBattle', { event: 'INIT', payload: {} });

        const result = await runtime.processOrbitalEvent('TacticalBattle', {
            event: 'DEPLOY_HERO',
            payload: DEPLOY_PAYLOAD,
        });

        const persistEffect = result.effectResults?.find((e) => e.effect === 'persist');
        expect(persistEffect).toBeDefined();
        expect(persistEffect?.success).toBe(false);
        expect(persistEffect?.denied).toBe(true);
    });

    it('does not stamp denied:true when the write is genuinely accepted', async () => {
        const schema = loadSchema();
        const runtime = new OrbitalServerRuntime({ debug: false });
        await runtime.register(schema);
        await runtime.processOrbitalEvent('TacticalBattle', { event: 'INIT', payload: {} });

        const result = await runtime.processOrbitalEvent('TacticalBattle', {
            event: 'DEPLOY_HERO',
            payload: DEPLOY_PAYLOAD,
        });

        const persistEffect = result.effectResults?.find((e) => e.effect === 'persist');
        expect(persistEffect?.success).toBe(true);
        expect(persistEffect?.denied).toBeUndefined();
    });
});
