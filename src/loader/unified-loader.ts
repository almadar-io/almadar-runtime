/**
 * Unified Schema Loader
 *
 * Auto-detects the environment and routes to the appropriate loader:
 * - FileSystemLoader for Node.js/Electron
 * - HttpLoader for browser
 *
 * Also handles mixed loading scenarios where some imports use filesystem
 * and others use HTTP.
 *
 * @packageDocumentation
 */

import type {
  SchemaLoader,
  LoadedSchema,
  LoadedOrbital,
  LoadResult,
  UnifiedLoaderOptions,
  ImportChainLike,
} from "./schema-loader.js";
import { isElectron, isBrowser, isNode } from "./schema-loader.js";
import { HttpLoader, HttpImportChain } from "./http-loader.js";

// ============================================================================
// Dynamic Import for FileSystem Loader
// ============================================================================

// Type for the external loader module (loaded dynamically in Node.js)
type ExternalLoaderModule = typeof import("./external-loader.js");

let externalLoaderModule: ExternalLoaderModule | null = null;

/**
 * Dynamically import the external loader (Node.js only).
 * This avoids bundling fs module in browser builds.
 */
async function getExternalLoaderModule(): Promise<ExternalLoaderModule | null> {
  if (externalLoaderModule) {
    return externalLoaderModule;
  }

  if (isBrowser()) {
    return null;
  }

  try {
    // Dynamic import to avoid bundling fs in browser
    externalLoaderModule = await import("./external-loader.js");
    return externalLoaderModule;
  } catch {
    return null;
  }
}

// ============================================================================
// Unified Import Chain
// ============================================================================

/**
 * Import chain that works with both loaders.
 */
export class UnifiedImportChain implements ImportChainLike {
  private chain: string[] = [];

  push(path: string): string | null {
    // Normalize path for comparison (handle both file paths and URLs)
    const normalized = this.normalizePath(path);
    if (this.chain.includes(normalized)) {
      const cycle = [
        ...this.chain.slice(this.chain.indexOf(normalized)),
        normalized,
      ];
      return `Circular import detected: ${cycle.join(" -> ")}`;
    }
    this.chain.push(normalized);
    return null;
  }

  pop(): void {
    this.chain.pop();
  }

  clone(): UnifiedImportChain {
    const newChain = new UnifiedImportChain();
    newChain.chain = [...this.chain];
    return newChain;
  }

  private normalizePath(path: string): string {
    // For URLs, use the full URL
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    // For file paths, normalize path separators
    return path.replace(/\\/g, "/");
  }
}

// ============================================================================
// Unified Loader
// ============================================================================

/**
 * UnifiedLoader - Auto-detects environment and routes to appropriate loader.
 *
 * Loading Strategy:
 * - Electron: Uses FileSystemLoader with HTTP fallback for remote URLs
 * - Browser: Uses HttpLoader only (no filesystem access)
 * - Node.js: Uses FileSystemLoader with HTTP for remote URLs
 *
 * Import Type Resolution:
 * - `./local.orb`: FileSystem (Node/Electron) or Error (Browser)
 * - `std/behaviors/x`: FileSystem OR HTTP (configurable)
 * - `@scope/pkg.orb`: FileSystem OR HTTP (configurable)
 * - `https://...`: Always HTTP
 *
 * @example
 * ```typescript
 * const loader = createUnifiedLoader({
 *   basePath: "/project/schemas",
 *   stdLibPath: "/project/std",  // or "https://cdn.example.com/std"
 * });
 *
 * // Load relative file (uses FileSystem in Node, error in Browser)
 * const local = await loader.load("./my-schema.orb");
 *
 * // Load from URL (always uses HTTP)
 * const remote = await loader.load("https://example.com/schema.orb");
 *
 * // Load from std library (uses configured path type)
 * const std = await loader.load("std/behaviors/game-core");
 * ```
 */
export class UnifiedLoader implements SchemaLoader {
  private options: UnifiedLoaderOptions;
  private httpLoader: HttpLoader | null = null;
  private fsLoader: SchemaLoader | null = null;
  private fsLoaderInitialized = false;
  private cache = new Map<string, LoadedSchema>();

  constructor(options: UnifiedLoaderOptions) {
    this.options = options;

    // Initialize HTTP loader (always available)
    this.httpLoader = new HttpLoader({
      basePath: options.basePath,
      stdLibPath: options.stdLibPath,
      scopedPaths: options.scopedPaths,
      ...options.http,
    });
  }

  /**
   * Initialize the filesystem loader if available.
   */
  private async initFsLoader(): Promise<void> {
    if (this.fsLoaderInitialized) {
      return;
    }

    this.fsLoaderInitialized = true;

    if (this.options.forceLoader === "http") {
      return;
    }

    const module = await getExternalLoaderModule();
    if (module) {
      this.fsLoader = new module.ExternalOrbitalLoader({
        basePath: this.options.basePath,
        stdLibPath: this.options.stdLibPath,
        scopedPaths: this.options.scopedPaths,
        ...this.options.fileSystem,
      }) as unknown as SchemaLoader;
    }
  }

  /**
   * Determine which loader to use for an import path.
   */
  private getLoaderForPath(importPath: string): "http" | "filesystem" {
    // Force loader if configured
    if (this.options.forceLoader) {
      return this.options.forceLoader;
    }

    // HTTP URLs always use HTTP loader
    if (importPath.startsWith("http://") || importPath.startsWith("https://")) {
      return "http";
    }

    // Check if std lib is configured as HTTP
    if (importPath.startsWith("std/") && this.options.stdLibPath) {
      if (
        this.options.stdLibPath.startsWith("http://") ||
        this.options.stdLibPath.startsWith("https://")
      ) {
        return "http";
      }
    }

    // Check if scoped package is configured as HTTP
    if (importPath.startsWith("@") && this.options.scopedPaths) {
      const match = importPath.match(/^(@[^/]+)/);
      if (match) {
        const scopePath = this.options.scopedPaths[match[1]];
        if (
          scopePath &&
          (scopePath.startsWith("http://") || scopePath.startsWith("https://"))
        ) {
          return "http";
        }
      }
    }

    // Browser always uses HTTP (no filesystem)
    if (isBrowser()) {
      return "http";
    }

    // Node.js/Electron use filesystem for local files
    return "filesystem";
  }

  /**
   * Load a schema from an import path.
   *
   * Note: We delegate chain management to the inner loader (HttpLoader or FsLoader).
   * The inner loader handles circular import detection, so we don't push/pop here.
   * We only use the unified cache to avoid duplicate loads across loaders.
   */
  async load(
    importPath: string,
    fromPath?: string,
    chain?: ImportChainLike
  ): Promise<LoadResult<LoadedSchema>> {
    // Ensure filesystem loader is initialized
    await this.initFsLoader();

    const importChain = chain ?? new UnifiedImportChain();
    const loaderType = this.getLoaderForPath(importPath);

    // Resolve path first to check cache
    const resolveResult = this.resolvePath(importPath, fromPath);
    if (!resolveResult.success) {
      return resolveResult;
    }
    const absolutePath = resolveResult.data;

    // Check unified cache
    const cached = this.cache.get(absolutePath);
    if (cached) {
      return { success: true, data: cached };
    }

    // Delegate to appropriate loader - the inner loader handles chain management
    let result: LoadResult<LoadedSchema>;

    if (loaderType === "http") {
      if (!this.httpLoader) {
        return {
          success: false,
          error: "HTTP loader not available",
        };
      }
      result = await this.httpLoader.load(importPath, fromPath, importChain);
    } else {
      if (!this.fsLoader) {
        // Fall back to HTTP if filesystem not available
        if (this.httpLoader) {
          result = await this.httpLoader.load(
            importPath,
            fromPath,
            importChain
          );
        } else {
          return {
            success: false,
            error: `Filesystem loader not available and import "${importPath}" cannot be loaded via HTTP. ` +
              `This typically happens when loading local files in a browser environment.`,
          };
        }
      } else {
        result = await this.fsLoader.load(importPath, fromPath, importChain);
      }
    }

    // Cache successful results in unified cache
    if (result.success) {
      this.cache.set(absolutePath, result.data);
    }

    return result;
  }

  /**
   * Load a specific orbital from a schema by name.
   */
  async loadOrbital(
    importPath: string,
    orbitalName?: string,
    fromPath?: string,
    chain?: ImportChainLike
  ): Promise<LoadResult<LoadedOrbital>> {
    const schemaResult = await this.load(importPath, fromPath, chain);
    if (!schemaResult.success) {
      return schemaResult;
    }

    const schema = schemaResult.data.schema;

    if (orbitalName) {
      const found = schema.orbitals.find((o) => o.name === orbitalName);
      if (!found) {
        return {
          success: false,
          error: `Orbital "${orbitalName}" not found in ${importPath}. Available: ${schema.orbitals.map((o) => o.name).join(", ")}`,
        };
      }
      return {
        success: true,
        data: {
          orbital: found,
          sourcePath: schemaResult.data.sourcePath,
          importPath,
        },
      };
    }

    // Default to first orbital
    if (schema.orbitals.length === 0) {
      return {
        success: false,
        error: `No orbitals found in ${importPath}`,
      };
    }

    return {
      success: true,
      data: {
        orbital: schema.orbitals[0],
        sourcePath: schemaResult.data.sourcePath,
        importPath,
      },
    };
  }

  /**
   * Resolve an import path to an absolute path/URL.
   */
  resolvePath(importPath: string, fromPath?: string): LoadResult<string> {
    const loaderType = this.getLoaderForPath(importPath);

    if (loaderType === "http" && this.httpLoader) {
      return this.httpLoader.resolvePath(importPath, fromPath);
    }

    if (this.fsLoader) {
      return this.fsLoader.resolvePath(importPath, fromPath);
    }

    // Fallback to HTTP loader
    if (this.httpLoader) {
      return this.httpLoader.resolvePath(importPath, fromPath);
    }

    return {
      success: false,
      error: "No loader available for path resolution",
    };
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.cache.clear();
    this.httpLoader?.clearCache();
    this.fsLoader?.clearCache();
  }

  /**
   * Get combined cache statistics.
   */
  getCacheStats(): { size: number } {
    let size = this.cache.size;
    if (this.httpLoader) {
      size += this.httpLoader.getCacheStats().size;
    }
    if (this.fsLoader) {
      size += this.fsLoader.getCacheStats().size;
    }
    return { size };
  }

  /**
   * Check if filesystem loading is available.
   */
  async hasFilesystemAccess(): Promise<boolean> {
    await this.initFsLoader();
    return this.fsLoader !== null;
  }

  /**
   * Get current environment info.
   */
  getEnvironmentInfo(): {
    isElectron: boolean;
    isBrowser: boolean;
    isNode: boolean;
    hasFilesystem: boolean;
  } {
    return {
      isElectron: isElectron(),
      isBrowser: isBrowser(),
      isNode: isNode(),
      hasFilesystem: this.fsLoader !== null,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a unified loader with sensible defaults.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const loader = createUnifiedLoader({
 *   basePath: "/schemas",
 *   stdLibPath: "/std",
 * });
 *
 * // With HTTP std library
 * const loader = createUnifiedLoader({
 *   basePath: "/schemas",
 *   stdLibPath: "https://cdn.example.com/orbital-std",
 * });
 *
 * // Force HTTP only (browser-like behavior)
 * const loader = createUnifiedLoader({
 *   basePath: "/api/schemas",
 *   forceLoader: "http",
 * });
 * ```
 */
export function createUnifiedLoader(
  options: UnifiedLoaderOptions
): UnifiedLoader {
  return new UnifiedLoader(options);
}

/**
 * Create a loader appropriate for the current environment.
 *
 * Convenience function that:
 * - In browser: Creates HttpLoader
 * - In Node.js/Electron: Creates UnifiedLoader
 */
export async function createAutoLoader(
  options: UnifiedLoaderOptions
): Promise<SchemaLoader> {
  if (isBrowser()) {
    return new HttpLoader({
      basePath: options.basePath,
      stdLibPath: options.stdLibPath,
      scopedPaths: options.scopedPaths,
      ...options.http,
    });
  }

  const loader = new UnifiedLoader(options);
  await loader.hasFilesystemAccess(); // Trigger initialization
  return loader;
}
