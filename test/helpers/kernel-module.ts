import { readLanguageBundle } from '@almadar/core/language-data';
import { loadKernelModule } from '../../src/kernel/load-node.js';
import type { KernelModule } from '../../src/kernel/index.js';
import type { LoadedKernel } from '../../src/kernel/load-node.js';
import type { KernelServerClass } from '../../src/kernel/wire.js';

/** The directory of the built `@almadar/kernel` package (the one holding `pkg/`); kernel suites skip without it. */
export const KERNEL_DIR: string | undefined = process.env.ALMADAR_KERNEL_DIR;

export function loadKernel(): Promise<LoadedKernel> {
  if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
  return loadKernelModule(KERNEL_DIR);
}

/** The installed language as the bundle a browser host hands its kernel. */
export const TEST_LANGUAGE: string = JSON.stringify(readLanguageBundle(process.cwd()));

let loaded: Promise<KernelModule> | undefined;

/** The built kernel, loaded once per test file. */
export function testKernel(): Promise<KernelModule> {
  return (loaded ??= loadKernel());
}

/** The built native kernel add-on (`kernel.node`); the native-engine suites skip without it. */
export const NATIVE_ADDON: string | undefined = process.env.ALMADAR_KERNEL_NODE;

/**
 * A whole `KernelModule` around a scripted `Server`, for tests that drive the engine without the wasm. Every member a
 * test does not name throws when called, so a double never falls behind the module's surface.
 */
export function stubKernelModule(Server: KernelServerClass, overrides: Partial<Omit<KernelModule, 'Server'>> = {}): KernelModule {
  const unexpected = (name: string) => (): never => {
    throw new Error(`stub kernel module: ${name} was not expected`);
  };
  return {
    Server,
    osGlobMatches: () => false,
    isPublicAddress: () => false,
    osDeferringOps: () => '[]',
    osCompletionEvent: () => 'null',
    tabUrlMatches: () => false,
    installLanguage: unexpected('installLanguage'),
    evaluateMany: unexpected('evaluateMany'),
    resolveValues: unexpected('resolveValues'),
    evaluateGuards: unexpected('evaluateGuards'),
    evaluateTraced: unexpected('evaluateTraced'),
    traceEffects: unexpected('traceEffects'),
    mapListenPayload: unexpected('mapListenPayload'),
    scopeRows: unexpected('scopeRows'),
    checkMutationAccess: unexpected('checkMutationAccess'),
    resolveRowBinding: unexpected('resolveRowBinding'),
    ...overrides,
  };
}
