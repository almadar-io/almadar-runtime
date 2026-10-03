/**
 * IndexedDbPersistence — the browser store for `[persistent: x, local]` entities.
 *
 * Implements the shared `PersistenceAdapter` contract, so the effect stage runs
 * `fetch`/`persist` against it exactly as a server runs them against Firestore
 * or Postgres. Sync-ready: minted ids are UUIDs, every write stamps `updatedAt`
 * and appends to an ordered change log (`__changes`) a later sync can replay.
 * `query`/`listPage` are left to the contract's fallback over `list`.
 *
 * @packageDocumentation
 */
import type { EntityRow } from "../types.js";
import type { PersistenceAdapter } from "./PersistenceAdapter.js";

/** Object store holding the append-only write log. */
export const CHANGE_LOG = "__changes";

export interface ChangeRecord {
  op: "create" | "update" | "delete";
  entityType: string;
  id: string;
  row: EntityRow | null;
  at: string;
}

export interface IndexedDbPersistenceOptions {
  /** One database per app, e.g. `almadar:<app name>`. */
  databaseName: string;
  /** Every browser-stored entity type this store holds (one object store each). */
  entityTypes: readonly string[];
  /** IndexedDB implementation; defaults to the browser's `indexedDB`. */
  factory?: IDBFactory;
  /** Clock for `updatedAt` / change stamps; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDatabase(factory: IDBFactory, name: string, version: number | undefined, stores: readonly string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? factory.open(name) : factory.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, store === CHANGE_LOG ? { autoIncrement: true } : { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbPersistence implements PersistenceAdapter {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly entityTypes: ReadonlySet<string>,
    private readonly now: () => string,
  ) {}

  /** Open (creating or upgrading) the database so it holds every listed entity type. */
  static async open(options: IndexedDbPersistenceOptions): Promise<IndexedDbPersistence> {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDbPersistence: this environment has no IndexedDB");
    const stores = [...options.entityTypes, CHANGE_LOG];
    let db = await openDatabase(factory, options.databaseName, undefined, stores);
    if (stores.some((s) => !db.objectStoreNames.contains(s))) {
      const next = db.version + 1;
      db.close();
      db = await openDatabase(factory, options.databaseName, next, stores);
    }
    return new IndexedDbPersistence(db, new Set(options.entityTypes), options.now ?? (() => new Date().toISOString()));
  }

  close(): void {
    this.db.close();
  }

  private store(entityType: string): string {
    if (!this.entityTypes.has(entityType)) {
      throw new Error(`IndexedDbPersistence: not opened with entity type "${entityType}"`);
    }
    return entityType;
  }

  private async write(entityType: string, op: ChangeRecord["op"], id: string, row: EntityRow | null): Promise<void> {
    const tx = this.db.transaction([this.store(entityType), CHANGE_LOG], "readwrite");
    if (row) tx.objectStore(entityType).put(row);
    else tx.objectStore(entityType).delete(id);
    const change: ChangeRecord = { op, entityType, id, row, at: this.now() };
    tx.objectStore(CHANGE_LOG).add(change);
    await done(tx);
  }

  async create(entityType: string, data: EntityRow): Promise<{ id: string }> {
    const id = typeof data.id === "string" && data.id.length > 0 ? data.id : crypto.randomUUID();
    await this.write(entityType, "create", id, { ...data, id, updatedAt: this.now() });
    return { id };
  }

  async update(entityType: string, id: string, data: EntityRow): Promise<void> {
    const existing = await this.getById(entityType, id);
    if (!existing) return;
    await this.write(entityType, "update", id, { ...existing, ...data, id, updatedAt: this.now() });
  }

  async delete(entityType: string, id: string): Promise<void> {
    await this.write(entityType, "delete", id, null);
  }

  async getById(entityType: string, id: string): Promise<EntityRow | null> {
    const tx = this.db.transaction(this.store(entityType), "readonly");
    const row = await request<EntityRow | undefined>(tx.objectStore(entityType).get(id));
    return row ?? null;
  }

  async list(entityType: string): Promise<EntityRow[]> {
    const tx = this.db.transaction(this.store(entityType), "readonly");
    return request<EntityRow[]>(tx.objectStore(entityType).getAll());
  }

  async countRows(entityType: string): Promise<number> {
    const tx = this.db.transaction(this.store(entityType), "readonly");
    return request<number>(tx.objectStore(entityType).count());
  }

  /** The write log, oldest first — the seam a later `sync` replays. */
  async changes(): Promise<ChangeRecord[]> {
    const tx = this.db.transaction(CHANGE_LOG, "readonly");
    return request<ChangeRecord[]>(tx.objectStore(CHANGE_LOG).getAll());
  }
}
