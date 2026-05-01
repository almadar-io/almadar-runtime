import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/OrbitalServerRuntime.ts',
    'src/ServerBridge.ts',
    // Node-only modules: separate entries so dist emits standalone
    // `createOsHandlers.js` and `LocalPersistenceAdapter.js` files.
    // OrbitalServerRuntime loads them via the eval-require helper at
    // runtime — needs the file to exist as a separate path. Browser
    // bundlers stub these via the package.json `browser` field path
    // mappings; the helper is never invoked in browsers (gated by
    // `isNodeEnv()`).
    'src/createOsHandlers.ts',
    'src/LocalPersistenceAdapter.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  // Top-level Node-only deps that must stay external so any consumer
  // (Node Express server, browser bundler) handles them correctly.
  // Browser bundlers substitute via the package.json `browser` field.
  external: ['express', 'fs', 'fs/promises', 'path', 'net', 'child_process', 'url', 'module'],
});
