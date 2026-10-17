/**
 * External Orbital Loader
 *
 * Loads external .orb files from various sources:
 * - Local filesystem (relative paths)
 * - Standard library (std/...)
 * - Scoped packages (@name/...)
 *
 * @packageDocumentation
 */

import * as fs from "fs";
import * as path from "path";
import type { Orbital, OrbitalSchema, DeclaredTraitConfig, JsonValue } from "@almadar/core";
import { OrbitalSchemaSchema } from "@almadar/core";
import { BehaviorPackageError, behaviorRegistryDir, readBehaviorPackage } from "@almadar/core/behavior-package";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of loading an orbital.
 */
export interface LoadedOrbital {
  /** The loaded orbital — the named one when requested, else the first. */
  orbital: Orbital;

  /**
   * EVERY orbital in the loaded schema. `Alias.traits.X` carries no orbital
   * segment, so a multi-orbital behavior's traits and pages must all stay
   * reachable; resolving against `orbital` alone silently loses everything
   * outside it. Mirrors the compiled path's `AliasEntry.orbitals`.
   */
  orbitals?: Orbital[];

  /**
   * The loaded schema's own app-level `config`, when it declares one.
   * Traits from this orbital must resolve against THIS config, not the
   * consumer's — omitted (never `undefined`) when the schema declares none.
   */
  schemaConfig?: DeclaredTraitConfig;

  /** Source path (resolved absolute path) */
  sourcePath: string;

  /** Original import path */
  importPath: string;
}

/**
 * Result of loading an orbital schema (may contain multiple orbitals).
 */
export interface LoadedSchema {
  /** The loaded schema */
  schema: OrbitalSchema;

  /** Source path (resolved absolute path) */
  sourcePath: string;

  /** Original import path */
  importPath: string;
}

/**
 * Loader options.
 */
export interface LoaderOptions {
  /** Base directory for resolving relative imports */
  basePath: string;

  /** Standard library root path */
  stdLibPath?: string;

  /**
   * Additional roots searched for `std/behaviors/*` imports after `stdLibPath`.
   * After the v16.0.0 package split, domain behaviors (app/, game/, marketing/,
   * probes/, service/) moved from `@almadar/std` to `@almadar-io/behaviors`.
   * Callers can pass that package's root here so cross-package `uses` resolve.
   *
   * If omitted, the loader auto-detects a sibling `@almadar-io/behaviors`
   * next to `stdLibPath` in node_modules at construction time.
   */
  behaviorsLibPaths?: string[];

  /** Scoped package roots (e.g., { "@game-lib": "/path/to/lib" }) */
  scopedPaths?: Record<string, string>;

  /** Whether to allow paths outside basePath (security) */
  allowOutsideBasePath?: boolean;
}

/**
 * Loader result with error handling.
 */
export type LoadResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================================================
// Circular Import Detection
// ============================================================================

/**
 * Tracks import chains to detect circular imports.
 */
export class ImportChain {
  private chain: string[] = [];

  /**
   * Try to add a path to the chain.
   * @returns Error message if circular, null if OK
   */
  push(absolutePath: string): string | null {
    if (this.chain.includes(absolutePath)) {
      const cycle = [...this.chain.slice(this.chain.indexOf(absolutePath)), absolutePath];
      return `Circular import detected: ${cycle.join(" -> ")}`;
    }
    this.chain.push(absolutePath);
    return null;
  }

  /**
   * Remove the last path from the chain.
   */
  pop(): void {
    this.chain.pop();
  }

  /**
   * Clone the chain for nested loading.
   */
  clone(): ImportChain {
    const newChain = new ImportChain();
    newChain.chain = [...this.chain];
    return newChain;
  }
}

// ============================================================================
// Cache
// ============================================================================

/**
 * Cache for loaded schemas to avoid re-loading.
 */
export class LoaderCache {
  private cache = new Map<string, LoadedSchema>();

  get(absolutePath: string): LoadedSchema | undefined {
    return this.cache.get(absolutePath);
  }

  set(absolutePath: string, schema: LoadedSchema): void {
    this.cache.set(absolutePath, schema);
  }

  has(absolutePath: string): boolean {
    return this.cache.has(absolutePath);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Browse-form specifier mapping (FC-3)
// ============================================================================

/**
 * Outcome of mapping a `uses ... from "<specifier>"` string to its canonical
 * loader form. Mirrors the Rust `BrowseMapping` enum in
 * `orbital-compiler/src/loader/mod.rs`.
 */
export type BrowseMapping =
  | { kind: 'not-browse-form' }
  | { kind: 'mapped'; canonical: string }
  | { kind: 'malformed' };

/**
 * The dual accepted `uses ... from` forms, named for the malformed-import error
 * so an agent that mistypes a browse path sees both loader and browse examples.
 */
const BROWSE_FORM_HELP =
  "Accepted forms — loader: std/behaviors/<name> (e.g. std/behaviors/std-stats) | " +
  "almadar-behaviors/<name> (e.g. almadar-behaviors/rpg-hero); " +
  "browse: @std/<topic>/<kind>/<name>.lolo (e.g. @std/ui/core/atoms/std-stats.lolo) | " +
  "@behaviors/<topic>/<kind>/<name>.lolo (e.g. @behaviors/app/molecules/app-crud-manager.lolo)";

const BROWSE_PREFIX_TO_PACKAGE: ReadonlyArray<readonly [string, string]> = [
  ['@std/', 'std/behaviors/'],
  ['@behaviors/', 'almadar-behaviors/'],
];

/**
 * Map a browse-form primitive specifier — the mount paths the free-compose
 * agent reads (`@std/…`, `@behaviors/…`) — to the canonical loader specifier.
 *
 * Deterministic pure string transform, identical to the Rust compiler:
 * strip the mount alias and intermediate topic/kind path, drop a trailing
 * `.lolo`, and route to the owning registry. `@std/<...>/<name>.lolo` →
 * `std/behaviors/<name>`; `@behaviors/<...>/<name>.lolo` →
 * `almadar-behaviors/<name>`. No fuzzy matching — the name is the path
 * basename verbatim. A browse-prefixed specifier with no basename is
 * `malformed`; anything not starting with a mount alias is `not-browse-form`.
 */
export function mapBrowseSpecifier(importPath: string): BrowseMapping {
  for (const [prefix, pkg] of BROWSE_PREFIX_TO_PACKAGE) {
    if (!importPath.startsWith(prefix)) continue;
    const rest = importPath.slice(prefix.length);
    const basename = rest.slice(rest.lastIndexOf('/') + 1);
    const name = basename.endsWith('.lolo') ? basename.slice(0, -'.lolo'.length) : basename;
    if (name.length === 0) return { kind: 'malformed' };
    return { kind: 'mapped', canonical: `${pkg}${name}` };
  }
  return { kind: 'not-browse-form' };
}

// ============================================================================
// External Orbital Loader
// ============================================================================

/**
 * ExternalOrbitalLoader - Loads external .orb files with security and caching.
 *
 * Security Model:
 * - By default, only allows loading from within basePath
 * - std library has its own allowed path
 * - Scoped packages have their own allowed paths
 * - No path traversal outside allowed directories
 *
 * @example
 * ```typescript
 * const loader = new ExternalOrbitalLoader({
 *   basePath: "/project/schemas",
 *   stdLibPath: "/project/std",
 * });
 *
 * // Load relative .orb file
 * const result = await loader.load("./shared/health.orb");
 *
 * // Load from std library
 * const stdResult = await loader.load("std/behaviors/game-core");
 * ```
 */
export class ExternalOrbitalLoader {
  private options: Required<LoaderOptions>;
  private cache: LoaderCache;
  /** Package root → its lowered tree, resolved once per cache lifetime (like `cache`). */
  private registryRoots = new Map<string, string>();

  constructor(options: LoaderOptions) {
    this.options = {
      stdLibPath: options.stdLibPath ?? "",
      behaviorsLibPaths: options.behaviorsLibPaths ?? autoDetectBehaviorsLibPaths(options.stdLibPath),
      scopedPaths: options.scopedPaths ?? {},
      allowOutsideBasePath: options.allowOutsideBasePath ?? false,
      ...options,
    };
    this.cache = new LoaderCache();
  }

  /**
   * Load a schema from an import path.
   *
   * @param importPath - The import path (e.g., "./health.orb", "std/behaviors/game-core")
   * @param fromPath - The path of the file doing the import (for relative resolution)
   * @param chain - Import chain for circular detection
   */
  async load(
    importPath: string,
    fromPath?: string,
    chain?: ImportChain
  ): Promise<LoadResult<LoadedSchema>> {
    const importChain = chain ?? new ImportChain();

    // Resolve the absolute path
    const resolveResult = this.resolvePath(importPath, fromPath);
    if (!resolveResult.success) {
      return resolveResult;
    }
    const absolutePath = resolveResult.data;

    // Check for circular imports
    const circularError = importChain.push(absolutePath);
    if (circularError) {
      return { success: false, error: circularError };
    }

    try {
      // Check cache
      const cached = this.cache.get(absolutePath);
      if (cached) {
        return { success: true, data: cached };
      }

      // Load and parse the file
      const loadResult = await this.loadFile(absolutePath);
      if (!loadResult.success) {
        return loadResult;
      }

      const loaded: LoadedSchema = {
        schema: loadResult.data,
        sourcePath: absolutePath,
        importPath,
      };

      // Cache the result
      this.cache.set(absolutePath, loaded);

      return { success: true, data: loaded };
    } finally {
      importChain.pop();
    }
  }

  /**
   * Load a specific orbital from a schema by name.
   *
   * @param importPath - The import path
   * @param orbitalName - The orbital name (optional, defaults to first orbital)
   * @param fromPath - The path of the file doing the import
   * @param chain - Import chain for circular detection
   */
  async loadOrbital(
    importPath: string,
    orbitalName?: string,
    fromPath?: string,
    chain?: ImportChain
  ): Promise<LoadResult<LoadedOrbital>> {
    const schemaResult = await this.load(importPath, fromPath, chain);
    if (!schemaResult.success) {
      return schemaResult;
    }

    const schema = schemaResult.data.schema;
    let orbital: Orbital;

    if (orbitalName) {
      const found = schema.orbitals.find((o: Orbital) => o.name === orbitalName);
      if (!found) {
        return {
          success: false,
          error: `Orbital "${orbitalName}" not found in ${importPath}. Available: ${schema.orbitals.map((o: Orbital) => o.name).join(", ")}`,
        };
      }
      orbital = found;
    } else {
      // Default to first orbital
      if (schema.orbitals.length === 0) {
        return {
          success: false,
          error: `No orbitals found in ${importPath}`,
        };
      }
      orbital = schema.orbitals[0];
    }

    return {
      success: true,
      data: {
        orbital,
        orbitals: schema.orbitals,
        ...(schema.config ? { schemaConfig: schema.config } : {}),
        sourcePath: schemaResult.data.sourcePath,
        importPath,
      },
    };
  }

  /**
   * Resolve an import path to an absolute filesystem path.
   */
  resolvePath(importPath: string, fromPath?: string): LoadResult<string> {
    // FC-3: accept the browse-form specifier the free-compose agent reads
    // (`@std/…`, `@behaviors/…`) by mapping it to the canonical loader form
    // before any resolution — identical mapping to the Rust compiler path.
    const mapped = mapBrowseSpecifier(importPath);
    if (mapped.kind === "malformed") {
      return {
        success: false,
        error: `Unresolvable primitive import "${importPath}". ${BROWSE_FORM_HELP}`,
      };
    }
    if (mapped.kind === "mapped") {
      importPath = mapped.canonical;
    }

    // Standard library
    if (importPath.startsWith("std/")) {
      return this.resolveStdPath(importPath);
    }

    // Scoped packages
    if (importPath.startsWith("@")) {
      return this.resolveScopedPath(importPath);
    }

    // Relative paths
    if (importPath.startsWith("./") || importPath.startsWith("../")) {
      return this.resolveRelativePath(importPath, fromPath);
    }

    // Absolute paths (only if allowed)
    if (path.isAbsolute(importPath)) {
      if (!this.options.allowOutsideBasePath) {
        return {
          success: false,
          error: `Absolute paths not allowed: ${importPath}`,
        };
      }
      return { success: true, data: importPath };
    }

    // Behavior-package registry: a bare `<package>/<behavior-name>` import
    // (e.g. `almadar-behaviors/rpg-hero`) resolves to the emitted
    // `<root>/behaviors/registry/.../<name>.orb`. Mirrors the compiled-path
    // loader; std stays handled above.
    if (
      importPath.includes("/") &&
      !importPath.startsWith("./") &&
      !importPath.startsWith("../") &&
      !importPath.startsWith("@") &&
      !importPath.startsWith("std/")
    ) {
      const name = importPath
        .slice(importPath.lastIndexOf("/") + 1)
        .replace(/\.orb$/, "");
      const prefix = importPath.slice(0, importPath.indexOf("/"));
      const result = this.resolveBehaviorInRegistries(name, prefix);
      if (result.success || this.isConfiguredPrefix(prefix)) {
        return result;
      }
    }

    // Default: treat as relative to base path
    return this.resolveRelativePath(`./${importPath}`, fromPath);
  }

  /**
   * Resolve a bare behavior name by searching each configured package root
   * (`stdLibPath` first, then `behaviorsLibPaths`) for `<name>.orb` under its
   * registry: the `orb.registry` its manifest declares, or — for a workspace
   * package declaring `orb.source` — the live mirror of its `.lolo` sources
   * (`behaviorRegistryDir`), resolved once per cache lifetime: clearing the
   * cache re-reads the sources, so an edit is seen by the next resolution.
   */
  private resolveBehaviorInRegistries(name: string, prefix?: string): LoadResult<string> {
    const roots = this.configuredRoots().filter(
      (root) => prefix === undefined || packagePrefix(root) === prefix,
    );
    const target = `${name}.orb`;
    for (const root of roots) {
      let registryRoot = this.registryRoots.get(root);
      if (registryRoot === undefined) {
        try {
          registryRoot = path.normalize(behaviorRegistryDir(readBehaviorPackage(root)));
        } catch (e) {
          return { success: false, error: `${root}: ${e instanceof Error ? e.message : String(e)}` };
        }
        this.registryRoots.set(root, registryRoot);
      }
      const found = this.findFileRecursive(registryRoot, target, registryRoot);
      if (found) return { success: true, data: found };
    }
    return {
      success: false,
      error: `Behavior not found in registries: ${name} (searched ${roots.length} root(s): ${roots.join(", ")})`,
    };
  }

  private configuredRoots(): string[] {
    const roots: string[] = [];
    if (this.options.stdLibPath) roots.push(path.normalize(this.options.stdLibPath));
    for (const p of this.options.behaviorsLibPaths) {
      const norm = path.normalize(p);
      if (!roots.includes(norm)) roots.push(norm);
    }
    return roots;
  }

  /** Whether a bare import's first segment is the `orb.prefix` of a configured behavior package. */
  private isConfiguredPrefix(prefix: string): boolean {
    return this.configuredRoots().some((root) => packagePrefix(root) === prefix);
  }

  /** Depth-first recursive search for `target` filename under `dir`, guarded
   * to stay within `root`. Returns the normalized absolute path on hit. */
  private findFileRecursive(
    dir: string,
    target: string,
    root: string
  ): string | undefined {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const normalized = path.normalize(full);
      if (!normalized.startsWith(root)) continue;
      if (entry.isDirectory()) {
        const hit = this.findFileRecursive(full, target, root);
        if (hit) return hit;
      } else if (entry.name === target) {
        return normalized;
      }
    }
    return undefined;
  }

  /**
   * Resolve `std/behaviors/<name>`: the behavior file named `<name>` in the
   * registry of std, then of each companion package — the same rule as a bare
   * behavior import, matching the compiled-path loader (`registry_lookup`).
   */
  private resolveStdPath(importPath: string): LoadResult<string> {
    if (!this.options.stdLibPath && this.options.behaviorsLibPaths.length === 0) {
      return {
        success: false,
        error: `Standard library path not configured. Cannot load: ${importPath}`,
      };
    }
    const name = importPath
      .slice(4)
      .replace(/^behaviors\//, "")
      .replace(/\.orb$/, "");
    const result = this.resolveBehaviorInRegistries(name);
    return result.success
      ? result
      : { success: false, error: `std behavior not found in registry: ${importPath} — ${result.error}` };
  }

  /**
   * Resolve a scoped package path.
   */
  private resolveScopedPath(importPath: string): LoadResult<string> {
    // Extract scope: @game-lib/enemies.orb -> @game-lib
    const match = importPath.match(/^(@[^/]+)/);
    if (!match) {
      return {
        success: false,
        error: `Invalid scoped package path: ${importPath}`,
      };
    }

    const scope = match[1];
    const scopeRoot = this.options.scopedPaths[scope];
    if (!scopeRoot) {
      return {
        success: false,
        error: `Scoped package "${scope}" not configured. Available: ${Object.keys(this.options.scopedPaths).join(", ") || "none"}`,
      };
    }

    // @game-lib/enemies.orb -> scopeRoot/enemies.orb
    const relativePath = importPath.slice(scope.length + 1); // Remove "@scope/"
    let absolutePath = path.join(scopeRoot, relativePath);

    // Add .orb extension if not present
    if (!absolutePath.endsWith(".orb")) {
      absolutePath += ".orb";
    }

    // Validate it's within scope root
    const normalizedPath = path.normalize(absolutePath);
    const normalizedRoot = path.normalize(scopeRoot);
    if (!normalizedPath.startsWith(normalizedRoot)) {
      return {
        success: false,
        error: `Path traversal outside scoped package: ${importPath}`,
      };
    }

    return { success: true, data: absolutePath };
  }

  /**
   * Resolve a relative path.
   */
  private resolveRelativePath(
    importPath: string,
    fromPath?: string
  ): LoadResult<string> {
    const baseDir = fromPath
      ? path.dirname(fromPath)
      : this.options.basePath;

    let absolutePath = path.resolve(baseDir, importPath);

    // Add .orb extension if not present
    if (!absolutePath.endsWith(".orb")) {
      absolutePath += ".orb";
    }

    // Security check: ensure within base path
    if (!this.options.allowOutsideBasePath) {
      const normalizedPath = path.normalize(absolutePath);
      const normalizedBase = path.normalize(this.options.basePath);
      if (!normalizedPath.startsWith(normalizedBase)) {
        return {
          success: false,
          error: `Path traversal outside base path: ${importPath}. Base: ${this.options.basePath}`,
        };
      }
    }

    return { success: true, data: absolutePath };
  }

  /**
   * Load and parse an .orb file.
   */
  private async loadFile(absolutePath: string): Promise<LoadResult<OrbitalSchema>> {
    try {
      // Check file exists
      if (!fs.existsSync(absolutePath)) {
        return {
          success: false,
          error: `File not found: ${absolutePath}`,
        };
      }

      // Read file
      const content = await fs.promises.readFile(absolutePath, "utf-8");

      // Parse JSON
      let data: JsonValue;
      try {
        data = JSON.parse(content);
      } catch (e) {
        return {
          success: false,
          error: `Invalid JSON in ${absolutePath}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // Validate with Zod
      const parseResult = OrbitalSchemaSchema.safeParse(data);
      if (!parseResult.success) {
        const errors = parseResult.error.errors
          .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
          .join("\n");
        return {
          success: false,
          error: `Invalid schema in ${absolutePath}:\n${errors}`,
        };
      }

      return { success: true, data: parseResult.data as OrbitalSchema };
    } catch (e) {
      return {
        success: false,
        error: `Failed to load ${absolutePath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.registryRoots.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number } {
    return { size: this.cache.size };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a loader with sensible defaults.
 */
export function createLoader(basePath: string, options?: Partial<LoaderOptions>): ExternalOrbitalLoader {
  return new ExternalOrbitalLoader({
    basePath,
    ...options,
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse an import path with optional fragment.
 *
 * @example
 * parseImportPath("./health.orb") // { path: "./health.orb", fragment: undefined }
 * parseImportPath("./game.orb#Player") // { path: "./game.orb", fragment: "Player" }
 */
export function parseImportPath(importPath: string): { path: string; fragment?: string } {
  const hashIndex = importPath.indexOf("#");
  if (hashIndex === -1) {
    return { path: importPath };
  }
  return {
    path: importPath.slice(0, hashIndex),
    fragment: importPath.slice(hashIndex + 1),
  };
}

/**
 * Auto-detect a sibling `@almadar-io/behaviors` next to `@almadar/std`.
 *
 * After the v16.0.0 split, domain behaviors live in a companion package.
 * When a caller passes `stdLibPath` pointing at an installed `@almadar/std`,
 * the io package is usually a sibling in the same node_modules layout:
 *
 *   <pkg>/node_modules/.pnpm/@almadar+std@x.y.z/node_modules/@almadar/std
 *   <pkg>/node_modules/.pnpm/@almadar-io+behaviors@a.b.c/node_modules/@almadar-io/behaviors
 *
 * or the simpler hoisted form:
 *
 *   <pkg>/node_modules/@almadar/std
 *   <pkg>/node_modules/@almadar-io/behaviors
 *
 * We walk up from `stdLibPath` looking for either layout and return every
 * behavior package root we find. Callers can override by passing
 * `behaviorsLibPaths` explicitly.
 */
function packagePrefix(root: string): string | undefined {
  return isBehaviorPackageRoot(root) ? readBehaviorPackage(root).orb.prefix : undefined;
}

function isBehaviorPackageRoot(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, "package.json"))) return false;
  try {
    readBehaviorPackage(dir);
    return true;
  } catch (e) {
    if (e instanceof BehaviorPackageError) return false;
    throw e;
  }
}

function autoDetectBehaviorsLibPaths(stdLibPath: string | undefined): string[] {
  if (!stdLibPath) return [];
  const found: string[] = [];
  try {
    // Walk up to the nearest `node_modules` ancestor
    let dir = path.normalize(stdLibPath);
    for (let i = 0; i < 10; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      // Hoisted layout: <…>/node_modules/@almadar/std → check sibling
      if (path.basename(parent) === "@almadar" && path.basename(path.dirname(parent)) === "node_modules") {
        const nm = path.dirname(parent);
        const ioPath = path.join(nm, "@almadar-io", "behaviors");
        if (isBehaviorPackageRoot(ioPath)) found.push(ioPath);
      }
      // pnpm layout: <…>/.pnpm/@almadar+std@x.y.z/node_modules/@almadar/std
      if (path.basename(parent) === ".pnpm") {
        const pnpmRoot = parent;
        try {
          for (const entry of fs.readdirSync(pnpmRoot)) {
            if (!entry.startsWith("@almadar-io+behaviors@")) continue;
            const ioPath = path.join(pnpmRoot, entry, "node_modules", "@almadar-io", "behaviors");
            if (isBehaviorPackageRoot(ioPath)) found.push(ioPath);
          }
        } catch {
          // unreadable .pnpm dir — skip
        }
        break;
      }
      // Workspace layout: <repo>/packages/almadar-std → sibling
      // <repo>/packages/almadar-behaviors. A pnpm workspace link resolves
      // `stdLibPath` to the real source directory, whose ancestors are neither
      // `@almadar` nor `.pnpm`, so neither branch above fires and every domain
      // atom comes back "not found in registry" for locally-linked runs.
      if (path.basename(dir).endsWith("almadar-std")) {
        const sibling = path.join(parent, path.basename(dir).replace(/almadar-std$/, "almadar-behaviors"));
        if (isBehaviorPackageRoot(sibling)) {
          found.push(sibling);
          break;
        }
      }
      dir = parent;
    }
  } catch {
    // Filesystem access failed (read-only mount, missing perms) — return what
    // we have. Explicit `behaviorsLibPaths` override remains available.
  }
  return found;
}
