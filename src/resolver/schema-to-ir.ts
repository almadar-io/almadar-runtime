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
} from '@almadar/core';
import {
  isEntityReference,
  isEntityCall,
  isPageReferenceString,
  isPageReferenceObject,
  inferTsType,
} from '@almadar/core';

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
  // Use a local extra variable for accessing non-EntityField properties
  interface FieldExtra { enumValues?: string[]; values?: string[]; options?: string[]; validation?: { enum?: string[] }; description?: string }
  const extra = field as EntityField & FieldExtra;
  // Collect enum values from all possible locations
  const enumValues = extra.enumValues || extra.values || extra.options || extra.validation?.enum;

  return {
    // EntityField.name is optional in @almadar/core 7+ (matches Rust IR
    // FieldDefinition.name: Option<String>). Top-level entity fields
    // always carry a name; nameless nested item descriptors don't reach
    // this resolver path.
    name: field.name ?? '',
    type: field.type || 'string',
    tsType: inferTsType(field.type || 'string'),
    description: extra.description as string | undefined,
    default: field.default as string | undefined,
    required: field.required ?? false,
    validation: extra.validation || (enumValues ? { enum: enumValues } : undefined),
    values: enumValues,
    enumValues: enumValues, // Also provide enumValues for compatibility
    relation: field.type === 'relation' ? field.relation : undefined,
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

function resolveStateMachine(sm: any): {
  states: ResolvedTraitState[];
  events: ResolvedTraitEvent[];
  transitions: ResolvedTraitTransition[];
} {
  return {
    states: (sm?.states || []).map((s: any) => ({
      name: s.name,
      isInitial: s.isInitial ?? false,
      isFinal: s.isFinal ?? false,
    })),
    events: (sm?.events || []).map((e: any) => ({
      key: e.key,
      name: e.name || e.key,
    })),
    transitions: (sm?.transitions || []).map((t: any) => ({
      from: t.from as TransitionFrom,
      to: t.to,
      event: t.event,
      guard: t.guard as SExpr | undefined,
      effects: (t.effects || []) as SExpr[],
    })),
  };
}

function resolveTrait(trait: any, source: 'schema' | 'library' | 'inline'): ResolvedTrait {
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
    guards: (sm?.guards || []).map((g: any) => ({
      name: g.name,
      condition: g.condition as SExpr,
    })),
    ticks: (trait.ticks || []).map((tick: any): ResolvedTraitTick => ({
      name: tick.name || 'tick',
      interval: tick.interval || 0,
      guard: tick.guard as SExpr | undefined,
      effects: (tick.effects || []) as SExpr[],
      priority: tick.priority ?? 0,
      appliesTo: tick.appliesTo || [],
    })),
    listens: (trait.listens || []).map((listen: any): ResolvedTraitListener => ({
      event: listen.event || '',
      triggers: listen.action || listen.triggers || '',
      guard: listen.guard as SExpr | undefined,
    })),
    dataEntities: (trait.dataEntities || []).map((de: any) => ({
      name: de.name,
      fields: (de.fields || []).map((f: unknown) => resolveField(f as EntityField)),
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
        // eslint-disable-next-line almadar/no-record-string-unknown -- dynamic shape from preprocessor
        const wrap = trait as Record<string, unknown>;
        const resolved = wrap['_resolved'] as { name?: string; id?: string; stateMachine?: unknown } | undefined;
        if (resolved && resolved.stateMachine) {
          const name = resolved.name ?? (trait as { ref?: string }).ref;
          if (name && !traitMap.has(name)) {
            const resolvedTrait = resolveTrait(resolved, 'inline');
            traitMap.set(name, resolvedTrait);
            if (resolved.id) traitById.set(resolved.id, resolvedTrait);
            // V4 composed-surface backbone: page-ref refIds point at the
            // wrapper's own LOCAL declaration id (distinct from the resolved
            // atom's id) — register it so a renamed declaration still binds.
            const declId = wrap['id'];
            if (typeof declId === 'string' && declId.length > 0) {
              traitById.set(declId, resolvedTrait);
            }
          }
        }
        continue;
      }

      // Plain inline trait definition
      if (!trait.name || traitMap.has(trait.name)) continue;
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
  t: any,
  traitMap: Map<string, ResolvedTrait>,
  traitById: Map<string, ResolvedTrait>,
  orbitalEntity?: string
): ResolvedTraitBinding {
  // Case 1: String reference
  if (typeof t === 'string') {
    const trait = traitMap.get(t);
    return {
      ref: t,
      trait: trait || createEmptyTrait(t, 'library'),
      linkedEntity: orbitalEntity,
    };
  }

  // Case 2: Reference object { ref: "TraitName", ... }
  // Preprocessed ref traits from @almadar/runtime's preprocessSchema carry
  // `_resolved: FullTrait` alongside the ref — the state machine (with events
  // rename already applied at preprocess time) lives there. If we skip the
  // `_resolved` path, traitMap.get(t.ref) returns undefined for renamed refs
  // like "CartItemAddItem" (which aren't top-level library traits), we fall
  // back to createEmptyTrait, and useTraitStateMachine subscribes to zero
  // events. Result: UI:ADD_ITEM button clicks have no listener and the state
  // machine is silent.
  if (t.ref && !t.stateMachine) {
    if (t._resolved && t._resolved.stateMachine) {
      // Wrapper-level rebind wins; otherwise inherit the inlined atom's
      // own linkedEntity (e.g. PagedItem for std-pagination), and fall
      // back to the orbital's primary entity only if neither names a
      // target. Without this, atoms imported via `uses` without an
      // explicit `-> Entity` rebind silently rebind to the orbital's
      // primary entity (the gap #22 design intent of "atoms keep their
      // own auxiliary entity" was being overridden here).
      return {
        ref: t._resolved.name ?? t.ref,
        trait: resolveTrait(t._resolved, 'inline'),
        config: t.config,
        linkedEntity: t.linkedEntity || t._resolved.linkedEntity || orbitalEntity,
      };
    }
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

  // Case 3: Inline trait definition (has stateMachine or name with states)
  if (t.stateMachine || (t.name && !t.ref)) {
    const inlineTrait = resolveTrait(t, 'inline');

    return {
      ref: t.name,
      trait: inlineTrait,
      config: t.config,
      linkedEntity: t.linkedEntity || inlineTrait.linkedEntity || orbitalEntity,
    };
  }

  // Fallback: try to look up by id (stable under rename) then by name
  const ref = t.name || t.ref || 'unknown';
  const trait = (t.refId && traitById.get(t.refId)) ?? traitMap.get(ref);
  return {
    ref,
    trait: trait || createEmptyTrait(ref, 'library'),
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
function getPageInfoFromRef(pageRef: PageRef): { name: string; path: string; traits: any[] } | null {
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

      // Page traits can be:
      // 1. References to traits (string or { ref: "TraitName" })
      // 2. Inline trait definitions (object with stateMachine)
      const pageTraitRefs = pageInfo.traits || [];

      const traitBindings: ResolvedTraitBinding[] = pageTraitRefs.map((t: any) => {
        const binding = resolveTraitBinding(t, traitMap, traitById, orbitalEntity);

        // Also add inline traits to traitMap for consistency
        if (binding.trait.source === 'inline' && !traitMap.has(binding.trait.name)) {
          traitMap.set(binding.trait.name, binding.trait);
        }

        return binding;
      });

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
