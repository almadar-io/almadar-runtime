// The browser host's credential store: the server host's encrypted rows kept in `chrome.storage`, run against a fake of it.
import { describe, expect, it } from 'vitest';
import {
  CHROME_CREDENTIAL_MASTER_KEY,
  CHROME_CREDENTIAL_ROWS_KEY,
  createChromeCredentialStore,
  type ChromeStorageArea,
} from '../src/host/chrome/index.js';

function storageArea(): ChromeStorageArea & { held: Map<string, object> } {
  const held = new Map<string, object>();
  return {
    held,
    async get(key) {
      const value = held.get(key);
      return value === undefined ? {} : { [key]: value };
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) held.set(key, structuredClone(value));
    },
    async remove(key) {
      held.delete(key);
    },
  };
}

describe('chrome credential store', () => {
  it('keeps encrypted rows in storage that a later store reads back, with the label in the clear and the secret nowhere', async () => {
    const storage = storageArea();
    const store = await createChromeCredentialStore(storage);
    await store.set('kernel', 'KNOWLEDGE_REFRESH_TOKEN', '1//firebase-refresh-SECRET', undefined, 'ada@example.com');
    const text = JSON.stringify(storage.held.get(CHROME_CREDENTIAL_ROWS_KEY));
    expect(text).toContain('ada@example.com');
    expect(text).not.toContain('firebase-refresh-SECRET');
    const reopened = await createChromeCredentialStore(storage);
    expect(reopened.resolve('KNOWLEDGE_REFRESH_TOKEN')).toBe('1//firebase-refresh-SECRET');
    expect(reopened.label('KNOWLEDGE_REFRESH_TOKEN')).toBe('ada@example.com');
    await reopened.remove('KNOWLEDGE_REFRESH_TOKEN');
    expect((await createChromeCredentialStore(storage)).resolve('KNOWLEDGE_REFRESH_TOKEN')).toBeUndefined();
  });

  it('control: the master key is minted once, a lost key makes the rows unreadable rather than wrong, and an empty profile holds nothing', async () => {
    const storage = storageArea();
    const first = await createChromeCredentialStore(storage);
    await first.set('kernel', 'K', 'v');
    const key = JSON.stringify(storage.held.get(CHROME_CREDENTIAL_MASTER_KEY));
    await createChromeCredentialStore(storage);
    expect(JSON.stringify(storage.held.get(CHROME_CREDENTIAL_MASTER_KEY))).toBe(key);
    storage.held.set(CHROME_CREDENTIAL_MASTER_KEY, { key: '11'.repeat(32) });
    expect((await createChromeCredentialStore(storage)).resolve('K')).toBeUndefined();
    expect((await createChromeCredentialStore(storageArea())).entries()).toEqual([]);
  });

  it('serialises concurrent writes so no row is lost', async () => {
    const storage = storageArea();
    const store = await createChromeCredentialStore(storage);
    await Promise.all(['A', 'B', 'C'].map((name) => store.set('kernel', name, `value-${name}`)));
    const reopened = await createChromeCredentialStore(storage);
    expect(['A', 'B', 'C'].map((name) => reopened.resolve(name))).toEqual(['value-A', 'value-B', 'value-C']);
  });
});
