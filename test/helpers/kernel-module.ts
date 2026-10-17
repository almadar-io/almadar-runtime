import { loadKernelModule } from '../../src/kernel/load-node.js';
import type { KernelModule } from '../../src/kernel/index.js';

/** The directory of the built `@almadar/kernel` package (the one holding `pkg/`); kernel suites skip without it. */
export const KERNEL_DIR: string | undefined = process.env.ALMADAR_KERNEL_DIR;

export function loadKernel(): Promise<KernelModule> {
  if (KERNEL_DIR === undefined) throw new Error('ALMADAR_KERNEL_DIR is not set');
  return loadKernelModule(KERNEL_DIR);
}

/** The built native kernel add-on (`kernel.node`); the native-engine suites skip without it. */
export const NATIVE_ADDON: string | undefined = process.env.ALMADAR_KERNEL_NODE;
