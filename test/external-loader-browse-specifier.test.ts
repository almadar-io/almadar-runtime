import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { STD_ROOT, STD_REGISTRY, IO_ROOT, IO_REGISTRY } from './helpers/behavior-packages.js';
import {
  mapBrowseSpecifier,
  ExternalOrbitalLoader,
} from '../src/entities/loader/external-loader.js';

// FC-3: the browse-form specifier the free-compose agent reads (`@std/…`,
// `@behaviors/…`) must map deterministically to the canonical loader form,
// identical to the Rust compiler path.
describe('mapBrowseSpecifier — browse-form → canonical loader form', () => {
  it('maps @std browse paths to the std/behaviors registry', () => {
    expect(mapBrowseSpecifier('@std/ui/core/atoms/std-stats.lolo')).toEqual({
      kind: 'mapped',
      canonical: 'std/behaviors/std-stats',
    });
    expect(mapBrowseSpecifier('@std/ui/core/molecules/ui-calendar-grid.lolo')).toEqual({
      kind: 'mapped',
      canonical: 'std/behaviors/ui-calendar-grid',
    });
  });

  it('maps @behaviors browse paths to the almadar-behaviors registry', () => {
    expect(mapBrowseSpecifier('@behaviors/app/molecules/app-crud-manager.lolo')).toEqual({
      kind: 'mapped',
      canonical: 'almadar-behaviors/app-crud-manager',
    });
    expect(mapBrowseSpecifier('@behaviors/game/organisms/rpg-hero.lolo')).toEqual({
      kind: 'mapped',
      canonical: 'almadar-behaviors/rpg-hero',
    });
  });

  it('leaves canonical and relative specifiers unchanged', () => {
    expect(mapBrowseSpecifier('std/behaviors/std-stats')).toEqual({ kind: 'not-browse-form' });
    expect(mapBrowseSpecifier('almadar-behaviors/rpg-hero')).toEqual({ kind: 'not-browse-form' });
    expect(mapBrowseSpecifier('./health.orb')).toEqual({ kind: 'not-browse-form' });
  });

  it('flags a browse-prefixed specifier with no primitive name', () => {
    expect(mapBrowseSpecifier('@std/')).toEqual({ kind: 'malformed' });
    expect(mapBrowseSpecifier('@behaviors/app/molecules/')).toEqual({ kind: 'malformed' });
  });
});

describe('ExternalOrbitalLoader.resolvePath — browse-form integration', () => {
  it('resolves a browse-form @std path to the same target as its canonical form', () => {
    const loader = new ExternalOrbitalLoader({
      basePath: '/project',
      stdLibPath: '/project/std',
    });
    const browse = loader.resolvePath('@std/ui/core/atoms/std-stats.lolo');
    const canonical = loader.resolvePath('std/behaviors/std-stats');
    expect(browse).toEqual(canonical);
  });

  it('rejects a malformed browse path naming both accepted forms', () => {
    const loader = new ExternalOrbitalLoader({ basePath: '/project', stdLibPath: '/project/std' });
    const result = loader.resolvePath('@std/');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('std/behaviors/std-stats');
    expect(result.error).toContain('@std/ui/core/atoms/std-stats.lolo');
    expect(result.error).toContain('@behaviors/app/molecules/app-crud-manager.lolo');
  });
});

describe('ExternalOrbitalLoader.resolvePath — live behavior-package mirror', () => {
  const loader = new ExternalOrbitalLoader({ basePath: IO_ROOT, stdLibPath: STD_ROOT });

  it('resolves std/behaviors/<name> into the std live mirror', () => {
    const result = loader.resolvePath('std/behaviors/std-stats');
    if (!result.success) throw new Error(result.error);
    expect(result.data.startsWith(STD_REGISTRY)).toBe(true);
    expect(existsSync(result.data)).toBe(true);
  });

  it('resolves almadar-behaviors/<name> into the io live mirror, auto-detected beside std', () => {
    const result = loader.resolvePath('almadar-behaviors/std-time-tracking');
    if (!result.success) throw new Error(result.error);
    expect(result.data.startsWith(IO_REGISTRY)).toBe(true);
    expect(existsSync(result.data)).toBe(true);
  });

  it('fails explicitly for an unknown behavior name', () => {
    const result = loader.resolvePath('almadar-behaviors/no-such-behavior-xyz');
    expect(result.success).toBe(false);
  });

  it('fails explicitly for an unknown std behavior name', () => {
    const result = loader.resolvePath('std/behaviors/no-such-behavior-xyz');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('no-such-behavior-xyz');
  });
});
