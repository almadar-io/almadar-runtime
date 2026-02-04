/**
 * Almadar Studio Loader Configuration
 *
 * Provides Electron-specific configuration for loading OrbitalSchema files
 * in the Almadar Studio desktop application.
 *
 * Features:
 * - Auto-detect bundled vs downloaded std library
 * - File system access for local .orb files
 * - HTTP fallback for remote schemas
 * - Workspace-relative path resolution
 *
 * @packageDocumentation
 */

import type { UnifiedLoaderOptions } from "./schema-loader.js";
import { isElectron } from "./schema-loader.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Almadar Studio configuration options.
 */
export interface AlmadarStudioConfig {
  /**
   * Path to the workspace directory (user's project).
   * All relative imports are resolved from here.
   */
  workspacePath: string;

  /**
   * Path to bundled std library (in app resources).
   * Used when std library is bundled with the app.
   */
  bundledStdPath?: string;

  /**
   * Path to downloaded/cached std library.
   * Used when std library is downloaded on first run.
   */
  downloadedStdPath?: string;

  /**
   * URL for downloading std library if not available locally.
   */
  stdLibDownloadUrl?: string;

  /**
   * Scoped package paths for local packages.
   * e.g., { "@my-company": "/path/to/packages" }
   */
  localPackages?: Record<string, string>;

  /**
   * URLs for remote scoped packages (HTTP fallback).
   * e.g., { "@community": "https://orbitals.example.com/packages" }
   */
  remotePackages?: Record<string, string>;

  /**
   * Enable verbose logging.
   */
  debug?: boolean;
}

/**
 * Resolved paths for Almadar Studio.
 */
export interface ResolvedAlmadarPaths {
  /** Workspace path (base for relative imports) */
  workspacePath: string;

  /** Resolved std library path (bundled or downloaded) */
  stdLibPath: string | null;

  /** Whether std library was found locally */
  stdLibAvailable: boolean;

  /** Fallback URL for std library if not local */
  stdLibFallbackUrl: string | null;

  /** Combined scoped package paths (local + remote) */
  scopedPaths: Record<string, string>;
}

// ============================================================================
// Default Paths
// ============================================================================

/**
 * Default paths for Almadar Studio in different environments.
 */
export const ALMADAR_DEFAULTS = {
  /**
   * Default bundled std library path (relative to app resources).
   * In Electron: process.resourcesPath + '/std'
   */
  BUNDLED_STD_SUBPATH: "std",

  /**
   * Default downloaded std library path (in user data).
   * In Electron: app.getPath('userData') + '/orbital-std'
   */
  DOWNLOADED_STD_SUBPATH: "orbital-std",

  /**
   * Default std library download URL.
   */
  STD_LIB_DOWNLOAD_URL: "https://cdn.almadar.dev/orbital-std",

  /**
   * Default remote package registry URL.
   */
  REMOTE_PACKAGE_URL: "https://registry.almadar.dev/packages",
};

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Check if a path exists (works in both Node.js and Electron).
 * Returns false in browser environment.
 */
async function pathExists(path: string): Promise<boolean> {
  if (typeof window !== "undefined" && !isElectron()) {
    return false;
  }

  try {
    // Dynamic import to avoid bundling fs in browser
    const fs = await import("fs");
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Extended process type for Electron environment.
 */
interface ElectronProcess extends NodeJS.Process {
  resourcesPath?: string;
}

/**
 * Get Electron app paths if available.
 */
function getElectronPaths(): {
  resourcesPath: string | null;
  userDataPath: string | null;
} {
  if (!isElectron()) {
    return { resourcesPath: null, userDataPath: null };
  }

  try {
    // In Electron renderer process
    if (typeof window !== "undefined" && (window as unknown as { electronAPI?: { resourcesPath?: string; userDataPath?: string } }).electronAPI) {
      const api = (window as unknown as { electronAPI: { resourcesPath?: string; userDataPath?: string } }).electronAPI;
      return {
        resourcesPath: api.resourcesPath || null,
        userDataPath: api.userDataPath || null,
      };
    }

    // In Electron main process
    const electronProcess = process as ElectronProcess;
    if (typeof process !== "undefined" && electronProcess.resourcesPath) {
      return {
        resourcesPath: electronProcess.resourcesPath,
        userDataPath: null, // Would need app.getPath('userData')
      };
    }
  } catch {
    // Ignore errors
  }

  return { resourcesPath: null, userDataPath: null };
}

/**
 * Resolve std library path, checking bundled first, then downloaded.
 */
async function resolveStdLibPath(
  config: AlmadarStudioConfig
): Promise<{ path: string | null; available: boolean }> {
  // Check explicit bundled path first
  if (config.bundledStdPath) {
    if (await pathExists(config.bundledStdPath)) {
      return { path: config.bundledStdPath, available: true };
    }
  }

  // Check explicit downloaded path
  if (config.downloadedStdPath) {
    if (await pathExists(config.downloadedStdPath)) {
      return { path: config.downloadedStdPath, available: true };
    }
  }

  // Try Electron default paths
  const electronPaths = getElectronPaths();

  if (electronPaths.resourcesPath) {
    const bundledPath = `${electronPaths.resourcesPath}/${ALMADAR_DEFAULTS.BUNDLED_STD_SUBPATH}`;
    if (await pathExists(bundledPath)) {
      return { path: bundledPath, available: true };
    }
  }

  if (electronPaths.userDataPath) {
    const downloadedPath = `${electronPaths.userDataPath}/${ALMADAR_DEFAULTS.DOWNLOADED_STD_SUBPATH}`;
    if (await pathExists(downloadedPath)) {
      return { path: downloadedPath, available: true };
    }
  }

  // No local std library found
  return { path: null, available: false };
}

/**
 * Resolve all paths for Almadar Studio configuration.
 */
export async function resolveAlmadarPaths(
  config: AlmadarStudioConfig
): Promise<ResolvedAlmadarPaths> {
  const stdLibResult = await resolveStdLibPath(config);

  // Combine local and remote scoped packages
  const scopedPaths: Record<string, string> = {
    ...(config.localPackages || {}),
    ...(config.remotePackages || {}),
  };

  return {
    workspacePath: config.workspacePath,
    stdLibPath: stdLibResult.path,
    stdLibAvailable: stdLibResult.available,
    stdLibFallbackUrl: stdLibResult.available
      ? null
      : config.stdLibDownloadUrl || ALMADAR_DEFAULTS.STD_LIB_DOWNLOAD_URL,
    scopedPaths,
  };
}

// ============================================================================
// Loader Factory
// ============================================================================

/**
 * Create UnifiedLoader options for Almadar Studio.
 *
 * @example
 * ```typescript
 * // In Almadar Studio
 * const options = await createAlmadarLoaderOptions({
 *   workspacePath: '/Users/dev/my-project',
 * });
 *
 * const loader = createUnifiedLoader(options);
 * const result = await loader.load('./my-schema.orb');
 * ```
 */
export async function createAlmadarLoaderOptions(
  config: AlmadarStudioConfig
): Promise<UnifiedLoaderOptions> {
  const resolved = await resolveAlmadarPaths(config);

  if (config.debug) {
    console.log("[AlmadarStudio] Resolved paths:", resolved);
  }

  // Determine std library path (local or URL fallback)
  const stdLibPath = resolved.stdLibPath || resolved.stdLibFallbackUrl || undefined;

  return {
    basePath: resolved.workspacePath,
    stdLibPath,
    scopedPaths: resolved.scopedPaths,
    fileSystem: {
      allowOutsideBasePath: false, // Security: don't allow path traversal
    },
    http: {
      timeout: 30000,
      credentials: "omit", // Don't send cookies to CDN
    },
  };
}

/**
 * Check if std library needs to be downloaded.
 */
export async function needsStdLibDownload(
  config: AlmadarStudioConfig
): Promise<boolean> {
  const resolved = await resolveAlmadarPaths(config);
  return !resolved.stdLibAvailable;
}

/**
 * Get the download URL for std library.
 */
export function getStdLibDownloadUrl(config: AlmadarStudioConfig): string {
  return config.stdLibDownloadUrl || ALMADAR_DEFAULTS.STD_LIB_DOWNLOAD_URL;
}

/**
 * Get the target path for downloaded std library.
 */
export function getStdLibDownloadTarget(config: AlmadarStudioConfig): string | null {
  if (config.downloadedStdPath) {
    return config.downloadedStdPath;
  }

  const electronPaths = getElectronPaths();
  if (electronPaths.userDataPath) {
    return `${electronPaths.userDataPath}/${ALMADAR_DEFAULTS.DOWNLOADED_STD_SUBPATH}`;
  }

  return null;
}

// ============================================================================
// Workspace Detection
// ============================================================================

/**
 * Detect workspace from a schema file path.
 * Looks for common project markers (.git, package.json, orbital.config.json).
 */
export async function detectWorkspace(schemaPath: string): Promise<string | null> {
  if (typeof window !== "undefined" && !isElectron()) {
    return null;
  }

  try {
    const path = await import("path");
    const fs = await import("fs");

    let current = path.dirname(schemaPath);
    const root = path.parse(current).root;

    while (current !== root) {
      // Check for project markers
      const markers = [
        ".git",
        "package.json",
        "orbital.config.json",
        "almadar.config.json",
        ".orbital",
      ];

      for (const marker of markers) {
        const markerPath = path.join(current, marker);
        if (fs.existsSync(markerPath)) {
          return current;
        }
      }

      current = path.dirname(current);
    }
  } catch {
    // Ignore errors
  }

  return null;
}
