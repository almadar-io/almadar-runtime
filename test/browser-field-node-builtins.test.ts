/**
 * Every Node builtin the runtime imports must be declared `false` in the
 * package `browser` field. The dist rewrites `node:x` to bare `x`, and a
 * webpack browser build (the orb website) cannot resolve a bare builtin, so an
 * unmapped one fails the consumer's whole bundle even when the import is lazy
 * and only ever runs on the server (orb-website build, 2026-09-25:
 * `import('node:async_hooks')` in OrbitalServerRuntime).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8')) as {
  browser?: Record<string, string | false>;
};
const browser = pkg.browser ?? {};
const builtins = new Set(builtinModules.filter((m) => !m.startsWith('_')));

const IMPORT_RE = /(?:^|\n)\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** `node:fs/promises` → `fs/promises`; returns null for a non-builtin specifier. */
export function builtinOf(specifier: string): string | null {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return builtins.has(bare) ? bare : null;
}

function isMappedAway(file: string): boolean {
  const rel = `./${path.relative(pkgRoot, file).replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js')}`;
  return browser[rel] === false;
}

function importedBuiltins(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(path.join(pkgRoot, 'src'))) {
    if (isMappedAway(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const b = builtinOf(m[1] ?? m[2] ?? m[3] ?? '');
      if (b) found.set(b, [...(found.get(b) ?? []), path.relative(pkgRoot, file)]);
    }
  }
  return found;
}

describe('browser field covers every Node builtin the runtime imports', () => {
  it('recognizes builtins in both spellings and ignores packages', () => {
    expect(builtinOf('node:async_hooks')).toBe('async_hooks');
    expect(builtinOf('fs/promises')).toBe('fs/promises');
    expect(builtinOf('express')).toBeNull();
    expect(builtinOf('@almadar/core')).toBeNull();
  });

  it('a type-only import does not count (it is erased)', () => {
    const typeOnly = 'import type { AsyncLocalStorage } from "node:async_hooks";';
    expect([...typeOnly.matchAll(IMPORT_RE)]).toEqual([]);
  });

  it('maps each imported builtin to false', () => {
    const unmapped = [...importedBuiltins()]
      .filter(([b]) => browser[b] !== false)
      .map(([b, files]) => `${b} (${files.join(', ')})`);
    expect(unmapped).toEqual([]);
  });
});
