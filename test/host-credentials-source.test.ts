// The twin of orbital-core runtime `credentials`: the same vector (test/fixtures/credentials-source.json) is answered by
// the native host and, here, by the JS host's one credential-reference resolver.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EntityRow } from '@almadar/core';
import { CredentialStore, type CredentialPersistence } from '../src/host/credentials/store.js';
import { credentialsFromStoreOnly, installCredentialStore, resolveCredentialRef, uninstallCredentialStore } from '../src/host/credentials/scope.js';
import { seedCredentialStore } from '../src/host/credentials/seed.js';
import { loadNativeKernelModule } from '../src/kernel/load-node.js';
import { KERNEL_DIR, loadKernel, NATIVE_ADDON } from './helpers/kernel-module.js';

interface SourceCase {
  case: string;
  env: Record<string, string>;
  store: Record<string, string>;
  name: string;
  answer: string | null;
}

const vector: { cases: SourceCase[] } = JSON.parse(readFileSync(new URL('./fixtures/credentials-source.json', import.meta.url), 'utf8'));
const KEY = 'c'.repeat(64);

class MemoryPersistence implements CredentialPersistence {
  readonly rows = new Map<string, EntityRow>();
  private sequence = 0;
  async create(_type: string, data: EntityRow): Promise<{ id: string }> {
    const id = String(++this.sequence);
    this.rows.set(id, { ...data, id });
    return { id };
  }
  async update(_type: string, id: string, data: EntityRow): Promise<void> {
    this.rows.set(id, { ...this.rows.get(id), ...data });
  }
  async delete(_type: string, id: string): Promise<void> {
    this.rows.delete(id);
  }
  async list(): Promise<EntityRow[]> {
    return [...this.rows.values()];
  }
}

async function storeWith(rows: Record<string, string>): Promise<CredentialStore> {
  const store = new CredentialStore(new MemoryPersistence(), KEY);
  for (const [name, value] of Object.entries(rows)) await store.set('svc', name, value);
  return store;
}

describe('credentials source', () => {
  afterEach(() => uninstallCredentialStore());

  it.each(vector.cases)('answers the shared vector: $case', async (c) => {
    installCredentialStore(await storeWith(c.store));
    expect(resolveCredentialRef(c.name, c.env)).toBe(c.answer ?? undefined);
  });

  it('selects store-only resolution for the exact word and nothing else', () => {
    expect(credentialsFromStoreOnly({ ALMADAR_CREDENTIALS_SOURCE: 'store' })).toBe(true);
    for (const other of [undefined, '', 'env', 'Store']) expect(credentialsFromStoreOnly({ ALMADAR_CREDENTIALS_SOURCE: other })).toBe(false);
  });

  it('a user-scoped credential never falls back to the env in either mode', async () => {
    installCredentialStore(await storeWith({}));
    expect(resolveCredentialRef('K', { K: 'env', ALMADAR_CREDENTIALS_SOURCE: 'store' }, 'someone')).toBeUndefined();
  });
});

describe.skipIf(KERNEL_DIR === undefined && NATIVE_ADDON === undefined)('credential store seeding', () => {
  const kernel = { credentialSeedPlan: (declared: string, held: string, present: string): string => '' };
  beforeAll(async () => { kernel.credentialSeedPlan = (NATIVE_ADDON !== undefined ? await loadNativeKernelModule(NATIVE_ADDON) : await loadKernel()).credentialSeedPlan; });

  const declared = [
    { service: 'stripe', envVar: 'STRIPE_KEY' },
    { service: 'stripe', envVar: 'STRIPE_WEBHOOK' },
    { service: 'other', envVar: 'STRIPE_KEY' },
    { service: 'mail', envVar: 'EMPTY' },
  ];
  const env = { STRIPE_KEY: 'sk-env', STRIPE_WEBHOOK: 'whsec-env', EMPTY: '', UNDECLARED: 'x', ALMADAR_CREDENTIALS_SOURCE: 'store' };

  it('copies the declared env values the store lacks once, never overwrites a held row, and ignores empty and undeclared names', async () => {
    const store = await storeWith({ STRIPE_WEBHOOK: 'already-stored' });
    installCredentialStore(store);
    expect(await seedCredentialStore(store, declared, env, kernel)).toBe(1);
    expect(resolveCredentialRef('STRIPE_KEY', env)).toBe('sk-env');
    expect(resolveCredentialRef('STRIPE_WEBHOOK', env)).toBe('already-stored');
    expect(resolveCredentialRef('EMPTY', env)).toBeUndefined();
    expect(resolveCredentialRef('UNDECLARED', env)).toBeUndefined();
    expect(await seedCredentialStore(store, declared, env, kernel)).toBe(0);
  });

  it('shows a seeded credential as its last four characters only', async () => {
    const store = await storeWith({});
    await seedCredentialStore(store, declared, env, kernel);
    const shown = JSON.stringify(store.entries());
    expect(shown).not.toContain('sk-env');
    expect(shown).toContain('-env');
  });

  it('control: a store without a master key seeds nothing', async () => {
    const keyless = new CredentialStore(new MemoryPersistence(), '');
    expect(keyless.enabled).toBe(false);
    expect(await seedCredentialStore(keyless, declared, env, kernel)).toBe(0);
  });
});
