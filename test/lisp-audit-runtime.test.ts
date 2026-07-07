/**
 * LOLO Lisp audit — runtime-path smoke (Phase 0.B of
 * Almadar_Compiler_Runtime_Gaps_PLAN.md).
 *
 * The JS-interpreter twin of the Rust `orbital-lolo/tests/lisp_audit.rs` and the
 * `@almadar/evaluator` value-level parity test. Each audit fixture must load into
 * `OrbitalServerRuntime`, accept `INIT`, and resolve its guards/effects without
 * throwing — proving the runtime path carries the same S-expression surface the
 * compiled path does.
 *
 * Fixtures live in `test/fixtures/lisp-audit/<name>.orb` (emitted from the
 * matching `.lolo`). The orbital name is read from the schema itself so the test
 * cannot drift from the fixture.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures/lisp-audit');

interface AuditFixture {
    base: string;
    schema: OrbitalSchema;
    orbitalName: string;
}

function loadAuditFixtures(): AuditFixture[] {
    return readdirSync(fixturesDir)
        .filter((f) => f.endsWith('.orb'))
        .map((f) => {
            const base = f.replace(/\.orb$/, '');
            const schema = JSON.parse(
                readFileSync(join(fixturesDir, f), 'utf-8'),
            ) as OrbitalSchema;
            const orbitalName = schema.orbitals[0]?.name;
            if (!orbitalName) {
                throw new Error(`${f}: emitted schema has no orbital name`);
            }
            return { base, schema, orbitalName };
        })
        .sort((a, b) => a.base.localeCompare(b.base));
}

const fixtures = loadAuditFixtures();

describe('LOLO Lisp audit — runtime smoke (Phase 0.B)', () => {
    it('found the audit fixtures', () => {
        expect(fixtures.length).toBe(11);
    });

    for (const { base, schema, orbitalName } of fixtures) {
        describe(base, () => {
            it('registers the schema without throwing', async () => {
                const runtime = new OrbitalServerRuntime({ debug: false });
                await runtime.register(schema);
                expect(runtime.listOrbitals()).toContain(orbitalName);
            });

            it('handles INIT and resolves guards/effects', async () => {
                const runtime = new OrbitalServerRuntime({ debug: false });
                await runtime.register(schema);
                const result = await runtime.processOrbitalEvent(orbitalName, {
                    event: 'INIT',
                    payload: {},
                });
                expect(result.success).toBe(true);
            });
        });
    }
});
