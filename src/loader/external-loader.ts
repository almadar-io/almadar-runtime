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
import type { Orbital, OrbitalSchema } from "@almadar/core";
import { OrbitalSchemaSchema } from "@almadar/core";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of loading an orbital.
 */
export interface LoadedOrbital {
  /** The loaded orbital */
  orbital: Orbital;

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

  constructor(options: LoaderOptions) {
    this.options = {
      stdLibPath: options.stdLibPath ?? "",
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
        sourcePath: schemaResult.data.sourcePath,
        importPath,
      },
    };
  }

  /**
   * Resolve an import path to an absolute filesystem path.
   */
  resolvePath(importPath: string, fromPath?: string): LoadResult<string> {
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

    // Default: treat as relative to base path
    return this.resolveRelativePath(`./${importPath}`, fromPath);
  }

  /**
   * Resolve a standard library path.
   */
  private resolveStdPath(importPath: string): LoadResult<string> {
    if (!this.options.stdLibPath) {
      return {
        success: false,
        error: `Standard library path not configured. Cannot load: ${importPath}`,
      };
    }

    // std/behaviors/game-core -> stdLibPath/behaviors/game-core.orb
    const relativePath = importPath.slice(4); // Remove "std/"
    let absolutePath = path.join(this.options.stdLibPath, relativePath);

    // Add .orb extension if not present
    if (!absolutePath.endsWith(".orb")) {
      absolutePath += ".orb";
    }

    // Validate it's within std library
    const normalizedPath = path.normalize(absolutePath);
    const normalizedStdLib = path.normalize(this.options.stdLibPath);
    if (!normalizedPath.startsWith(normalizedStdLib)) {
      return {
        success: false,
        error: `Path traversal outside std library: ${importPath}`,
      };
    }

    return { success: true, data: absolutePath };
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
      let data: unknown;
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
