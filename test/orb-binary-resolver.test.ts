/**
 * One resolver picks the `orb` binary for every host (G-RUNTIME-099): a configured binary (`ORBITAL_BIN`, then
 * `ALMADAR_ORB`) always beats an `orb` that happens to be first on `PATH` (a workspace's older
 * `node_modules/.bin/orb`), through `resolveOrbBinary` and through `resolveProgramFile`'s `orb resolve`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOrbBinary } from '../src/host/program/index.js';
import { resolveProgramFile } from '../src/kernel/program-node.js';

const saved = { PATH: process.env.PATH, ORBITAL_BIN: process.env.ORBITAL_BIN, ALMADAR_ORB: process.env.ALMADAR_ORB, ALMADAR_DEV: process.env.ALMADAR_DEV };
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
  delete process.env.ORBITAL_BIN;
  delete process.env.ALMADAR_ORB;
  delete process.env.ALMADAR_DEV;
});

afterEach(() => {
  (['PATH', 'ORBITAL_BIN', 'ALMADAR_ORB', 'ALMADAR_DEV'] as const).forEach(restore);
  rmSync(dir, { recursive: true, force: true });
});

describe('the one orb binary resolver', () => {
  it('ORBITAL_BIN wins over the orb first on PATH, for both callers', async () => {
    const configured = fakeOrb('orbital', 'configured');
    process.env.ORBITAL_BIN = configured;
    expect(resolveOrbBinary()).toBe(configured);
    expect((await resolveProgramFile(join(dir, 'p.lolo'), dir)).name).toBe('configured');
  });

  it('ALMADAR_ORB is the same configured binary when ORBITAL_BIN is unset', async () => {
    const configured = fakeOrb('orb-dev', 'configured');
    process.env.ALMADAR_ORB = configured;
    expect(resolveOrbBinary()).toBe(configured);
    expect((await resolveProgramFile(join(dir, 'p.lolo'), dir)).name).toBe('configured');
  });

  it('edge: a configured path that does not exist is skipped, never run', () => {
    const configured = fakeOrb('orb-dev', 'configured');
    process.env.ORBITAL_BIN = join(dir, 'missing');
    process.env.ALMADAR_ORB = configured;
    expect(resolveOrbBinary()).toBe(configured);
  });

  it('control: with nothing configured the caller-named binary is the one run', async () => {
    const named = fakeOrb('named', 'named');
    expect((await resolveProgramFile(join(dir, 'p.lolo'), dir, named)).name).toBe('named');
  });
});
