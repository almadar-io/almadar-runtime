/** Node-only: load and initialise `@almadar/kernel` from its package directory (the one with `pkg/`). */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HttpKernel } from './http-exchange.js';
import type { KernelModule } from './wire.js';

export interface LoadedKernel extends KernelModule, HttpKernel {
  initSync(input: { module: Uint8Array }): object;
  installLanguage(bundleJson: string): void;
}

export interface LoadKernelOptions {
  /** Where the installed `@almadar/core` and `@almadar/std` are found, node-style (default: the working directory). */
  languageFrom?: string;
}

/**
 * Loads the kernel and installs the language data the installed packages declare (the operator table that
 * routes `program/*` and the other host effects), as `orb` reads it. The first install in a process wins.
 */
export async function loadKernelModule(kernelDir: string, options: LoadKernelOptions = {}): Promise<KernelModule> {
  return loadKernel(kernelDir, options);
}

/**
 * The `http` effect's builder exports of the same package (`buildHttpRequest`, `isPublicAddress`, …): the
 * interpreter's only way to build a request. A directory that does not hold a built kernel rejects, never falls back.
 */
export async function loadHttpKernel(kernelDir: string, options: LoadKernelOptions = {}): Promise<HttpKernel> {
  return loadKernel(kernelDir, options);
}

async function loadKernel(kernelDir: string, options: LoadKernelOptions): Promise<LoadedKernel> {
  const loaded: LoadedKernel = await import(pathToFileURL(join(kernelDir, 'pkg/orbital_wasm.js')).href);
  loaded.initSync({ module: await readFile(join(kernelDir, 'pkg/orbital_wasm_bg.wasm')) });
  const { readLanguageBundle } = await import('@almadar/core/language-data');
  loaded.installLanguage(JSON.stringify(readLanguageBundle(options.languageFrom ?? process.cwd())));
  return loaded;
}

/** The platform packages `@almadar/orb` ships its binaries in; each holds the native kernel add-on as `kernel.node`. */
const NATIVE_PLATFORMS: Record<string, string> = {
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'win32-x64': 'windows-x64',
};

/**
 * Where the native kernel add-on is: `ALMADAR_KERNEL_NODE`, else `kernel.node` in the `@almadar/orb-<platform>-<arch>`
 * package this platform installs. Rejects when neither exists, so a host can fall back to the wasm kernel by choice.
 */
export function resolveNativeAddon(from: string = process.cwd()): string {
  const named = process.env.ALMADAR_KERNEL_NODE;
  if (named !== undefined && named !== '') return named;
  const platform = NATIVE_PLATFORMS[`${process.platform}-${process.arch}`];
  if (platform === undefined) throw new Error(`no native kernel add-on is shipped for ${process.platform}-${process.arch}`);
  return createRequire(join(from, 'resolve.js')).resolve(`@almadar/orb-${platform}/kernel.node`);
}

/**
 * Loads the native kernel add-on (the same API as the wasm module, run as machine code) and installs the language data
 * the installed packages declare. The first install in a process wins.
 */
export async function loadNativeKernelModule(addonPath: string, options: LoadKernelOptions = {}): Promise<LoadedKernel> {
  const loaded: LoadedKernel = createRequire(import.meta.url)(addonPath);
  const { readLanguageBundle } = await import('@almadar/core/language-data');
  loaded.installLanguage(JSON.stringify(readLanguageBundle(options.languageFrom ?? process.cwd())));
  return loaded;
}
