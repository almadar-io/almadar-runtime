import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const kernelRuntime = fileURLToPath(new URL('./test/kernel-mode/OrbitalServerRuntime.ts', import.meta.url));

/**
 * The engine-agnostic suites (the ones that drive `OrbitalServerRuntime`) run on the kernel engine:
 * `ALMADAR_KERNEL_DIR=<@almadar/kernel dir> pnpm exec vitest run -c vitest.engine-kernel.config.ts`.
 */
export default defineConfig({
  resolve: {
    alias: [{ find: /^\.\.\/src\/server\/OrbitalServerRuntime(\.js)?$/, replacement: kernelRuntime }],
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/kernel-engine.test.ts', 'test/baked/**'],
    globals: true,
    setupFiles: ['./test/helpers/kernel-evaluator.setup.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
