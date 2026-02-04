/**
 * HTTP Schema Loader
 *
 * Loads OrbitalSchema files via HTTP/fetch for browser environments.
 * Also works in Node.js with the fetch API.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema, Orbital } from "@almadar/core";
import { OrbitalSchemaSchema } from "@almadar/core";
import type {
  SchemaLoader,
  LoadedSchema,
  LoadedOrbital,
  LoadResult,
  HttpLoaderOptions,
  ImportChainLike,
} from "./schema-loader.js";

// ============================================================================
// Import Chain Implementation
// ============================================================================

/**
 * Tracks import chains to detect circular imports.
 * Compatible with ImportChainLike interface.
 */
export class HttpImportChain implements ImportChainLike {
  private chain: string[] = [];

  /**
   * Try to add a path to the chain.
   * @returns Error message if circular, null if OK
   */
  push(absolutePath: string): string | null {
    if (this.chain.includes(absolutePath)) {
      const cycle = [
        ...this.chain.slice(this.chain.indexOf(absolutePath)),
        absolutePath,
      ];
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
  clone(): HttpImportChain {
    const newChain = new HttpImportChain();
    newChain.chain = [...this.chain];
    return newChain;
  }
}

// ============================================================================
// Cache
// ============================================================================

/**
 * Cache for loaded schemas to avoid re-fetching.
 */
class HttpLoaderCache {
  private cache = new Map<string, LoadedSchema>();

  get(url: string): LoadedSchema | undefined {
    return this.cache.get(url);
  }

  set(url: string, schema: LoadedSchema): void {
    this.cache.set(url, schema);
  }

  has(url: string): boolean {
    return this.cache.has(url);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// HTTP Loader
// ============================================================================

/**
 * HttpLoader - Loads OrbitalSchema files via HTTP/fetch.
 *
 * Designed for browser environments where file system access is not available.
 * Uses the fetch API for loading schemas.
 *
 * Path Resolution:
 * - Relative paths: `./health.orb` -> base URL + path
 * - Standard library: `std/behaviors/game-core` -> std lib URL + path
 * - Scoped packages: `@scope/pkg.orb` -> scoped URL + path
 * - Absolute URLs: `https://...` -> used directly
 *
 * @example
 * ```typescript
 * const loader = new HttpLoader({
 *   basePath: "/api/schemas",
 *   stdLibPath: "https://cdn.example.com/orbital-std",
 * });
 *
 * // Load from relative path
 * const result = await loader.load("./my-schema.orb");
 *
 * // Load from std library
 * const stdResult = await loader.load("std/behaviors/game-core");
 * ```
 */
export class HttpLoader implements SchemaLoader {
  private options: Required<
    Pick<HttpLoaderOptions, "basePath" | "stdLibPath" | "scopedPaths">
  > &
    HttpLoaderOptions;
  private cache: HttpLoaderCache;

  constructor(options: HttpLoaderOptions) {
    this.options = {
      basePath: options.basePath,
      stdLibPath: options.stdLibPath ?? "",
      scopedPaths: options.scopedPaths ?? {},
      fetchOptions: options.fetchOptions,
      timeout: options.timeout ?? 30000,
      credentials: options.credentials ?? "same-origin",
    };
    this.cache = new HttpLoaderCache();
  }

  /**
   * Load a schema from an import path.
   */
  async load(
    importPath: string,
    fromPath?: string,
    chain?: ImportChainLike
  ): Promise<LoadResult<LoadedSchema>> {
    const importChain = chain ?? new HttpImportChain();

    // Resolve to absolute URL
    const resolveResult = this.resolvePath(importPath, fromPath);
    if (!resolveResult.success) {
      return resolveResult;
    }
    const absoluteUrl = resolveResult.data;

    // Check for circular imports
    const circularError = importChain.push(absoluteUrl);
    if (circularError) {
      return { success: false, error: circularError };
    }

    try {
      // Check cache
      const cached = this.cache.get(absoluteUrl);
      if (cached) {
        return { success: true, data: cached };
      }

      // Fetch and parse the schema
      const loadResult = await this.fetchSchema(absoluteUrl);
      if (!loadResult.success) {
        return loadResult;
      }

      const loaded: LoadedSchema = {
        schema: loadResult.data,
        sourcePath: absoluteUrl,
        importPath,
      };

      // Cache the result
      this.cache.set(absoluteUrl, loaded);

      return { success: true, data: loaded };
    } finally {
      importChain.pop();
    }
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
    let orbital: Orbital;

    if (orbitalName) {
      const found = schema.orbitals.find(
        (o: Orbital) => o.name === orbitalName
      );
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
   * Resolve an import path to an absolute URL.
   */
  resolvePath(importPath: string, fromPath?: string): LoadResult<string> {
    // Already absolute URL
    if (importPath.startsWith("http://") || importPath.startsWith("https://")) {
      return { success: true, data: importPath };
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
        error: `Standard library URL not configured. Cannot load: ${importPath}`,
      };
    }

    // std/behaviors/game-core -> stdLibPath/behaviors/game-core.orb
    const relativePath = importPath.slice(4); // Remove "std/"
    let absoluteUrl = this.joinUrl(this.options.stdLibPath, relativePath);

    // Add .orb extension if not present
    if (!absoluteUrl.endsWith(".orb")) {
      absoluteUrl += ".orb";
    }

    return { success: true, data: absoluteUrl };
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
    let absoluteUrl = this.joinUrl(scopeRoot, relativePath);

    // Add .orb extension if not present
    if (!absoluteUrl.endsWith(".orb")) {
      absoluteUrl += ".orb";
    }

    return { success: true, data: absoluteUrl };
  }

  /**
   * Resolve a relative path.
   */
  private resolveRelativePath(
    importPath: string,
    fromPath?: string
  ): LoadResult<string> {
    const baseUrl = fromPath ? this.getParentUrl(fromPath) : this.options.basePath;

    let absoluteUrl = this.joinUrl(baseUrl, importPath);

    // Add .orb extension if not present
    if (!absoluteUrl.endsWith(".orb")) {
      absoluteUrl += ".orb";
    }

    return { success: true, data: absoluteUrl };
  }

  /**
   * Fetch and parse an OrbitalSchema from a URL.
   */
  private async fetchSchema(url: string): Promise<LoadResult<OrbitalSchema>> {
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.options.timeout
      );

      try {
        const response = await fetch(url, {
          ...this.options.fetchOptions,
          credentials: this.options.credentials,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...this.options.fetchOptions?.headers,
          },
        });

        if (!response.ok) {
          return {
            success: false,
            error: `HTTP ${response.status}: ${response.statusText} for ${url}`,
          };
        }

        const text = await response.text();

        // Parse JSON
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch (e) {
          return {
            success: false,
            error: `Invalid JSON in ${url}: ${e instanceof Error ? e.message : String(e)}`,
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
            error: `Invalid schema in ${url}:\n${errors}`,
          };
        }

        return { success: true, data: parseResult.data as OrbitalSchema };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return {
          success: false,
          error: `Request timeout for ${url} (${this.options.timeout}ms)`,
        };
      }
      return {
        success: false,
        error: `Failed to fetch ${url}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Join URL parts, handling relative paths and trailing slashes.
   */
  private joinUrl(base: string, path: string): string {
    // Handle absolute URLs in path
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }

    // Use URL API if available (browser and modern Node.js)
    if (typeof URL !== "undefined") {
      try {
        // Ensure base has a trailing slash for proper resolution
        const baseUrl = base.endsWith("/") ? base : base + "/";
        return new URL(path, baseUrl).href;
      } catch {
        // Fall back to string manipulation
      }
    }

    // Simple string manipulation fallback
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const normalizedPath = path.startsWith("/") ? path : "/" + path;

    // Handle relative path navigation
    if (normalizedPath.startsWith("/./")) {
      return normalizedBase + normalizedPath.slice(2);
    }

    // Handle parent directory navigation
    if (normalizedPath.startsWith("/../")) {
      const baseParts = normalizedBase.split("/");
      baseParts.pop(); // Remove last segment
      return baseParts.join("/") + normalizedPath.slice(3);
    }

    return normalizedBase + normalizedPath;
  }

  /**
   * Get parent URL (directory) from a URL.
   */
  private getParentUrl(url: string): string {
    if (typeof URL !== "undefined") {
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split("/");
        pathParts.pop(); // Remove file name
        urlObj.pathname = pathParts.join("/");
        return urlObj.href;
      } catch {
        // Fall back to string manipulation
      }
    }

    const lastSlash = url.lastIndexOf("/");
    if (lastSlash !== -1) {
      return url.slice(0, lastSlash);
    }
    return url;
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
 * Create an HTTP loader with sensible defaults.
 */
export function createHttpLoader(
  basePath: string,
  options?: Partial<HttpLoaderOptions>
): HttpLoader {
  return new HttpLoader({
    basePath,
    ...options,
  });
}
