/**
 * A field typed `T.f` (`projectedFrom`) seeds from `T`'s seeded rows — row `i` takes row
 * `i mod n`'s `f` — through the same placeholder-then-link pass a relation uses, whichever
 * entity registers first. Twin of orbital-core `tests/projected_field_seed.rs`.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/entities/MockPersistenceAdapter.js';

const tag: EntitySchema = {
  name: 'Tag',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
  ],
};

const note: EntitySchema = {
  name: 'Note',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    { name: 'tagRef', type: 'string', projectedFrom: { type: 'Tag', field: 'id' } },
    { name: 'tagName', type: 'string', projectedFrom: { type: 'Tag', field: 'name' } },
    { name: 'tagRefs', type: 'array', items: { type: 'string', projectedFrom: { type: 'Tag', field: 'id' } } },
  ],
};

async function seeded(order: 'tags-first' | 'notes-first' | 'no-tags') {
  const adapter = new MockPersistenceAdapter();
  if (order === 'tags-first') adapter.registerEntity(tag, 4);
  adapter.registerEntity(note, 4);
  if (order === 'notes-first') adapter.registerEntity(tag, 4);
  const tags = order === 'no-tags' ? [] : await adapter.list('Tag');
  return { notes: await adapter.list('Note'), tags };
}

describe('a T.f field seeds from T\'s seeded rows', () => {
  it('a projected id holds a seeded Tag id, row i taking row i mod n', async () => {
    const { notes, tags } = await seeded('tags-first');
    notes.forEach((n, i) => expect(n.tagRef).toBe(tags[i % tags.length]!.id));
  });

  it('a projected name holds that column of a seeded Tag', async () => {
    const { notes, tags } = await seeded('tags-first');
    const names = tags.map((t) => t.name);
    for (const n of notes) expect(names).toContain(n.tagName);
  });

  it('an array of projected ids carries a seeded Tag id', async () => {
    const { notes, tags } = await seeded('tags-first');
    notes.forEach((n, i) => expect(n.tagRefs).toEqual([tags[i % tags.length]!.id]));
  });

  it('edge: the target registering after the field still links it', async () => {
    const { notes, tags } = await seeded('notes-first');
    notes.forEach((n, i) => expect(n.tagRef).toBe(tags[i % tags.length]!.id));
  });

  it('edge: a target with no rows leaves the placeholder', async () => {
    const { notes } = await seeded('no-tags');
    for (const n of notes) expect(n.tagRef).toBe('');
  });

  it('control: an unprojected field keeps its sampled value', async () => {
    const { notes } = await seeded('tags-first');
    for (const n of notes) expect(typeof n.title === 'string' && n.title.length > 0).toBe(true);
  });
});
