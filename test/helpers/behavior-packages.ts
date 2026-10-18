/**
 * The behavior registries a test reads, from the installed packages: a workspace
 * link in the monorepo, the published package in a standalone checkout.
 */
import { createRequire } from 'node:module';

import { behaviorRegistryDir, readBehaviorPackage, resolveOrbBinary } from '@almadar/core/behavior-package';
import { dirname, join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { programResolve } from '../../src/host/program/index.js';

const require = createRequire(import.meta.url);

/** `@almadar/std`'s package root (`behaviors/registry/…`, `behaviors/lolo/…`). */
export const STD_ROOT = dirname(require.resolve('@almadar/std/package.json'));

/** `@almadar-io/behaviors`'s package root. */
export const IO_ROOT = dirname(require.resolve('@almadar-io/behaviors/package.json'));

/** `@almadar/std`'s lowered programs, through its manifest: the live mirror of its
 *  `.lolo` sources in the workspace, the shipped registry from npm. */
export const STD_REGISTRY = behaviorRegistryDir(readBehaviorPackage(STD_ROOT));

/** `@almadar-io/behaviors`'s lowered programs, through its manifest. */
export const IO_REGISTRY = behaviorRegistryDir(readBehaviorPackage(IO_ROOT));

/** This package's root: the cwd an `orb` spawn resolves `@almadar/std` / `@almadar-io/behaviors` from. */
export const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');

/** The compiler the runtime itself reaches (`ORB_BIN`, `~/bin/orb`, PATH); a standalone checkout with none keeps its installed pin. */
function resolveTestOrb(): string {
  if (process.env.ORB_BIN) return resolveOrbBinary();
  try {
    return resolveOrbBinary();
  } catch {
    return join(dirname(require.resolve('@almadar/orb/package.json')), 'bin', 'orb');
  }
}

export const ORB_BIN = resolveTestOrb();

/** Spawn options for `orb`: behaviors from this package's `node_modules`, no dev-registry override. */
export function orbSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ALMADAR_DEV;
  delete env.ALMADAR_ROOT;
  return env;
}

/** Whether source text builds a path out of this package into a monorepo sibling. */
export function climbsOutOfPackage(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /['"`]packages\/almadar-/.test(code)
    || /['"`]\.\.['"`]\s*,\s*['"`]\.\.['"`]\s*,\s*['"`]\.\.['"`]/.test(code)
    || /\.\.\/\.\.\/\.\.\//.test(code);
}

/** A program file resolved by `orb` from this package, as a host registers it. */
export function resolveProgram(path: string): Promise<OrbitalSchema> {
  return programResolve(path, { cwd: PACKAGE_ROOT, orbBin: ORB_BIN });
}
