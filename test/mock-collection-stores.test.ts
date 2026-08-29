/**
 * Collection-keyed mock stores — the interpreter's mirror of the compiled
 * path's dedup-by-collection seeding (orbital-shell-typescript seed.rs).
 *
 * Two entities declaring the same `persistent: <collection>` must share ONE
 * store: a shadow entity (`WikiTagRef [persistent: tags]`) reads the very rows
 * its sibling (`Tag [persistent: tags]`) seeds. Before this, each schema got a
 * disjoint fake dataset keyed by entity name — tag pickers offered a different
 * vocabulary than the taxonomy page browsed, and every cross-store id match
 * was structurally impossible.
 *
 * Also covers the deterministic self-relation forest: a `one`-cardinality
 * relation targeting its own store (a parent column) links row i to row
 * ⌊(i−1)/2⌋ with row 0 a root — real roots, no cycles — instead of the old
 * every-row-gets-a-random-parent linking that left `parentId = ""` root
 * fetches empty and could cycle.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/MockPersistenceAdapter.js';

const tagSchema: EntitySchema = {
  name: 'Tag',
  collection: 'tags',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    {
      name: 'parentId',
      type: 'relation',
      relation: { entity: 'Tag', cardinality: 'one' },
      default: '',
    },
  ],
};

const tagRefSchema: EntitySchema = {
  name: 'WikiTagRef',
  collection: 'tags',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
  ],
};

describe('collection-keyed stores', () => {
  it('entities declaring the same collection share one store', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity(tagSchema);
    adapter.registerEntity(tagRefSchema);

    const tags = await adapter.list('Tag');
    const refs = await adapter.list('WikiTagRef');
    expect(tags.length).toBeGreaterThan(0);
    expect(refs.map((r) => r.id)).toEqual(tags.map((t) => t.id));

    // A write through either name lands in the same store.
    const { id } = await adapter.create('WikiTagRef', { name: 'science' });
    const viaTag = await adapter.getById('Tag', id);
    expect(viaTag?.name).toBe('science');
  });

  it('registration order does not matter and later fields are backfilled', async () => {
    const adapter = new MockPersistenceAdapter();
    // Shadow (fewer fields) registers FIRST; the real taxonomy entity follows.
    adapter.registerEntity(tagRefSchema);
    adapter.registerEntity(tagSchema);

    const tags = await adapter.list('Tag');
    const refs = await adapter.list('WikiTagRef');
    expect(refs.map((r) => r.id)).toEqual(tags.map((t) => t.id));
    // Tag.parentId was declared only by the second registrant; every shared
    // row must still carry it (backfill + relation linking).
    for (const row of tags) {
      expect(row.parentId).not.toBeUndefined();
    }
  });

  it('entities with different collections keep disjoint stores', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity({
      name: 'Note',
      collection: 'notes',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
      ],
    });
    adapter.registerEntity(tagSchema);
    const notes = await adapter.list('Note');
    const tags = await adapter.list('Tag');
    expect(notes.map((n) => n.id)).not.toEqual(tags.map((t) => t.id));
  });
});

describe('self-relation deterministic forest', () => {
  it('links a one-cardinality parent column as an acyclic forest with a root', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity(tagSchema);
    const rows = await adapter.list('Tag');
    expect(rows.length).toBeGreaterThan(2);

    const ids = new Set(rows.map((r) => r.id as string));
    const roots = rows.filter((r) => r.parentId === '');
    expect(roots.length).toBeGreaterThan(0);

    // Every non-root parent is a real sibling id, never self.
    for (const row of rows) {
      if (row.parentId === '') continue;
      expect(ids.has(row.parentId as string)).toBe(true);
      expect(row.parentId).not.toBe(row.id);
    }

    // Acyclic: walking parents from any row terminates at a root.
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    for (const row of rows) {
      let current = row;
      const seen = new Set<string>();
      while (current.parentId !== '') {
        expect(seen.has(current.id as string)).toBe(false);
        seen.add(current.id as string);
        current = byId.get(current.parentId as string)!;
        expect(current).toBeDefined();
      }
    }
  });

  it('cross-entity one-cardinality relations still link to real target ids', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity({
      name: 'WikiPage',
      collection: 'wikipages',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
      ],
    });
    adapter.registerEntity({
      name: 'WikiRevision',
      collection: 'wikirevisions',
      fields: [
        { name: 'id', type: 'string', required: true },
        {
          name: 'documentId',
          type: 'relation',
          relation: { entity: 'WikiPage', cardinality: 'one' },
        },
      ],
    });
    const pages = await adapter.list('WikiPage');
    const pageIds = new Set(pages.map((p) => p.id as string));
    const revisions = await adapter.list('WikiRevision');
    for (const rev of revisions) {
      expect(pageIds.has(rev.documentId as string)).toBe(true);
    }
  });
});
