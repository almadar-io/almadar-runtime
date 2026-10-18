import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { installKernelEvaluator, lazyKernelExports, type KernelEvaluatorExports } from '@almadar/core';
import { readLanguageBundle } from '@almadar/core/language-data';

interface WasmGlue extends KernelEvaluatorExports {
  initSync(input: { module: Uint8Array }): object;
  installLanguage(bundleJson: string): void;
}

const dir = process.env.ALMADAR_KERNEL_DIR;

// The wasm is compiled on the first evaluation, so a test file that never evaluates pays nothing.
if (dir !== undefined && dir !== '') {
  installKernelEvaluator(
    lazyKernelExports(() => {
      const glue: WasmGlue = createRequire(import.meta.url)(join(dir, 'pkg/orbital_wasm.js'));
      glue.initSync({ module: readFileSync(join(dir, 'pkg/orbital_wasm_bg.wasm')) });
      glue.installLanguage(JSON.stringify(readLanguageBundle(process.cwd())));
      return glue;
    }),
  );
}
