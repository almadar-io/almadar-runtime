/**
 * MockPersistenceAdapter - In-memory data store with faker-based mock generation
 *
 * Provides a stateful mock data layer that implements PersistenceAdapter.
 * Uses @faker-js/faker for realistic data generation based on field types.
 *
 * @packageDocumentation
 */

import { faker } from '@faker-js/faker';
import type { PersistenceAdapter } from './OrbitalServerRuntime.js';
import type { EntityRow } from './types.js';
import type { FieldValue } from '@almadar/core';
import { createLogger } from '@almadar/logger';

const mockLog = createLogger('almadar:runtime:mock');

/** Default seed used when callers don't provide one. Fixed so re-seeds
 *  during hermetic-frame mode produce identical row data each time —
 *  matching the compiled path's compile-baked-in mock semantics. */
const DEFAULT_MOCK_SEED = 42;

/** Return a deterministic stock-photo URL from Picsum Photos.
 *  Free, no API key, seed-stable so the same entity+field always renders
 *  the same image across reruns. Used for fields declaring
 *  `format: "image" | "avatar" | "thumbnail"` and a few well-known field
 *  names (`imageUrl`, `photo`, etc.). */
function picsumUrl(entityName: string, fieldName: string, width = 400, height = 400): string {
  const seed = `${entityName}-${fieldName}-${faker.number.int({ min: 0, max: 1000 })}`;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${width}/${height}`;
}
/** Reference timestamp used as `now` for seeded rows. Deterministic so
 *  diff observers don't see all rows as "changed" between frames just
 *  because the wallclock advanced. */
const SEED_REFERENCE_TIMESTAMP = '2024-01-01T00:00:00.000Z';

// ============================================================================
// Types
// ============================================================================

export interface EntityField {
  name: string;
  type: string;
  required?: boolean;
  values?: string[]; // For enum types
  default?: unknown;
  /** Validation format: email/url/phone/date/datetime/uuid. Drives mock-value shape without name heuristics. */
  format?: 'email' | 'url' | 'phone' | 'date' | 'datetime' | 'uuid' | 'image' | 'avatar' | 'thumbnail';
  /** Element schema for `type: 'array'`. When omitted, arrays default to []. Mirrors `ArrayEntityField.items` in @almadar/core. */
  items?: EntityField;
  /** Property schemas for `type: 'object'` (or array-of-object via `items.properties`). Mirrors `EntityFieldBase.properties` in @almadar/core. */
  properties?: Record<string, EntityField>;
}

export interface EntitySchema {
  name: string;
  fields: EntityField[];
  /** Pre-authored instance data from the schema (used instead of faker generation) */
  seedData?: EntityRow[];
}

export interface MockPersistenceConfig {
  /** Seed for deterministic generation */
  seed?: number;
  /** Default number of records to generate per entity */
  defaultSeedCount?: number;
  /** Enable debug logging */
  debug?: boolean;
}

// ============================================================================
// MockPersistenceAdapter
// ============================================================================

/**
 * In-memory mock data store with CRUD operations and faker-based seeding.
 */
export class MockPersistenceAdapter implements PersistenceAdapter {
  private stores: Map<string, Map<string, EntityRow>> = new Map();
  private schemas: Map<string, EntitySchema> = new Map();
  private idCounters: Map<string, number> = new Map();
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
    faker.seed(this.config.seed);
    mockLog.debug('mock:adapter:init', { seed: this.config.seed });
  }

  /** Re-anchor faker's PRNG to the configured seed. Called before every
   *  re-seed loop so identical reseed sequences produce identical rows
   *  (timestamps + faker-generated fields). Without this, the first
   *  reseed produces row set A, the second produces row set B, and
   *  diff observers see all rows as "changed" between frames. */
  resetFakerSeed(): void {
    if (this.config.seed !== undefined) {
      faker.seed(this.config.seed);
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
   * Otherwise, random mock data is generated with faker.
   */
  registerEntity(schema: EntitySchema, seedCount?: number): void {
    const normalized = schema.name.toLowerCase();
    this.schemas.set(normalized, schema);

    if (schema.seedData && schema.seedData.length > 0) {
      // Seed with actual pre-authored instances
      this.seedFromInstances(schema.name, schema.seedData);
    } else {
      const count = seedCount ?? this.config.defaultSeedCount ?? 6;
      this.seed(schema.name, schema.fields, count);
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
  seed(entityName: string, fields: EntityField[], count: number): void {
    const store = this.getStore(entityName);
    const normalized = entityName.toLowerCase();

    if (this.config.debug) {
      mockLog.debug('seeding', { count, entity: entityName });
    }

    const generated: Array<{ id: string; updatedAt: string }> = [];
    for (let i = 0; i < count; i++) {
      const item = this.generateMockItem(normalized, entityName, fields, i + 1);
      store.set(item.id as string, item);
      generated.push({
        id: item.id as string,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      });
    }
    mockLog.debug('mock:seed', () => ({ entityName, count, idsAndTimestamps: JSON.stringify(generated) }));
  }

  /**
   * Generate a single mock item based on field schemas.
   */
  private generateMockItem(
    normalizedName: string,
    entityName: string,
    fields: EntityField[],
    index: number
  ): EntityRow {
    const id = this.nextId(entityName);
    // Deterministic timestamps: keep updatedAt anchored at the seed
    // reference so re-seeded rows compare identically across hermetic
    // frames. createdAt uses faker (also deterministic with seed) to
    // simulate a realistic creation date.
    const item: EntityRow = {
      id,
      createdAt: faker.date.past({ years: 1 }).toISOString(),
      updatedAt: SEED_REFERENCE_TIMESTAMP,
    };

    for (const field of fields) {
      if (field.name === 'id' || field.name === 'createdAt' || field.name === 'updatedAt') {
        continue;
      }
      item[field.name] = this.generateFieldValue(entityName, field, index);
    }

    return item;
  }

  /**
   * Generate a mock value for a field based on its schema.
   */
  private generateFieldValue(entityName: string, field: EntityField, index: number): FieldValue {
    // Mock-seed default policy: numeric fields preserve their declared
    // default (so `tokenCount : number = 0` stays 0), every other type
    // falls through to faker. Mirrors the gate in the compiled-path
    // codegen (`backend.rs:generate_seed_mock_data`). String/enum/bool/
    // date placeholder defaults like `name = ""` would otherwise paint
    // every seeded row with the same literal.
    const fieldTypeLc = field.type.toLowerCase();
    mockLog.debug('field:generate', {
      entityName,
      fieldName: field.name,
      fieldType: fieldTypeLc,
      hasValues: !!field.values?.length,
      valuesCount: field.values?.length ?? 0,
      values: field.values?.length ? field.values.join(',') : null,
      format: field.format ?? null,
      hasDefault: field.default !== undefined,
    });
    const isNumeric = fieldTypeLc === 'number' || fieldTypeLc === 'integer';
    if (isNumeric && field.default !== undefined) {
      return field.default as FieldValue;
    }

    // Always populate seeded fields. The previous 80% heuristic dropped
    // ~20% of optional fields to null to "exercise the UI's empty path",
    // but that flaked runtime-verify — a seeded row could silently come
    // out with `name=null` and the DataGrid would render a blank-title
    // card that didn't match any test expectation. Deterministic seed
    // data is more valuable than random-nil stress; callers who want
    // nil-testing should construct that scenario explicitly.
    switch (fieldTypeLc) {
      case 'string':
        return this.generateStringValue(entityName, field, index);

      case 'number':
        return faker.number.int({ min: 0, max: 100 });

      case 'boolean':
        return faker.datatype.boolean();

      case 'date':
      case 'timestamp':
      case 'datetime':
        return this.generateDateValue(field);

      case 'enum':
        if (field.values && field.values.length > 0) {
          return faker.helpers.arrayElement(field.values);
        }
        return null;

      case 'relation':
        return null; // Relations need special handling

      case 'array':
        return this.generateArrayValue(entityName, field, index);
      case 'object':
        return this.generateObjectValue(entityName, field, index);

      default:
        // Treat unknown types as strings
        return this.generateStringValue(entityName, field, index);
    }
  }

  /**
   * Generate 3–5 elements for an array field. When `items` describes an
   * object shape (the common case for `tiles: [KpiTile]`-style declarations),
   * each element is recursively mock-generated against `items.properties`.
   * When `items` describes a scalar, each element uses the scalar generator
   * for that type. When `items` is missing (legacy `[object] = []` declarations
   * with no element schema), falls back to an empty array — the historical
   * behavior.
   */
  private generateArrayValue(entityName: string, field: EntityField, index: number): FieldValue {
    if (!field.items) return [];
    const count = faker.number.int({ min: 3, max: 5 });
    const out: FieldValue[] = [];
    for (let i = 0; i < count; i++) {
      // Synthesize a child EntityField for the element. Each iteration gets a
      // fresh `index` so per-element string generators don't repeat verbatim.
      const elementField: EntityField = {
        ...field.items,
        name: `${field.name}[${i}]`,
      };
      out.push(this.generateFieldValue(entityName, elementField, index * 10 + i));
    }
    return out as FieldValue;
  }

  /**
   * Generate a single object value with each declared property populated
   * by faker. Walks `properties` and recursively delegates to
   * `generateFieldValue` per property so nested objects-of-arrays-of-objects
   * compose correctly.
   */
  private generateObjectValue(entityName: string, field: EntityField, index: number): FieldValue {
    if (!field.properties) return null;
    const out: Record<string, FieldValue> = {};
    for (const [propName, propField] of Object.entries(field.properties)) {
      // The nested schema may omit `name` (it's implied by the parent key)
      // — synthesize one so downstream string generators that read `field.name`
      // have something to log against.
      const childField: EntityField = { ...propField, name: propName };
      out[propName] = this.generateFieldValue(entityName, childField, index);
    }
    return out as FieldValue;
  }

  /**
   * Generate a string value based on the field's declared schema metadata.
   * Reads `values` (enum) first, then `format` (email/url/phone/uuid/date/
   * datetime), then falls back to faker.lorem.words. No field-name heuristics
   * — the schema is the source of truth. If a caller needs a real email, they
   * declare `format: "email"`; if they need an enum, they declare `values: [...]`.
   */
  private generateStringValue(entityName: string, field: EntityField, _index: number): string {
    if (field.values && field.values.length > 0) {
      return faker.helpers.arrayElement(field.values);
    }
    switch (field.format) {
      case 'email': return faker.internet.email();
      case 'url': return faker.internet.url();
      case 'phone': return faker.phone.number();
      case 'uuid': return faker.string.uuid();
      case 'date': return faker.date.recent().toISOString().split('T')[0]!;
      case 'datetime': return faker.date.recent().toISOString();
      case 'image':
      case 'avatar':
      case 'thumbnail':
        return picsumUrl(entityName, field.name);
    }
    // Field-name fallback for image-bearing string fields. Authors who haven't
    // (yet) annotated `format: "image"` still get a real photo from Picsum
    // rather than a `faker.lorem.words(2)` sentence that breaks data-grid
    // imageField rendering. Heuristic is narrow + clearly named.
    const lname = field.name.toLowerCase();
    if (
      lname === 'image' ||
      lname === 'imageurl' ||
      lname === 'image_url' ||
      lname === 'photo' ||
      lname === 'photourl' ||
      lname === 'photo_url' ||
      lname === 'avatar' ||
      lname === 'avatarurl' ||
      lname === 'avatar_url' ||
      lname === 'thumbnail' ||
      lname === 'thumbnailurl' ||
      lname === 'thumbnail_url' ||
      lname === 'picture' ||
      lname === 'pictureurl' ||
      lname === 'cover' ||
      lname === 'coverurl' ||
      lname === 'banner' ||
      lname === 'bannerurl'
    ) {
      return picsumUrl(entityName, field.name);
    }
    const value = faker.lorem.words(2);
    mockLog.debug('field:fallback-lorem', () => ({
      entityName,
      fieldName: field.name,
      hasValues: false,
      format: field.format ?? null,
      generated: value,
    }));
    return value;
  }

  /**
   * Generate a date value. Uses the field's `format` (date vs datetime) to
   * decide ISO shape; otherwise returns a recent ISO-8601 datetime. No
   * field-name heuristics.
   */
  private generateDateValue(field: EntityField): string {
    const date = faker.date.recent({ days: 30 });
    if (field.format === 'date') return date.toISOString().split('T')[0]!;
    return date.toISOString();
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

  /** Clear all data + re-anchor faker so the next seed loop reproduces
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
