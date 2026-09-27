/**
 * The Node range this package declares must run every package it loads at run
 * time. `@almadar/llm` moved to undici 8 (Node >= 22.19) while this package still
 * tested Node 20, which failed only on the Node 20 CI leg, far from the cause.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './helpers/behavior-packages.js';

interface Manifest {
  name: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function manifestAt(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Manifest;
}

/** Every package reachable through `dependencies`, resolved the way Node resolves it from its parent. */
function runtimeClosure(root: string): Map<string, Manifest> {
  const seen = new Map<string, Manifest>();
  const visit = (dir: string): void => {
    const manifest = manifestAt(dir);
    const lookup = createRequire(join(dir, 'package.json')).resolve.paths('') ?? [];
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      // Node's own lookup: the first `node_modules/<dep>` up from the parent (exports can't hide it).
      const depDir = lookup.map((p) => join(p, dep)).find((d) => existsSync(join(d, 'package.json')));
      if (depDir === undefined) throw new Error(`${manifest.name}: dependency ${dep} is not installed`);
      if (seen.has(depDir)) continue;
      seen.set(depDir, manifestAt(depDir));
      visit(depDir);
    }
  };
  visit(root);
  return seen;
}

/** Packages whose declared Node range the floor does not satisfy. */
export function uncoveredEngines(floorRange: string, packages: Iterable<Manifest>): string[] {
  const floor = semver.minVersion(floorRange);
  if (floor === null) return ['<no floor>'];
  const unmet = [...packages]
    .filter((m) => m.engines?.node !== undefined && semver.validRange(m.engines.node) !== null)
    .filter((m) => !semver.satisfies(floor, m.engines?.node ?? '*'))
    .map((m) => `${m.name} (node ${m.engines?.node})`);
  return [...new Set(unmet)].sort();
}

describe('engines.node', () => {
  it('this package declares a Node floor that runs every run-time dependency', () => {
    const own = manifestAt(PACKAGE_ROOT);
    expect(own.engines?.node, 'package.json engines.node').toBeDefined();
    const unmet = uncoveredEngines(own.engines?.node ?? '', runtimeClosure(PACKAGE_ROOT).values());
    expect(unmet).toEqual([]);
  });

  it('control: a floor below a dependency\'s range is caught, one inside it is not', () => {
    const undici8 = { name: 'undici', engines: { node: '>=22.19.0' } };
    expect(uncoveredEngines('>=20', [undici8])).toEqual(['undici (node >=22.19.0)']);
    expect(uncoveredEngines('>=22.19.0', [undici8])).toEqual([]);
    expect(uncoveredEngines('>=22.19.0', [{ name: 'any', engines: { node: '*' } }, { name: 'none' }])).toEqual([]);
  });
});
