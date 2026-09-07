/**
 * Real-organism JS-vs-Rust orbital-import parity (B4-J6).
 *
 * The Stage B parity gate (`reference-resolver-stage-b-fixtures.test.ts`)
 * only ever compared SYNTHETIC fixtures the compiled path wrote for itself
 * — it never exercised a real organism's own imported orbitals through both
 * paths (prevention verdict rung 3: the gate measured what a hand-built
 * fixture wanted, not what a real `.lolo` corpus produces). Project
 * Friday's two orbital-reference-form imports of `std-time-tracking`
 * (`TimesheetOrbital = TimeTracking.orbitals.TimesheetPanelOrbital`,
 * `ApprovalRequestOrbital = TimeTracking.orbitals.ApprovalRequestPanelOrbital`)
 * are the corpus case that surfaced everything this file's `foldCallSiteConfigOntoTrait`,
 * `resolveTraitEntry`'s `embedScope` propagation, and the sibling-pull
 * `consumerDeclaredProvenance` gate exist to fix — this test is the standing
 * regression gate for all three.
 *
 * Regenerates the Rust reference at test time (`orb emit orb` + `orbital
 * resolve`, both under `ALMADAR_DEV`) rather than embedding a frozen
 * snapshot — a stale snapshot would silently stop catching a JS regression
 * the moment the compiled side legitimately changes. Skips (not fails) when
 * the dev binaries aren't on this machine, same convention as
 * `composed-trait-listen-eventid-routing.test.ts`'s real-plugin suite.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { OrbitalSchema, Orbital, Trait } from '@almadar/core';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const PF_LOLO = join(
  REPO_ROOT,
  'packages/almadar-behaviors/behaviors/lolo/project-friday/organisms/project-friday.lolo',
);
const ORB_BIN = join(homedir(), 'bin', 'orb');
const ORBITAL_BIN = join(homedir(), 'bin', 'orbital');
const canRun = existsSync(ORB_BIN) && existsSync(ORBITAL_BIN) && existsSync(PF_LOLO);

const CLI_ENV = { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT };

function isTrait(t: unknown): t is Trait {
  return typeof t === 'object' && t !== null && 'stateMachine' in t;
}

describe.skipIf(!canRun)(
  'ReferenceResolver — real-organism JS-vs-Rust orbital-import parity (Project Friday, B4-J6)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-parity-'));
    const pfOrbPath = join(dir, 'pf.orb');
    const pfResolvedPath = join(dir, 'pf-resolved.orb');
    execFileSync(ORB_BIN, ['emit', 'orb', PF_LOLO, '-o', pfOrbPath], { env: CLI_ENV, maxBuffer: 64 * 1024 * 1024 });
    execFileSync(ORBITAL_BIN, ['resolve', pfOrbPath, '-o', pfResolvedPath], {
      env: CLI_ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
    const pfSchema = JSON.parse(readFileSync(pfOrbPath, 'utf-8')) as OrbitalSchema;
    const rustSchema = JSON.parse(readFileSync(pfResolvedPath, 'utf-8')) as { orbitals: Orbital[] };
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }

    for (const orbitalName of ['TimesheetOrbital', 'ApprovalRequestOrbital'] as const) {
      it(`"${orbitalName}" resolves the same trait SET through both paths (order-independent)`, async () => {
        const result = await preprocessSchema(pfSchema, {
          basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
          stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
          allowOutsideBasePath: true,
        });
        expect(result.success).toBe(true);
        if (!result.success) return;

        const jsOrbital = result.data.schema.orbitals.find((o) => o.name === orbitalName);
        const rustOrbital = rustSchema.orbitals.find((o) => o.name === orbitalName);
        expect(jsOrbital).toBeDefined();
        expect(rustOrbital).toBeDefined();
        if (!jsOrbital || !rustOrbital) return;

        const jsNames = new Set(jsOrbital.traits.filter(isTrait).map((t) => t.name));
        const rustNames = new Set(rustOrbital.traits.filter(isTrait).map((t) => t.name));
        const jsOnly = [...jsNames].filter((n) => !rustNames.has(n)).sort();
        const rustOnly = [...rustNames].filter((n) => !jsNames.has(n)).sort();

        // Closed (J2, B4-J6): when ONE atom is composed TWICE as separate
        // top-level entries of the SAME imported file (std-approval-request's
        // `InlineBrowseItemBrowse6`/`…10`, both `ref: Dense.traits.
        // BrowseItemBrowse`), their shared sibling (`DataGrid1`/
        // `DenseTableView`/`MasterListView`) now materialises TWICE (once
        // bare, once owner-prefixed) on both paths — `pullSiblingTraits`
        // keys/disambiguates by the IMMEDIATE embedder (`parent`), not just
        // the top-level owner, and drains its worklist FIFO (verified against
        // the compiled path's actual `orbital resolve` output, not just its
        // source). Both sides must now be exactly `[]`.
        expect(jsOnly).toEqual([]);
        expect(rustOnly).toEqual([]);
      });
    }

    it('both AppLayout shells forward the imported app-level appName/navItems knobs (uses { config } override)', async () => {
      const result = await preprocessSchema(pfSchema, {
        basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
        stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
        allowOutsideBasePath: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      for (const orbitalName of ['TimesheetOrbital', 'ApprovalRequestOrbital'] as const) {
        const o = result.data.schema.orbitals.find((x) => x.name === orbitalName);
        expect(o).toBeDefined();
        if (!o) continue;
        const appLayout = o.traits.filter(isTrait).find((t) => /AppLayout$/.test(t.name));
        expect(appLayout).toBeDefined();
        if (!appLayout?.config) continue;
        expect(appLayout.config.appName?.default).toBe('Project Friday');
        expect(appLayout.config.appName?.forwardedFrom).toBe('@config.appName');
        const navItems = appLayout.config.navItems?.default;
        const declaredNav = pfSchema.config?.['navItems']?.default;
        expect(Array.isArray(navItems) ? navItems.length : navItems).toBe(Array.isArray(declaredNav) ? declaredNav.length : -1);
        expect(appLayout.config.navItems?.forwardedFrom).toBe('@config.navItems');
      }
    });
  },
);
