/** Node-only: load and initialise `@almadar/kernel` from its package directory (the one with `pkg/`). */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KernelModule } from './wire.js';

interface LoadedKernel extends KernelModule {
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
  const loaded: LoadedKernel = await import(pathToFileURL(join(kernelDir, 'pkg/orbital_wasm.js')).href);
  loaded.initSync({ module: await readFile(join(kernelDir, 'pkg/orbital_wasm_bg.wasm')) });
  const { readLanguageBundle } = await import('@almadar/core/language-data');
  loaded.installLanguage(JSON.stringify(readLanguageBundle(options.languageFrom ?? process.cwd())));
  return loaded;
}
