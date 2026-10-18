import { afterEach, describe, expect, it } from 'vitest';
import { CredentialStore, installCredentialStore, runWithCredentialScope, uninstallCredentialStore, type CredentialPersistence } from '../src/host/credentials/index.js';
import type { EntityRow, PersistenceAdapter } from '@almadar/core';
import { createHttpSecrets } from '../src/kernel/http-exchange.js';
import { createOAuthPort } from '../src/kernel/oauth-port.js';

type TestAdapter = CredentialPersistence & Pick<PersistenceAdapter, 'getById'> & Partial<Pick<PersistenceAdapter, 'writeWhere' | 'writeCapabilities'>>;

function memoryAdapter(options: { conditional?: boolean } = {}): TestAdapter {
  const tables = new Map<string, Map<string, EntityRow>>();
  const table = (type: string): Map<string, EntityRow> => {
    const held = tables.get(type) ?? new Map<string, EntityRow>();
    tables.set(type, held);
    return held;
  };
  let sequence = 0;
  const base: TestAdapter = {
    async create(type, data) {
      const id = typeof data.id === 'string' ? data.id : String(++sequence);
      table(type).set(id, { ...data, id });
      return { id };
    },
    async update(type, id, data) { table(type).set(id, { ...table(type).get(id), ...data }); },
    async delete(type, id) { table(type).delete(id); },
    async list(type) { return [...table(type).values()]; },
    async getById(type, id) { return table(type).get(id) ?? null; },
  };
  if (options.conditional !== true) return base;
  return {
    ...base,
    writeCapabilities: () => ({ guards: { leaves: [], combinators: [], compareOps: [] }, conditional: true, returnsRow: false, stopRuns: false, atomicBatch: false }),
    async writeWhere(op) {
      if (op.kind !== 'delete') return { kind: 'failed', message: 'only delete' };
      const held = table(op.entityType);
      if (!held.has(op.id)) return { kind: 'not-found' };
      held.delete(op.id);
      return { kind: 'deleted' };
    },
  };
}

function memoryStore(adapter: TestAdapter = memoryAdapter()): CredentialStore {
  return new CredentialStore(adapter, 'a'.repeat(64));
}

describe('HTTP credential identity', () => {
  afterEach(() => uninstallCredentialStore());

  it('expires minted tokens at the exact boundary and keeps installed authorities independent', async () => {
    let now = 1000;
    const secrets = createHttpSecrets(() => now);
    await secrets.set('KEY', 'environment-token', 100);
    const first = memoryStore();
    await first.set('service', 'KEY', 'first-persisted');
    installCredentialStore(first);
    expect(await secrets.get('KEY')).toBe('first-persisted');
    await secrets.set('KEY', 'first-minted', 100);
    now = 1099;
    expect(await secrets.get('KEY')).toBe('first-minted');
    now = 1100;
    expect(await secrets.get('KEY')).toBe('first-persisted');
    const second = memoryStore();
    await second.set('service', 'KEY', 'second-persisted');
    installCredentialStore(second);
    expect(await secrets.get('KEY')).toBe('second-persisted');
    await secrets.set('KEY', 'second-minted', 100);
    await secrets.set('KEY', 'cleared', 0);
    expect(await secrets.get('KEY')).toBe('second-persisted');
  });

  it('resolves and forgets the exact persisted principal in the effective tenant', async () => {
    const first = memoryStore();
    const second = memoryStore();
    for (const [store, prefix] of [[first, 'first'], [second, 'second']] as const) {
      await store.set('service', 'KEY', `${prefix}-app`);
      await store.set('service', 'KEY', `${prefix}-owner`, 'owner');
      await store.set('service', 'KEY', `${prefix}-other`, 'other');
    }
    installCredentialStore(first);
    const secrets = createHttpSecrets();
    expect(await secrets.get('KEY', 'owner')).toBe('first-owner');
    await runWithCredentialScope(second, async () => {
      expect(await secrets.get('KEY', 'owner')).toBe('second-owner');
      await secrets.forget('KEY', 'owner');
      expect(await secrets.get('KEY', 'owner')).toBeUndefined();
      expect(await secrets.get('KEY')).toBe('second-app');
      expect(await secrets.get('KEY', 'other')).toBe('second-other');
    });
    expect(await secrets.get('KEY', 'owner')).toBe('first-owner');
  });

  it('isolates minted values by tenant authority as well as principal', async () => {
    const first = memoryStore();
    const second = memoryStore();
    installCredentialStore(first);
    const secrets = createHttpSecrets(() => 1000);
    await secrets.set('KEY', 'first-token', 10000, 'owner');
    await runWithCredentialScope(second, async () => {
      expect(await secrets.get('KEY', 'owner')).toBeUndefined();
      await secrets.set('KEY', 'second-token', 10000, 'owner');
      expect(await secrets.get('KEY', 'owner')).toBe('second-token');
      await secrets.forget('KEY', 'owner');
    });
    expect(await secrets.get('KEY', 'owner')).toBe('first-token');
  });

  it('separates app and user names even when identifiers contain namespace delimiters', async () => {
    const secrets = createHttpSecrets(() => 1000);
    await secrets.set('user:a:b:c', 'app-token', 10000);
    await secrets.set('c', 'first-user-token', 10000, 'a:b');
    await secrets.set('b:c', 'second-user-token', 10000, 'a');
    expect(await secrets.get('user:a:b:c')).toBe('app-token');
    expect(await secrets.get('c', 'a:b')).toBe('first-user-token');
    expect(await secrets.get('b:c', 'a')).toBe('second-user-token');
  });

  it('control: keeps ordinary app and two-user slots independent', async () => {
    const secrets = createHttpSecrets(() => 1000);
    await secrets.set('KEY', 'app-token', 10000);
    await secrets.set('KEY', 'first-user-token', 10000, 'u1');
    await secrets.set('KEY', 'second-user-token', 10000, 'u2');
    expect(await secrets.get('KEY')).toBe('app-token');
    expect(await secrets.get('KEY', 'u1')).toBe('first-user-token');
    expect(await secrets.get('KEY', 'u2')).toBe('second-user-token');
  });
  it('persists a credential per principal, creating it when absent, and takes a minted value once', async () => {
    installCredentialStore(memoryStore());
    const secrets = createHttpSecrets(() => 1000);
    expect(await secrets.durable?.()).toBe(true);
    await secrets.persist?.('oauth:connection:google', '{"row":{}}', 'u1');
    expect(await secrets.get('oauth:connection:google', 'u1')).toBe('{"row":{}}');
    expect(await secrets.get('oauth:connection:google', 'u2')).toBeUndefined();
    expect(await secrets.get('oauth:connection:google')).toBeUndefined();
    await secrets.set('oauth:grant:s', 'grant', 10000, 'u1');
    expect(await secrets.take?.('oauth:grant:s', 'u2')).toBeUndefined();
    expect(await secrets.take?.('oauth:grant:s', 'u1')).toBe('grant');
    expect(await secrets.take?.('oauth:grant:s', 'u1')).toBeUndefined();
  });

  it('control: without an installed store nothing is durable, and an expired minted value is not taken', async () => {
    let now = 1000;
    const secrets = createHttpSecrets(() => now);
    expect(await secrets.durable?.()).toBe(false);
    await expect(secrets.persist?.('oauth:connection:google', 'x', 'u1')).rejects.toThrow('no credential store');
    await secrets.set('oauth:grant:s', 'grant', 100, 'u1');
    now = 1100;
    expect(await secrets.take?.('oauth:grant:s', 'u1')).toBeUndefined();
  });
  it('shares a held one-use value across instances on one adapter: the first to take it gets it', async () => {
    const adapter = memoryAdapter({ conditional: true });
    const [a, b] = [memoryStore(adapter), memoryStore(adapter)];
    const secrets = createHttpSecrets(() => 1000);
    await runWithCredentialScope(a, () => secrets.hold?.('oauth:grant:s', 'grant', 10000, 'u1'));
    const raced = await Promise.all([
      runWithCredentialScope(a, () => secrets.take?.('oauth:grant:s', 'u1')),
      runWithCredentialScope(b, () => secrets.take?.('oauth:grant:s', 'u1')),
    ]);
    expect(raced.filter((value) => value === 'grant')).toHaveLength(1);
    expect(raced.filter((value) => value === undefined)).toHaveLength(1);
    expect(await runWithCredentialScope(b, () => secrets.take?.('oauth:grant:s', 'u1'))).toBeUndefined();
  });

  it('control: a held value is encrypted at rest, scoped to its principal, and an expired one is consumed unread', async () => {
    const adapter = memoryAdapter();
    let now = 1000;
    const secrets = createHttpSecrets(() => now);
    await runWithCredentialScope(memoryStore(adapter), () => secrets.hold?.('oauth:grant:s', 'VERIFIER-SECRET', 100, 'u1'));
    const rows = await adapter.list('AlmadarKernelDerivedSecret');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('VERIFIER-SECRET');
    expect(await runWithCredentialScope(memoryStore(adapter), () => secrets.take?.('oauth:grant:s', 'u2'))).toBeUndefined();
    now = 1100;
    expect(await runWithCredentialScope(memoryStore(adapter), () => secrets.take?.('oauth:grant:s', 'u1'))).toBeUndefined();
    expect(await adapter.list('AlmadarKernelDerivedSecret')).toHaveLength(0);
  });

  it('an authorize on one instance and its callback on another meet through the shared adapter', async () => {
    const adapter = memoryAdapter({ conditional: true });
    const secrets = createHttpSecrets(() => 1000);
    const port = createOAuthPort({ secrets, now: () => 1000 });
    const grant = { provider: 'google', redirectUri: 'https://app/cb', verifier: 'V', subject: null, scopes: ['openid'] };
    await runWithCredentialScope(memoryStore(adapter), () => port.answer({ ask: 'pendingPut', state: 's', grant, ttlMs: 600_000 }, 'alice'));
    const callback = await runWithCredentialScope(memoryStore(adapter), () => port.answer({ ask: 'pendingTake', state: 's' }, 'bob'));
    expect(callback).toEqual({ reply: 'taken', taken: { found: 'grant', grant } });
    expect(await runWithCredentialScope(memoryStore(adapter), () => port.answer({ ask: 'pendingTake', state: 's' }, 'alice'))).toEqual({ reply: 'taken', taken: { found: 'missing' } });
  });
});
