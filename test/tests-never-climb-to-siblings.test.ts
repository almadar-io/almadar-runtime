/**
 * CI checks this package out alone, so a test that reads a sibling folder of the
 * monorepo either fails there or (behind an `existsSync` skip) never runs there.
 * Behavior registries come from the installed packages (`test/helpers/behavior-packages.ts`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { climbsOutOfPackage } from './helpers/behavior-packages.js';

const TEST_DIR = import.meta.dirname;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('runtime tests stay inside the package', () => {
  it('no test builds a path into a sibling package', () => {
    const offenders = testFiles(TEST_DIR)
      .filter((f) => f !== import.meta.filename)
      .filter((f) => climbsOutOfPackage(readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => f.slice(TEST_DIR.length + 1))).toEqual([]);
  });

  it('control: the check sees each spelling of a climb, and not an in-package path', () => {
    expect(climbsOutOfPackage("join(REPO_ROOT, 'packages/almadar-std/behaviors')")).toBe(true);
    expect(climbsOutOfPackage("join(__dirname, '..', '..', '..')")).toBe(true);
    expect(climbsOutOfPackage("resolve(here, '../../../almadar-behaviors')")).toBe(true);
    expect(climbsOutOfPackage("join(IO_ROOT, 'behaviors/registry/riya/atoms/riya-level-sine.orb')")).toBe(false);
    expect(climbsOutOfPackage("join(__dirname, 'fixtures', 'a.orb')")).toBe(false);
    expect(climbsOutOfPackage("/** see `packages/almadar-std/behaviors/x.orb` */\nconst a = 1;")).toBe(false);
    expect(climbsOutOfPackage("// mirrors '../../../orbital-rust/fixtures'\nconst a = 1;")).toBe(false);
  });
});
