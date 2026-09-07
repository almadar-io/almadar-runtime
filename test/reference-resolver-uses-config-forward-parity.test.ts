/**
 * A `uses Alias { config { k: @config.j } }` override FORWARDS the consumer's
 * own app knob into the alias's app knob. Both paths must take that last hop
 * (Rust `inline::orbital::forward_consumer_app_knobs`, JS
 * `forwardConsumerAppKnobs`) so every imported shell renders the consumer's
 * list, never the literal token. Real organism: Project Friday's file-scope
 * `uses TimeTracking { config { appName: @config.appName navItems: @config.navItems } }`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { OrbitalSchema, Orbital, Trait, TraitConfigValue } from '@almadar/core';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
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

interface ShellNav {
  trait: string;
  navCount: number | 'not-a-list';
  appName: TraitConfigValue | undefined;
  forwardedFrom: string | undefined;
}

function shellsOf(orbital: Orbital): ShellNav[] {
  const out: ShellNav[] = [];
  for (const t of orbital.traits ?? []) {
    if (!isTrait(t) || !t.config || !('navItems' in t.config)) continue;
    const nav = t.config['navItems'];
    const app = t.config['appName'];
    out.push({
      trait: t.name,
      navCount: Array.isArray(nav.default) ? nav.default.length : 'not-a-list',
      appName: app?.default,
      forwardedFrom: nav.forwardedFrom,
    });
  }
  return out;
}

describe.skipIf(!canRun)('uses-config override forwards the consumer app knob (last hop, both paths)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-uses-forward-'));
  const pfOrbPath = join(dir, 'pf.orb');
  const pfResolvedPath = join(dir, 'pf-resolved.orb');
  execFileSync(ORB_BIN, ['emit', 'orb', PF_LOLO, '-o', pfOrbPath], { env: CLI_ENV, maxBuffer: 64 * 1024 * 1024 });
  execFileSync(ORBITAL_BIN, ['resolve', pfOrbPath, '-o', pfResolvedPath], { env: CLI_ENV, maxBuffer: 64 * 1024 * 1024 });
  const pfSchema = JSON.parse(readFileSync(pfOrbPath, 'utf-8')) as OrbitalSchema;
  const rustSchema = JSON.parse(readFileSync(pfResolvedPath, 'utf-8')) as { orbitals: Orbital[] };
  const declaredNav = pfSchema.config?.['navItems']?.default;
  const expectedNavCount = Array.isArray(declaredNav) ? declaredNav.length : -1;

  for (const orbitalName of ['TimesheetOrbital', 'ApprovalRequestOrbital'] as const) {
    it(`"${orbitalName}"'s imported shells carry the consumer nav on both paths`, async () => {
      const result = await preprocessSchema(pfSchema, {
        basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
        stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
        allowOutsideBasePath: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const js = result.data.schema.orbitals.find((o) => o.name === orbitalName);
      const rust = rustSchema.orbitals.find((o) => o.name === orbitalName);
      expect(js).toBeDefined();
      expect(rust).toBeDefined();
      if (!js || !rust) return;
      const jsShells = shellsOf(js);
      const rustShells = shellsOf(rust);
      expect(jsShells.length).toBeGreaterThan(0);
      for (const shell of [...jsShells, ...rustShells]) {
        expect(shell, `${shell.trait} ${JSON.stringify(shell)}`).toMatchObject({ navCount: expectedNavCount, appName: 'Project Friday', forwardedFrom: '@config.navItems' });
      }
      expect(jsShells.map((s) => s.trait).sort()).toEqual(rustShells.map((s) => s.trait).sort());
    });
  }

  it('cleans up', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
