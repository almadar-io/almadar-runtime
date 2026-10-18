// The twin of orbital-core runtime `credential_store`: the same fixture (__tests__/fixtures/credential-store.json) is
// read by the native store, which must open every JS-written row, and reproduce every fixed-IV seal below byte for byte.
// Here the JS store opens the rows it wrote and the rows rebuilt from the seals the native store reproduces.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EntityRow } from '@almadar/core';
import { CredentialStore, type CredentialPersistence } from '../src/host/credentials/store.js';

interface Seal {
  ivHex: string;
  service: string;
  name: string;
  principal: string | null;
  plaintext: string;
  ciphertext: string;
  authTag: string;
  keyId: string;
}

interface Fixture {
  masterKey: string;
  previousKey: string;
  rows: EntityRow[];
  resolves: Array<{ name: string; principal: string | null; service: string; value: string; last4: string; label?: string }>;
  unreadable: string[];
  seals: Seal[];
}

const fixture: Fixture = JSON.parse(readFileSync(new URL('./fixtures/credential-store.json', import.meta.url), 'utf8'));

class Rows implements CredentialPersistence {
  constructor(private readonly rows: EntityRow[]) {}
  async create(_type: string, data: EntityRow): Promise<{ id: string }> {
    const id = String(this.rows.length);
    this.rows.push({ id, ...data });
    return { id };
  }
  async update(_type: string, id: string, data: EntityRow): Promise<void> {
    const at = this.rows.findIndex((row) => row.id === id);
    if (at >= 0) this.rows[at] = { ...this.rows[at], ...data };
  }
  async delete(): Promise<void> {}
  async list(): Promise<EntityRow[]> {
    return this.rows;
  }
}

describe('credential store native twin', () => {
  it('resolves the fixture rows it wrote, including the previous-key and legacy rows', async () => {
    const store = new CredentialStore(new Rows(fixture.rows), fixture.masterKey, fixture.previousKey);
    await store.warm();
    for (const want of fixture.resolves) {
      expect(store.resolve(want.name, want.principal ?? undefined)).toBe(want.value);
      expect(store.label(want.name, want.principal ?? undefined)).toBe(want.label);
    }
    expect(store.label('GITHUB_TOKEN')).toBeUndefined();
    for (const name of fixture.unreadable) expect(store.resolve(name)).toBeUndefined();
  });

  it('control: without the previous key the previous-key row stays unreadable', async () => {
    const store = new CredentialStore(new Rows(fixture.rows), fixture.masterKey, undefined);
    await store.warm();
    expect(store.resolve('GITHUB_TOKEN')).toBeUndefined();
    expect(store.resolve('STRIPE_KEY')).toBe('sk_test_alpha-1234');
  });

  it('opens the rows the native store writes (the fixed-IV seals it reproduces byte for byte)', async () => {
    const rows: EntityRow[] = fixture.seals.map((seal, index) => ({
      id: `native-${index}`,
      service: seal.service,
      envVar: seal.name,
      ciphertext: seal.ciphertext,
      iv: seal.ivHex,
      authTag: seal.authTag,
      keyId: seal.keyId,
      updatedAt: 1,
      ...(seal.principal !== null ? { principal: seal.principal } : {}),
    }));
    const store = new CredentialStore(new Rows(rows), fixture.masterKey);
    await store.warm();
    for (const seal of fixture.seals) {
      expect(store.resolve(seal.name, seal.principal ?? undefined)).toBe(seal.plaintext);
    }
  });

  it('keeps a label in the clear beside the ciphertext, never as or inside the secret', async () => {
    const rows: EntityRow[] = [];
    const store = new CredentialStore(new Rows(rows), fixture.masterKey);
    const secret = '1//refresh-token-SECRET-4242';
    await store.set('kflow', 'KNOWLEDGE_REFRESH_TOKEN', secret, undefined, 'ada@example.com');
    expect(store.label('KNOWLEDGE_REFRESH_TOKEN')).toBe('ada@example.com');
    expect(store.resolve('KNOWLEDGE_REFRESH_TOKEN')).toBe(secret);
    expect(rows[0].label).toBe('ada@example.com');
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(String(rows[0].ciphertext)).not.toContain('ada@example.com');
    const reopened = new CredentialStore(new Rows(rows), fixture.masterKey);
    await reopened.warm();
    expect(reopened.label('KNOWLEDGE_REFRESH_TOKEN')).toBe('ada@example.com');
    expect(reopened.label('KNOWLEDGE_REFRESH_TOKEN')).not.toBe(secret);
  });

  it('control: a plain set keeps the label, a relabel replaces it, an empty label is refused, a row without one reads none', async () => {
    const rows: EntityRow[] = [];
    const store = new CredentialStore(new Rows(rows), fixture.masterKey);
    await store.set('kflow', 'T', 'first', 'u1', 'ada@example.com');
    await store.set('kflow', 'T', 'second', 'u1');
    expect(store.resolve('T', 'u1')).toBe('second');
    expect(store.label('T', 'u1')).toBe('ada@example.com');
    expect(store.label('T')).toBeUndefined();
    await store.set('kflow', 'T', 'third', 'u1', 'grace@example.com');
    expect(store.label('T', 'u1')).toBe('grace@example.com');
    await expect(store.set('kflow', 'K', 'v', undefined, '')).rejects.toThrow('label');
    await store.set('kflow', 'K', 'v');
    expect(store.label('K')).toBeUndefined();
  });
});
