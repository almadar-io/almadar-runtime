/**
 * Two-hop `@config.<knob>` emit-name override — JS-vs-Rust corpus parity
 * (C1-J4, item A).
 *
 * `resolveTraitEntry`'s `"stateMachine" in entry` branch (called from
 * `resolveTraitRefString`'s imported branch, resolving the trait a `ref`
 * points AT) used to call `resolveConfigRefEmitNames(entry as Trait)` with
 * NO call-site config. For a reference like `std-approval-gate`'s
 * `CloseButton = Button.traits.ButtonRender { config: { action: CLOSE } }`,
 * this resolved `ButtonRender`'s own `emits { @config.action }` against its
 * bare declared default (`"ACTION"`, `packages/almadar-std/behaviors/
 * registry/ui/core/atoms/ui-button.orb`) BEFORE `CloseButton`'s own
 * `action: CLOSE` override ever reached it — and because
 * `resolveConfigRefEmitNames` rewrites the `@config.<knob>` marker to a
 * concrete literal in place, the marker was gone by the time the caller
 * (`resolveTraitRefString`, which DOES have the real override) ran the same
 * resolution a second time: `hasRef` was false, so the second call silently
 * no-op'd and the wrong name (`"ACTION"`) stuck. Verified via Rust ground
 * truth (`orbital resolve`) on `std-cicd-pipeline.orb`: `CloseButton.emits[0]
 * .event` = `stateMachine.events[1].key` = `"CLOSE"`.
 *
 * Fix: `resolveTraitEntry` now threads an optional `callSiteConfig` through
 * to its own `resolveConfigRefEmitNames` call; `resolveTraitRefString`'s
 * imported branch passes its `resolvedConfig` at the one call site that
 * recurses into a further ref (`pullSiblingTraits`' direct call, which folds
 * no config of its own, is unchanged). One resolution point per trait, no
 * second fold.
 *
 * This gate diffs the JS `preprocessSchema` output against the Rust
 * `orbital resolve` output for the atom itself plus every real registry
 * organism that composes `std-approval-gate` (`grep -rl 'std-approval-gate'
 * packages/*\/behaviors/lolo --include='*.lolo'`, 2026-09-06): the
 * COMPOSING trait's own `emits[].event`/`stateMachine.events[].key` set
 * (unaffected by the bug — `CLOSE` there is a plain literal event key
 * inside `ApprovalGateReview`'s own body, not a `@config.<knob>` ref — kept
 * as a sanity check that nothing else drifted) plus the pulled `CloseButton`
 * sibling's own set, the exact case the bug reproduces on. NOT the whole
 * `ApprovalGateReview` sibling family: Rust materializes only the
 * LISTENS-addressed sibling (`CloseButton`) as its own trait entry per
 * orbital — a pure render-only sibling (`LoadingSpinner`, `ErrorAlert`, …)
 * is inlined directly into the render-ui body instead, a representational
 * difference from JS's "every embedded sibling gets its own trait object"
 * unrelated to `@config.<knob>` emit names (verified on `std-cms.orb`:
 * Rust's `ArticleOrbital` carries only `ArticleApprovalReview` +
 * `CloseButton` from this family, confirmed via `orbital resolve`).
 * Skips (not fails) when the dev binary isn't on this machine.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { Orbital, OrbitalSchema, Trait } from '@almadar/core';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ORBITAL_BIN = join(homedir(), 'bin', 'orbital');
const CLI_ENV = { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT };

interface GateCase {
  readonly label: string;
  readonly file: string;
  readonly basePath: string;
  /** The trait that composes `ApprovalGateReview` in this file (bare `ApprovalGateReview` for the atom itself). */
  readonly composingTrait: string;
}

const GATE_CASES: readonly GateCase[] = [
  {
    label: 'std-approval-gate (the atom itself)',
    file: join(REPO_ROOT, 'packages/almadar-std/behaviors/registry/infra/atoms/std-approval-gate.orb'),
    basePath: join(REPO_ROOT, 'packages/almadar-std'),
    composingTrait: 'ApprovalGateReview',
  },
  {
    label: 'std-purchase-order (POApproval composes ApprovalGateReview)',
    file: join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/atoms/std-purchase-order.orb'),
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    composingTrait: 'POApproval',
  },
  {
    label: 'std-cms (ArticleApprovalReview composes ApprovalGateReview)',
    file: join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/organisms/std-cms.orb'),
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    composingTrait: 'ArticleApprovalReview',
  },
  {
    label: 'std-cicd-pipeline (DeploymentApproval composes ApprovalGateReview)',
    file: join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/organisms/std-cicd-pipeline.orb'),
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    composingTrait: 'DeploymentApproval',
  },
  {
    label: 'std-wiki (WikiPublishApproval composes ApprovalGateReview)',
    file: join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/organisms/std-wiki.orb'),
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    composingTrait: 'WikiPublishApproval',
  },
];

const canRun = existsSync(ORBITAL_BIN) && GATE_CASES.every((c) => existsSync(c.file));

/** `preprocessSchema` (UsesIntegration.ts) wraps a resolved trait carrying
 * `config`/`linkedEntity` into `{ref, config, linkedEntity, _resolved:
 * Trait}` rather than the bare inline shape — unwrap it. */
function asTrait(t: unknown): Trait | undefined {
  if (typeof t !== 'object' || t === null) return undefined;
  if ('stateMachine' in t) return t as Trait;
  if ('_resolved' in t && (t as { _resolved?: unknown })._resolved) return (t as { _resolved: Trait })._resolved;
  return undefined;
}

interface EmitNameProjection {
  readonly emits: readonly string[];
  readonly events: readonly string[];
}

/**
 * `<orbital name>::<trait name>` -> sorted `emits[].event` /
 * `stateMachine.events[].key`. Keyed per-orbital, not flattened across the
 * whole file — a generic sibling name (`DataGrid1`) recurs across
 * INDEPENDENT orbitals in one registry file (a real organism composes
 * several unrelated browse-lists), and a flat by-name map would collide
 * those and report a spurious diff unrelated to this gate's `CloseButton`
 * concern.
 */
function projectEmitNames(orbitals: readonly Orbital[]): Map<string, EmitNameProjection> {
  const out = new Map<string, EmitNameProjection>();
  for (const orbital of orbitals) {
    for (const raw of orbital.traits) {
      const trait = asTrait(raw);
      if (!trait) continue;
      out.set(`${orbital.name}::${trait.name}`, {
        emits: (trait.emits ?? []).map((e) => e.event).sort(),
        events: (trait.stateMachine?.events ?? []).map((e) => e.key).sort(),
      });
    }
  }
  return out;
}

describe.skipIf(!canRun)(
  'ReferenceResolver — two-hop @config.<knob> emit-name override, JS-vs-Rust corpus parity (C1-J4, item A)',
  () => {
    for (const { label, file, basePath, composingTrait } of GATE_CASES) {
      it(`${label} — CloseButton and ${composingTrait}'s emit/event-key sets match Rust "orbital resolve"`, async () => {
        const jsSchema = JSON.parse(readFileSync(file, 'utf-8')) as OrbitalSchema;
        const rustSchema = JSON.parse(
          execFileSync(ORBITAL_BIN, ['resolve', file], { env: CLI_ENV, maxBuffer: 64 * 1024 * 1024 }).toString(),
        ) as { orbitals: Orbital[] };

        const result = await preprocessSchema(jsSchema, {
          basePath,
          stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
          allowOutsideBasePath: true,
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const jsProjection = projectEmitNames(result.data.schema.orbitals);
        const rustProjection = projectEmitNames(rustSchema.orbitals);

        const closeButtonKey = [...jsProjection.keys()].find((k) => k.endsWith('::CloseButton'));
        const rustCloseButtonKey = [...rustProjection.keys()].find((k) => k.endsWith('::CloseButton'));
        expect(closeButtonKey).toBeDefined();
        expect(rustCloseButtonKey).toBeDefined();
        expect(jsProjection.get(closeButtonKey!)).toEqual(rustProjection.get(rustCloseButtonKey!));
        // The two-hop bug's exact reported value: CloseButton's bare-default
        // collapse ("ACTION", ui-button.orb's own declared default) instead
        // of its own `action: CLOSE` override.
        expect(jsProjection.get(closeButtonKey!)?.emits).toEqual(['CLOSE']);

        const composingKey = [...jsProjection.keys()].find((k) => k.endsWith(`::${composingTrait}`));
        const rustComposingKey = [...rustProjection.keys()].find((k) => k.endsWith(`::${composingTrait}`));
        expect(composingKey).toBeDefined();
        expect(rustComposingKey).toBeDefined();
        expect(jsProjection.get(composingKey!)).toEqual(rustProjection.get(rustComposingKey!));
      });
    }
  },
);
