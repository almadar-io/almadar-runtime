import { afterEach, describe, expect, it } from 'vitest';
import type { EntityRow } from '@almadar/core';
import { CredentialStore, CREDENTIAL_ENTITY_TYPE, type CredentialPersistence } from '../src/host/credentials/store.js';
import { installCredentialStore, resolveCredentialRef, uninstallCredentialStore } from '../src/host/credentials/scope.js';

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);
const ENV = { KEY: 'environment-fallback' };

class MemoryPersistence implements CredentialPersistence {
  readonly rows = new Map<string, EntityRow>();
  private sequence = 0;

  async create(_entityType: string, data: EntityRow): Promise<{ id: string }> {
    const id = String(++this.sequence);
    this.rows.set(id, { ...data, id });
    return { id };
  }

  async update(_entityType: string, id: string, data: EntityRow): Promise<void> {
    this.rows.set(id, { ...this.rows.get(id), ...data });
  }

  async delete(_entityType: string, id: string): Promise<void> {
    this.rows.delete(id);
  }

  async list(_entityType: string): Promise<EntityRow[]> {
    return [...this.rows.values()];
  }
}

function rowText(row: EntityRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`fixture ${field} must be a string`);
  return value;
}

function tamperedHex(value: string): string {
  return value.replace(/^./, (first) => first === '0' ? '1' : '0');
}

describe('authenticated empty credential ciphertext', () => {
  afterEach(() => uninstallCredentialStore());

  it.each(['', 'nonempty-value'])('rewarm preserves app/user plaintext %j and its env shadow', async (value) => {
    const adapter = new MemoryPersistence();
    const written = new CredentialStore(adapter, OLD_KEY);
    await written.set('service', 'KEY', value);
    await written.set('service', 'KEY', value, 'owner');
    installCredentialStore(written);
    expect(resolveCredentialRef('KEY', ENV)).toBe(value);
    expect(resolveCredentialRef('KEY', ENV, 'owner')).toBe(value);

    for (const row of await adapter.list(CREDENTIAL_ENTITY_TYPE)) {
      const ciphertext = rowText(row, 'ciphertext');
      expect(ciphertext.length === 0).toBe(value.length === 0);
      expect(row.iv).toMatch(/^[0-9a-f]{24}$/);
      expect(row.authTag).toMatch(/^[0-9a-f]{32}$/);
      expect(row.keyId).toMatch(/^[0-9a-f]{16}$/);
    }

    const loaded = new CredentialStore(adapter, OLD_KEY);
    const count = await loaded.warm();
    installCredentialStore(loaded);
    expect(resolveCredentialRef('KEY', ENV)).toBe(value);
    expect(count).toBe(2);
    expect(loaded.resolve('KEY')).toBe(value);
    expect(loaded.resolve('KEY', 'owner')).toBe(value);
    expect(loaded.resolve('KEY', 'other')).toBeUndefined();
    expect(loaded.snapshotEnv()).toEqual({ KEY: value });
    expect(loaded.entries()).toHaveLength(1);
    expect(loaded.entries('owner')).toHaveLength(1);
    expect(resolveCredentialRef('KEY', ENV)).toBe(value);
    expect(resolveCredentialRef('KEY', ENV, 'owner')).toBe(value);
    expect(resolveCredentialRef('KEY', ENV, 'other')).toBeUndefined();
    await loaded.remove('KEY');
    expect(resolveCredentialRef('KEY', ENV)).toBe(ENV.KEY);
    expect(resolveCredentialRef('KEY', ENV, 'owner')).toBe(value);
  });

  it.each(['', 'nonempty-value'])('rotation preserves app/user plaintext %j after retiring the old key', async (value) => {
    const adapter = new MemoryPersistence();
    const written = new CredentialStore(adapter, OLD_KEY);
    await written.set('service', 'KEY', value);
    await written.set('service', 'KEY', value, 'owner');
    const prior = [...adapter.rows.values()].map((row) => row.keyId);
    const rotating = new CredentialStore(adapter, NEW_KEY, OLD_KEY);

    expect(await rotating.rotate()).toEqual({ rotated: 2, alreadyCurrent: 0, unreadable: 0 });
    expect([...adapter.rows.values()].every((row) => !prior.includes(row.keyId))).toBe(true);

    const loaded = new CredentialStore(adapter, NEW_KEY);
    expect(await loaded.warm()).toBe(2);
    installCredentialStore(loaded);
    expect(resolveCredentialRef('KEY', ENV)).toBe(value);
    expect(resolveCredentialRef('KEY', ENV, 'owner')).toBe(value);
    expect(resolveCredentialRef('KEY', ENV, 'other')).toBeUndefined();
    expect(await loaded.rotate()).toEqual({ rotated: 0, alreadyCurrent: 2, unreadable: 0 });
  });

  it.each(['', 'nonempty-value'])('current-key rotation authenticates and retains plaintext %j', async (value) => {
    const adapter = new MemoryPersistence();
    const written = new CredentialStore(adapter, NEW_KEY);
    await written.set('service', 'KEY', value);
    await written.set('service', 'KEY', value, 'owner');
    const before = [...adapter.rows.values()];
    const loaded = new CredentialStore(adapter, NEW_KEY);

    expect(await loaded.rotate()).toEqual({ rotated: 0, alreadyCurrent: 2, unreadable: 0 });
    expect([...adapter.rows.values()]).toEqual(before);
    installCredentialStore(loaded);
    expect(resolveCredentialRef('KEY', ENV)).toBe(value);
    expect(resolveCredentialRef('KEY', ENV, 'owner')).toBe(value);
  });

  it.each(['', 'nonempty-value'])('legacy unstamped ciphertext for %j remains readable and gains the current key stamp', async (value) => {
    const adapter = new MemoryPersistence();
    const written = new CredentialStore(adapter, NEW_KEY);
    await written.set('service', 'KEY', value);
    const [row] = [...adapter.rows.values()];
    const { keyId: _keyId, ...legacy } = row;
    adapter.rows.set(rowText(row, 'id'), legacy);
    const loaded = new CredentialStore(adapter, NEW_KEY);

    expect(await loaded.rotate()).toEqual({ rotated: 0, alreadyCurrent: 1, unreadable: 0 });
    expect(loaded.resolve('KEY')).toBe(value);
    expect([...adapter.rows.values()][0].keyId).toBe(row.keyId);
  });

  const corruptions: { name: string; change: (row: EntityRow) => EntityRow }[] = [
    { name: 'IV bytes', change: (row) => ({ iv: tamperedHex(rowText(row, 'iv')) }) },
    { name: 'authentication tag', change: (row) => ({ authTag: tamperedHex(rowText(row, 'authTag')) }) },
    { name: 'ciphertext bytes', change: (row) => ({ ciphertext: `${rowText(row, 'ciphertext')}00` }) },
    { name: 'unknown key stamp', change: () => ({ keyId: 'c'.repeat(16) }) },
    { name: 'authenticated principal', change: () => ({ principal: 'other' }) },
    { name: 'authenticated name', change: () => ({ envVar: 'OTHER_KEY' }) },
  ];

  it.each(corruptions)('control: rejects tampered $name for empty and nonempty ciphertext', async ({ change }) => {
    for (const value of ['', 'nonempty-value']) {
      const adapter = new MemoryPersistence();
      const written = new CredentialStore(adapter, NEW_KEY);
      await written.set('service', 'KEY', value, 'owner');
      const [row] = [...adapter.rows.values()];
      await adapter.update(CREDENTIAL_ENTITY_TYPE, rowText(row, 'id'), change(row));
      const before = [...adapter.rows.values()];
      const loaded = new CredentialStore(adapter, NEW_KEY);

      expect(await loaded.warm()).toBe(0);
      expect(await loaded.rotate()).toEqual({ rotated: 0, alreadyCurrent: 0, unreadable: 1 });
      expect([...adapter.rows.values()]).toEqual(before);
      expect(loaded.resolve('KEY', 'owner')).toBeUndefined();
      expect(loaded.resolve('KEY', 'other')).toBeUndefined();
      expect(loaded.resolve('OTHER_KEY', 'owner')).toBeUndefined();
    }
  });

  const invalidRows: { name: string; change: EntityRow }[] = [
    { name: 'nonstring ciphertext', change: { ciphertext: 0 } },
    { name: 'missing ciphertext', change: { ciphertext: null } },
    { name: 'empty IV', change: { iv: '' } },
    { name: 'empty authentication tag', change: { authTag: '' } },
    { name: 'empty row id', change: { id: '' } },
    { name: 'empty service', change: { service: '' } },
    { name: 'empty credential name', change: { envVar: '' } },
    { name: 'empty principal', change: { principal: '' } },
  ];

  it.each(invalidRows)('control: still rejects $name', async ({ change }) => {
    const adapter = new MemoryPersistence();
    const written = new CredentialStore(adapter, NEW_KEY);
    await written.set('service', 'KEY', '', 'owner');
    const [row] = [...adapter.rows.values()];
    await adapter.update(CREDENTIAL_ENTITY_TYPE, rowText(row, 'id'), change);
    const loaded = new CredentialStore(adapter, NEW_KEY);

    expect(await loaded.warm()).toBe(0);
    expect(await loaded.rotate()).toEqual({ rotated: 0, alreadyCurrent: 0, unreadable: 1 });
    expect(adapter.rows.size).toBe(1);
  });

  it('control: a different master key cannot read or rotate authenticated empty ciphertext', async () => {
    const adapter = new MemoryPersistence();
    const written = new CredentialStore(adapter, OLD_KEY);
    await written.set('service', 'KEY', '');
    const loaded = new CredentialStore(adapter, NEW_KEY);

    expect(await loaded.warm()).toBe(0);
    expect(await loaded.rotate()).toEqual({ rotated: 0, alreadyCurrent: 0, unreadable: 1 });
    installCredentialStore(loaded);
    expect(resolveCredentialRef('KEY', ENV)).toBe(ENV.KEY);
  });
});
