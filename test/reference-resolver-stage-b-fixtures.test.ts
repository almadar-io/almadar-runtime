import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { OrbitalSchema, OrbitalDefinition, Orbital, EventPayloadField, Trait } from '@almadar/core';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';

// Cross-path parity: for every named Stage B materialization case, B2-R
// (compiler) and B2-J (this resolver) must produce byte-identical
// materialized orbitals from the SAME input — the `derive_id.json` pattern
// (`docs/tender-booping-moler.md` W-B2 gate note), extended to Stage B's
// roles/entities/mounts/siblings surface. B2-R writes the fixtures
// concurrently with this file; each case is described in the Rust test
// `orbital-rust/crates/orbital-compiler/tests/orbital_import.rs`.
//
// Fixture shape (documented here since the directory does not exist yet —
// confirm/adjust against the actual B2-R output before un-skipping):
// one `<case>.json` per case, `{ "schema": <OrbitalSchema>, "expected":
// <materialized OrbitalDefinition, camelCase> }`. `schema` is resolved via
// `resolveOrbitalImports` (a `uses` entry's `from` is loaded from a SIBLING
// `<case>.upstream.json` file holding `{ orbital, orbitals, sourcePath }`
// when the schema needs an external load — see `loadUpstreamFor` below).

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../orbital-rust/crates/orbital-compiler/tests/fixtures/orbital_import_stage_b',
);

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Rust's canonical JSON never serializes `None` — an `undefined`-valued
 *  key on either side (JS's optional-field convention) is a non-diff, not
 *  a mismatch. Strip before comparing. */
function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[key] = stripUndefinedDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * `uses` is import-provenance JS keeps on every resolved orbital (Stage A);
 * the Rust fixture's `expected` is being asked to carry it too, but a
 * fixture written before that lands still omits it. Compare `uses` only
 * when BOTH sides carry it — drop it from whichever side has it otherwise,
 * so the comparison doesn't fail on provenance neither side is disputing.
 */
function alignUsesForParity(
  actual: OrbitalDefinition,
  expected: OrbitalDefinition,
): { actual: OrbitalDefinition; expected: OrbitalDefinition } {
  const hasActual = actual.uses !== undefined;
  const hasExpected = expected.uses !== undefined;
  if (hasActual === hasExpected) return { actual, expected };
  return {
    actual: hasActual ? { ...actual, uses: undefined } : actual,
    expected: hasExpected ? { ...expected, uses: undefined } : expected,
  };
}

type StageBFixture = {
  schema: OrbitalSchema;
  expected: OrbitalDefinition;
  /** Optional per-case upstream loads, keyed by the `uses[].from` path. */
  upstream?: Record<string, { orbital: Orbital; orbitals?: Orbital[] }>;
};

function loaderFor(fixture: StageBFixture): SchemaLoader {
  const upstream = fixture.upstream ?? {};
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      const entry = upstream[importPath];
      if (!entry) {
        return { success: false, error: `stage-b fixture has no upstream entry for "${importPath}"` };
      }
      return {
        success: true,
        data: {
          orbital: entry.orbital,
          orbitals: entry.orbitals ?? [entry.orbital],
          sourcePath: importPath,
          importPath,
        },
      };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

const fixturesDirExists = fs.existsSync(FIXTURES_DIR);
if (!fixturesDirExists) {
  console.warn(
    `[reference-resolver-stage-b-fixtures] SKIPPED: fixtures directory not found at ` +
      `${FIXTURES_DIR} — B2-R (orbital-rust) has not landed the Stage B fixture set yet. ` +
      `Re-run this suite once orbital-rust/crates/orbital-compiler/tests/fixtures/orbital_import_stage_b/*.json exists.`,
  );
}

// Fixtures with a bespoke `expected` shape (not a full `OrbitalDefinition`)
// get their OWN dedicated comparison below instead of the generic
// materialization-equality loop.
const BESPOKE_SHAPE_FIXTURES = new Set(['sentinel_payload.json']);

// Parity is defined for VALID programs only: a fixture whose upstream leaves an
// out-of-orbital relation unmapped is refused here at resolve while Rust defers
// the same finding to validate — the Rust writer must map it (`entities {}`).

describe.skipIf(!fixturesDirExists)('ReferenceResolver — Stage B cross-path fixture parity (B2-R ↔ B2-J)', () => {
  const caseFiles = fixturesDirExists
    ? fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json') && !BESPOKE_SHAPE_FIXTURES.has(f))
    : [];

  if (fixturesDirExists && caseFiles.length === 0) {
    it.fails('fixtures directory exists but is empty — nothing to compare', () => {
      throw new Error(`${FIXTURES_DIR} exists but has no *.json fixtures`);
    });
  }

  for (const file of caseFiles) {
    it(`materializes "${file}" identically to the compiled path`, async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')) as StageBFixture;
      const resolver = new ReferenceResolver({ basePath: '.', loader: loaderFor(fixture) });
      const result = await resolver.resolveOrbitalImports(fixture.schema);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const materialized = result.data.find((o) => o.name === fixture.expected.name) ?? result.data[0];
      const aligned = alignUsesForParity(materialized, fixture.expected);
      expect(sortKeysDeep(stripUndefinedDeep(aligned.actual))).toEqual(
        sortKeysDeep(stripUndefinedDeep(aligned.expected)),
      );
    });
  }
});

// `sentinel_payload.json` (C1-J1) carries a bespoke `expected` shape —
// just the resolved `emits`/`events` payload schemas, not a full
// `OrbitalDefinition` — since its whole point is the sentinel resolution
// pass, not orbital-import materialization.
function noopLoader(): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      return { success: false, error: `unexpected import path: ${importPath}` };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

const SENTINEL_FIXTURE = path.join(FIXTURES_DIR, 'sentinel_payload.json');
const sentinelFixtureExists = fixturesDirExists && fs.existsSync(SENTINEL_FIXTURE);

describe.skipIf(!sentinelFixtureExists)(
  'ReferenceResolver — sentinel resolution fixture parity (sentinel_payload.json, C1-J1)',
  () => {
    it('resolves @entity / $<TypeParam> payload sentinels identically to the compiled path', async () => {
      const fixture = JSON.parse(fs.readFileSync(SENTINEL_FIXTURE, 'utf8')) as {
        schema: OrbitalSchema;
        expected: { emits: EventPayloadField[]; events: EventPayloadField[] };
      };
      const resolver = new ReferenceResolver({ basePath: '.', loader: noopLoader() });
      const result = await resolver.resolveOrbitalImports(fixture.schema);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const orbital = result.data.find((o) => o.name === fixture.schema.orbitals[0].name);
      expect(orbital).toBeDefined();
      if (!orbital) return;
      const trait = orbital.traits[0] as Trait;
      expect(sortKeysDeep(stripUndefinedDeep(trait.emits?.[0]?.payloadSchema))).toEqual(
        sortKeysDeep(stripUndefinedDeep(fixture.expected.emits)),
      );
      expect(sortKeysDeep(stripUndefinedDeep(trait.stateMachine?.events?.[0]?.payloadSchema))).toEqual(
        sortKeysDeep(stripUndefinedDeep(fixture.expected.events)),
      );
    });
  },
);
