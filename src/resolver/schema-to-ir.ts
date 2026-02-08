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
} from '@almadar/core';
import {
  isEntityReference,
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

function resolveField(field: any): ResolvedField {
  // Collect enum values from all possible locations
  const enumValues = field.enumValues || field.values || field.options || field.validation?.enum;

  return {
    name: field.name,
    type: field.type || 'string',
    tsType: inferTsType(field.type || 'string'),
    description: field.description,
    default: field.default,
    required: field.required ?? false,
    validation: field.validation || (enumValues ? { enum: enumValues } : undefined),
    values: enumValues,
    enumValues: enumValues, // Also provide enumValues for compatibility
    relation: field.relation,
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

    const entityRef = (orbital as any).entity as EntityRef | undefined;
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
    } else {
      // Inline entity definition
      const entity = entityRef;
      // Derive runtime/singleton from persistence field
      const isRuntime = entity.persistence === 'runtime';
      const isSingleton = entity.persistence === 'singleton';
      const entityInstances = (entity as any).instances as Record<string, unknown>[] | undefined;
      entityMap.set(entity.name, {
        name: entity.name,
        description: entity.description,
        collection: entity.collection || entity.name.toLowerCase() + 's',
        fields: (entity.fields || []).map(resolveField),
        usedByTraits: [],
        usedByPages: [],
        runtime: isRuntime,
        singleton: isSingleton,
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
      fields: (de.fields || []).map(resolveField),
      runtime: de.runtime ?? false,
      singleton: de.singleton ?? false,
    })),
    config: trait.config,
    ui: trait.ui,
  };
}

function resolveTraits(schema: OrbitalSchema): Map<string, ResolvedTrait> {
  const traitMap = new Map<string, ResolvedTrait>();

  // Note: OrbitalSchema no longer has top-level traits
  // Traits are only inside orbitals now

  // Collect inline traits from orbital.traits
  for (const orbital of schema.orbitals || []) {
    if ('ref' in orbital && !('traits' in orbital)) continue;

    const orbitalDef = orbital as any;
    const orbitalTraits = orbitalDef.traits || [];

    for (const trait of orbitalTraits) {
      // Skip trait references (they have 'ref')
      if (typeof trait === 'string' || trait.ref) continue;

      // This is an inline trait definition
      if (!trait.name || traitMap.has(trait.name)) continue;

      traitMap.set(trait.name, resolveTrait(trait, 'inline'));
    }
  }

  return traitMap;
}

// ============================================================================
// Page Resolution
// ============================================================================

function resolveTraitBinding(
  t: any,
  traitMap: Map<string, ResolvedTrait>,
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

  // Case 2: Reference object { ref: "TraitName" }
  if (t.ref && !t.stateMachine) {
    const trait = traitMap.get(t.ref);
    return {
      ref: t.ref,
      trait: trait || createEmptyTrait(t.ref, 'library'),
      config: t.config,
      linkedEntity: t.linkedEntity || orbitalEntity,
    };
  }

  // Case 3: Inline trait definition (has stateMachine or name with states)
  if (t.stateMachine || (t.name && !t.ref)) {
    const inlineTrait = resolveTrait(t, 'inline');

    return {
      ref: t.name,
      trait: inlineTrait,
      config: t.config,
      linkedEntity: t.linkedEntity || orbitalEntity,
    };
  }

  // Fallback: try to look up by name
  const ref = t.name || t.ref || 'unknown';
  const trait = traitMap.get(ref);
  return {
    ref,
    trait: trait || createEmptyTrait(ref, 'library'),
    config: t.config,
    linkedEntity: t.linkedEntity || orbitalEntity,
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
  traitMap: Map<string, ResolvedTrait>
): Map<string, ResolvedPage> {
  const pageMap = new Map<string, ResolvedPage>();

  for (const orbital of schema.orbitals || []) {
    // Skip orbital references
    if ('ref' in orbital && !('pages' in orbital)) continue;

    const orbitalDef = orbital as any;
    const orbitalName = orbitalDef.name;
    // Handle EntityRef: can be string or inline entity
    const orbitalEntity = getEntityNameFromRef(orbitalDef.entity);

    for (const pageRef of orbitalDef.pages || []) {
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
        const binding = resolveTraitBinding(t, traitMap, orbitalEntity);

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
        viewType: (pageRef as any).viewType,
        layout: (pageRef as any).layout,
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
  const traits = resolveTraits(schema);
  const pages = resolvePages(schema, traits);

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
