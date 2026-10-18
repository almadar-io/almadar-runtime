/**
 * The browser bundle gate (G-CROSS-146): `@almadar/runtime`'s entry, bundled for
 * the browser with every Node builtin replaced by an empty module — what Vite's
 * browser-external stub does — must build. A named import from a Node builtin
 * (`import { homedir } from 'node:os'`) anywhere on the graph, including the
 * `@almadar/*` packages it pulls in, fails here instead of in a client build.
 */
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build, type BuildFailure, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';
import tsupConfig from '../tsup.config';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** The source of every tsup entry the package `browser` field maps to `false`: a browser bundler stubs its dist file. */
function browserStubbedSources(): Set<string> {
  const browser = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { browser?: Record<string, string | false> }).browser ?? {};
  const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig;
  const entry = typeof config === 'function' ? undefined : config.entry;
  const entries = entry !== undefined && !Array.isArray(entry) ? Object.entries(entry) : [];
  return new Set(entries.filter(([name]) => browser[`./dist/${name}.js`] === false).map(([, source]) => path.join(ROOT, source)));
}
const STUBBED = browserStubbedSources();

const browserStubs: Plugin = {
  name: 'browser-stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (BUILTINS.has(args.path)) return { path: args.path, namespace: 'node-stub' };
      if (args.path.startsWith('.') && STUBBED.has(path.join(args.resolveDir, args.path).replace(/\.js$/, '.ts'))) {
        return { path: args.path, namespace: 'node-stub' };
      }
      if (/^[^./]/.test(args.path) && !args.path.startsWith('@almadar/')) return { path: args.path, external: true };
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {}', loader: 'js' }));
  },
};

async function bundleErrors(options: { entry: string } | { source: string }): Promise<string[]> {
  return build({
    ...('entry' in options
      ? { entryPoints: [path.join(ROOT, options.entry)] }
      : { stdin: { contents: options.source, resolveDir: ROOT, loader: 'ts' as const } }),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [browserStubs],
  }).then(
    (): string[] => [],
    (failure: BuildFailure): string[] => failure.errors.map((err) => `${err.location?.file ?? ''}: ${err.text}`),
  );
}

describe('browser bundle', () => {
  it('the runtime entry bundles for the browser with Node builtins stubbed', async () => {
    expect(await bundleErrors({ entry: 'src/index.ts' })).toEqual([]);
  }, 120_000);

  // `@almadar/ui`'s in-browser playground imports this entry; its Node-only halves load through entries the browser
  // field maps away, never through a chunk the map cannot name.
  it('the OrbitalServerRuntime entry bundles for the browser, reaching Node code only through browser-mapped entries', async () => {
    expect(await bundleErrors({ entry: 'src/server/OrbitalServerRuntime.ts' })).toEqual([]);
  }, 120_000);

  it('control: a dynamic import of a module no browser-mapped entry owns fails the gate', async () => {
    const errors = await bundleErrors({ source: "export const load = () => import('./src/host/program/index.ts');" });
    expect(errors.join('\n')).toMatch(/createRequire|randomUUID|tmpdir|No matching export/);
  }, 120_000);

  it('control: a named import from a Node builtin fails the gate', async () => {
    const errors = await bundleErrors({ source: "import { homedir } from 'node:os'; export const h = homedir;" });
    expect(errors.join('\n')).toMatch(/homedir/);
  });
});
