import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { OrbitalDefinition, OrbitalSchema, Orbital, Page, PageId, TraitId } from '@almadar/core';

// The JS twin of orbital-compiler's `page_source_identity.rs`: an imported page
// remembers which upstream page it is (`sourcePage`), so the per-locale imports
// of one page are each other's language alternates.
const upstream: Orbital = {
  name: 'SiteOrbital',
  entity: { name: 'Site', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
  traits: [
    {
      id: 'trt_SITEVIEW00000000000000001' as TraitId,
      name: 'SiteView',
      linkedEntity: 'Site',
      scope: 'instance',
      category: 'interaction',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
    },
  ],
  pages: [
    { id: 'pag_HOME000000000000000000001' as PageId, name: 'HomePage', path: '/', traits: [{ ref: 'SiteView' }] },
    { id: 'pag_ABOUT00000000000000000001' as PageId, name: 'AboutPage', path: '/about', traits: [{ ref: 'SiteView' }] },
  ],
};

function loader(): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      return { success: true, data: { orbital: upstream, orbitals: [upstream], sourcePath: './site.orb', importPath } };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

function localeImport(name: string, pages: Record<string, string>): OrbitalDefinition {
  return {
    name,
    uses: [{ from: './site.orb', as: 'Up' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: 'Up.orbitals.SiteOrbital', pages },
  };
}

async function pagesOf(schema: OrbitalSchema): Promise<Page[]> {
  const result = await new ReferenceResolver({ basePath: '.', loader: loader() }).resolveOrbitalImports(schema);
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data.flatMap((o) => (o.pages ?? []).filter((p): p is Page => typeof p !== 'string' && 'path' in p));
}

function at(pages: Page[], path: string): Page {
  const found = pages.find((p) => p.path === path);
  if (!found) throw new Error(`no page at ${path}`);
  return found;
}

describe('ReferenceResolver — imported pages remember their upstream page', () => {
  it('per-locale imports of one upstream page share its identity', async () => {
    const pages = await pagesOf({
      name: 'S',
      orbitals: [localeImport('SiteEN', {}), localeImport('SiteAR', { '/': '/ar', '/about': '/ar/about' })],
    });
    expect(at(pages, '/about').sourcePage).toBe('pag_ABOUT00000000000000000001');
    expect(at(pages, '/ar/about').sourcePage).toBe('pag_ABOUT00000000000000000001');
    expect(at(pages, '/ar').sourcePage).toBe(at(pages, '/').sourcePage);
  });

  it('control: different upstream pages stay distinct', async () => {
    const pages = await pagesOf({ name: 'S', orbitals: [localeImport('SiteAR', { '/': '/ar', '/about': '/ar/about' })] });
    expect(at(pages, '/ar').sourcePage).not.toBe(at(pages, '/ar/about').sourcePage);
  });

  it('a single-page reference carries the identity of the page it names', async () => {
    const result = await new ReferenceResolver({ basePath: '.', loader: loader() }).resolve({
      name: 'AboutAR',
      uses: [{ from: './site.orb', as: 'Up' }],
      entity: { name: 'Local', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [{ ref: 'Up.pages.AboutPage', path: '/ar/about' }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pages[0].page.sourcePage).toBe('pag_ABOUT00000000000000000001');
  });
});
