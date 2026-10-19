/**
 * The runtime runs `orb` through `@almadar/core`'s one resolver (G-RUNTIME-099, G-CROSS-261): a configured binary
 * (`ORB_BIN`, then `ORBITAL_BIN`) always beats an `orb` that happens to be first on `PATH` (a workspace's older
 * `node_modules/.bin/orb`), through `resolveOrbBinary` and through `resolveProgramFile`'s `orb resolve`. The order
 * itself is pinned by core's `orb-binary.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOrbBinary } from '../src/host/program/index.js';
import { resolveProgramFile } from '../src/kernel/program-node.js';

const saved = { PATH: process.env.PATH, ORB_BIN: process.env.ORB_BIN, ORBITAL_BIN: process.env.ORBITAL_BIN };
let dir = '';

function fakeOrb(name: string, programName: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho '{"name":"${programName}","orbitals":[]}'\n`);
  chmodSync(path, 0o755);
  return path;
}

function restore(key: keyof typeof saved): void {
  const value = saved[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-resolver-'));
  writeFileSync(join(dir, 'orb'), `#!/bin/sh\necho '{"name":"stale","orbitals":[]}'\n`);
  chmodSync(join(dir, 'orb'), 0o755);
  process.env.PATH = `${dir}:${saved.PATH ?? ''}`;
  delete process.env.ORB_BIN;
  delete process.env.ORBITAL_BIN;
});

afterEach(() => {
  (['PATH', 'ORB_BIN', 'ORBITAL_BIN'] as const).forEach(restore);
  rmSync(dir, { recursive: true, force: true });
});

describe('the one orb binary resolver', () => {
  it('ORBITAL_BIN wins over the orb first on PATH, for both callers', async () => {
    const configured = fakeOrb('orbital', 'configured');
    process.env.ORBITAL_BIN = configured;
    expect(resolveOrbBinary(dir)).toBe(configured);
    expect((await resolveProgramFile(join(dir, 'p.lolo'), dir)).name).toBe('configured');
  });

  it('edge: a configured path that does not exist is refused by name, never skipped for the PATH orb', () => {
    process.env.ORBITAL_BIN = join(dir, 'missing');
    expect(() => resolveOrbBinary(dir)).toThrow(/ORBITAL_BIN/);
  });

  it('control: with nothing configured the caller-named binary is the one run', async () => {
    const named = fakeOrb('named', 'named');
    expect((await resolveProgramFile(join(dir, 'p.lolo'), dir, named)).name).toBe('named');
  });
});
