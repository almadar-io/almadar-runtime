import { credentialStorageKey, type CredentialIdentity, type EntityRow, type PersistenceAdapter } from '@almadar/core';

/** Entity type the credential rows persist under (never a `.lolo`-declared entity). */
export const CREDENTIAL_ENTITY_TYPE = 'AlmadarIntegrationCredential';

/** Env var holding the 64-char-hex AES-256 master key (Secret Manager in production). */
export const CREDENTIAL_MASTER_KEY_ENV = 'ALMADAR_CREDENTIAL_MASTER_KEY';

/**
 * Env var holding the PREVIOUS master key during a rotation window (I-28):
 * decryption tries the row's stamped key, `rotate()` re-encrypts every row
 * under the current key, then the previous key is retired from the env.
 */
export const CREDENTIAL_PREVIOUS_MASTER_KEY_ENV = 'ALMADAR_CREDENTIAL_MASTER_KEY_PREVIOUS';

const TAG_BYTES = 16;
const IV_BYTES = 12;

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

function environment(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env[name];
}

/** The slice of the persistence contract the credential store uses. */
export type CredentialPersistence = Pick<PersistenceAdapter, 'create' | 'update' | 'delete' | 'list'>;

/** Entity type the shared one-use values (a pending OAuth grant) persist under. */
export const DERIVED_ENTITY_TYPE = 'AlmadarKernelDerivedSecret';

/** What an adapter also offers when it can share one-use values across instances: a read by id, and a conditional delete where the store has one. */
export type DerivedPersistence = Pick<PersistenceAdapter, 'getById'> & Partial<Pick<PersistenceAdapter, 'writeWhere' | 'writeCapabilities'>>;

function keepsDerived(adapter: CredentialPersistence): adapter is CredentialPersistence & DerivedPersistence {
  return 'getById' in adapter && typeof adapter.getById === 'function';
}

function derivedId(identity: CredentialIdentity): Promise<string> {
  return sha256Hex(utf8(credentialStorageKey(identity)));
}

/** Masked view of one stored credential — safe to return to a settings page. */
export interface CredentialEntry {
  service: string;
  envVar: string;
  last4: string;
  updatedAt: number;
  principal?: CredentialIdentity['principal'];
}

interface StoredCredential extends CredentialEntry {
  id: string;
  value: string;
  label?: string;
}

function isNonEmptyString(v: EntityRow[string]): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Stable non-secret fingerprint of a master key, stamped on rows as `keyId`. */
async function keyIdOf(masterKeyHex: string): Promise<string> {
  return (await sha256Hex(fromHex(masterKeyHex))).slice(0, 16);
}

const MASTER_KEY_SHAPE = /^[0-9a-fA-F]{64}$/;

/**
 * Tenant-scoped (app-wide) credential store: one AES-256-GCM-encrypted row
 * per (service, envVar) through the host's persistence adapter, master key
 * `ALMADAR_CREDENTIAL_MASTER_KEY` held alone in the platform secret store.
 *
 * Resolution contract: credential keys ARE env-var names (the same names
 * `serviceCredentials` declares and `connectionRef` carries), so a stored
 * value transparently shadows its env counterpart — store → env →
 * unconfigured, everywhere.
 *
 * `warm()` decrypts all rows into memory so resolution stays synchronous;
 * every write re-warms the affected entry and notifies subscribers (the
 * `RuntimeIntegrationManager` re-configures on that signal, so new keys go
 * live without a restart).
 */
export class CredentialStore {
  private readonly adapter: CredentialPersistence;
  private readonly masterKeyHex: string | undefined;
  private readonly previousKeyHex: string | undefined;
  private readonly byIdentity = new Map<string, StoredCredential>();
  private readonly listeners = new Set<(principal?: string) => void>();
  private warmed = false;

  constructor(adapter: CredentialPersistence, masterKey?: string, previousMasterKey?: string) {
    this.adapter = adapter;
    const key = masterKey ?? environment(CREDENTIAL_MASTER_KEY_ENV);
    const valid = typeof key === 'string' && MASTER_KEY_SHAPE.test(key);
    if (!valid && environment('NODE_ENV') === 'production') {
      throw new Error(
        `${CREDENTIAL_MASTER_KEY_ENV} must be a 64-character hex string (32 bytes) in production — ` +
          'generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    this.masterKeyHex = valid ? key : undefined;
    const prev = previousMasterKey ?? environment(CREDENTIAL_PREVIOUS_MASTER_KEY_ENV);
    this.previousKeyHex = typeof prev === 'string' && MASTER_KEY_SHAPE.test(prev) ? prev : undefined;
  }

  /** True when a valid master key is present (writes and decryption enabled). */
  get enabled(): boolean {
    return this.masterKeyHex !== undefined;
  }

  /** Subscribe to credential changes; returns an unsubscribe function. */
  subscribe(listener: (principal?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(principal?: string): void {
    for (const listener of this.listeners) listener(principal);
  }

  private async encrypt(plaintext: string, identity?: CredentialIdentity): Promise<{ ciphertext: string; iv: string; authTag: string; keyId: string }> {
    if (!this.masterKeyHex) {
      throw new Error(`${CREDENTIAL_MASTER_KEY_ENV} is not configured — cannot store credentials`);
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await globalThis.crypto.subtle.importKey('raw', fromHex(this.masterKeyHex), 'AES-GCM', false, ['encrypt']);
    const sealed = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8, ...(identity?.principal !== undefined ? { additionalData: utf8(credentialStorageKey(identity)) } : {}) },
        key,
        utf8(plaintext),
      ),
    );
    return {
      ciphertext: toHex(sealed.subarray(0, sealed.length - TAG_BYTES)),
      iv: toHex(iv),
      authTag: toHex(sealed.subarray(sealed.length - TAG_BYTES)),
      keyId: await keyIdOf(this.masterKeyHex),
    };
  }

  private async decryptWithKey(
    keyHex: string,
    ciphertext: string,
    ivHex: string,
    authTagHex: string,
    identity?: CredentialIdentity,
  ): Promise<string> {
    const key = await globalThis.crypto.subtle.importKey('raw', fromHex(keyHex), 'AES-GCM', false, ['decrypt']);
    const body = fromHex(ciphertext);
    const tag = fromHex(authTagHex);
    const joined = new Uint8Array(body.length + tag.length);
    joined.set(body, 0);
    joined.set(tag, body.length);
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(ivHex), tagLength: TAG_BYTES * 8, ...(identity?.principal !== undefined ? { additionalData: utf8(credentialStorageKey(identity)) } : {}) },
      key,
      joined,
    );
    return new TextDecoder().decode(plain);
  }

  /**
   * Decrypt one row, selecting the key by the row's stamped `keyId` (I-28):
   * current key first, then the rotation-window previous key. Legacy rows
   * (no `keyId`) try current then previous. Returns null when no held key
   * decrypts the row — the row is unreadable, never silently wrong (GCM
   * auth tags make a wrong-key success impossible).
   */
  private async decryptRow(
    ciphertext: string,
    ivHex: string,
    authTagHex: string,
    rowKeyId?: string,
    identity?: CredentialIdentity,
  ): Promise<string | null> {
    if (!this.masterKeyHex) {
      throw new Error(`${CREDENTIAL_MASTER_KEY_ENV} is not configured — cannot decrypt credentials`);
    }
    const candidates: string[] = [];
    if (rowKeyId === undefined || rowKeyId === (await keyIdOf(this.masterKeyHex))) {
      candidates.push(this.masterKeyHex);
    }
    if (
      this.previousKeyHex !== undefined &&
      (rowKeyId === undefined || rowKeyId === (await keyIdOf(this.previousKeyHex)))
    ) {
      candidates.push(this.previousKeyHex);
    }
    for (const key of candidates) {
      try {
        return await this.decryptWithKey(key, ciphertext, ivHex, authTagHex, identity);
      } catch {
        // wrong key — try the next candidate
      }
    }
    return null;
  }

  /**
   * Load and decrypt every stored row into memory. Returns the number of
   * resolvable credentials. Without a master key nothing decrypts (rows are
   * left in place, resolution falls through to env).
   */
  async warm(): Promise<number> {
    this.byIdentity.clear();
    this.warmed = true;
    if (!this.enabled) return 0;
    const rows = await this.adapter.list(CREDENTIAL_ENTITY_TYPE);
    for (const row of rows) {
      const { id, service, envVar, ciphertext, iv, authTag, principal } = row;
      if (
        !isNonEmptyString(id) ||
        !isNonEmptyString(service) ||
        !isNonEmptyString(envVar) ||
        typeof ciphertext !== 'string' ||
        !isNonEmptyString(iv) ||
        !isNonEmptyString(authTag) ||
        (principal !== undefined && !isNonEmptyString(principal))
      ) {
        continue;
      }
      const value = await this.decryptRow(
        ciphertext,
        iv,
        authTag,
        isNonEmptyString(row.keyId) ? row.keyId : undefined,
        { name: envVar, ...(principal !== undefined ? { principal } : {}) },
      );
      if (value === null) continue;
      this.byIdentity.set(credentialStorageKey({ name: envVar, ...(principal !== undefined ? { principal } : {}) }), {
        id,
        service,
        envVar,
        value,
        last4: value.slice(-4),
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        ...(isNonEmptyString(row.label) ? { label: row.label } : {}),
        ...(principal !== undefined ? { principal } : {}),
      });
    }
    return this.byIdentity.size;
  }

  /** Resolve one credential by env-var name (warmed values only). */
  resolve(envVar: string, principal?: string): string | undefined {
    return this.byIdentity.get(credentialStorageKey({ name: envVar, ...(principal !== undefined ? { principal } : {}) }))?.value;
  }

  /** The non-secret account label stored in the clear beside a credential's ciphertext; undefined when its row carries none. */
  label(envVar: string, principal?: string): string | undefined {
    return this.byIdentity.get(credentialStorageKey({ name: envVar, ...(principal !== undefined ? { principal } : {}) }))?.label;
  }

  /** All warmed values as an env-shaped map, for merging over the process env. */
  snapshotEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of this.byIdentity.values()) {
      if (entry.principal === undefined) env[entry.envVar] = entry.value;
    }
    return env;
  }

  /** Masked entries for display — never includes plaintext. */
  entries(principal?: string): CredentialEntry[] {
    return Array.from(this.byIdentity.values())
      .filter(entry => entry.principal === principal)
      .map(({ service, envVar, last4, updatedAt, principal: owner }) => ({ service, envVar, last4, updatedAt, ...(owner !== undefined ? { principal: owner } : {}) }))
      .sort((a, b) => a.service.localeCompare(b.service) || a.envVar.localeCompare(b.envVar));
  }

  /**
   * Upsert one credential (encrypts, persists, re-warms the entry, notifies). `label` is a non-secret account name kept
   * in the clear in the row beside the ciphertext; left out, the row's label stays as it is.
   */
  async set(service: string, envVar: string, value: string, principal?: string, label?: string): Promise<CredentialEntry> {
    if (principal !== undefined && !isNonEmptyString(principal)) throw new Error('credential principal must be a nonempty string');
    if (label !== undefined && !isNonEmptyString(label)) throw new Error('credential label must be a nonempty string');
    if (!this.warmed) await this.warm();
    const identity: CredentialIdentity = { name: envVar, ...(principal !== undefined ? { principal } : {}) };
    const storageKey = credentialStorageKey(identity);
    const { ciphertext, iv, authTag, keyId } = await this.encrypt(value, identity);
    const updatedAt = Date.now();
    const existing = this.byIdentity.get(storageKey);
    const data: EntityRow = { service, envVar, ciphertext, iv, authTag, keyId, updatedAt, ...(principal !== undefined ? { principal } : {}), ...(label !== undefined ? { label } : {}) };
    let id: string;
    if (existing) {
      id = existing.id;
      await this.adapter.update(CREDENTIAL_ENTITY_TYPE, id, data);
    } else {
      ({ id } = await this.adapter.create(CREDENTIAL_ENTITY_TYPE, data));
    }
    const kept = label ?? existing?.label;
    const entry: StoredCredential = { id, service, envVar, value, last4: value.slice(-4), updatedAt, ...(kept !== undefined ? { label: kept } : {}), ...(principal !== undefined ? { principal } : {}) };
    this.byIdentity.set(storageKey, entry);
    this.notify(principal);
    const { service: s, envVar: e, last4, updatedAt: u } = entry;
    return { service: s, envVar: e, last4, updatedAt: u, ...(principal !== undefined ? { principal } : {}) };
  }

  /**
   * Re-encrypt every readable row under the CURRENT master key (I-28).
   * Rotation window: deploy the new key as `ALMADAR_CREDENTIAL_MASTER_KEY`
   * with the old one as `..._PREVIOUS`, call `rotate()`, then retire the
   * previous key. Rows no held key can read are counted, never dropped.
   */
  async rotate(): Promise<{ rotated: number; alreadyCurrent: number; unreadable: number }> {
    if (!this.masterKeyHex) {
      throw new Error(`${CREDENTIAL_MASTER_KEY_ENV} is not configured — cannot rotate`);
    }
    const currentKeyId = await keyIdOf(this.masterKeyHex);
    let rotated = 0;
    let alreadyCurrent = 0;
    let unreadable = 0;
    const rows = await this.adapter.list(CREDENTIAL_ENTITY_TYPE);
    for (const row of rows) {
      const { id, service, envVar, ciphertext, iv, authTag, principal } = row;
      if (
        !isNonEmptyString(id) ||
        !isNonEmptyString(service) ||
        !isNonEmptyString(envVar) ||
        typeof ciphertext !== 'string' ||
        !isNonEmptyString(iv) ||
        !isNonEmptyString(authTag) ||
        (principal !== undefined && !isNonEmptyString(principal))
      ) {
        unreadable += 1;
        continue;
      }
      const rowKeyId = isNonEmptyString(row.keyId) ? row.keyId : undefined;
      const identity: CredentialIdentity = { name: envVar, ...(principal !== undefined ? { principal } : {}) };
      const value = await this.decryptRow(ciphertext, iv, authTag, rowKeyId, identity);
      if (value === null) {
        unreadable += 1;
        continue;
      }
      if (rowKeyId === currentKeyId) {
        alreadyCurrent += 1;
        continue;
      }
      if (rowKeyId === undefined && (await this.decryptRow(ciphertext, iv, authTag, currentKeyId, identity)) !== null) {
        // Legacy row already under the current key — just stamp it.
        alreadyCurrent += 1;
        await this.adapter.update(CREDENTIAL_ENTITY_TYPE, id, { ...row, keyId: currentKeyId });
        continue;
      }
      const fresh = await this.encrypt(value, identity);
      await this.adapter.update(CREDENTIAL_ENTITY_TYPE, id, {
        service,
        envVar,
        ciphertext: fresh.ciphertext,
        iv: fresh.iv,
        authTag: fresh.authTag,
        keyId: fresh.keyId,
        updatedAt: Date.now(),
        ...(principal !== undefined ? { principal } : {}),
      });
      rotated += 1;
    }
    await this.warm();
    this.notify();
    return { rotated, alreadyCurrent, unreadable };
  }

  /** Whether one-use values are shared through the adapter: a master key and an adapter that reads a row by id. */
  get sharesDerived(): boolean {
    return this.enabled && keepsDerived(this.adapter);
  }

  /** Keep `value` encrypted in the adapter until `expiresAt` (epoch ms) so any instance on the same store can take it once. */
  async holdDerived(name: string, value: string, expiresAt: number, principal?: string): Promise<void> {
    const adapter = this.adapter;
    if (!this.enabled || !keepsDerived(adapter)) throw new Error('this host cannot share one-use values through its credential store');
    const identity: CredentialIdentity = { name, ...(principal !== undefined ? { principal } : {}) };
    const id = await derivedId(identity);
    const { ciphertext, iv, authTag, keyId } = await this.encrypt(value, identity);
    const fields: EntityRow = { envVar: name, ciphertext, iv, authTag, keyId, expiresAt, ...(principal !== undefined ? { principal } : {}) };
    if ((await adapter.getById(DERIVED_ENTITY_TYPE, id)) !== null) await adapter.update(DERIVED_ENTITY_TYPE, id, fields);
    else await adapter.create(DERIVED_ENTITY_TYPE, { id, ...fields });
  }

  /**
   * Remove and return a held value. Where the adapter has a conditional delete only the instance whose delete
   * lands gets the value; elsewhere the delete is unconditional, so two instances racing for one state can both
   * read it. An expired value is consumed and not returned.
   */
  async takeDerived(name: string, principal: string | undefined, now: number): Promise<string | undefined> {
    const adapter = this.adapter;
    if (!this.enabled || !keepsDerived(adapter)) return undefined;
    const identity: CredentialIdentity = { name, ...(principal !== undefined ? { principal } : {}) };
    const id = await derivedId(identity);
    const row = await adapter.getById(DERIVED_ENTITY_TYPE, id);
    if (row === null) return undefined;
    const conditional = adapter.writeCapabilities?.(DERIVED_ENTITY_TYPE)?.conditional === true;
    const outcome = conditional ? await adapter.writeWhere?.({ kind: 'delete', entityType: DERIVED_ENTITY_TYPE, id }) : undefined;
    if (outcome !== undefined) {
      if (outcome.kind !== 'deleted') return undefined;
    } else {
      await adapter.delete(DERIVED_ENTITY_TYPE, id);
    }
    const { ciphertext, iv, authTag, expiresAt } = row;
    if (typeof expiresAt !== 'number' || expiresAt <= now) return undefined;
    if (typeof ciphertext !== 'string' || !isNonEmptyString(iv) || !isNonEmptyString(authTag)) return undefined;
    return (await this.decryptRow(ciphertext, iv, authTag, isNonEmptyString(row.keyId) ? row.keyId : undefined, identity)) ?? undefined;
  }

  /** Delete one credential row; resolution falls back to env afterwards. */
  async remove(envVar: string, principal?: string): Promise<boolean> {
    if (!this.warmed) await this.warm();
    const storageKey = credentialStorageKey({ name: envVar, ...(principal !== undefined ? { principal } : {}) });
    const existing = this.byIdentity.get(storageKey);
    if (!existing) return false;
    await this.adapter.delete(CREDENTIAL_ENTITY_TYPE, existing.id);
    this.byIdentity.delete(storageKey);
    this.notify(principal);
    return true;
  }
}
