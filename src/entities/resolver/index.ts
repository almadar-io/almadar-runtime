/**
 * Shared Resolver Module
 *
 * Converts OrbitalSchema to ResolvedIR for use by
 * both the compiler and runtime.
 *
 * @packageDocumentation
 */

export {
  schemaToIR,
  getPage,
  getPageTraits,
  clearSchemaCache,
} from "./schema-to-ir.js";

// Computed Event Interface (Trait-Centric Model)
export {
  computeOrbitalEventInterface,
  hasExternalEvents,
  getOrbitalEmitNames,
  getOrbitalListenNames,
  findEmitSource,
  findListenSource,
  type ComputedEventInterface,
  type TraitResolver,
} from "./compute-event-interface.js";

// Reference Resolution (Uses System)
export {
  ReferenceResolver,
  createResolver,
  resolveSchema,
  type ResolvedImports,
  type ResolvedImport,
  type ResolvedOrbital,
  type ResolvedTrait,
  type ResolvedPage,
  type ResolveOptions,
  type ResolveResult,
} from "./reference-resolver.js";
