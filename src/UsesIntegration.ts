/**
 * Uses Integration for OrbitalServerRuntime
 *
 * Pre-processes OrbitalSchema to resolve `uses` declarations
 * before registration with the runtime.
 *
 * Features:
 * - Resolves all `uses` imports
 * - Expands entity/trait/page references
 * - Handles entity persistence semantics
 * - Applies event namespacing for imported traits
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, Orbital, OrbitalDefinition, Entity, Page, Trait, TraitRef } from "@almadar/core";
import {
  isEntityReference,
  isPageReference,
  isPageReferenceString,
  isPageReferenceObject,
} from "@almadar/core";
import {
  ReferenceResolver,
  resolveSchema,
  type ResolvedOrbital,
  type ResolveOptions,
} from "./resolver/reference-resolver.js";
import {
  type SchemaLoader,
  createUnifiedLoader,
  isBrowser,
} from "./loader/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of pre-processing a schema.
 */
export interface PreprocessedSchema {
  /** Schema with all references resolved */
  schema: OrbitalSchema;

  /** Entity sharing information (for runtime isolation) */
  entitySharing: EntitySharingMap;

  /** Event namespace mapping */
  eventNamespaces: EventNamespaceMap;

  /** Warnings from resolution */
  warnings: string[];
}

/**
 * Map of orbital -> entity sharing info
 */
export interface EntitySharingMap {
  [orbitalName: string]: {
    /** The entity name */
    entityName: string;
    /** Persistence type */
    persistence: "persistent" | "runtime" | "singleton";
    /** Whether this entity is shared with other orbitals */
    isShared: boolean;
    /** Source orbital if imported */
    sourceAlias?: string;
    /** Collection name for persistent entities */
    collectionName?: string;
  };
}

/**
 * Map of trait events to namespaced events
 */
export interface EventNamespaceMap {
  [orbitalName: string]: {
    [traitName: string]: {
      /** Original event -> namespaced event */
      emits: Record<string, string>;
      /** Namespaced event -> original event (for listeners) */
      listens: Record<string, string>;
    };
  };
}

/**
 * Options for preprocessing.
 */
export interface PreprocessOptions extends ResolveOptions {
  /** Apply event namespacing to imported traits */
  namespaceEvents?: boolean;
}

/**
 * Result type for preprocessing.
 */
export type PreprocessResult =
  | { success: true; data: PreprocessedSchema }
  | { success: false; errors: string[] };

// ============================================================================
// Pre-processor
// ============================================================================

/**
 * Preprocess a schema to resolve all `uses` references.
 *
 * This is the integration point between the new `uses` system and the
 * existing OrbitalServerRuntime. It:
 *
 * 1. Resolves all `uses` declarations
 * 2. Expands entity references to inline definitions
 * 3. Expands trait references to inline definitions
 * 4. Expands page references with path overrides
 * 5. Builds entity sharing map for runtime isolation
 * 6. Builds event namespace map for cross-orbital events
 *
 * @example
 * ```typescript
 * const result = await preprocessSchema(schema, {
 *   basePath: "/project/schemas",
 * });
 *
 * if (result.success) {
 *   // Register the preprocessed schema
 *   runtime.register(result.data.schema);
 *
 *   // Use entitySharing for isolation decisions
 *   if (result.data.entitySharing["Level1"].persistence === "runtime") {
 *     // Entities are isolated per orbital
 *   }
 * }
 * ```
 */
export async function preprocessSchema(
  schema: OrbitalSchema,
  options: PreprocessOptions
): Promise<PreprocessResult> {
  const namespaceEvents = options.namespaceEvents ?? true;

  // Resolve all references
  const resolveResult = await resolveSchema(schema, options);
  if (!resolveResult.success) {
    return { success: false, errors: resolveResult.errors };
  }

  const resolved = resolveResult.data;
  const warnings = resolveResult.warnings;

  // Build preprocessed orbitals
  const preprocessedOrbitals: Orbital[] = [];
  const entitySharing: EntitySharingMap = {};
  const eventNamespaces: EventNamespaceMap = {};

  for (const resolvedOrbital of resolved) {
    const orbitalName = resolvedOrbital.name;

    // Build entity sharing info
    const persistence = resolvedOrbital.entitySource?.persistence ??
      (resolvedOrbital.entity.persistence as "persistent" | "runtime" | "singleton" | undefined) ??
      "persistent";

    entitySharing[orbitalName] = {
      entityName: resolvedOrbital.entity.name,
      persistence,
      isShared: persistence !== "runtime",
      sourceAlias: resolvedOrbital.entitySource?.alias,
      collectionName: resolvedOrbital.entity.collection,
    };

    // Build event namespace map
    eventNamespaces[orbitalName] = {};
    for (const resolvedTrait of resolvedOrbital.traits) {
      const traitName = resolvedTrait.trait.name;
      const namespace: { emits: Record<string, string>; listens: Record<string, string> } = {
        emits: {},
        listens: {},
      };

      // Namespace emitted events if the trait is imported
      if (namespaceEvents && resolvedTrait.source.type === "imported") {
        const emits = resolvedTrait.trait.emits ?? [];
        for (const emit of emits) {
          const eventName = typeof emit === "string" ? emit : emit.event;
          // External events get namespaced: OrbitalName.TraitName.EVENT
          namespace.emits[eventName] = `${orbitalName}.${traitName}.${eventName}`;
        }

        const listens = resolvedTrait.trait.listens ?? [];
        for (const listen of listens) {
          // Listening to namespaced events
          namespace.listens[listen.event] = listen.event;
        }
      }

      eventNamespaces[orbitalName][traitName] = namespace;
    }

    // Build preprocessed orbital with resolved inline definitions
    const preprocessedOrbital: OrbitalDefinition = {
      name: orbitalName,
      description: resolvedOrbital.original.description,
      visual_prompt: resolvedOrbital.original.visual_prompt,
      // Resolved entity (always inline now)
      entity: resolvedOrbital.entity,
      // Resolved traits (inline definitions)
      traits: resolvedOrbital.traits.map((rt) => {
        // If it has config or linkedEntity, wrap in reference object
        if (rt.config || rt.linkedEntity) {
          return {
            ref: rt.trait.name,
            config: rt.config,
            linkedEntity: rt.linkedEntity,
            // Include the resolved trait definition for runtime
            _resolved: rt.trait,
          } as TraitRef;
        }
        // Otherwise return the inline trait
        return rt.trait as TraitRef;
      }),
      // Resolved pages (inline definitions with path overrides applied)
      pages: resolvedOrbital.pages.map((rp) => rp.page),
      // Preserve other fields
      exposes: resolvedOrbital.original.exposes,
      domainContext: resolvedOrbital.original.domainContext,
      design: resolvedOrbital.original.design,
    };

    preprocessedOrbitals.push(preprocessedOrbital);
  }

  // Build preprocessed schema
  const preprocessedSchema: OrbitalSchema = {
    ...schema,
    orbitals: preprocessedOrbitals,
  };

  return {
    success: true,
    data: {
      schema: preprocessedSchema,
      entitySharing,
      eventNamespaces,
      warnings,
    },
  };
}

// ============================================================================
// Entity Isolation Helper
// ============================================================================

/**
 * Get the collection name for an orbital's entity, considering isolation.
 *
 * - `persistent` entities share the same collection
 * - `runtime` entities get isolated collections per orbital
 * - `singleton` entities share a single-record collection
 */
export function getIsolatedCollectionName(
  orbitalName: string,
  entitySharing: EntitySharingMap
): string {
  const info = entitySharing[orbitalName];
  if (!info) {
    throw new Error(`Unknown orbital: ${orbitalName}`);
  }

  if (info.persistence === "runtime") {
    // Isolated: use orbital-prefixed collection
    return `${orbitalName}_${info.entityName}`;
  }

  // Shared: use the entity's collection name or default
  return info.collectionName || info.entityName.toLowerCase() + "s";
}

// ============================================================================
// Event Namespacing Helper
// ============================================================================

/**
 * Get the namespaced event name for an orbital's trait event.
 */
export function getNamespacedEvent(
  orbitalName: string,
  traitName: string,
  eventName: string,
  eventNamespaces: EventNamespaceMap
): string {
  const orbitalNs = eventNamespaces[orbitalName];
  if (!orbitalNs) return eventName;

  const traitNs = orbitalNs[traitName];
  if (!traitNs) return eventName;

  return traitNs.emits[eventName] || eventName;
}

/**
 * Check if an event name is namespaced (contains dots).
 */
export function isNamespacedEvent(eventName: string): boolean {
  return eventName.includes(".");
}

/**
 * Parse a namespaced event name.
 */
export function parseNamespacedEvent(
  eventName: string
): { orbital?: string; trait?: string; event: string } {
  const parts = eventName.split(".");
  if (parts.length === 3) {
    return { orbital: parts[0], trait: parts[1], event: parts[2] };
  }
  if (parts.length === 2) {
    return { trait: parts[0], event: parts[1] };
  }
  return { event: eventName };
}

// ============================================================================
// Loader Factory Helper
// ============================================================================

/**
 * Options for creating a schema preprocessor.
 */
export interface CreatePreprocessorOptions {
  /** Base path for schema files */
  basePath: string;

  /** Standard library path (filesystem or URL) */
  stdLibPath?: string;

  /** Scoped package paths */
  scopedPaths?: Record<string, string>;

  /** Custom loader instance (optional) */
  loader?: SchemaLoader;

  /** Apply event namespacing to imported traits */
  namespaceEvents?: boolean;
}

/**
 * Create a schema preprocessor with automatic loader selection.
 *
 * In browser environments, uses HttpLoader.
 * In Node.js/Electron, uses UnifiedLoader (filesystem + HTTP fallback).
 *
 * @example
 * ```typescript
 * // Server-side (Node.js)
 * const preprocessor = createPreprocessor({
 *   basePath: "/project/schemas",
 *   stdLibPath: "/project/std",
 * });
 *
 * // Browser-side (uses HTTP)
 * const preprocessor = createPreprocessor({
 *   basePath: "/api/schemas",
 *   stdLibPath: "https://cdn.example.com/orbital-std",
 * });
 *
 * // Custom loader
 * const preprocessor = createPreprocessor({
 *   basePath: "/schemas",
 *   loader: myCustomLoader,
 * });
 * ```
 */
export function createPreprocessor(options: CreatePreprocessorOptions): {
  preprocess: (schema: OrbitalSchema) => Promise<PreprocessResult>;
  loader: SchemaLoader;
} {
  // Create loader if not provided
  const loader = options.loader ?? createUnifiedLoader({
    basePath: options.basePath,
    stdLibPath: options.stdLibPath,
    scopedPaths: options.scopedPaths,
  });

  const preprocess = (schema: OrbitalSchema) =>
    preprocessSchema(schema, {
      basePath: options.basePath,
      stdLibPath: options.stdLibPath,
      scopedPaths: options.scopedPaths,
      loader,
      namespaceEvents: options.namespaceEvents,
    });

  return { preprocess, loader };
}

/**
 * Preprocess a schema with automatic loader selection.
 *
 * Convenience wrapper around `preprocessSchema` that creates
 * an appropriate loader based on the environment.
 *
 * @example
 * ```typescript
 * const result = await preprocessSchemaAuto(schema, {
 *   basePath: "/schemas",
 *   stdLibPath: "/std",
 * });
 * ```
 */
export async function preprocessSchemaAuto(
  schema: OrbitalSchema,
  options: Omit<CreatePreprocessorOptions, "loader">
): Promise<PreprocessResult> {
  const { preprocess } = createPreprocessor(options);
  return preprocess(schema);
}
