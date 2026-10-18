/** The credential store of a browser host: the server host's encrypted rows over `chrome.storage`, never a second store. */
import { EntityRowSchema, type EntityRow } from '@almadar/core';
import { CREDENTIAL_ENTITY_TYPE, CredentialStore, type CredentialPersistence } from '../credentials/store.js';

/** The slice of `chrome.storage` a browser host keeps its rows in. */
export interface ChromeStorageArea {
  get(key: string): Promise<Record<string, object>>;
  set(items: Record<string, object>): Promise<void>;
  remove(key: string): Promise<void>;
}

export const CHROME_CREDENTIAL_ROWS_KEY = 'almadar.credentials.rows';
export const CHROME_CREDENTIAL_MASTER_KEY = 'almadar.credentials.masterKey';

/** The store's rows kept as one array under one `chrome.storage` key; writes are applied one after another. */
export function chromeCredentialRows(storage: ChromeStorageArea): CredentialPersistence {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<EntityRow[]> => {
    const held = (await storage.get(CHROME_CREDENTIAL_ROWS_KEY))[CHROME_CREDENTIAL_ROWS_KEY];
    const rows = EntityRowSchema.array().safeParse(held);
    return rows.success ? rows.data : [];
  };
  const write = (rows: EntityRow[]): Promise<void> => storage.set({ [CHROME_CREDENTIAL_ROWS_KEY]: rows });
  const change = <T>(work: (rows: EntityRow[]) => Promise<T> | T): Promise<T> => {
    const next = queue.then(async () => work(await read()));
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    async list(entityType) {
      if (entityType !== CREDENTIAL_ENTITY_TYPE) return [];
      await queue;
      return read();
    },
    create: (_entityType, data) =>
      change(async (rows) => {
        const id = globalThis.crypto.randomUUID();
        await write([...rows, { ...data, id }]);
        return { id };
      }),
    update: (_entityType, id, data) =>
      change(async (rows) => {
        await write(rows.map((row) => (row.id === id ? { ...row, ...data, id } : row)));
      }),
    delete: (_entityType, id) =>
      change(async (rows) => {
        await write(rows.filter((row) => row.id !== id));
      }),
  };
}

function randomMasterKey(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The warmed credential store of this browser profile. Its master key is minted on first use and kept in the same
 * extension storage, so the rows stay in the server host's format while the browser's own storage isolation is what protects them.
 */
export async function createChromeCredentialStore(storage: ChromeStorageArea): Promise<CredentialStore> {
  const held = (await storage.get(CHROME_CREDENTIAL_MASTER_KEY))[CHROME_CREDENTIAL_MASTER_KEY];
  let masterKey = typeof held === 'object' && 'key' in held && typeof held.key === 'string' ? held.key : undefined;
  if (masterKey === undefined) {
    masterKey = randomMasterKey();
    await storage.set({ [CHROME_CREDENTIAL_MASTER_KEY]: { key: masterKey } });
  }
  const store = new CredentialStore(chromeCredentialRows(storage), masterKey);
  await store.warm();
  return store;
}
