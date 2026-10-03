import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LazyPage } from '@almadar/core';

import { HttpLoader } from '../src/entities/loader/http-loader.js';
import { loadLazyPage } from '../src/entities/loader/lazy-page.js';

const post = {
  name: 'BlogWhy',
  orbitals: [
    {
      name: 'BlogWhy',
      entity: { name: 'BlogWhyState', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [{ name: 'BlogWhyPage', path: '/blog/why', traits: [] }],
    },
  ],
};

const page: LazyPage = { path: '/blog/why', orbital: 'BlogWhy', orbRef: 'lazy/BlogWhy.orb' };

function serve(files: Record<string, unknown>): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    const body = files[url];
    return body === undefined
      ? new Response('missing', { status: 404, statusText: 'Not Found' })
      : new Response(JSON.stringify(body), { status: 200 });
  });
  return requested;
}

const loader = () => new HttpLoader({ basePath: 'https://site.test/' });

describe('loadLazyPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the behavior behind a lazy page, relative to the importer .orb', async () => {
    const requested = serve({ 'https://site.test/app/lazy/BlogWhy.orb': post });
    const result = await loadLazyPage(loader(), page, 'https://site.test/app/site.orb');
    expect(result.success && result.data.name).toBe('BlogWhy');
    expect(requested).toEqual(['https://site.test/app/lazy/BlogWhy.orb']);
  });

  it('fails when the loaded .orb does not carry the expected orbital', async () => {
    serve({ 'https://site.test/app/lazy/BlogWhy.orb': { ...post, orbitals: [{ ...post.orbitals[0], name: 'Other' }] } });
    const result = await loadLazyPage(loader(), page, 'https://site.test/app/site.orb');
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain('BlogWhy');
  });

  it('fails with the url when the .orb is missing', async () => {
    serve({});
    const result = await loadLazyPage(loader(), page, 'https://site.test/app/site.orb');
    expect(!result.success && result.error).toContain('https://site.test/app/lazy/BlogWhy.orb');
  });

  it('edge: a second load of the same page is served from the loader cache', async () => {
    const requested = serve({ 'https://site.test/app/lazy/BlogWhy.orb': post });
    const shared = loader();
    await loadLazyPage(shared, page, 'https://site.test/app/site.orb');
    await loadLazyPage(shared, page, 'https://site.test/app/site.orb');
    expect(requested).toHaveLength(1);
  });
});
