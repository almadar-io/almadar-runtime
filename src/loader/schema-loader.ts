/**
 * SchemaLoader Interface
 *
 * Abstract interface for loading OrbitalSchema files from various sources.
 * Implementations exist for:
 * - FileSystemLoader (Node.js) - uses fs module
 * - HttpLoader (Browser) - uses fetch API
 * - UnifiedLoader (Auto-detect) - routes to appropriate loader
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from "../types/schema.js";
import type { Orbital } from "../types/orbital.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of loading a schema.
 */
export interface LoadedSchema {
  /** The loaded schema */
  schema: OrbitalSchema;

  /** Source path/URL (resolved) */
  sourcePath: string;

  /** Original import path */
  importPath: string;
}

/**
 * Result of loading a single orbital from a schema.
 */
export interface LoadedOrbital {
  /** The loaded orbital */
  orbital: Orbital;

  /** Source path/URL (resolved) */
  sourcePath: string;

  /** Original import path */
  importPath: string;
}

/**
 * Loader result with error handling.
 */
export type LoadResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Base options for all loaders.
 */
export interface BaseLoaderOptions {
  /** Base path/URL for resolving relative imports */
  basePath: string;

  /** Standard library root path/URL */
  stdLibPath?: string;

  /** Scoped package roots (e.g., { "@game-lib": "/path/to/lib" }) */
  scopedPaths?: Record<string, string>;
}

/**
 * Options for file system loading.
 */
export interface FileSystemLoaderOptions extends BaseLoaderOptions {
  /** Whether to allow paths outside basePath (security) */
  allowOutsideBasePath?: boolean;
}

/**
 * Options for HTTP loading.
 */
export interface HttpLoaderOptions extends BaseLoaderOptions {
  /** Default fetch options */
  fetchOptions?: RequestInit;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Whether to use credentials (cookies, auth headers) */
  credentials?: RequestCredentials;
}

/**
 * Combined options for unified loader.
 */
export interface UnifiedLoaderOptions extends BaseLoaderOptions {
  /** File system specific options */
  fileSystem?: Omit<FileSystemLoaderOptions, keyof BaseLoaderOptions>;

  /** HTTP specific options */
  http?: Omit<HttpLoaderOptions, keyof BaseLoaderOptions>;

  /** Force a specific loader type */
  forceLoader?: "filesystem" | "http";
}

/**
 * Loader strategy type for environment-specific loading.
 */
export type LoaderStrategy = "filesystem" | "http" | "auto";

// ============================================================================
// SchemaLoader Interface
// ============================================================================

/**
 * Abstract interface for schema loaders.
 *
 * All loaders must implement:
 * - load() - Load a schema from an import path
 * - resolvePath() - Resolve an import path to absolute path/URL
 *
 * @example
 * ```typescript
 * // Using FileSystemLoader (Node.js)
 * const loader: SchemaLoader = new FileSystemLoader({ basePath: "/schemas" });
 * const result = await loader.load("./my-schema.orb");
 *
 * // Using HttpLoader (Browser)
 * const loader: SchemaLoader = new HttpLoader({ basePath: "/api/schemas" });
 * const result = await loader.load("./my-schema.orb");
 *
 * // Using UnifiedLoader (auto-detect)
 * const loader: SchemaLoader = createUnifiedLoader({ basePath: "/schemas" });
 * const result = await loader.load("./my-schema.orb");
 * ```
 */
export interface SchemaLoader {
  /**
   * Load a schema from an import path.
   *
   * @param importPath - The import path (e.g., "./health.orb", "std/behaviors/game-core")
   * @param fromPath - The path of the file doing the import (for relative resolution)
   * @param chain - Import chain for circular detection (optional)
   */
  load(
    importPath: string,
    fromPath?: string,
    chain?: ImportChainLike
  ): Promise<LoadResult<LoadedSchema>>;

  /**
   * Load a specific orbital from a schema by name.
   *
   * @param importPath - The import path
   * @param orbitalName - The orbital name (optional, defaults to first orbital)
   * @param fromPath - The path of the file doing the import
   * @param chain - Import chain for circular detection (optional)
   */
  loadOrbital(
    importPath: string,
    orbitalName?: string,
    fromPath?: string,
    chain?: ImportChainLike
  ): Promise<LoadResult<LoadedOrbital>>;

  /**
   * Resolve an import path to an absolute path/URL.
   *
   * @param importPath - The import path
   * @param fromPath - The path of the file doing the import (optional)
   */
  resolvePath(importPath: string, fromPath?: string): LoadResult<string>;

  /**
   * Clear the loader's cache.
   */
  clearCache(): void;

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number };
}

/**
 * Interface for import chain (circular detection).
 * This allows different implementations to interoperate.
 */
export interface ImportChainLike {
  /**
   * Try to add a path to the chain.
   * @returns Error message if circular, null if OK
   */
  push(absolutePath: string): string | null;

  /**
   * Remove the last path from the chain.
   */
  pop(): void;

  /**
   * Clone the chain for nested loading.
   */
  clone(): ImportChainLike;
}

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Detect if running in Electron.
 */
export function isElectron(): boolean {
  return typeof process !== "undefined" && !!process.versions?.electron;
}

/**
 * Detect if running in browser (not Electron).
 */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && !isElectron();
}

/**
 * Detect if running in Node.js (not browser).
 */
export function isNode(): boolean {
  return typeof process !== "undefined" && !isBrowser();
}

/**
 * Get the recommended loader strategy for the current environment.
 */
export function getDefaultLoaderStrategy(): LoaderStrategy {
  if (isBrowser()) {
    return "http";
  }
  return "filesystem";
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Schema loader factory function type.
 */
export type SchemaLoaderFactory<T extends BaseLoaderOptions = BaseLoaderOptions> = (
  options: T
) => SchemaLoader;
