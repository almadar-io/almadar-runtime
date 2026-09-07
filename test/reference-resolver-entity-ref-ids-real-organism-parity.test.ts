/**
 * C1-J5 gate: real-organism JS-vs-Rust `entityRefIds` parity.
 *
 * `applyLinkedEntityRename`'s call sites now thread `ReferenceResolver.
 * entityIdsInScope` (schema-wide, grown by `noteResolvedEntityIds` as each
 * of a schema's OWN orbitals resolves — the JS twin of the compiled path's
 * `consumer_entity_ids`) so a call-site `-> Entity` rebind can REFRESH the
 * trait's `entityRefIds` side-map instead of merely dropping it. This is
 * the standing regression gate for that fix: for every trait in every
 * orbital of five real organisms, the JS-resolved `entityRefIds` map must
 * equal Rust's (same keys AND same ids) — `std-api-gateway` is the exact
 * corpus case (`RouteOrbital`'s no-rebind `Audit.traits.AuditCaptureListener`
 * pull establishes `AuditEntry`'s id; `GatewayUserOrbital`, resolved LATER
 * in the same file, rebinds `Browse.traits.BrowseItemBrowse -> AuditEntry`
 * and must recover it) — the other four are C1-R3's own
 * `ORB_ID_UNKNOWN_REF` corpus (`std-fitness-studio`, `std-healthcare`,
 * `std-property-mgmt`, `std-wiki`).
 *
 * Compares against the ALREADY-EMITTED registry `.orb` (not a fresh
 * `orb emit orb` from `.lolo` — the gate names the registry file directly)
 * resolved by the real `~/bin/orbital resolve` binary. Skips (not fails)
 * when the dev binaries aren't on this machine, matching this package's
 * other real-organism parity suites
 * (`reference-resolver-pf-orbital-import-parity.test.ts`).
 *
 * Reads the JS side through {@link resolveSchema} (`ResolvedOrbital[]`,
 * `ResolvedTrait.trait` always inline) rather than `UsesIntegration.
 * preprocessSchema` — the latter deliberately WRAPS a trait whose
 * `ResolvedTrait` carries a call-site `linkedEntity`/`config` override back
 * into a `{ref, _resolved}` placeholder for runtime re-registration, which
 * would make this comparison's own `isTrait` filter (state-machine-gated)
 * silently drop every ordinarily-composed rebound trait — exactly the
 * traits this gate exists to check.
 *
 * The `@almadar/core` id-stripping gap this file used to record as BLOCKED
 * is fixed (`OrbitalEntitySchema` now declares `id: EntityIdSchema.optional()`
 * — C1-J5's ledger). C1-J6 closed the residual C1-J5 found once that
 * landed: two classes of `entityRefIds` divergence, both id-based, ported
 * from `orbital-compiler/src/phases/inline/rewrite.rs` into
 * `applyLinkedEntityRename`/`resolveTraits`' flow —
 *   (A) `consumer_known_entity_rebind_subs` (id-based secondary-reference
 *       recovery, unconditional) + `stale_entity_rebind_subs` (rebind-only,
 *       by the trait's OWN pre-rebind bound-entity id) + the
 *       `alias_entity_renames` pre-pass (a rebind established by one
 *       explicit `Alias.traits.X -> Y` pull propagates to every OTHER pull
 *       from the SAME alias in the same orbital) — plus two ordering fixes
 *       `entityIdsInScope` needed to see these ids at all:
 *       `ReferenceResolver.seedSchemaEntityIds` seeds EVERY orbital's own
 *       primary (+ declared aux) up front, matching Rust's `consumer_
 *       entity_ids` initial whole-schema build instead of JS's previous
 *       resolved-so-far-only growth; and the Gap #22 aux-entity scan now
 *       runs BEFORE `resolveTraits` (was after), matching Rust's own
 *       ordering, guarded so a same-named orbital primary always wins over
 *       a coincidentally-same-named atom placeholder (Rust's `seen_aux_
 *       names` pre-seeded with the primary).
 *   (B) `ReferenceResolver.uniquifyCrossOrbitalPulledSiblings`, a NEW
 *       schema-wide pass run once by {@link resolveSchema} after every
 *       orbital resolves — JS twin of `uniquify_cross_orbital_pulled_
 *       siblings`: a sibling-pulled trait name that ALSO appears (pulled or
 *       explicit) in a DIFFERENT orbital gets prefixed with its OWNING
 *       orbital's name (`ContributorOrbitalDataGrid1`), where JS previously
 *       left it bare.
 *
 * `std-property-mgmt` and `std-wiki` reach full parity from (A)+(B) alone.
 * `std-api-gateway`, `std-fitness-studio`, `std-healthcare` had ONE residual
 * left, entirely OUTSIDE (A)/(B): WITHIN one orbital, when TWO OR MORE
 * distinct top-level owners pull the SAME atom (e.g. `std-api-gateway`'s
 * `GatewayUserOrbital` — `AuditBrowseList`, declared trait index 7, and
 * `GatewayUserBrowseList`, index 4, both pull `DataGrid1`/`DenseTableView`/
 * `MasterListView`), Rust's `worklist.pop()` (`orbital-compiler/src/phases/
 * inline/trait.rs:2026`, depth-first LIFO, draining the SAME `Vec` both
 * top-level seeds and nested recursive pulls push onto) decides
 * `AuditBrowseList` first. JS's `pullSiblingTraits` used to drain its
 * equivalent worklist FIFO (`work.shift()`) — a naive swap to `work.pop()`
 * fixed these three organisms but regressed the already-verified PF corpus
 * case (`reference-resolver-pf-orbital-import-parity.test.ts`'s
 * `ApprovalRequestOrbital` assertion).
 *
 * C1-J7 (2026-09-06) traced the root cause: it isn't drain order alone,
 * it's WHEN each collision's peers become visible. `AuditBrowseList`/
 * `GatewayUserBrowseList` collide as genuine top-level PEERS visible to a
 * SINGLE `pullSiblingTraits` call (`GatewayUserOrbital`'s own `traits[]`).
 * PF's `InlineBrowseItemBrowse6`/`…10` are NOT peers of anything PF
 * declares — they are std-approval-request's OWN internal composed chrome,
 * reached only via `ApprovalRequestPipeline`'s `@trait.…` embed tokens; Rust
 * resolves every `uses` import's OWN orbitals to completion BEFORE the
 * consumer ever sees them (`inline_orbital` recurses per alias ahead of
 * `ctx.add_alias_multi`, `inline/mod.rs:1000-1013`), so `Browse6`/`Browse10`
 * already collided as top-level peers one `uses`-boundary IN, before PF's
 * own sibling-pull ever ran. JS's `pullSiblingTraits` ran ONCE, lazily, on
 * the FINAL composed orbital — `resolveImports` loaded each `uses` alias's
 * orbitals in RAW/unresolved `ref:` form and never recursively pre-resolved
 * them, so `Browse6`/`Browse10` arrived one level flatter than Rust ever
 * saw them, sharing ONE JS-visible owner instead of becoming their own
 * peer-level collision.
 *
 * C1-J8 (2026-09-06) ported the missing piece: {@link ReferenceResolver.
 * preResolveImportFile} (`src/resolver/reference-resolver.ts`) resolves
 * every `uses` alias's OWN file to completion — recursively, on a fresh
 * child resolver, cached per absolute source path — BEFORE `resolveImports`
 * hands the alias to any consumer, mirroring `inline_orbital`'s per-`uses`
 * recursion. `pullSiblingTraits`' sibling search now tries that pre-resolved
 * orbital first (pinned to the SAME orbital index a raw top-level match
 * establishes — never a blind cross-orbital name search, which would grab a
 * coincidentally-same-numbered PULLED trait from an unrelated atom
 * elsewhere in a multi-orbital file); `PullItem.preResolvedScope` carries
 * that pinned orbital into recursion so a transitively-nested,
 * atom-internal sibling (never a raw top-level entry) is still found. With
 * every alias pre-resolved, `.shift()` → `.pop()` (LIFO) is correct at
 * every level — no further FIFO/LIFO asymmetry between this file's three
 * organisms and PF.
 *
 * One more piece surfaced only by `std-fitness-studio`'s deeper case
 * (`MembershipDirectory`'s `InlineTypographyRender21 → 17/20 → 15/16/18/19`
 * chain, all seven pre-resolved, none of it a raw-ref hop): Rust's ACTUAL
 * disambiguated names for every one of those seven are flat, single-level
 * `MembershipDirectory<Name>` — never a cascade through a renamed
 * intermediate. `pullSiblingTraits`' recursion push now keeps a descendant's
 * `parent` CONSTANT (the current item's own `parent`, not `finalName`)
 * whenever the child will itself search within a pre-resolved scope —
 * effectively the name of whichever trait first crossed from this
 * orbital's own scope into the alias's pre-resolved one, held constant for
 * every descendant reached transitively within it — while a fully
 * raw-walked (non-pre-resolved) hop keeps the pre-existing `finalName`
 * cascade unchanged (verified against `reference-resolver-pf-orbital-
 * import-parity.test.ts`, unaffected since PF's own one-hop case never
 * exercises this branch: `DataGrid1`'s own disambiguation already happened
 * INSIDE std-approval-request's pre-resolution, one `uses`-boundary
 * earlier, so the sibling name PF's consumer-level pull discovers is
 * already final).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveSchema } from '../src/resolver/reference-resolver.js';
import type { OrbitalSchema, Orbital, Trait } from '@almadar/core';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BEHAVIORS_ROOT = join(REPO_ROOT, 'packages/almadar-behaviors');
const REGISTRY_ORGANISMS = join(BEHAVIORS_ROOT, 'behaviors/registry/app/organisms');
const ORB_BIN = join(homedir(), 'bin', 'orb');
const ORBITAL_BIN = join(homedir(), 'bin', 'orbital');

const ORGANISMS = [
  'std-api-gateway',
  'std-fitness-studio',
  'std-healthcare',
  'std-property-mgmt',
  'std-wiki',
] as const;

const registryPaths = ORGANISMS.map((name) => join(REGISTRY_ORGANISMS, `${name}.orb`));
const canRun = existsSync(ORB_BIN) && existsSync(ORBITAL_BIN) && registryPaths.every((p) => existsSync(p));

const CLI_ENV = { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT };

function isTrait(t: unknown): t is Trait {
  return typeof t === 'object' && t !== null && 'stateMachine' in t;
}

// Regenerate the Rust reference + read the registry input for all five
// organisms UP FRONT, entirely synchronously — a nested `describe()` call
// defers its own callback to run AFTER the enclosing describe's body (incl.
// any `finally`) finishes, so building per-organism fixtures inside a
// per-organism `describe()` (rather than flat, right here) raced the temp
// dir's cleanup out from under the still-pending `execFileSync` calls.
type Fixture = { readonly name: string; readonly jsInputSchema: OrbitalSchema; readonly rustSchema: { orbitals: Orbital[] } };

function buildFixtures(): readonly Fixture[] {
  const dir = mkdtempSync(join(tmpdir(), 'entity-ref-ids-parity-'));
  try {
    return ORGANISMS.map((name) => {
      const orbPath = join(REGISTRY_ORGANISMS, `${name}.orb`);
      const resolvedPath = join(dir, `${name}.resolved.orb`);
      execFileSync(ORBITAL_BIN, ['resolve', orbPath, '-o', resolvedPath], {
        env: CLI_ENV,
        maxBuffer: 64 * 1024 * 1024,
      });
      return {
        name,
        jsInputSchema: JSON.parse(readFileSync(orbPath, 'utf-8')) as OrbitalSchema,
        rustSchema: JSON.parse(readFileSync(resolvedPath, 'utf-8')) as { orbitals: Orbital[] },
      };
    });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

describe.skipIf(!canRun)('ReferenceResolver — real-organism JS-vs-Rust entityRefIds parity (C1-J5)', () => {
  const fixtures = canRun ? buildFixtures() : [];

  // GREEN today: proves the fix's own mechanism (schema-wide sequential
  // visibility renaming an `entityRefIds` KEY to the rebind target) works
  // on the real corpus, independent of the `@almadar/core` id-stripping
  // blocker documented above (which only corrupts the VALUE half, and only
  // for externally-loaded entities). `GatewayUserOrbital`, resolved AFTER
  // `RouteOrbital` in the same schema, rebinds `Browse.traits.
  // BrowseItemBrowse -> AuditEntry` — before this fix, `entityRefIds` had
  // no id map at its call site at all, so `dropStaleEntityRefIdsAfterRebind`
  // just deleted the stale `BrowseItem` key outright (no rename); this
  // asserts the key is now correctly renamed to the rebind target.
  it('std-api-gateway: GatewayUserOrbital.AuditBrowseList entityRefIds is keyed by the rebind target, not the atom\'s own bound entity', async () => {
    const fixture = fixtures.find((f) => f.name === 'std-api-gateway');
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const result = await resolveSchema(fixture.jsInputSchema, {
      basePath: BEHAVIORS_ROOT,
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const gatewayUser = result.data.find((o) => o.name === 'GatewayUserOrbital');
    const auditBrowseList = gatewayUser?.traits.find((rt) => rt.trait.name === 'AuditBrowseList');
    expect(auditBrowseList).toBeDefined();
    const keys = Object.keys(auditBrowseList?.trait.entityRefIds ?? {});
    expect(keys).toEqual(['AuditEntry']);
  });

  // C1-J8: the within-orbital sibling-pull collision-winner-order residual
  // documented above (Rust's `worklist.pop()` vs JS's `work.shift()`, plus
  // the missing per-alias pre-resolution) is fixed — all five organisms now
  // reach full JS-vs-Rust `entityRefIds` parity.
  for (const { name, jsInputSchema, rustSchema } of fixtures) {
    it(`${name}: every trait in every orbital carries the SAME entityRefIds map (keys AND ids) as Rust`, async () => {
      const result = await resolveSchema(jsInputSchema, {
        basePath: BEHAVIORS_ROOT,
        stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
        allowOutsideBasePath: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const mismatches: string[] = [];
      for (const rustOrbital of rustSchema.orbitals) {
        const jsOrbital = result.data.find((o) => o.name === rustOrbital.name);
        if (!jsOrbital) {
          mismatches.push(`orbital "${rustOrbital.name}": missing on the JS side`);
          continue;
        }
        const jsTraitsByName = new Map(
          jsOrbital.traits.map((rt) => [rt.trait.name, rt.trait] as const),
        );
        for (const rustTrait of rustOrbital.traits.filter(isTrait)) {
          const jsTrait = jsTraitsByName.get(rustTrait.name);
          const label = `${rustOrbital.name}.${rustTrait.name}`;
          if (!jsTrait) {
            mismatches.push(`${label}: trait missing on the JS side`);
            continue;
          }
          const rustRefs = rustTrait.entityRefIds ?? {};
          const jsRefs = jsTrait.entityRefIds ?? {};
          const rustKeys = Object.keys(rustRefs).sort();
          const jsKeys = Object.keys(jsRefs).sort();
          if (JSON.stringify(rustKeys) !== JSON.stringify(jsKeys)) {
            mismatches.push(
              `${label}: entityRefIds keys differ — rust=${JSON.stringify(rustKeys)} js=${JSON.stringify(jsKeys)}`,
            );
            continue;
          }
          for (const key of rustKeys) {
            if (rustRefs[key] !== jsRefs[key]) {
              mismatches.push(
                `${label}: entityRefIds["${key}"] differs — rust=${rustRefs[key]} js=${jsRefs[key]}`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
