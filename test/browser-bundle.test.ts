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
import { build, type BuildFailure, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const browserStubs: Plugin = {
  name: 'browser-stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (BUILTINS.has(args.path)) return { path: args.path, namespace: 'node-stub' };
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

  it('control: a named import from a Node builtin fails the gate', async () => {
    const errors = await bundleErrors({ source: "import { homedir } from 'node:os'; export const h = homedir;" });
    expect(errors.join('\n')).toMatch(/homedir/);
  });
});
