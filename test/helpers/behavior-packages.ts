/**
 * The behavior registries a test reads, from the installed packages: a workspace
 * link in the monorepo, the published package in a standalone checkout.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** `@almadar/std`'s package root (`behaviors/registry/…`, `behaviors/lolo/…`). */
export const STD_ROOT = dirname(require.resolve('@almadar/std/package.json'));

/** `@almadar-io/behaviors`'s package root. */
export const IO_ROOT = dirname(require.resolve('@almadar-io/behaviors/package.json'));

/** This package's root: the cwd an `orb` spawn resolves `@almadar/std` / `@almadar-io/behaviors` from. */
export const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');

/** The installed `@almadar/orb` CLI — the compiled path a parity test compares against. */
export const ORB_BIN = join(dirname(require.resolve('@almadar/orb/package.json')), 'bin', 'orb');

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
