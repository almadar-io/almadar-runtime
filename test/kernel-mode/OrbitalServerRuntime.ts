/**
 * Kernel-mode stand-in for `src/server/OrbitalServerRuntime`: the same module with the class constructed on the
 * Rust kernel. `vitest.engine-kernel.config.ts` aliases the suites' import to this file, so an engine-agnostic suite runs
 * unchanged on the kernel engine. Test-only; no host default changes.
 */
import { OrbitalServerRuntime as JsRuntime, type OrbitalServerRuntimeConfig } from '../../src/server/OrbitalServerRuntime.js';
import { loadKernel } from '../helpers/kernel-module.js';

export * from '../../src/server/OrbitalServerRuntime.js';

const kernel = await loadKernel();

export class OrbitalServerRuntime extends JsRuntime {
  constructor(config: OrbitalServerRuntimeConfig = {}) {
    super({ ...config, engine: 'kernel', kernel });
  }
}
