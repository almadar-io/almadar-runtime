import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    OrbitalServerRuntime: 'src/server/OrbitalServerRuntime.ts',
    ServerBridge: 'src/server/ServerBridge.ts',
    // The kernel engine's host half (pure) and its Node-only loader for `@almadar/kernel`.
    kernel: 'src/kernel/index.ts',
    kernelNode: 'src/kernel/load-node.ts',
    // The Node `os` answerer of a kernel host (fs, child_process, net, dgram, dns); the browser bundle never imports it.
    kernelOsNode: 'src/kernel/os-node.ts',
    // Load a program on the kernel engine from Node, dispatch an event and read its external emits.
    kernelProgram: 'src/kernel/program-node.ts',
    // The program host's workspaces: std-workspace run by the kernel (Node only).
    kernelWorkspace: 'src/kernel/workspace-node.ts',
    // The `http` effect's default fetch (undici), Node only: the browser field maps it away so no browser bundle reaches undici.
    pinnedFetchNode: 'src/kernel/pinned-fetch-node.ts',
    // The credential store and its scope (browser-safe; a Node host adds AsyncLocalStorage tenant scopes).
    credentials: 'src/host/credentials/index.ts',
    // The raw ports of a Chrome-extension host (tabs, credential rows) and the page-side content script.
    chrome: 'src/host/chrome/index.ts',
    chromeContent: 'src/host/chrome/content.ts',
    // Node-only host ports: the program host (spawns `orb`) and the development master key.
    hostNode: 'src/host/node.ts',
    // Renderer-agnostic UI contract. Any UI library (React, Web Components,
    // etc.) imports this surface and implements the framework-specific slot
    // manager / component registry on top of it.
    'ui/index': 'src/ui/index.ts',
    // Node-only module: separate entry so dist emits a standalone
    // `createProgramHandlers.js` file that OrbitalServerRuntime loads via dynamic import().
    // It spawns `orb` through the program host.
    createProgramHandlers: 'src/effects/createProgramHandlers.ts',
    // Lightweight seeded PRNG exposed for downstream tooling that needs
    // deterministic mock values without pulling in @faker-js/faker.
    mockRandom: 'src/entities/mockRandom.ts',
    // The owner-gate installer shared with `@almadar/server`'s MockDataService (the compiled apps' mock).
    mockPersistence: 'src/entities/policyOwnerGates.ts',
    // Server-Sent Events helpers, shared with `@almadar/server` (which re-exports them).
    sse: 'src/server/sse.ts',
  },
  format: ['esm'],
  dts: true,
  clean: false,
  sourcemap: false,
  splitting: true,
  treeshake: true,
  // Top-level Node-only deps that must stay external so any consumer
  // (Node Express server, browser bundler) handles them correctly.
  // Browser bundlers substitute via the package.json `browser` field.
  external: ['express', '@almadar/core/language-data', 'fs', 'fs/promises', 'path', 'net', 'child_process', 'url', 'module', 'dgram', 'dns/promises', 'os', 'tty', 'crypto'],
});
