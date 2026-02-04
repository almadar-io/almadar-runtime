/**
 * Orbital Loader Module
 *
 * Provides functionality for loading external .orb files from various sources:
 * - FileSystemLoader (Node.js) - ExternalOrbitalLoader
 * - HttpLoader (Browser) - Uses fetch API
 * - UnifiedLoader (Auto-detect) - Routes to appropriate loader
 *
 * @packageDocumentation
 */

// Schema Loader Interface
export {
  type SchemaLoader,
  type LoadedSchema,
  type LoadedOrbital,
  type LoadResult,
  type BaseLoaderOptions,
  type FileSystemLoaderOptions,
  type HttpLoaderOptions,
  type UnifiedLoaderOptions,
  type LoaderStrategy,
  type ImportChainLike,
  type SchemaLoaderFactory,
  isElectron,
  isBrowser,
  isNode,
  getDefaultLoaderStrategy,
} from "./schema-loader.js";

// FileSystem Loader (Node.js)
export {
  ExternalOrbitalLoader,
  ImportChain,
  LoaderCache,
  createLoader,
  parseImportPath,
  type LoaderOptions,
  // Re-export for backwards compatibility
  type LoadedOrbital as FSLoadedOrbital,
  type LoadedSchema as FSLoadedSchema,
} from "./external-loader.js";

// HTTP Loader (Browser)
export {
  HttpLoader,
  HttpImportChain,
  createHttpLoader,
} from "./http-loader.js";

// Unified Loader (Auto-detect)
export {
  UnifiedLoader,
  UnifiedImportChain,
  createUnifiedLoader,
  createAutoLoader,
} from "./unified-loader.js";

// Almadar Studio Configuration (Electron)
export {
  createAlmadarLoaderOptions,
  resolveAlmadarPaths,
  needsStdLibDownload,
  getStdLibDownloadUrl,
  getStdLibDownloadTarget,
  detectWorkspace,
  ALMADAR_DEFAULTS,
  type AlmadarStudioConfig,
  type ResolvedAlmadarPaths,
} from "./almadar-studio-config.js";
