/**
 * Node-only code cannot reach a browser bundle: the `http` effect's default fetch (undici, 1.33 MB)
 * lives in its own Node-only entry, which the package `browser` field maps away. The entries are
 * bundled from source with that field applied (what a browser bundler does to the dist), and the
 * bundle must import no `undici`; the Node program entry, bundled the same way without the field, must.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { browser: Record<string, string | false> };
const tsup = fs.readFileSync(path.join(ROOT, 'tsup.config.ts'), 'utf-8');

const entryFiles = new Map<string, string>();
for (const m of tsup.matchAll(/^\s*(?:'([^']+)'|(\w+)):\s*'(src\/[^']+)',/gm)) {
  entryFiles.set(path.join(ROOT, m[3] ?? ''), m[1] ?? m[2] ?? '');
}

const applyBrowserField: Plugin = {
  name: 'apply-browser-field',
  setup(b) {
    b.onResolve({ filter: /^\./ }, async (args) => {
      if (args.pluginData === 'inner') return undefined;
      const resolved = await b.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 'inner' });
      const name = entryFiles.get(resolved.path);
      if (name !== undefined && pkg.browser[`./dist/${name}.js`] === false) return { path: resolved.path, namespace: 'mapped-away' };
      return resolved;
    });
    b.onLoad({ filter: /.*/, namespace: 'mapped-away' }, () => ({ contents: 'export {}', loader: 'js' }));
  },
};

const external: Plugin = {
  name: 'bare-external',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@almadar/') ? undefined : { path: args.path, external: true }));
  },
};

async function importedPackages(entry: string, browserField: boolean): Promise<string[]> {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: browserField ? [applyBrowserField, external] : [external],
  });
  return Object.values(result.metafile.outputs).flatMap((out) => out.imports.map((i) => i.path));
}

describe('browser bundles reach no undici', () => {
  it('the package maps the undici entry away and tsup builds it as its own entry', () => {
    expect(pkg.browser['./dist/pinnedFetchNode.js']).toBe(false);
    expect(entryFiles.get(path.join(ROOT, 'src/kernel/pinned-fetch-node.ts'))).toBe('pinnedFetchNode');
  });

  it.each(['src/index.ts', 'src/kernel/index.ts'])('%s, bundled with the browser field applied, imports no undici', async (entry) => {
    expect(await importedPackages(entry, true)).not.toContain('undici');
  }, 120_000);

  it('control: the Node program entry still imports undici', async () => {
    expect(await importedPackages('src/kernel/program-node.ts', false)).toContain('undici');
  }, 120_000);

  it('control: without the browser field the kernel entry reaches undici', async () => {
    expect(await importedPackages('src/kernel/index.ts', false)).toContain('undici');
  }, 120_000);
});
