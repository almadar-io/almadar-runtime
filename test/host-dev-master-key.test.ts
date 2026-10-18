import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateDevMasterKey } from '../src/host/credentials/dev-master-key.js';

describe('loadOrCreateDevMasterKey', () => {
  const savedEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  it('creates a 64-hex key once (owner-only file) and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-key-'));
    const first = loadOrCreateDevMasterKey(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateDevMasterKey(dir)).toBe(first);
    expect(readFileSync(join(dir, 'dev-credential-master-key'), 'utf8').trim()).toBe(first);
    expect(statSync(join(dir, 'dev-credential-master-key')).mode & 0o777).toBe(0o600);
  });

  it('creates the directory when it does not exist', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dev-key-')), 'nested', '.almadar');
    expect(loadOrCreateDevMasterKey(dir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a malformed existing key instead of overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-key-'));
    writeFileSync(join(dir, 'dev-credential-master-key'), 'not-hex');
    expect(() => loadOrCreateDevMasterKey(dir)).toThrow(/malformed/);
  });

  it('refuses under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => loadOrCreateDevMasterKey(mkdtempSync(join(tmpdir(), 'dev-key-')))).toThrow(/production/);
  });
});
