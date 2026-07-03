/**
 * PersistenceAdapter — the storage contract for runtime effect handlers.
 *
 * The server-side runtime and the in-browser mock runtime both invoke
 * `fetch` / `persist` / `ref` / `deref` / `swap!` effects against an
 * implementation of this interface. Extracted from
 * `OrbitalServerRuntime.ts` so it can be imported by browser code that
 * cannot depend on the server module (which pulls in express).
 *
 * @packageDocumentation
 */
import type { EntityRow } from "./types.js";

/**
 * Storage contract for CRUD operations on runtime entity rows.
 *
 * Implementations:
 * - `InMemoryPersistence` (this file) — simple Map-backed store, used by
 *   the browser mock runtime and as the default when an adapter is not
 *   supplied to `OrbitalServerRuntime`.
 * - `MockPersistenceAdapter` — in-memory with faker-generated seed data
 *   for realistic preview content.
 * - Consumer-provided (e.g. Firestore, Postgres) for production servers.
 */
export interface PersistenceAdapter {
  create(entityType: string, data: EntityRow): Promise<{ id: string }>;
  update(entityType: string, id: string, data: EntityRow): Promise<void>;
  delete(entityType: string, id: string): Promise<void>;
  getById(entityType: string, id: string): Promise<EntityRow | null>;
  list(entityType: string): Promise<EntityRow[]>;
}

/**
 * Simple in-memory persistence for dev/testing and offline previews.
 * Keys each entity collection by type, rows by generated string id.
 */
export class InMemoryPersistence implements PersistenceAdapter {
  private data = new Map<string, Map<string, EntityRow>>();
  private idCounter = 0;

  /**
   * Seed the store with pre-existing rows.
   *
   * Accepts either a plain `Record<entityType, EntityRow[]>` or an iterable
   * of `[entityType, EntityRow[]]` entries. Rows without an `id` get one
   * generated at insert time; rows with an `id` keep it (so re-seeding
   * after a schema rebuild preserves identities used in render bindings).
   */
  seed(seedData: Record<string, EntityRow[]> | Iterable<[string, EntityRow[]]>): void {
    const entries: Iterable<[string, EntityRow[]]> =
      Symbol.iterator in Object(seedData)
        ? (seedData as Iterable<[string, EntityRow[]]>)
        : Object.entries(seedData as Record<string, EntityRow[]>);
    for (const [entityType, rows] of entries) {
      if (!this.data.has(entityType)) {
        this.data.set(entityType, new Map());
      }
      const collection = this.data.get(entityType)!;
      for (const row of rows) {
        const id = (row.id as string) || `${entityType}-${++this.idCounter}`;
        collection.set(id, { ...row, id });
      }
    }
  }

  async create(
    entityType: string,
    data: EntityRow,
  ): Promise<{ id: string }> {
    const id = (data.id as string) || `${entityType}-${++this.idCounter}`;
    if (!this.data.has(entityType)) {
      this.data.set(entityType, new Map());
    }
    this.data.get(entityType)!.set(id, { ...data, id });
    return { id };
  }

  async update(
    entityType: string,
    id: string,
    data: EntityRow,
  ): Promise<void> {
    const collection = this.data.get(entityType);
    if (collection?.has(id)) {
      const existing = collection.get(id)!;
      collection.set(id, { ...existing, ...data });
    }
  }

  async delete(entityType: string, id: string): Promise<void> {
    this.data.get(entityType)?.delete(id);
  }

  async getById(
    entityType: string,
    id: string,
  ): Promise<EntityRow | null> {
    return this.data.get(entityType)?.get(id) || null;
  }

  async list(entityType: string): Promise<EntityRow[]> {
    const collection = this.data.get(entityType);
    return collection ? Array.from(collection.values()) : [];
  }

  /**
   * Snapshot the entire store as a plain object (entityType → rows).
   * Useful for feeding a fresh render-time binding layer with the
   * current persistence view.
   */
  snapshot(): Record<string, EntityRow[]> {
    const out: Record<string, EntityRow[]> = {};
    for (const [entityType, collection] of this.data) {
      out[entityType] = Array.from(collection.values());
    }
    return out;
  }
}
