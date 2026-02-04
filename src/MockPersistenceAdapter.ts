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

// ============================================================================
// Types
// ============================================================================

export interface EntityField {
  name: string;
  type: string;
  required?: boolean;
  values?: string[]; // For enum types
  default?: unknown;
}

export interface EntitySchema {
  name: string;
  fields: EntityField[];
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
  private stores: Map<string, Map<string, Record<string, unknown>>> = new Map();
  private schemas: Map<string, EntitySchema> = new Map();
  private idCounters: Map<string, number> = new Map();
  private config: MockPersistenceConfig;

  constructor(config: MockPersistenceConfig = {}) {
    this.config = {
      defaultSeedCount: 6,
      debug: false,
      ...config,
    };

    // Set seed for deterministic generation if provided
    if (config.seed !== undefined) {
      faker.seed(config.seed);
      if (this.config.debug) {
        console.log(`[MockPersistence] Using seed: ${config.seed}`);
      }
    }
  }

  // ============================================================================
  // Store Management
  // ============================================================================

  private getStore(entityName: string): Map<string, Record<string, unknown>> {
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
   */
  registerEntity(schema: EntitySchema, seedCount?: number): void {
    const normalized = schema.name.toLowerCase();
    this.schemas.set(normalized, schema);

    const count = seedCount ?? this.config.defaultSeedCount ?? 6;
    this.seed(schema.name, schema.fields, count);
  }

  /**
   * Seed an entity with mock data.
   */
  seed(entityName: string, fields: EntityField[], count: number): void {
    const store = this.getStore(entityName);
    const normalized = entityName.toLowerCase();

    if (this.config.debug) {
      console.log(`[MockPersistence] Seeding ${count} ${entityName}...`);
    }

    for (let i = 0; i < count; i++) {
      const item = this.generateMockItem(normalized, entityName, fields, i + 1);
      store.set(item.id as string, item);
    }
  }

  /**
   * Generate a single mock item based on field schemas.
   */
  private generateMockItem(
    normalizedName: string,
    entityName: string,
    fields: EntityField[],
    index: number
  ): Record<string, unknown> {
    const id = this.nextId(entityName);
    const now = new Date().toISOString();
    const item: Record<string, unknown> = {
      id,
      createdAt: faker.date.past({ years: 1 }).toISOString(),
      updatedAt: now,
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
  private generateFieldValue(entityName: string, field: EntityField, index: number): unknown {
    // Handle default values
    if (field.default !== undefined) {
      if (field.default === '@now') {
        return new Date().toISOString();
      }
      return field.default;
    }

    // Handle optional fields - 80% chance of having a value
    if (!field.required && Math.random() > 0.8) {
      return null;
    }

    const fieldType = field.type.toLowerCase();

    switch (fieldType) {
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
      case 'object':
        return field.type === 'array' ? [] : {};

      default:
        // Treat unknown types as strings
        return this.generateStringValue(entityName, field, index);
    }
  }

  /**
   * Generate a string value based on field name heuristics.
   */
  private generateStringValue(entityName: string, field: EntityField, index: number): string {
    const name = field.name.toLowerCase();

    // If field has enum values, use them
    if (field.values && field.values.length > 0) {
      return faker.helpers.arrayElement(field.values);
    }

    // Specific fields - use faker for realistic data
    if (name.includes('email')) return faker.internet.email();
    if (name.includes('phone')) return faker.phone.number();
    if (name.includes('address')) return faker.location.streetAddress();
    if (name.includes('city')) return faker.location.city();
    if (name.includes('country')) return faker.location.country();
    if (name.includes('url') || name.includes('website')) return faker.internet.url();
    if (name.includes('avatar') || name.includes('image')) return faker.image.avatar();
    if (name.includes('color')) return faker.color.human();
    if (name.includes('uuid')) return faker.string.uuid();
    if (name.includes('description') || name.includes('bio')) return faker.lorem.paragraph();

    // Generic name/title/text fields - use entity-aware readable format
    const entityLabel = this.capitalizeFirst(entityName);
    const fieldLabel = this.capitalizeFirst(field.name);
    return `${entityLabel} ${fieldLabel} ${index}`;
  }

  /**
   * Generate a date value based on field name heuristics.
   */
  private generateDateValue(field: EntityField): string {
    const name = field.name.toLowerCase();

    let date: Date;
    if (name.includes('created') || name.includes('start') || name.includes('birth')) {
      date = faker.date.past({ years: 2 });
    } else if (name.includes('updated') || name.includes('modified')) {
      date = faker.date.recent({ days: 30 });
    } else if (name.includes('deadline') || name.includes('due') || name.includes('end') || name.includes('expires')) {
      date = faker.date.future({ years: 1 });
    } else {
      date = faker.date.anytime();
    }

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
    data: Record<string, unknown>
  ): Promise<{ id: string }> {
    const store = this.getStore(entityType);
    const id = this.nextId(entityType);
    const now = new Date().toISOString();

    const item = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };

    store.set(id, item);
    return { id };
  }

  async update(
    entityType: string,
    id: string,
    data: Record<string, unknown>
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
  ): Promise<Record<string, unknown> | null> {
    const store = this.getStore(entityType);
    return store.get(id) ?? null;
  }

  async list(entityType: string): Promise<Array<Record<string, unknown>>> {
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

  /**
   * Clear all data.
   */
  clearAll(): void {
    this.stores.clear();
    this.idCounters.clear();
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
