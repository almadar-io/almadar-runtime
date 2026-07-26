/**
 * MockPersistenceAdapter - In-memory data store with seeded mock generation
 *
 * Provides a stateful mock data layer that implements PersistenceAdapter.
 * Uses a lightweight seeded PRNG so the client bundle does not pull in faker.
 *
 * @packageDocumentation
 */

import type { PersistenceAdapter } from './OrbitalServerRuntime.js';
import type { EntityRow } from './types.js';
import type { EntityField, EntityId, EntityPersistence, FieldValue } from '@almadar/core';
import { sampleRow, sampleRowCount } from '@almadar/core/mock';
import { createLogger } from '@almadar/logger';
import {
  seedRandom,
  randomArrayElement,
  randomInt,
  shuffleArray,
  randomPastDate,
} from './mockRandom.js';

const mockLog = createLogger('almadar:runtime:mock');

/** Default seed used when callers don't provide one. Fixed so re-seeds
 *  during hermetic-frame mode produce identical row data each time —
 *  matching the compiled path's compile-baked-in mock semantics. */
const DEFAULT_MOCK_SEED = 42;

/** Reference timestamp used as `now` for seeded rows. Deterministic so
 *  diff observers don't see all rows as "changed" between frames just
 *  because the wallclock advanced. */
const SEED_REFERENCE_TIMESTAMP = '2024-01-01T00:00:00.000Z';

// ============================================================================
// Types
// ============================================================================

// EntityField is the canonical discriminated union from @almadar/core
// (re-exported here so existing consumers don't break). All variant-specific
// fields (`items`, `properties`, `relation`, `values`, `format`) live on the
// canonical type — no local shadow shape.
export type { EntityField };

/** EntityField narrowed to require `name`. The canonical type makes `name`
 *  optional (it's omitted on nested `items` / `properties` descriptors), but
 *  the seed loop iterates by name. Callers filter for name-having fields
 *  at the registerEntity boundary. */
type NamedEntityField = EntityField & { name: string };

export interface EntitySchema {
  name: string;
  /** V4 dual-carry id sibling of `name` — optional until the Phase-7 flip. */
  id?: EntityId;
  fields: NamedEntityField[];
  /** Pre-authored instance data from the schema (used instead of generated mocks) */
  seedData?: EntityRow[];
  /** A `[runtime]` entity is a per-orbital singleton, so it seeds ONE row whose
   *  values equal its declared defaults. Without this the persistence layer can
   *  disagree with the declared-default layer in the `@entity` merge and boot a
   *  machine into the wrong state. */
  persistence?: EntityPersistence;
}

export interface MockPersistenceConfig {
  /** Seed for deterministic generation */
  seed?: number;
  /** Default number of records to generate per entity */
  defaultSeedCount?: number;
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Make the signed-in viewer own some of the seeded rows.
   *
   * An ownership-scoped view (`only my bookings`, `my prescriptions`) filters
   * rows by `@user.id`. Faker-seeded owner columns hold random ids, so such a
   * view is ALWAYS empty in mock mode and cannot be told apart from a broken
   * filter — the exact ambiguity that cost this campaign a debugging cycle.
   *
   * `ownerFields` names the columns that hold a user id, as `Entity.field`
   * pairs — declared explicitly, never inferred from a field's name. Every
   * other seeded row is assigned `ownerId`, so a scoped view has real data AND
   * the scoping stays observable (a second persona sees the complement).
   */
  ownerId?: string;
  ownerFields?: string[];
}

// ============================================================================
// MockPersistenceAdapter
// ============================================================================

/**
 * In-memory mock data store with CRUD operations and seeded mock generation.
 */
export class MockPersistenceAdapter implements PersistenceAdapter {
  private stores: Map<string, Map<string, EntityRow>> = new Map();
  private schemas: Map<string, EntitySchema> = new Map();
  private idCounters: Map<string, number> = new Map();
  /** entityId -> normalized store name, so relation lookups can prefer the id sibling over `relation.entity` name-matching. */
  private storeNameById: Map<string, string> = new Map();
  private config: MockPersistenceConfig;

  constructor(config: MockPersistenceConfig = {}) {
    this.config = {
      defaultSeedCount: 6,
      debug: false,
      ...config,
      // Apply default after spread so an undefined `seed` in the
      // input doesn't overwrite the default.
      seed: config.seed ?? DEFAULT_MOCK_SEED,
    };
    seedRandom(this.config.seed);
    mockLog.debug('mock:adapter:init', { seed: this.config.seed });
  }

  /** Re-anchor the PRNG to the configured seed. Called before every
   *  re-seed loop so identical reseed sequences produce identical rows
   *  (timestamps + generated fields). Without this, the first
   *  reseed produces row set A, the second produces row set B, and
   *  diff observers see all rows as "changed" between frames. */
  resetFakerSeed(): void {
    if (this.config.seed !== undefined) {
      seedRandom(this.config.seed);
    }
  }

  // ============================================================================
  // Store Management
  // ============================================================================

  private getStore(entityName: string): Map<string, EntityRow> {
    const normalized = entityName.toLowerCase();
    if (!this.stores.has(normalized)) {
      this.stores.set(normalized, new Map());
      this.idCounters.set(normalized, 0);
    }
    return this.stores.get(normalized)!;
  }

  private nextId(entityName: string): string {
    const normalized = entityName.toLowerCase();
    const counter = (this.idCounters.get(normalized) ?? 0) + 1;
    this.idCounters.set(normalized, counter);
    return `${this.capitalizeFirst(entityName)} Id ${counter}`;
  }

  // ============================================================================
  // Schema & Seeding
  // ============================================================================

  /**
   * Register an entity schema and seed mock data.
   * If the schema has seedData, those instances are used directly.
   * Otherwise, random mock data is generated with the seeded PRNG.
   */
  registerEntity(schema: EntitySchema, seedCount?: number): void {
    const normalized = schema.name.toLowerCase();
    this.schemas.set(normalized, schema);
    if (schema.id) {
      this.storeNameById.set(schema.id, normalized);
    }

    if (schema.seedData && schema.seedData.length > 0) {
      // Seed with actual pre-authored instances
      this.seedFromInstances(schema.name, schema.seedData);
    } else {
      const requested = seedCount ?? this.config.defaultSeedCount ?? 6;
      const count = sampleRowCount(
        { name: schema.name, persistence: schema.persistence, fields: schema.fields },
        requested,
      );
      this.seed(schema.name, schema.fields, count, schema.persistence);
    }

    // Phase 9.6.A: re-link relation fields across ALL registered entities.
    // Relations may point at entities registered before OR after this one;
    // a global pass after each registration is cheap (O(rows × fields)) and
    // keeps relation arrays in sync with whichever stores currently exist.
    this.linkRelationFields();
  }

  /**
   * Walk every row of every registered entity and fill in `type: "relation"`
   * fields with real IDs from the target entity's store. Without this pass,
   * relation fields stay as placeholder `[]` / `""` and `populateRelations`
   * in OrbitalServerRuntime has nothing to hydrate — catalog/preview demos
   * of nested-tree atoms (e.g. std-thread-comments-linear with ThreadPost.
   * replies → [ThreadPost]) render empty reply cards.
   *
   * For self-referential relations, each row gets 2–4 sibling IDs (excluding
   * self). For cross-entity relations, IDs are picked from the target store.
   * The runtime caps recursion at depth=2 in `populateRelations`, so
   * grandparent-of-self cycles render two levels deep then stop.
   */
  linkRelationFields(): void {
    for (const [normalizedName, schema] of this.schemas) {
      const store = this.stores.get(normalizedName);
      if (!store) continue;
      // Narrow to RelationEntityField (with required `relation` config) via the
      // canonical discriminator. The `f is NamedEntityField & { type: "relation" }`
      // predicate is what makes `field.relation` typed in the loop below — no
      // record-access casts, no unknown narrowing.
      const relationFields = schema.fields.filter(
        (f): f is NamedEntityField & { type: 'relation'; relation: { entity: string; entityId?: EntityId; cardinality?: string; field?: string } } =>
          f.type === 'relation',
      );
      if (relationFields.length === 0) continue;
      for (const row of store.values()) {
        for (const field of relationFields) {
          // Id-primary: prefer the `entityId` sibling via the id->name index,
          // falling back to the `entity` name string when the id is absent
          // or unindexed (transition-period tolerance).
          const targetNormalized =
            (field.relation.entityId && this.storeNameById.get(field.relation.entityId)) ??
            field.relation.entity.toLowerCase();
          const targetStore = this.stores.get(targetNormalized);
          if (!targetStore || targetStore.size === 0) continue;
          // Eligible IDs: every id in the target store, minus this row's own id
          // (only when target === self entity) so a comment doesn't list itself
          // as its own reply.
          const selfId = row['id'] as string | undefined;
          const sameStore = targetStore === store;
          const eligible: string[] = [];
          for (const id of targetStore.keys()) {
            if (sameStore && id === selfId) continue;
            eligible.push(id);
          }
          if (eligible.length === 0) continue;
          const cardinality = field.relation.cardinality ?? 'many';
          if (cardinality === 'one' || cardinality === 'many-to-one') {
            row[field.name] = randomArrayElement(eligible);
          } else {
            // many / one-to-many / many-to-many → pick 2–4 IDs
            const pickCount = Math.min(eligible.length, randomInt({ min: 2, max: 4 }));
            row[field.name] = shuffleArray(eligible.slice()).slice(0, pickCount);
          }
        }
      }
    }
  }

  /**
   * Seed an entity with pre-authored instance data.
   */
  seedFromInstances(entityName: string, instances: EntityRow[]): void {
    const store = this.getStore(entityName);

    if (this.config.debug) {
      mockLog.debug('seeding-from-instances', { count: instances.length, entity: entityName });
    }

    for (const instance of instances) {
      const id = (instance.id as string) || this.nextId(entityName);
      const item: EntityRow = {
        ...instance,
        id,
        createdAt: instance.createdAt as string || SEED_REFERENCE_TIMESTAMP,
        updatedAt: SEED_REFERENCE_TIMESTAMP,
      };
      store.set(id, item);
    }
  }

  /**
   * Seed an entity with mock data.
   */
  seed(entityName: string, fields: EntityField[], count: number, persistence?: EntityPersistence): void {
    const store = this.getStore(entityName);
    const normalized = entityName.toLowerCase();

    if (this.config.debug) {
      mockLog.debug('seeding', { count, entity: entityName });
    }

    // Declared owner columns for THIS entity (see MockPersistenceConfig.ownerFields).
    const ownerCols = (this.config.ownerFields ?? [])
      .map((pair) => pair.split('.'))
      .filter(([ent]) => ent?.toLowerCase() === normalized)
      .map(([, field]) => field)
      .filter((field): field is string => Boolean(field));
    const ownerId = this.config.ownerId;

    const generated: Array<{ id: string; updatedAt: string }> = [];
    for (let i = 0; i < count; i++) {
      const item = this.generateMockItem(entityName, fields, i + 1, persistence);
      // Give the viewer every other row, so an ownership-scoped view has real
      // data while a second persona still sees a different set.
      if (ownerId && ownerCols.length > 0 && i % 2 === 0) {
        for (const col of ownerCols) item[col] = ownerId;
      }
      store.set(item.id as string, item);
      generated.push({
        id: item.id as string,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      });
    }
    mockLog.debug('mock:seed', () => ({ entityName, count, idsAndTimestamps: JSON.stringify(generated) }));
  }

  /**
   * Generate a single mock item. Field values come from the canonical policy in
   * `@almadar/core/mock`; this method owns only the id and timestamp stamping.
   */
  private generateMockItem(
    entityName: string,
    fields: EntityField[],
    index: number,
    persistence?: EntityPersistence,
  ): EntityRow {
    const id = this.nextId(entityName);
    // Deterministic timestamps: keep updatedAt anchored at the seed
    // reference so re-seeded rows compare identically across hermetic
    // frames. createdAt uses the seeded PRNG to simulate a realistic creation date.
    return {
      ...sampleRow(
        { name: entityName, persistence, fields },
        { index, strategy: 'seeded', persistence },
      ),
      id,
      createdAt: randomPastDate({ years: 1 }).toISOString(),
      updatedAt: SEED_REFERENCE_TIMESTAMP,
    };
  }


  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // ============================================================================
  // PersistenceAdapter Implementation
  // ============================================================================

  async create(
    entityType: string,
    data: EntityRow
  ): Promise<{ id: string }> {
    const store = this.getStore(entityType);
    const id = this.nextId(entityType);
    const now = new Date().toISOString();

    const withDefaults = this.applyFieldDefaults(entityType, data);

    const item = {
      ...withDefaults,
      id,
      createdAt: now,
      updatedAt: now,
    };

    store.set(id, item);
    return { id };
  }

  /**
   * Fill in any entity-declared field defaults that the caller omitted.
   * SAVE payloads coming from form-section only carry the fields the user
   * edited; persisted rows should still honor `field.default` so downstream
   * row-content probes (VG11f) see a row whose every declared-default field
   * is non-empty. `@now` resolves to the current ISO timestamp.
   */
  private applyFieldDefaults(entityType: string, data: EntityRow): EntityRow {
    const schema = this.schemas.get(entityType.toLowerCase());
    if (!schema) return data;
    const result: EntityRow = { ...data };
    for (const field of schema.fields) {
      if (field.name === 'id' || field.name === 'createdAt' || field.name === 'updatedAt') continue;
      if (result[field.name] !== undefined) continue;
      if (field.default === undefined) continue;
      result[field.name] = field.default === '@now'
        ? new Date().toISOString()
        : (field.default as FieldValue);
    }
    return result;
  }

  async update(
    entityType: string,
    id: string,
    data: EntityRow
  ): Promise<void> {
    const store = this.getStore(entityType);
    const existing = store.get(id);

    if (!existing) {
      throw new Error(`Entity ${entityType} with id ${id} not found`);
    }

    const updated = {
      ...existing,
      ...data,
      id, // Preserve original ID
      updatedAt: new Date().toISOString(),
    };

    store.set(id, updated);
  }

  async delete(entityType: string, id: string): Promise<void> {
    const store = this.getStore(entityType);
    if (!store.has(id)) {
      throw new Error(`Entity ${entityType} with id ${id} not found`);
    }
    store.delete(id);
  }

  async getById(
    entityType: string,
    id: string
  ): Promise<EntityRow | null> {
    const store = this.getStore(entityType);
    return store.get(id) ?? null;
  }

  async list(entityType: string): Promise<Array<EntityRow>> {
    const store = this.getStore(entityType);
    return Array.from(store.values());
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Clear all data for an entity.
   */
  clear(entityName: string): void {
    const normalized = entityName.toLowerCase();
    this.stores.delete(normalized);
    this.idCounters.delete(normalized);
  }

  /** Clear all data + re-anchor the PRNG so the next seed loop reproduces
   *  identical rows. Hermetic-frame mode calls this between every step
   *  via OrbitalServerRuntime.resetMockPersistence. */
  clearAll(): void {
    this.stores.clear();
    this.idCounters.clear();
    this.resetFakerSeed();
    mockLog.debug('mock:adapter:clearAll', { reanchored: this.config.seed });
  }

  /**
   * Get count of items for an entity.
   */
  count(entityName: string): number {
    const store = this.getStore(entityName);
    return store.size;
  }
}

/**
 * Create a MockPersistenceAdapter instance.
 */
export function createMockPersistence(config?: MockPersistenceConfig): MockPersistenceAdapter {
  return new MockPersistenceAdapter(config);
}
