import { describe, it, expect } from 'vitest';
import { schemaToIR } from '../src/entities/resolver/schema-to-ir.js';
import type { OrbitalSchema, Page } from '@almadar/core';

// Page modifiers ride the runtime resolver exactly as core's: declared ones
// land on the ResolvedPage, absent ones stay absent.
function schema(page: Partial<Page>): OrbitalSchema {
  return {
    name: 'App',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Feature',
        entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [],
        pages: [{ name: 'AccountPage', path: '/account', traits: [], ...page }],
      },
    ],
  };
}

describe('schemaToIR — page modifiers', () => {
  it('carries declared access, indexing, title and description', () => {
    const ir = schemaToIR(schema({ access: 'authenticated', indexing: 'noindex', title: ['i18n/t', 'app:meta.account'], description: 'Yours' }));
    const page = ir.pages.get('AccountPage');
    expect(page?.access).toBe('authenticated');
    expect(page?.indexing).toBe('noindex');
    expect(page?.title).toEqual(['i18n/t', 'app:meta.account']);
    expect(page?.description).toBe('Yours');
  });

  it('control: an undeclared page carries none of them', () => {
    const page = schemaToIR(schema({})).pages.get('AccountPage');
    expect(page).toBeDefined();
    for (const key of ['access', 'indexing', 'title', 'description'] as const) expect(page && key in page).toBe(false);
  });
});
