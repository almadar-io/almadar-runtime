import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/OrbitalServerRuntime.ts',
    'src/ServerBridge.ts',
    // Renderer-agnostic UI contract. Any UI library (React, Web Components,
    // etc.) imports this surface and implements the framework-specific slot
    // manager / component registry on top of it.
    'src/ui/index.ts',
    // Node-only module: separate entry so dist emits a standalone
    // `createOsHandlers.js` file. OrbitalServerRuntime loads it via
    // dynamic import() at runtime — needs the file to exist as a
    // separate path. The browser stubs it via the package.json `browser`
    // field path mapping; the import is never invoked in browsers (gated
    // by `isNodeEnv()`).
    'src/createOsHandlers.ts',
    // Lightweight seeded PRNG exposed for downstream tooling that needs
    // deterministic mock values without pulling in @faker-js/faker.
    'src/mockRandom.ts',
    // Row-level entity access. A separate entry because generated app servers
    // import it directly — going through the root barrel would drag `./ui`,
    // MockPersistenceAdapter and the whole @almadar/std chain into a Node
    // process that needs two pure functions.
    'src/entityAccess.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: false,
  sourcemap: false,
  splitting: true,
  treeshake: true,
  // Top-level Node-only deps that must stay external so any consumer
  // (Node Express server, browser bundler) handles them correctly.
  // Browser bundlers substitute via the package.json `browser` field.
  external: ['express', '@almadar/server', 'fs', 'fs/promises', 'path', 'net', 'child_process', 'url', 'module'],
});
