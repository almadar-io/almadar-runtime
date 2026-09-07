/**
 * Call-site `typeArgs` (`::`) corpus parity (C1-J3, item A).
 *
 * C1-J1 ported Rust's `resolve_type_param_sentinels` but never wired a trait
 * REFERENCE's own call-site `typeArgs` (`TraitReference.typeArgs`, the `::`
 * form) into the substitution map it builds — only the no-arg Entity-kind
 * default. `sentinel-resolution.ts::resolveTraitTypeParamSentinels` and
 * `reference-resolver.ts::resolveTraitRefString`/`resolveTraitEntry` now
 * thread it through (twin of Rust's `trait_def.type_args`).
 *
 * This gate diffs the JS `preprocessSchema` output against the Rust `orbital
 * resolve` output for every real registry trait that authors a call-site
 * `typeArgs` override (`grep -rl '"typeArgs"' packages/*\/behaviors/registry`),
 * projecting that ONE trait's `emits[].payloadSchema[]` /
 * `stateMachine.events[].payloadSchema[]` to `{name, type, entity,
 * properties: <nested field names>}` — 0 differences expected on all four.
 * Scoped to the typeArgs-bearing trait itself (not its whole composed
 * orbital): its sibling-pulled children go through a SEPARATE, pre-existing
 * bug found while building this gate (`resolveTraitEntry`'s `"stateMachine"
 * in entry` branch resolves a declaring atom's OWN bare `emits {
 * @config.<knob> }` name before any caller's override config can reach it —
 * reproduces with zero `typeArgs` involved, ledgered as an out-of-scope
 * finding rather than fixed here). Skips (not fails) when the dev binaries
 * aren't on this machine, same convention as
 * `reference-resolver-pf-orbital-import-parity.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { EventPayloadField, Orbital, OrbitalSchema, Trait } from '@almadar/core';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ORBITAL_BIN = join(homedir(), 'bin', 'orbital');
const BEHAVIORS_REGISTRY = join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry');
const CLI_ENV = { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT };

/** Every registry trait authoring a call-site `typeArgs` override, verified
 * via `grep -rl '"typeArgs"' packages/*\/behaviors/registry` (2026-09-06). */
const GATE_CASES = [
  { file: 'app/atoms/std-purchase-order.orb', trait: 'POApproval' },
  { file: 'app/organisms/std-wiki.orb', trait: 'WikiPublishApproval' },
  { file: 'app/organisms/std-cms.orb', trait: 'ArticleApprovalReview' },
  { file: 'app/organisms/std-cicd-pipeline.orb', trait: 'DeploymentApproval' },
] as const;

const canRun = existsSync(ORBITAL_BIN) && GATE_CASES.every((c) => existsSync(join(BEHAVIORS_REGISTRY, c.file)));

/** `preprocessSchema` (UsesIntegration.ts) wraps any resolved trait that
 * carries `config`/`linkedEntity` into `{ref, config, linkedEntity,
 * _resolved: Trait}` rather than the bare inline shape — unwrap it so a
 * trait like `POApproval` (which declares its own call-site `config {}`)
 * is still found. */
function asTrait(t: unknown): Trait | undefined {
  if (typeof t !== 'object' || t === null) return undefined;
  if ('stateMachine' in t) return t as Trait;
  if ('_resolved' in t && (t as { _resolved?: unknown })._resolved) return (t as { _resolved: Trait })._resolved;
  return undefined;
}

interface PayloadProjection {
  readonly name: string;
  readonly type: string;
  readonly entity?: string;
  readonly properties?: readonly string[];
}

function projectFields(fields: readonly EventPayloadField[] | undefined): PayloadProjection[] {
  if (!fields) return [];
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.entity !== undefined ? { entity: f.entity } : {}),
    ...(f.properties ? { properties: f.properties.map((p) => p.name) } : {}),
  }));
}

/** `emit:<event>` / `event:<key>` -> projected payload, for ONE named trait
 * found anywhere across `orbitals`. */
function projectTrait(orbitals: readonly Orbital[], traitName: string): Map<string, PayloadProjection[]> {
  const out = new Map<string, PayloadProjection[]>();
  for (const orbital of orbitals) {
    const trait = orbital.traits.map(asTrait).find((t): t is Trait => t !== undefined && t.name === traitName);
    if (!trait) continue;
    for (const emit of trait.emits ?? []) {
      out.set(`emit:${emit.event}`, projectFields(emit.payloadSchema));
    }
    for (const ev of trait.stateMachine?.events ?? []) {
      out.set(`event:${ev.key}`, projectFields(ev.payloadSchema));
    }
    return out;
  }
  return out;
}

describe.skipIf(!canRun)('sentinel-resolution — call-site typeArgs corpus parity (C1-J3, item A)', () => {
  for (const { file, trait: traitName } of GATE_CASES) {
    it(`"${file}"'s "${traitName}" — JS preprocessSchema payload markers match Rust orbital resolve`, async () => {
      const orbPath = join(BEHAVIORS_REGISTRY, file);
      const jsSchema = JSON.parse(readFileSync(orbPath, 'utf-8')) as OrbitalSchema;
      const rustSchema = JSON.parse(
        execFileSync(ORBITAL_BIN, ['resolve', orbPath], { env: CLI_ENV, maxBuffer: 64 * 1024 * 1024 }).toString(),
      ) as { orbitals: Orbital[] };

      const result = await preprocessSchema(jsSchema, {
        basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
        stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
        allowOutsideBasePath: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const jsProjection = projectTrait(result.data.schema.orbitals, traitName);
      const rustProjection = projectTrait(rustSchema.orbitals, traitName);
      expect(jsProjection.size).toBeGreaterThan(0);
      expect(rustProjection.size).toBeGreaterThan(0);

      const jsKeys = new Set(jsProjection.keys());
      const rustKeys = new Set(rustProjection.keys());
      expect([...jsKeys].filter((k) => !rustKeys.has(k)).sort()).toEqual([]);
      expect([...rustKeys].filter((k) => !jsKeys.has(k)).sort()).toEqual([]);

      const mismatches: string[] = [];
      for (const key of jsKeys) {
        const js = jsProjection.get(key);
        const rust = rustProjection.get(key);
        if (JSON.stringify(js) !== JSON.stringify(rust)) {
          mismatches.push(`${key}\n  js:   ${JSON.stringify(js)}\n  rust: ${JSON.stringify(rust)}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
