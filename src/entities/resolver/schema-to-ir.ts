/**
 * Schema to IR Resolver
 *
 * Converts OrbitalSchema to ResolvedIR.
 * This is the single source of truth for schema resolution,
 * used by both the compiler and runtime.
 *
 * @packageDocumentation
 */

import type {
  OrbitalSchema,
  SExpr,
  EntityRef,
  PageRef,
  ResolvedIR,
  ResolvedEntity,
  ResolvedTrait,
  ResolvedPage,
  ResolvedTraitBinding,
  ResolvedField,
  ResolvedTraitState,
  ResolvedTraitEvent,
  ResolvedTraitTransition,
  ResolvedTraitTick,
  ResolvedTraitListener,
  TransitionFrom,
  EntityField,
  Page,
  Orbital,
  JsonValue,
  PageTraitRef,
  StateMachine,
  Trait,
  TraitConfigValue,
  TraitEntityField,
} from '@almadar/core';

import {
  isEntityReference,
  isEntityCall,
  isPageReferenceString,
  isPageReferenceObject,
  inferTsType,
} from '@almadar/core';
import { createLogger } from '@almadar/logger';

const schemaToIrLog = createLogger('almadar:runtime:schema-to-ir');

// ============================================================================
// Cache
// ============================================================================

const schemaCache = new Map<string, ResolvedIR>();

function getCacheKey(schema: OrbitalSchema): string {
  return `${schema.name}-${JSON.stringify(schema).length}`;
}

/**
 * Clear the schema resolution cache
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
}

// ============================================================================
// Field Resolution
// ============================================================================

function resolveField(field: EntityField): ResolvedField {
  const values = 'values' in field ? field.values : undefined;
  return {
    // EntityField.name is optional in @almadar/core 7+ (matches Rust IR
    // FieldDefinition.name: Option<String>). Top-level entity fields
    // always carry a name; nameless nested item descriptors don't reach
    // this resolver path.
    name: field.name ?? '',
    type: field.type,
    tsType: inferTsType(field.type),
    description: field.description,
    default: field.default,
    required: field.required ?? false,
    validation: values ? { enum: values } : undefined,
    values,
    enumValues: values,
    relation: field.type === 'relation' ? field.relation : undefined,
  };
}

function traitConfigToJson(value: TraitConfigValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (isTraitConfigArray(value)) return value.map(traitConfigToJson);
  const out: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = traitConfigToJson(entry);
  }
  return out;
}

function isTraitConfigArray(value: TraitConfigValue): value is ReadonlyArray<TraitConfigValue> {
  return Array.isArray(value);
}

/** A trait's own `dataEntities` field (`TraitEntityField`) as a `ResolvedField`. */
function resolveTraitEntityField(field: TraitEntityField): ResolvedField {
  return {
    name: field.name,
    type: field.type,
    tsType: inferTsType(field.type),
    default: field.default === undefined ? undefined : traitConfigToJson(field.default),
    required: field.required ?? false,
    values: field.values,
    enumValues: field.values,
  };
}

// ============================================================================
// Entity Resolution
// ============================================================================

function resolveEntities(schema: OrbitalSchema): Map<string, ResolvedEntity> {
  const entityMap = new Map<string, ResolvedEntity>();

  for (const orbital of schema.orbitals || []) {
    // Skip orbital references (they have 'ref' instead of 'entity')
    if ('ref' in orbital && !('entity' in orbital)) continue;

    const entityRef = (orbital as Orbital).entity as EntityRef | undefined;
    if (!entityRef) continue;

    // Handle EntityRef: can be inline Entity object OR string reference
    if (isEntityReference(entityRef)) {
      // String reference like "Alias.entity" - extract name, create minimal entity
      // Note: Full resolution of imported entities requires the reference-resolver
      const entityName = entityRef.replace('.entity', '');
      // Only add if not already present (inline entities take precedence)
      if (!entityMap.has(entityName)) {
        entityMap.set(entityName, {
          name: entityName,
          description: `Referenced entity: ${entityRef}`,
          collection: entityName.toLowerCase() + 's',
          fields: [], // Fields unknown for reference - requires full resolution
          usedByTraits: [],
          usedByPages: [],
        });
      }
    } else if (isEntityCall(entityRef)) {
      // EntityCall: object form like { extends: "Modal.entity", name: "CartItem", fields: [...] }
      // Full field resolution requires the reference-resolver; create a minimal placeholder
      const entityName = entityRef.name ?? entityRef.extends.replace('.entity', '');
      if (!entityMap.has(entityName)) {
        entityMap.set(entityName, {
          name: entityName,
          description: `Extended entity: ${entityRef.extends}`,
          collection: entityRef.collection ?? entityName.toLowerCase() + 's',
          fields: (entityRef.fields || []).map(resolveField),
          usedByTraits: [],
          usedByPages: [],
        });
      }
    } else {
      // Inline OrbitalEntity definition
      const entity = entityRef;
      // Derive runtime from persistence field
      const isRuntime = entity.persistence === 'runtime';
      const entityInstances = entity.instances;
      entityMap.set(entity.name, {
        name: entity.name,
        description: entity.description,
        collection: entity.collection || entity.name.toLowerCase() + 's',
        fields: (entity.fields || []).map(resolveField),
        usedByTraits: [],
        usedByPages: [],
        runtime: isRuntime,
        // `[shared]` is orthogonal to persistence and drives the client's
        // shared-entity groups (one frame across bound traits). Dropping it
        // here left every browser-side trait on a private copy — cross-trait
        // `@entity` reads (rail highlight, thread refresh filter) saw only
        // declared defaults.
        shared: entity.shared === true,
        hasInstances: (entityInstances?.length ?? 0) > 0,
        instances: entityInstances,
        defaults: {}, // defaults are part of instances, not entity definition
      });
    }
  }

  return entityMap;
}

// ============================================================================
// Trait Resolution
// ============================================================================

function resolveStateMachine(sm: StateMachine | undefined): {
  states: ResolvedTraitState[];
  events: ResolvedTraitEvent[];
  transitions: ResolvedTraitTransition[];
} {
  return {
    states: (sm?.states || []).map((s) => ({
      name: s.name,
      isInitial: s.isInitial ?? false,
      isFinal: s.isFinal ?? false,
    })),
    events: (sm?.events || []).map((e) => ({
      key: e.key,
      name: e.name || e.key,
    })),
    transitions: (sm?.transitions || []).map((t) => ({
      from: t.from as TransitionFrom,
      to: t.to,
      event: t.event,
      guard: t.guard as SExpr | undefined,
      effects: (t.effects || []) as SExpr[],
    })),
  };
}

function resolveTrait(trait: Trait, source: 'schema' | 'library' | 'inline'): ResolvedTrait {
  const sm = trait.stateMachine;
  const { states, events, transitions } = resolveStateMachine(sm);

  return {
    name: trait.name,
    description: trait.description,
    source,
    category: trait.category,
    states,
    events,
    transitions,
    guards: (sm?.guards || []).map((g) => ({
      name: g.name,
      condition: g.expression,
    })),
    ticks: (trait.ticks || []).map((tick): ResolvedTraitTick => ({
      name: tick.name || 'tick',
      interval: tick.interval || 0,
      guard: tick.guard as SExpr | undefined,
      effects: (tick.effects || []) as SExpr[],
      priority: tick.priority ?? 0,
      appliesTo: tick.appliesTo || [],
    })),
    listens: (trait.listens || []).map((listen): ResolvedTraitListener => ({
      event: listen.event || '',
      triggers: listen.triggers,
      guard: listen.guard as SExpr | undefined,
    })),
    dataEntities: (trait.dataEntities || []).map((de) => ({
      name: de.name,
      fields: (de.fields || []).map(resolveTraitEntityField),
      runtime: de.runtime ?? false,
      singleton: de.singleton ?? false,
    })),
    config: trait.config,
    ui: trait.ui,
  };
}

interface ResolvedTraitMaps {
  byName: Map<string, ResolvedTrait>;
  // Id-primary index: stable trait id → resolved trait. Page bindings whose
  // `refId` survives a declaration rename resolve through this even when the
  // ref's name is stale (the name-seam the V4 id-flip closes).
  byId: Map<string, ResolvedTrait>;
}

/**
 * A second declaration under a name the trait index already holds. The index is
 * name-keyed, so the loser is dropped and every `@trait.X` / page binding /
 * listen source naming it silently resolves to the winner — the failure mode
 * looks like a working app rendering the wrong trait's data. Trait names are
 * unique per app by contract (`ORB_T_DUPLICATE_NAME`), so reaching here means
 * an upstream resolver produced a colliding pair; say so instead of dropping it
 * without a trace.
 */
function reportTraitNameCollision(name: string, orbitalName: string | undefined): void {
  schemaToIrLog.error('trait-name-collision', {
    trait: name,
    orbital: orbitalName,
    kept: 'first',
    consequence: 'later declaration dropped; every reference to this name binds the first',
  });
}

function resolveTraits(schema: OrbitalSchema): ResolvedTraitMaps {
  const traitMap = new Map<string, ResolvedTrait>();
  const traitById = new Map<string, ResolvedTrait>();

  // Note: OrbitalSchema no longer has top-level traits
  // Traits are only inside orbitals now

  // Collect inline traits from orbital.traits. Include preprocessed ref
  // traits that carry their fully-resolved definition under `_resolved`
  // (produced by `@almadar/runtime`'s preprocessSchema) — those are the
  // post-rename, post-config-substitution variant and SHOULD be findable
  // when page bindings reference them by name.
  for (const orbital of schema.orbitals || []) {
    if ('ref' in orbital && !('traits' in orbital)) continue;

    const orbitalTraits = (orbital as Orbital).traits || [];

    for (const trait of orbitalTraits) {
      if (typeof trait === 'string') continue;

      // Preprocessed ref-trait wrapper: { ref, config, linkedEntity, _resolved }
      // Register _resolved under the ref's local name so page bindings can find it.
      if ('ref' in trait) {
        const resolved = trait._resolved;
        if (resolved && resolved.stateMachine) {
          const name = resolved.name ?? trait.ref;
          if (name && traitMap.has(name)) {
            reportTraitNameCollision(name, (orbital as Orbital).name);
          } else if (name) {
            const resolvedTrait = resolveTrait(resolved, 'inline');
            traitMap.set(name, resolvedTrait);
            if (resolved.id) traitById.set(resolved.id, resolvedTrait);
            // V4 composed-surface backbone: page-ref refIds point at the
            // wrapper's own LOCAL declaration id (distinct from the resolved
            // atom's id) — register it so a renamed declaration still binds.
            const declId = (trait as { id?: string }).id;
            if (typeof declId === 'string' && declId.length > 0) {
              traitById.set(declId, resolvedTrait);
            }
          }
        }
        continue;
      }

      // Plain inline trait definition
      if (!trait.name) continue;
      if (traitMap.has(trait.name)) {
        reportTraitNameCollision(trait.name, (orbital as Orbital).name);
        continue;
      }
      const resolvedTrait = resolveTrait(trait, 'inline');
      traitMap.set(trait.name, resolvedTrait);
      const traitId = (trait as { id?: string }).id;
      if (traitId) traitById.set(traitId, resolvedTrait);
    }
  }

  return { byName: traitMap, byId: traitById };
}

// ============================================================================
// Page Resolution
// ============================================================================

function resolveTraitBinding(
  t: PageTraitRef,
  traitMap: Map<string, ResolvedTrait>,
  traitById: Map<string, ResolvedTrait>,
  orbitalEntity?: string
): ResolvedTraitBinding {
  // Id-primary: a `refId` that survives a declaration rename resolves the
  // (possibly renamed) trait by stable id; fall back to the name index.
  const trait = (t.refId && traitById.get(t.refId)) ?? traitMap.get(t.ref);
  return {
    ref: t.ref,
    trait: trait || createEmptyTrait(t.ref, 'library'),
    config: t.config,
    linkedEntity: t.linkedEntity || trait?.linkedEntity || orbitalEntity,
  };
}

function createEmptyTrait(name: string, source: 'schema' | 'library' | 'inline'): ResolvedTrait {
  return {
    name,
    source,
    states: [],
    events: [],
    transitions: [],
    guards: [],
    ticks: [],
    listens: [],
    dataEntities: [],
  };
}

/**
 * Get entity name from EntityRef (handles both inline and string reference)
 */
function getEntityNameFromRef(entityRef: EntityRef | undefined): string | undefined {
  if (!entityRef) return undefined;
  if (isEntityReference(entityRef)) {
    // String reference like "Alias.entity" -> extract name
    return entityRef.replace('.entity', '');
  }
  return entityRef.name;
}

/**
 * Extract page info from PageRef (handles inline, string ref, and object ref)
 */
function getPageInfoFromRef(pageRef: PageRef): { name: string; path: string; traits: PageTraitRef[] } | null {
  if (isPageReferenceString(pageRef)) {
    // String reference like "Alias.pages.PageName"
    const parts = pageRef.split('.');
    const name = parts[parts.length - 1];
    return { name, path: `/${name.toLowerCase()}`, traits: [] };
  }
  if (isPageReferenceObject(pageRef)) {
    // Object reference like { ref: "Alias.pages.PageName", path: "/custom" }
    const parts = pageRef.ref.split('.');
    const name = parts[parts.length - 1];
    return { name, path: pageRef.path || `/${name.toLowerCase()}`, traits: [] };
  }
  // Inline page
  return { name: pageRef.name, path: pageRef.path, traits: pageRef.traits || [] };
}

function resolvePages(
  schema: OrbitalSchema,
  traitMap: Map<string, ResolvedTrait>,
  traitById: Map<string, ResolvedTrait>
): Map<string, ResolvedPage> {
  const pageMap = new Map<string, ResolvedPage>();

  for (const orbital of schema.orbitals || []) {
    // Skip orbital references
    if ('ref' in orbital && !('pages' in orbital)) continue;

    const orbitalTyped = orbital as Orbital;
    const orbitalName = orbitalTyped.name;
    // Handle EntityRef: can be string or inline entity
    const orbitalEntity = getEntityNameFromRef(orbitalTyped.entity);

    for (const pageRef of orbitalTyped.pages || []) {
      // Handle PageRef: can be string, object reference, or inline page
      const pageInfo = getPageInfoFromRef(pageRef as PageRef);
      if (!pageInfo) continue;

      const pageName = pageInfo.name;
      const pagePath = pageInfo.path;

      const traitBindings: ResolvedTraitBinding[] = (pageInfo.traits || []).map((t) =>
        resolveTraitBinding(t, traitMap, traitById, orbitalEntity),
      );

      pageMap.set(pageName, {
        name: pageName,
        path: pagePath || `/${pageName.toLowerCase()}`,
        featureName: orbitalName,
        viewType: typeof pageRef === 'object' && !('ref' in pageRef) ? (pageRef as Page).viewType as ("create" | "list" | "detail" | "edit" | "dashboard" | undefined) : undefined,
        layout: typeof pageRef === 'object' ? (pageRef as Page & { layout?: string }).layout : undefined,
        sections: [], // Trait-driven: no static sections
        traits: traitBindings,
        entityBindings: [],
        navigation: [],
        singletonEntities: [],
      });
    }
  }

  return pageMap;
}

// ============================================================================
// Main Resolver
// ============================================================================

/**
 * Resolve an OrbitalSchema to IR.
 *
 * @param schema - The OrbitalSchema to resolve
 * @param options - Resolution options
 * @returns Resolved IR
 */
export function schemaToIR(
  schema: OrbitalSchema,
  options?: { noCache?: boolean }
): ResolvedIR {
  // Check cache
  if (!options?.noCache) {
    const cacheKey = getCacheKey(schema);
    const cached = schemaCache.get(cacheKey);
    if (cached) return cached;
  }

  // Validate schema has orbitals
  if (!Array.isArray(schema.orbitals) || schema.orbitals.length === 0) {
    throw new Error('OrbitalSchema must have at least one orbital');
  }

  // Resolve components
  const entities = resolveEntities(schema);
  const { byName: traits, byId: traitsById } = resolveTraits(schema);
  const pages = resolvePages(schema, traits, traitsById);

  const ir: ResolvedIR = {
    appName: schema.name,
    description: schema.description,
    version: schema.version || '1.0.0',
    entities,
    traits,
    pages,
    entityBindings: [],
    generatedAt: new Date().toISOString(),
  };

  // Cache result
  if (!options?.noCache) {
    const cacheKey = getCacheKey(schema);
    schemaCache.set(cacheKey, ir);
  }

  return ir;
}

/**
 * Get a specific page from a resolved IR.
 *
 * @param ir - Resolved IR
 * @param pageName - Page name or path
 * @returns Resolved page or undefined
 */
export function getPage(ir: ResolvedIR, pageName?: string): ResolvedPage | undefined {
  if (!pageName) {
    // Return first page
    return ir.pages.values().next().value;
  }

  // Try by name
  let page = ir.pages.get(pageName);
  if (page) return page;

  // Try by path
  const pages = Array.from(ir.pages.values());
  for (const p of pages) {
    if (p.path === pageName) {
      return p;
    }
  }

  // Fallback to first page
  return pages[0];
}

/**
 * Get trait bindings for a specific page.
 *
 * @param ir - Resolved IR
 * @param pageName - Page name or path
 * @returns Trait bindings for the page
 */
export function getPageTraits(ir: ResolvedIR, pageName?: string): ResolvedTraitBinding[] {
  const page = getPage(ir, pageName);
  return page?.traits || [];
}
