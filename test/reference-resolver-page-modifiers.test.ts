import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { OrbitalDefinition, Orbital, Page, PageId, TraitId } from '@almadar/core';

// The JS twin of orbital-compiler's page_modifiers_inherit.rs: an import's
// explicit page modifiers (on a page reference, or on a whole-orbital `pages {}`
// remap entry) replace the upstream page's, absent ones inherit, and `public`
// over an upstream `authenticated` is refused.
const upstream: Orbital = {
  name: 'AccountOrbital',
  entity: { name: 'Account', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
  traits: [
    {
      id: 'trt_ACCOUNTVIEW000000000000001' as TraitId,
      name: 'AccountView',
      linkedEntity: 'Account',
      scope: 'instance',
      category: 'interaction',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
    },
  ],
  pages: [
    { id: 'pag_ACCOUNT0000000000000000001' as PageId, name: 'AccountPage', path: '/account', traits: [{ ref: 'AccountView' }], access: 'authenticated', indexing: 'noindex' },
    { id: 'pag_ABOUT00000000000000000002' as PageId, name: 'AboutPage', path: '/about', traits: [{ ref: 'AccountView' }], access: 'public', indexing: 'index', title: 'About', description: 'Who we are' },
  ],
};

function loader(): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      return { success: true, data: { orbital: upstream, orbitals: [upstream], sourcePath: './up.orb', importPath } };
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

function wholeImport(pages: Record<string, string>, pageModifiers: NonNullable<OrbitalDefinition['reference']>['pageModifiers']): OrbitalDefinition {
  return {
    name: 'Imp',
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: 'Up.orbitals.AccountOrbital', pages, ...(pageModifiers ? { pageModifiers } : {}) },
  };
}

function pageRef(override: Record<string, string>): OrbitalDefinition {
  return {
    name: 'Local',
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: { name: 'Local', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [{ ref: 'Up.pages.AboutPage', ...override }],
  };
}

async function importedPages(orbital: OrbitalDefinition): Promise<Page[]> {
  const result = await new ReferenceResolver({ basePath: '.', loader: loader() }).resolveOrbitalImports({ name: 'S', orbitals: [orbital] });
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data.flatMap((o) => (o.pages ?? []).filter((p): p is Page => typeof p !== 'string' && 'path' in p));
}

describe('ReferenceResolver — import page modifiers', () => {
  it('a remap entry declares modifiers over the upstream page; absent ones inherit', async () => {
    const pages = await importedPages(wholeImport({ '/about': '/play/about' }, { '/about': { indexing: 'noindex', title: 'Play', translationOf: 'about' } }));
    const about = pages.find((p) => p.path === '/play/about');
    expect(about).toMatchObject({ indexing: 'noindex', title: 'Play', translationOf: 'about', access: 'public', description: 'Who we are' });
  });

  it('control: modifiers for one entry leave the other pages alone', async () => {
    const pages = await importedPages(wholeImport({ '/about': '/play/about' }, { '/about': { indexing: 'noindex' } }));
    expect(pages.find((p) => p.path === '/account')).toMatchObject({ access: 'authenticated', indexing: 'noindex' });
  });

  it('a remap entry cannot weaken access', async () => {
    await expect(importedPages(wholeImport({ '/account': '/me' }, { '/account': { access: 'public' } }))).rejects.toThrow('ORB_O_PAGE_ACCESS_WEAKENED');
  });

  it('a page reference applies its modifiers too, translationOf included', async () => {
    const result = await new ReferenceResolver({ basePath: '.', loader: loader() }).resolve(pageRef({ path: '/ar/about', indexing: 'noindex', translationOf: 'about' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pages[0].page).toMatchObject({ path: '/ar/about', indexing: 'noindex', translationOf: 'about', access: 'public', title: 'About' });
  });
});
