import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_FILE = 'dev-credential-master-key';
const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * A development host's credential-store master key: read from `<dir>/dev-credential-master-key`,
 * generated there (owner-only) on first use. Production must hold its key in the platform secret
 * store, so this refuses under NODE_ENV=production.
 */
export function loadOrCreateDevMasterKey(dir: string): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('A generated dev master key is not permitted when NODE_ENV=production — set ALMADAR_CREDENTIAL_MASTER_KEY');
  }
  const path = join(dir, KEY_FILE);
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim();
    if (!HEX_KEY.test(key)) throw new Error(`${path} is malformed (expected 64 hex characters)`);
    return key;
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}
