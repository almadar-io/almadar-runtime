/**
 * Reference Resolver
 *
 * Resolves `uses` imports and component references in OrbitalSchema.
 * Handles:
 * - `Alias.entity` entity references
 * - `Alias.traits.TraitName` trait references
 * - `Alias.pages.PageName` page references
 *
 * @packageDocumentation
 */

import type {
  Orbital,
  OrbitalDefinition,
  EntityRef,
  PageRef,
  PageRefObject,
  Entity,
  Page,
  Trait,
  TraitRef,
  OrbitalSchema,
} from "@almadar/core";
import {
  isEntityReference,
  isPageReference,
  isPageReferenceString,
  isPageReferenceObject,
  parseEntityRef,
  parsePageRef,
  parseImportedTraitRef,
} from "@almadar/core";
import {
  ExternalOrbitalLoader,
  ImportChain,
  type LoaderOptions,
} from "../loader/external-loader.js";
import type {
  SchemaLoader,
  ImportChainLike,
} from "../loader/schema-loader.js";

// UseDeclaration type (not exported from @almadar/core, define locally)
type UseDeclaration = {
  path: string;
  alias?: string;
};

// ============================================================================
// Types
// ============================================================================

/**
 * Resolved imports from `uses` declarations.
 */
export interface ResolvedImports {
  /** Map of alias -> loaded orbital */
  orbitals: Map<string, ResolvedImport>;
}

/**
 * A single resolved import.
 */
export interface ResolvedImport {
  /** The alias used for this import */
  alias: string;

  /** The original import path */
  from: string;

  /** The loaded orbital */
  orbital: Orbital;

  /** Absolute source path */
  sourcePath: string;
}

/**
 * Fully resolved orbital with all references expanded.
 */
export interface ResolvedOrbital {
  /** Original orbital name */
  name: string;

  /** Resolved entity (always inline after resolution) */
  entity: Entity;

  /** Whether entity was referenced from an import */
  entitySource?: {
    alias: string;
    persistence: "persistent" | "runtime" | "singleton";
  };

  /** Resolved traits (references expanded) */
  traits: ResolvedTrait[];

  /** Resolved pages (references expanded with path overrides applied) */
  pages: ResolvedPage[];

  /** Resolved imports */
  imports: ResolvedImports;

  /** Original orbital definition */
  original: OrbitalDefinition;
}

/**
 * Resolved trait with source tracking.
 */
export interface ResolvedTrait {
  /** The trait definition */
  trait: Trait;

  /** Source of the trait */
  source:
    | { type: "inline" }
    | { type: "local"; name: string }
    | { type: "imported"; alias: string; traitName: string };

  /** Linked entity for this trait */
  linkedEntity?: string;

  /** Configuration overrides */
  config?: Record<string, unknown>;
}

/**
 * Resolved page with source tracking.
 */
export interface ResolvedPage {
  /** The page definition */
  page: Page;

  /** Source of the page */
  source:
    | { type: "inline" }
    | { type: "imported"; alias: string; pageName: string };

  /** Whether path was overridden */
  pathOverridden: boolean;

  /** Original path before override */
  originalPath?: string;
}

/**
 * Resolution options.
 */
export interface ResolveOptions extends LoaderOptions {
  /** Map of local trait definitions (name -> trait) */
  localTraits?: Map<string, Trait>;

  /** Whether to skip loading external imports (for testing) */
  skipExternalLoading?: boolean;

  /** Custom schema loader instance (optional, defaults to ExternalOrbitalLoader) */
  loader?: SchemaLoader;
}

/**
 * Resolution result.
 */
export type ResolveResult<T> =
  | { success: true; data: T; warnings: string[] }
  | { success: false; errors: string[] };

// ============================================================================
// Reference Resolver
// ============================================================================

/**
 * ReferenceResolver - Resolves all references in an orbital.
 */
export class ReferenceResolver {
  private loader: SchemaLoader;
  private options: ResolveOptions;
  private localTraits: Map<string, Trait>;

  constructor(options: ResolveOptions) {
    this.options = options;
    // Use provided loader or create default ExternalOrbitalLoader
    this.loader = options.loader ?? new ExternalOrbitalLoader(options);
    this.localTraits = options.localTraits ?? new Map();
  }

  /**
   * Resolve all references in an orbital.
   */
  async resolve(
    orbital: OrbitalDefinition,
    sourcePath?: string,
    chain?: ImportChainLike
  ): Promise<ResolveResult<ResolvedOrbital>> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const importChain = chain ?? new ImportChain();

    // Step 1: Resolve imports
    const importsResult = await this.resolveImports(
      orbital.uses ?? [],
      sourcePath,
      importChain
    );
    if (!importsResult.success) {
      return { success: false, errors: importsResult.errors };
    }
    const imports = importsResult.data;

    // Step 2: Resolve entity
    const entityResult = this.resolveEntity(orbital.entity, imports);
    if (!entityResult.success) {
      errors.push(...entityResult.errors);
    }

    // Step 3: Resolve traits
    const traitsResult = this.resolveTraits(orbital.traits, imports);
    if (!traitsResult.success) {
      errors.push(...traitsResult.errors);
    }

    // Step 4: Resolve pages
    const pagesResult = this.resolvePages(orbital.pages, imports);
    if (!pagesResult.success) {
      errors.push(...pagesResult.errors);
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    // At this point all results are successful (errors array is empty)
    // Use type narrowing to access data safely
    if (!entityResult.success || !traitsResult.success || !pagesResult.success) {
      // This should never happen since we checked errors above
      return { success: false, errors: ['Internal error: unexpected failure state'] };
    }

    return {
      success: true,
      data: {
        name: orbital.name,
        entity: entityResult.data.entity,
        entitySource: entityResult.data.source,
        traits: traitsResult.data,
        pages: pagesResult.data,
        imports,
        original: orbital,
      },
      warnings,
    };
  }

  /**
   * Resolve `uses` declarations to loaded orbitals.
   */
  private async resolveImports(
    uses: UseDeclaration[],
    sourcePath?: string,
    chain?: ImportChainLike
  ): Promise<ResolveResult<ResolvedImports>> {
    const errors: string[] = [];
    const orbitals = new Map<string, ResolvedImport>();

    if (this.options.skipExternalLoading) {
      return {
        success: true,
        data: { orbitals },
        warnings: ["External loading skipped"],
      };
    }

    for (const use of uses) {
      // Check for duplicate aliases
      if (orbitals.has(use.as)) {
        errors.push(`Duplicate import alias: ${use.as}`);
        continue;
      }

      // Load the orbital
      const loadResult = await this.loader.loadOrbital(
        use.from,
        undefined,
        sourcePath,
        chain
      );

      if (!loadResult.success) {
        errors.push(`Failed to load "${use.from}" as "${use.as}": ${loadResult.error}`);
        continue;
      }

      orbitals.set(use.as, {
        alias: use.as,
        from: use.from,
        orbital: loadResult.data.orbital,
        sourcePath: loadResult.data.sourcePath,
      });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: { orbitals }, warnings: [] };
  }

  /**
   * Resolve entity reference.
   */
  private resolveEntity(
    entityRef: EntityRef,
    imports: ResolvedImports
  ): ResolveResult<{
    entity: Entity;
    source?: { alias: string; persistence: "persistent" | "runtime" | "singleton" };
  }> {
    // Inline entity
    if (!isEntityReference(entityRef)) {
      return {
        success: true,
        data: { entity: entityRef },
        warnings: [],
      };
    }

    // Reference: "Alias.entity"
    const parsed = parseEntityRef(entityRef);
    if (!parsed) {
      return {
        success: false,
        errors: [`Invalid entity reference format: ${entityRef}. Expected "Alias.entity"`],
      };
    }

    const imported = imports.orbitals.get(parsed.alias);
    if (!imported) {
      return {
        success: false,
        errors: [
          `Unknown import alias in entity reference: ${parsed.alias}. ` +
            `Available aliases: ${Array.from(imports.orbitals.keys()).join(", ") || "none"}`,
        ],
      };
    }

    // Get entity from imported orbital
    const importedEntity = this.getEntityFromOrbital(imported.orbital);
    if (!importedEntity) {
      return {
        success: false,
        errors: [
          `Imported orbital "${parsed.alias}" does not have an inline entity. ` +
            `Entity references cannot be chained.`,
        ],
      };
    }

    // Determine persistence type
    const persistence = importedEntity.persistence ?? "persistent";

    return {
      success: true,
      data: {
        entity: importedEntity,
        source: {
          alias: parsed.alias,
          persistence: persistence as "persistent" | "runtime" | "singleton",
        },
      },
      warnings: [],
    };
  }

  /**
   * Get the entity from an orbital (handling EntityRef).
   */
  private getEntityFromOrbital(orbital: Orbital): Entity | null {
    const entityRef = orbital.entity;
    if (typeof entityRef === "string") {
      // It's a reference - we don't support chained references
      return null;
    }
    return entityRef;
  }

  /**
   * Resolve trait references.
   */
  private resolveTraits(
    traitRefs: TraitRef[],
    imports: ResolvedImports
  ): ResolveResult<ResolvedTrait[]> {
    const errors: string[] = [];
    const resolved: ResolvedTrait[] = [];

    for (const traitRef of traitRefs) {
      const result = this.resolveTraitRef(traitRef, imports);
      if (!result.success) {
        errors.push(...result.errors);
      } else {
        resolved.push(result.data!);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: resolved, warnings: [] };
  }

  /**
   * Resolve a single trait reference.
   */
  private resolveTraitRef(
    traitRef: TraitRef,
    imports: ResolvedImports
  ): ResolveResult<ResolvedTrait> {
    // Case 1: Inline trait definition
    if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
      return {
        success: true,
        data: {
          trait: traitRef as Trait,
          source: { type: "inline" },
        },
        warnings: [],
      };
    }

    // Case 2: Reference object { ref: "...", config: {...} }
    if (typeof traitRef !== "string" && "ref" in traitRef) {
      const refObj = traitRef as { ref: string; config?: Record<string, unknown>; linkedEntity?: string };
      return this.resolveTraitRefString(refObj.ref, imports, refObj.config, refObj.linkedEntity);
    }

    // Case 3: String reference
    if (typeof traitRef === "string") {
      return this.resolveTraitRefString(traitRef, imports);
    }

    return {
      success: false,
      errors: [`Unknown trait reference format: ${JSON.stringify(traitRef)}`],
    };
  }

  /**
   * Resolve a trait reference string.
   */
  private resolveTraitRefString(
    ref: string,
    imports: ResolvedImports,
    config?: Record<string, unknown>,
    linkedEntity?: string
  ): ResolveResult<ResolvedTrait> {
    // Check if it's an imported trait reference: "Alias.traits.TraitName"
    const parsed = parseImportedTraitRef(ref);

    if (parsed) {
      // Imported trait
      const imported = imports.orbitals.get(parsed.alias);
      if (!imported) {
        return {
          success: false,
          errors: [
            `Unknown import alias in trait reference: ${parsed.alias}. ` +
              `Available aliases: ${Array.from(imports.orbitals.keys()).join(", ") || "none"}`,
          ],
        };
      }

      // Find the trait in the imported orbital
      const trait = this.findTraitInOrbital(imported.orbital, parsed.traitName);
      if (!trait) {
        return {
          success: false,
          errors: [
            `Trait "${parsed.traitName}" not found in imported orbital "${parsed.alias}". ` +
              `Available traits: ${this.listTraitsInOrbital(imported.orbital).join(", ") || "none"}`,
          ],
        };
      }

      return {
        success: true,
        data: {
          trait,
          source: { type: "imported", alias: parsed.alias, traitName: parsed.traitName },
          config,
          linkedEntity,
        },
        warnings: [],
      };
    }

    // Local trait (from localTraits map)
    const localTrait = this.localTraits.get(ref);
    if (localTrait) {
      return {
        success: true,
        data: {
          trait: localTrait,
          source: { type: "local", name: ref },
          config,
          linkedEntity,
        },
        warnings: [],
      };
    }

    return {
      success: false,
      errors: [
        `Trait "${ref}" not found. ` +
          `For imported traits, use format "Alias.traits.TraitName". ` +
          `Local traits available: ${Array.from(this.localTraits.keys()).join(", ") || "none"}`,
      ],
    };
  }

  /**
   * Find a trait in an orbital by name.
   */
  private findTraitInOrbital(orbital: Orbital, traitName: string): Trait | null {
    for (const traitRef of orbital.traits) {
      // Inline trait
      if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
        if ((traitRef as Trait).name === traitName) {
          return traitRef as Trait;
        }
      }
      // Reference with name
      if (typeof traitRef !== "string" && "ref" in traitRef) {
        const refObj = traitRef as { ref?: string; name?: string };
        if (refObj.ref === traitName || refObj.name === traitName) {
          // This is a reference, not an inline definition
          // We can't return it directly - need to look up in local traits
          // For now, skip these
        }
      }
    }
    return null;
  }

  /**
   * List trait names in an orbital.
   */
  private listTraitsInOrbital(orbital: Orbital): string[] {
    const names: string[] = [];
    for (const traitRef of orbital.traits) {
      if (typeof traitRef !== "string" && "stateMachine" in traitRef) {
        names.push((traitRef as Trait).name);
      }
    }
    return names;
  }

  /**
   * Resolve page references.
   */
  private resolvePages(
    pageRefs: PageRef[],
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage[]> {
    const errors: string[] = [];
    const resolved: ResolvedPage[] = [];

    for (const pageRef of pageRefs) {
      const result = this.resolvePageRef(pageRef, imports);
      if (!result.success) {
        errors.push(...result.errors);
      } else {
        resolved.push(result.data!);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: resolved, warnings: [] };
  }

  /**
   * Resolve a single page reference.
   */
  private resolvePageRef(
    pageRef: PageRef,
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage> {
    // Case 1: Inline page definition
    if (!isPageReference(pageRef)) {
      return {
        success: true,
        data: {
          page: pageRef as Page,
          source: { type: "inline" },
          pathOverridden: false,
        },
        warnings: [],
      };
    }

    // Case 2: String reference "Alias.pages.PageName"
    if (isPageReferenceString(pageRef)) {
      return this.resolvePageRefString(pageRef, imports);
    }

    // Case 3: Object reference { ref: "Alias.pages.PageName", path?: "/override" }
    if (isPageReferenceObject(pageRef)) {
      return this.resolvePageRefObject(pageRef, imports);
    }

    return {
      success: false,
      errors: [`Unknown page reference format: ${JSON.stringify(pageRef)}`],
    };
  }

  /**
   * Resolve a page reference string.
   */
  private resolvePageRefString(
    ref: string,
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage> {
    const parsed = parsePageRef(ref);
    if (!parsed) {
      return {
        success: false,
        errors: [`Invalid page reference format: ${ref}. Expected "Alias.pages.PageName"`],
      };
    }

    const imported = imports.orbitals.get(parsed.alias);
    if (!imported) {
      return {
        success: false,
        errors: [
          `Unknown import alias in page reference: ${parsed.alias}. ` +
            `Available aliases: ${Array.from(imports.orbitals.keys()).join(", ") || "none"}`,
        ],
      };
    }

    const page = this.findPageInOrbital(imported.orbital, parsed.pageName);
    if (!page) {
      return {
        success: false,
        errors: [
          `Page "${parsed.pageName}" not found in imported orbital "${parsed.alias}". ` +
            `Available pages: ${this.listPagesInOrbital(imported.orbital).join(", ") || "none"}`,
        ],
      };
    }

    return {
      success: true,
      data: {
        page,
        source: { type: "imported", alias: parsed.alias, pageName: parsed.pageName },
        pathOverridden: false,
      },
      warnings: [],
    };
  }

  /**
   * Resolve a page reference object with optional path override.
   */
  private resolvePageRefObject(
    refObj: PageRefObject,
    imports: ResolvedImports
  ): ResolveResult<ResolvedPage> {
    const baseResult = this.resolvePageRefString(refObj.ref, imports);
    if (!baseResult.success) {
      return baseResult;
    }

    const resolved = baseResult.data!;

    // Apply path override if provided
    if (refObj.path) {
      const originalPath = resolved.page.path;
      resolved.page = {
        ...resolved.page,
        path: refObj.path,
      };
      resolved.pathOverridden = true;
      resolved.originalPath = originalPath;
    }

    return {
      success: true,
      data: resolved,
      warnings: baseResult.warnings,
    };
  }

  /**
   * Find a page in an orbital by name.
   */
  private findPageInOrbital(orbital: Orbital, pageName: string): Page | null {
    const pages = orbital.pages;
    if (!pages) return null;

    for (const pageRef of pages) {
      // Only look at inline pages (we don't support chained page references)
      if (typeof pageRef !== "string" && !("ref" in pageRef)) {
        const page = pageRef as Page;
        if (page.name === pageName) {
          // Return a copy to avoid mutation issues
          return { ...page };
        }
      }
    }
    return null;
  }

  /**
   * List page names in an orbital.
   */
  private listPagesInOrbital(orbital: Orbital): string[] {
    const pages = orbital.pages;
    if (!pages) return [];

    const names: string[] = [];
    for (const pageRef of pages) {
      if (typeof pageRef !== "string" && !("ref" in pageRef)) {
        names.push((pageRef as Page).name);
      }
    }
    return names;
  }

  /**
   * Add local traits for resolution.
   */
  addLocalTraits(traits: Trait[]): void {
    for (const trait of traits) {
      this.localTraits.set(trait.name, trait);
    }
  }

  /**
   * Clear loader cache.
   */
  clearCache(): void {
    this.loader.clearCache();
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a reference resolver with sensible defaults.
 */
export function createResolver(
  basePath: string,
  options?: Partial<ResolveOptions>
): ReferenceResolver {
  return new ReferenceResolver({
    basePath,
    ...options,
  });
}

// ============================================================================
// Schema Resolution
// ============================================================================

/**
 * Resolve all references in an OrbitalSchema.
 */
export async function resolveSchema(
  schema: OrbitalSchema,
  options: ResolveOptions
): Promise<ResolveResult<ResolvedOrbital[]>> {
  const resolver = new ReferenceResolver(options);
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedOrbital[] = [];

  // Collect all inline traits from all orbitals for local trait resolution
  for (const orbital of schema.orbitals) {
    const inlineTraits = orbital.traits.filter(
      (t): t is Trait => typeof t !== "string" && "stateMachine" in t
    );
    resolver.addLocalTraits(inlineTraits);
  }

  // Resolve each orbital
  for (const orbital of schema.orbitals) {
    const result = await resolver.resolve(orbital);
    if (!result.success) {
      errors.push(`Orbital "${orbital.name}": ${result.errors.join(", ")}`);
    } else {
      resolved.push(result.data);
      warnings.push(...result.warnings.map((w) => `Orbital "${orbital.name}": ${w}`));
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, data: resolved, warnings };
}
