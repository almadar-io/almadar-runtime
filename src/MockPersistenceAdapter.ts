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
import type { EntityField, FieldValue } from '@almadar/core';
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
  fields: NamedEntityField[];
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
        (f): f is NamedEntityField & { type: 'relation'; relation: { entity: string; cardinality?: string; field?: string } } =>
          f.type === 'relation',
      );
      if (relationFields.length === 0) continue;
      for (const row of store.values()) {
        for (const field of relationFields) {
          const targetStore = this.stores.get(field.relation.entity.toLowerCase());
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
            row[field.name] = faker.helpers.arrayElement(eligible) as FieldValue;
          } else {
            // many / one-to-many / many-to-many → pick 2–4 IDs
            const pickCount = Math.min(eligible.length, faker.number.int({ min: 2, max: 4 }));
            row[field.name] = faker.helpers
              .shuffle(eligible.slice())
              .slice(0, pickCount) as FieldValue;
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
      // Skip nameless nested-descriptor fields (canonical EntityField allows
      // `name?` on inner items/properties; the top-level seed loop only
      // iterates real named fields).
      if (!field.name) continue;
      if (field.name === 'id' || field.name === 'createdAt' || field.name === 'updatedAt') {
        continue;
      }
      item[field.name] = this.generateFieldValue(entityName, field, index);
    }

    return item;
  }

  /** Max nesting depth for recursive array/object schemas (e.g. a Comment
   *  entity whose `replies: [Comment]` field references itself). Without
   *  this guard, generateArrayValue → generateObjectValue → generateArray…
   *  recurses until stack overflow on every recursive type. Three levels
   *  is enough to render a useful thread depth (parent → reply → sub-reply)
   *  in catalog/preview without blowing the fixture. */
  private static MAX_NESTED_DEPTH = 3;

  /**
   * Generate a mock value for a field based on its schema.
   */
  private generateFieldValue(entityName: string, field: EntityField, index: number, depth = 0): FieldValue {
    // Mock-seed default policy: numeric fields preserve their declared
    // default (so `tokenCount : number = 0` stays 0), every other type
    // falls through to faker. Mirrors the gate in the compiled-path
    // codegen (`backend.rs:generate_seed_mock_data`). String/enum/bool/
    // date placeholder defaults like `name = ""` would otherwise paint
    // every seeded row with the same literal.
    const fieldTypeLc = field.type.toLowerCase();
    // `values` is on ScalarEntityField + EnumEntityField only. Narrow via
    // the discriminator instead of casting to `unknown` so we keep canonical
    // type safety end-to-end.
    const values = 'values' in field ? field.values : undefined;
    mockLog.debug('field:generate', {
      entityName,
      fieldName: field.name,
      fieldType: fieldTypeLc,
      hasValues: !!values?.length,
      valuesCount: values?.length ?? 0,
      values: values?.length ? values.join(',') : null,
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
    //
    // Switch on the canonical `field.type` (not the lowercased local var) so
    // each case narrows `field` to its discriminated-union variant — e.g.
    // `case 'array'` gives us `ArrayEntityField` with typed `items`, `case
    // 'relation'` gives `RelationEntityField` with typed `relation`. No
    // `unknown`/record-typed access needed.
    switch (field.type) {
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
        // After narrowing, field is EnumEntityField with required values. The
        // optional check is defensive in case canonical changes shape.
        if (field.values && field.values.length > 0) {
          return faker.helpers.arrayElement(field.values);
        }
        return null;

      case 'relation':
        // Placeholder — filled in by `linkRelationFields` after the seed pass
        // (target entity's store may not exist yet at field-generation time).
        // many-cardinality → empty array slot; one-cardinality → empty string slot.
        return field.relation?.cardinality === 'one' ? '' : [];

      case 'array':
        return this.generateArrayValue(entityName, field, index, depth);
      case 'object':
        return this.generateObjectValue(entityName, field, index, depth);

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
  private generateArrayValue(entityName: string, field: EntityField, index: number, depth = 0): FieldValue {
    if (field.type !== 'array' || !field.items) return [];
    // Stop recursing on self-referential types (e.g. Comment.replies: [Comment]).
    // Without this guard, faker would loop forever materialising replies-of-
    // replies-of-replies until the call stack blows.
    if (depth >= MockPersistenceAdapter.MAX_NESTED_DEPTH) return [];
    const count = faker.number.int({ min: 3, max: 5 });
    const out: FieldValue[] = [];
    const elementName = field.name ?? 'item';
    for (let i = 0; i < count; i++) {
      // Synthesize a child EntityField for the element. Each iteration gets a
      // fresh `index` so per-element string generators don't repeat verbatim.
      // The spread preserves the discriminator on `items` (string/object/array/…)
      // so generateFieldValue's switch narrows correctly.
      const elementField = {
        ...field.items,
        name: `${elementName}[${i}]`,
      } as EntityField;
      out.push(this.generateFieldValue(entityName, elementField, index * 10 + i, depth + 1));
    }
    return out as FieldValue;
  }

  /**
   * Generate a single object value with each declared property populated
   * by faker. Walks `properties` and recursively delegates to
   * `generateFieldValue` per property so nested objects-of-arrays-of-objects
   * compose correctly.
   */
  private generateObjectValue(entityName: string, field: EntityField, index: number, depth = 0): FieldValue {
    if (!field.properties) return null;
    if (depth >= MockPersistenceAdapter.MAX_NESTED_DEPTH) return null;
    const out: Record<string, FieldValue> = {};
    for (const [propName, propField] of Object.entries(field.properties)) {
      // The nested schema may omit `name` (it's implied by the parent key)
      // — synthesize one so downstream string generators that read `field.name`
      // have something to log against.
      const childField = { ...propField, name: propName } as EntityField;
      out[propName] = this.generateFieldValue(entityName, childField, index, depth + 1);
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
    // `values` exists on Scalar + Enum variants only. Narrow via canonical
    // discriminator so the access is type-safe without a record cast.
    const values = 'values' in field ? field.values : undefined;
    if (values && values.length > 0) {
      return faker.helpers.arrayElement(values);
    }
    // `field.name` is optional on the canonical EntityField (nested item/
    // property descriptors omit it). Top-level seed loop filters those out,
    // so name is set here in practice — but the type system needs the
    // explicit fallback to satisfy strict-null checks.
    const fieldName = field.name ?? 'field';
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
        return picsumUrl(entityName, fieldName);
    }
    // Field-name fallback for image-bearing string fields. Authors who haven't
    // (yet) annotated `format: "image"` still get a real photo from Picsum
    // rather than a `faker.lorem.words(2)` sentence that breaks data-grid
    // imageField rendering. Heuristic is narrow + clearly named.
    const lname = fieldName.toLowerCase();
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
      return picsumUrl(entityName, fieldName);
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
