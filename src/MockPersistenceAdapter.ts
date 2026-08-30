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
const MS_PER_DAY = 86_400_000;

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

/** EntityField narrowed to a relation field — the `isRelationField` guard
 *  below is what makes `field.relation` typed, no record-access casts. */
type RelationField = NamedEntityField & {
  type: 'relation';
  relation: { entity: string; entityId?: EntityId; cardinality?: string; field?: string };
};

function isRelationField(field: NamedEntityField): field is RelationField {
  return field.type === 'relation';
}

/** Composite key for an owner-stamped (entity/store key, row id, column)
 *  cell. `\x00`-joined — an id like "WikiPage Id 1" already contains
 *  spaces, so a space-joined key would collide across cells. */
function stampedCellKey(entity: string, id: string, column: string): string {
  return `${entity}\x00${id}\x00${column}`;
}

export interface EntitySchema {
  name: string;
  /** V4 dual-carry id sibling of `name` — optional until the Phase-7 flip. */
  id?: EntityId;
  /**
   * Declared `persistent: <collection>` name. Entities declaring the SAME
   * collection share ONE store — a shadow entity (`WikiTagRef [persistent:
   * tags]`) reads the very rows its sibling (`Tag [persistent: tags]`) seeds,
   * matching the compiled path's dedup-by-collection (orbital-shell-typescript
   * seed.rs) and docs/Almadar_Entity.md's collection rule. Absent → the store
   * is keyed by entity name, as before.
   */
  collection?: string;
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
  /** entityId -> store key, so relation lookups can prefer the id sibling over `relation.entity` name-matching. */
  private storeNameById: Map<string, string> = new Map();
  /** normalized entity name -> store key (the declared collection, else the name).
   *  Entities sharing a `persistent:` collection resolve to the same store. */
  private storeKeyByEntity: Map<string, string> = new Map();
  /** store key -> the first registrant's entity name, used as the minted-id label
   *  so rows in a shared collection carry one consistent id family. */
  private idLabelByStoreKey: Map<string, string> = new Map();
  private config: MockPersistenceConfig;
  /**
   * Every (entity, row id, column) cell `seed()` stamped with `config.ownerId`.
   * Seeding is eager and runs once at registration, before a dev host's
   * viewer is known to have changed — see `restampOwner`, which walks this
   * list to re-point the stamp when the default user changes later.
   */
  private ownerStampedCells: Array<{ entity: string; id: string; column: string }> = [];

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

  /**
   * Add owner columns discovered after construction.
   *
   * The adapter is built before any schema is registered, so schema-DERIVED
   * owner columns (relation fields pointing at the `[identity]` entity) can
   * only arrive later.
   *
   * ⚠️ Seeding is EAGER — `registerEntity()` seeds immediately — so callers must
   * supply these columns BEFORE registering any orbital. Calling this afterwards
   * silently stamps nothing.
   */
  addOwnerFields(fields: readonly string[]): void {
    if (fields.length === 0) return;
    const merged = new Set([...(this.config.ownerFields ?? []), ...fields]);
    this.config.ownerFields = [...merged];
  }

  /**
   * Re-point every owner-stamped cell from the current `ownerId` to
   * `newOwnerId`, and remember `newOwnerId` for any future seed.
   *
   * Seeding is eager (`registerEntity()` seeds immediately, at construction
   * time), so the columns above are frozen to whichever id was the default
   * user THEN — a dev host switching viewers later (`setDefaultUser` /
   * `POST /persona`) left the stamp pointing at the old id forever, so an
   * ownership-scoped view for the NEW viewer stayed empty. This does not
   * re-seed (eager seeding is intentional, see the class doc); it only
   * re-labels the cells `seed()` already marked as viewer-owned.
   *
   * No-op when there is no new id, or it matches the current one — an
   * anonymous switch (`newOwnerId === undefined`) leaves existing stamps as
   * they are rather than clearing a non-nullable owner column.
   *
   * Both this re-labeling AND `seed()`'s original stamping consult the
   * `ownerGate` hook (see `setOwnerGate`) — a re-register reseeds identical
   * rows, so gating only the restamp path leaks the moment a client
   * connects and the deterministic reseed stamps with the updated ownerId.
   */
  restampOwner(newOwnerId: string | undefined): void {
    const oldOwnerId = this.config.ownerId;
    this.config.ownerId = newOwnerId;
    if (!newOwnerId || newOwnerId === oldOwnerId) return;
    let skipped = 0;
    let fallbackStamps = 0;
    for (const cell of this.ownerStampedCells) {
      const row = this.stores.get(cell.entity)?.get(cell.id);
      if (!row) continue;
      if (this.ownerGate && !this.ownerGate(cell.entity, { ...row, [cell.column]: newOwnerId })) {
        const fallbackId = this.firstEligibleOwner(cell.entity, cell.column, row);
        if (fallbackId === undefined) {
          skipped++;
          continue;
        }
        row[cell.column] = fallbackId;
        fallbackStamps++;
        continue;
      }
      row[cell.column] = newOwnerId;
    }
    mockLog.debug('mock:owner-restamped', {
      from: oldOwnerId,
      to: newOwnerId,
      cells: this.ownerStampedCells.length,
      skipped,
      fallbackStamps,
    });
  }

  /**
   * The host's answer to "may the current viewer OWN this row?" — evaluated
   * against the candidate row with the owner column already re-pointed,
   * `storeKey` being the collection key the stores are keyed by. The runtime
   * installs the registered schema's `@create` directive here (the single
   * authority on who authors; no role heuristics), so a read-only persona
   * never inherits authorship of drafts from the demo stamper — neither on a
   * persona switch (`restampOwner`) nor on a deterministic reseed (`seed`).
   * Absent hook = stamp unconditionally (pre-role-model behavior).
   */
  private ownerGate?: (storeKey: string, candidateRow: EntityRow) => boolean;

  setOwnerGate(gate: ((storeKey: string, candidateRow: EntityRow) => boolean) | undefined): void {
    this.ownerGate = gate;
  }

  /**
   * The host's answer to "may THIS identity row own this candidate row?" —
   * evaluated per candidate rather than against the fixed default viewer, so
   * `linkRelationFields` and the eligible-owner fallback (see
   * `firstEligibleOwner`) can pick a policy-valid owner from the whole
   * identity roster instead of only ever checking the current default user.
   * Absent hook = no candidate filtering (pre-role-model behavior).
   */
  private ownerCandidateGate?: (
    storeKey: string,
    candidateRow: EntityRow,
    candidateIdentityRow: EntityRow,
  ) => boolean;

  setOwnerCandidateGate(
    gate:
      | ((storeKey: string, candidateRow: EntityRow, candidateIdentityRow: EntityRow) => boolean)
      | undefined,
  ): void {
    this.ownerCandidateGate = gate;
  }

  /**
   * The store an owner column's relation field targets, resolved the same
   * way `linkRelationFields` resolves any relation target (id sibling wins
   * over the `entity` name string) — but keyed by STORE, mirroring that
   * method's first-declarer-per-collection rule, so `seed()` and
   * `restampOwner()` can find it before a `linkRelationFields` pass has run
   * this registration. Undefined when no registered schema on `storeKey`
   * declares `column` as a relation field.
   */
  private resolveOwnerColumnTargetStore(storeKey: string, column: string): string | undefined {
    for (const [normalizedName, schema] of this.schemas) {
      if ((this.storeKeyByEntity.get(normalizedName) ?? normalizedName) !== storeKey) continue;
      const field = schema.fields.find((f) => f.name === column);
      if (field && isRelationField(field)) {
        return (
          (field.relation.entityId && this.storeNameById.get(field.relation.entityId)) ??
          this.resolveStoreKey(field.relation.entity)
        );
      }
    }
    return undefined;
  }

  /**
   * The first identity-store row (seed order) whose persona is eligible, per
   * the installed `ownerCandidateGate`, to own `row`'s `column` in `storeKey`
   * — the deterministic replacement for "skip the stamp" when the CURRENT
   * viewer fails the `@create` policy (e.g. a reader-default persona against
   * an author|reviewer-only policy). Undefined when no gate is installed, the
   * column isn't a resolvable relation, or no identity row is eligible — the
   * caller keeps today's skip behavior in that case.
   */
  private firstEligibleOwner(storeKey: string, column: string, row: EntityRow): string | undefined {
    if (!this.ownerCandidateGate) return undefined;
    const identityStoreKey = this.resolveOwnerColumnTargetStore(storeKey, column);
    const identityStore = identityStoreKey ? this.stores.get(identityStoreKey) : undefined;
    if (!identityStore) return undefined;
    for (const identityRow of identityStore.values()) {
      const candidateId = identityRow['id'] as string;
      if (this.ownerCandidateGate(storeKey, { ...row, [column]: candidateId }, identityRow)) {
        return candidateId;
      }
    }
    return undefined;
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

  /** Resolve an entity name to its store key: the declared collection when the
   *  entity is registered, the lowercased name otherwise (unregistered ad-hoc
   *  creates keep working). */
  private resolveStoreKey(entityName: string): string {
    const normalized = entityName.toLowerCase();
    return this.storeKeyByEntity.get(normalized) ?? normalized;
  }

  private getStore(entityName: string): Map<string, EntityRow> {
    const key = this.resolveStoreKey(entityName);
    if (!this.stores.has(key)) {
      this.stores.set(key, new Map());
      this.idCounters.set(key, 0);
    }
    return this.stores.get(key)!;
  }

  private nextId(entityName: string): string {
    const key = this.resolveStoreKey(entityName);
    const counter = (this.idCounters.get(key) ?? 0) + 1;
    this.idCounters.set(key, counter);
    const label = this.idLabelByStoreKey.get(key) ?? entityName;
    return `${this.capitalizeFirst(label)} Id ${counter}`;
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
    const storeKey = (schema.collection ?? schema.name).toLowerCase();
    this.storeKeyByEntity.set(normalized, storeKey);
    if (!this.idLabelByStoreKey.has(storeKey)) {
      this.idLabelByStoreKey.set(storeKey, schema.name);
    }
    this.schemas.set(normalized, schema);
    if (schema.id) {
      this.storeNameById.set(schema.id, storeKey);
    }

    const alreadySeeded = (this.stores.get(storeKey)?.size ?? 0) > 0;
    if (schema.seedData && schema.seedData.length > 0) {
      // Seed with actual pre-authored instances
      this.seedFromInstances(schema.name, schema.seedData);
    } else if (alreadySeeded) {
      // A sibling entity on the same collection seeded this store first.
      // Don't re-seed (one collection = one dataset); instead backfill any
      // fields THIS schema declares that the first registrant's rows lack,
      // so both entities' filters/renders find their columns populated.
      this.backfillFields(storeKey, schema);
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
   * Cross-entity relations pick random IDs from the target store. A
   * SELF-referential `one`-cardinality relation (a parent column like
   * `Tag.parentId : Tag`) is linked deterministically instead: row 0 stays a
   * root (`""`) and row *i* parents to row ⌊(i−1)/2⌋ — a proper forest with
   * real roots and no cycles, so tree views and `parentId = ""` root fetches
   * render sensibly. Self-referential `many` relations keep the 2–4 random
   * sibling IDs (excluding self). The runtime caps recursion at depth=2 in
   * `populateRelations`, so deep chains render two levels then stop.
   *
   * Entities sharing a collection are linked once per STORE, over the union
   * of their declared relation fields (first declarer of a field name wins).
   */
  linkRelationFields(): void {
    const relationFieldsByStore = new Map<string, Map<string, RelationField>>();
    for (const [normalizedName, schema] of this.schemas) {
      const storeKey = this.storeKeyByEntity.get(normalizedName) ?? normalizedName;
      let fieldMap = relationFieldsByStore.get(storeKey);
      if (!fieldMap) {
        fieldMap = new Map();
        relationFieldsByStore.set(storeKey, fieldMap);
      }
      for (const f of schema.fields) {
        if (isRelationField(f) && !fieldMap.has(f.name)) {
          fieldMap.set(f.name, f);
        }
      }
    }

    // Declared owner columns, by store — used below so a random relink never
    // hands a policy-ineligible identity credit for a row it may not own.
    const ownerColumnsByStore = new Map<string, Set<string>>();
    for (const { entity, field } of this.parsedOwnerFields()) {
      const storeKey = this.resolveStoreKey(entity);
      const set = ownerColumnsByStore.get(storeKey) ?? new Set<string>();
      set.add(field);
      ownerColumnsByStore.set(storeKey, set);
    }
    // Cells `seed()`/`restampOwner()` already stamped (deliberately, or via
    // the eligible-owner fallback) — never randomly relinked by this pass.
    const stampedCellKeys = new Set(
      this.ownerStampedCells.map((cell) => stampedCellKey(cell.entity, cell.id, cell.column)),
    );

    for (const [storeKey, fieldMap] of relationFieldsByStore) {
      const store = this.stores.get(storeKey);
      if (!store || fieldMap.size === 0) continue;
      const rows = [...store.values()];
      const ownerColumns = ownerColumnsByStore.get(storeKey);
      for (const field of fieldMap.values()) {
        const isOwnerColumn = ownerColumns?.has(field.name) ?? false;
        // Id-primary: prefer the `entityId` sibling via the id->store index,
        // falling back to the `entity` name string when the id is absent
        // or unindexed (transition-period tolerance).
        const targetKey =
          (field.relation.entityId && this.storeNameById.get(field.relation.entityId)) ??
          this.resolveStoreKey(field.relation.entity);
        const targetStore = this.stores.get(targetKey);
        if (!targetStore || targetStore.size === 0) continue;
        const sameStore = targetStore === store;
        const cardinality = field.relation.cardinality ?? 'many';

        if (sameStore && (cardinality === 'one' || cardinality === 'many-to-one')) {
          // Deterministic forest for parent columns (see method doc).
          rows.forEach((row, i) => {
            if (
              (this.config.ownerId !== undefined && row[field.name] === this.config.ownerId) ||
              stampedCellKeys.has(stampedCellKey(storeKey, row['id'] as string, field.name))
            ) {
              return;
            }
            row[field.name] = i === 0 ? '' : (rows[Math.floor((i - 1) / 2)]!['id'] as string);
          });
          continue;
        }

        for (const row of rows) {
          const selfId = row['id'] as string;
          // A schema-derived owner column IS a relation to the [identity]
          // entity, so this pass would overwrite the viewer stamp `seed()` just
          // assigned (or the eligible-owner fallback picked) and every
          // ownership-scoped view would render empty, or a wrongly-credited
          // draft, again. Deliberate/gated assignment wins over random linking.
          if (
            (this.config.ownerId !== undefined && row[field.name] === this.config.ownerId) ||
            stampedCellKeys.has(stampedCellKey(storeKey, selfId, field.name))
          ) {
            continue;
          }
          // Eligible IDs: every id in the target store, minus this row's own id
          // (only when target === self entity) so a comment doesn't list itself
          // as its own reply.
          let eligible: string[] = [];
          for (const id of targetStore.keys()) {
            if (sameStore && id === selfId) continue;
            eligible.push(id);
          }
          if (isOwnerColumn && this.ownerCandidateGate) {
            const gate = this.ownerCandidateGate;
            eligible = eligible.filter((id) =>
              gate(storeKey, { ...row, [field.name]: id }, targetStore.get(id)!),
            );
          }
          if (eligible.length === 0) continue;
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
   * Fill fields a late-registering sibling schema declares that the shared
   * store's existing rows lack. The first registrant on a collection seeds
   * with ITS field list; a sibling declaring extra columns (e.g. `Tag.parentId`
   * arriving after `WikiTagRef {id,name}`) would otherwise read `undefined`
   * where its filters expect a value. Values come from the same canonical
   * sample policy as seeding; relation fields are then linked by the global
   * `linkRelationFields` pass that follows registration.
   */
  private backfillFields(storeKey: string, schema: EntitySchema): void {
    const store = this.stores.get(storeKey);
    if (!store) return;
    const candidates = schema.fields.filter(
      (f) => f.name !== 'id' && f.name !== 'createdAt' && f.name !== 'updatedAt',
    );
    if (candidates.length === 0) return;
    let index = 0;
    for (const row of store.values()) {
      index += 1;
      const absent = candidates.filter((f) => row[f.name] === undefined);
      if (absent.length === 0) continue;
      const sample = sampleRow(
        { name: schema.name, persistence: schema.persistence, fields: absent },
        { index, strategy: 'seeded', persistence: schema.persistence },
      );
      for (const f of absent) {
        if (sample[f.name] !== undefined) {
          row[f.name] = sample[f.name] as FieldValue;
        }
      }
    }
    mockLog.debug('mock:backfill', {
      storeKey,
      entity: schema.name,
      fields: candidates.map((f) => f.name),
    });
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
    const storeKey = this.resolveStoreKey(entityName);

    if (this.config.debug) {
      mockLog.debug('seeding', { count, entity: entityName });
    }

    // Declared owner columns for THIS entity (see MockPersistenceConfig.ownerFields).
    const ownerCols = this.parsedOwnerFields()
      .filter(({ entity }) => entity.toLowerCase() === normalized)
      .map(({ field }) => field);
    const ownerId = this.config.ownerId;

    const generated: Array<{ id: string; updatedAt: string }> = [];
    let fallbackStamps = 0;
    for (let i = 0; i < count; i++) {
      const item = this.generateMockItem(entityName, fields, i + 1, persistence);
      // Give the viewer every other row, so an ownership-scoped view has real
      // data while a second persona still sees a different set — unless the
      // ownerGate says this viewer could not have authored the row (a reseed
      // runs AFTER a persona switch updated ownerId, so this path needs the
      // same gate as restampOwner or the switch leaks through re-register).
      if (ownerId && ownerCols.length > 0 && i % 2 === 0) {
        for (const col of ownerCols) {
          if (this.ownerGate && !this.ownerGate(storeKey, { ...item, [col]: ownerId })) {
            // The default viewer can't own this row under the entity's
            // @create policy (e.g. a reader-default persona, author-only
            // policy) — stamp the first policy-eligible identity instead of
            // leaving whatever random value `sampleRow` generated.
            const fallbackId = this.firstEligibleOwner(storeKey, col, item);
            if (fallbackId === undefined) continue;
            item[col] = fallbackId;
            this.ownerStampedCells.push({ entity: storeKey, id: item.id as string, column: col });
            fallbackStamps++;
            continue;
          }
          item[col] = ownerId;
          this.ownerStampedCells.push({ entity: storeKey, id: item.id as string, column: col });
        }
      }
      store.set(item.id as string, item);
      generated.push({
        id: item.id as string,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      });
    }
    mockLog.debug('mock:seed', () => ({
      entityName,
      count,
      idsAndTimestamps: JSON.stringify(generated),
      fallbackStamps,
    }));
  }

  /** Parsed `config.ownerFields` pairs — every declared "Entity.field" owner
   *  column, split once so `seed()` and `linkRelationFields()` don't each
   *  re-parse the same strings. */
  private parsedOwnerFields(): Array<{ entity: string; field: string }> {
    const out: Array<{ entity: string; field: string }> = [];
    for (const pair of this.config.ownerFields ?? []) {
      const [entity, field] = pair.split('.');
      if (entity && field) out.push({ entity, field });
    }
    return out;
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
    // Both timestamps come from the seeded PRNG, so a fixed seed reproduces them.
    // updatedAt was previously pinned to SEED_REFERENCE_TIMESTAMP, which made every
    // row render the same "Updated Jan 1, 2024" — an updated column that never varies
    // reads as broken data. It anchored nothing anyway: createdAt is relative to the
    // current date, so hermetic frames never held across days to begin with.
    const createdAt = randomPastDate({ years: 1 });
    const updatedAt = new Date(
      Math.min(createdAt.getTime() + randomInt({ min: 0, max: 30 }) * MS_PER_DAY, Date.now()),
    );
    return {
      ...sampleRow(
        { name: entityName, persistence, fields },
        { index, strategy: 'seeded', persistence },
      ),
      id,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
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
    this.assertFileValuesWithinCeiling(entityType, data);
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
   * Mock-mode file storage ceiling: a `file`-typed value whose `url` is a
   * `data:` URI keeps the whole payload in this in-memory/localStorage
   * store. Above the ceiling the write is REJECTED with a clear error —
   * never silently truncated or corrupted. Real deployments store bytes in
   * object storage and keep only the URL, so the ceiling is mock-only.
   */
  private static readonly FILE_DATA_URI_CEILING_BYTES = 2 * 1024 * 1024;

  private assertFileValuesWithinCeiling(entityType: string, data: EntityRow): void {
    for (const [fieldName, value] of Object.entries(data)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as { url?: unknown; sizeBytes?: unknown };
      if (typeof candidate.url !== 'string' || !candidate.url.startsWith('data:')) continue;
      const bytes =
        typeof candidate.sizeBytes === 'number' ? candidate.sizeBytes : candidate.url.length;
      if (bytes > MockPersistenceAdapter.FILE_DATA_URI_CEILING_BYTES) {
        throw new Error(
          `${entityType}.${fieldName}: the playground mock store cannot persist files larger than ` +
            `${MockPersistenceAdapter.FILE_DATA_URI_CEILING_BYTES / (1024 * 1024)}MB ` +
            `(got ${(bytes / (1024 * 1024)).toFixed(1)}MB). Use a smaller file - production ` +
            `deployments store file bytes in object storage instead of the row.`,
        );
      }
    }
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
    this.assertFileValuesWithinCeiling(entityType, data);
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
    const key = this.resolveStoreKey(entityName);
    this.stores.delete(key);
    this.idCounters.delete(key);
  }

  /** Clear all data + re-anchor the PRNG so the next seed loop reproduces
   *  identical rows. Hermetic-frame mode calls this between every step
   *  via OrbitalServerRuntime.resetMockPersistence. */
  clearAll(): void {
    this.stores.clear();
    this.idCounters.clear();
    this.ownerStampedCells = [];
    this.storeKeyByEntity.clear();
    this.idLabelByStoreKey.clear();
    this.storeNameById.clear();
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
