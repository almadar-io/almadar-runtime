// A self-referential `include` (ThreadPost.replies : [ThreadPost]) hydrates the
// whole reply tree, not one level: a reply to a reply is loaded under its
// parent. A cycle in the stored ids ends at the repeated ancestor, so the
// payload stays serializable.
import { describe, it, expect } from 'vitest';
import type { EntityRow, FieldValue, OrbitalSchema } from '@almadar/core';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'notes-app',
    version: '1.0.0',
    orbitals: [{
      name: 'NotesOrbital',
      pages: [],
      entity: {
        name: 'Note',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'content', type: 'string' },
          { name: 'replies', type: 'relation', relation: { entity: 'Note', cardinality: 'many' } },
        ],
      },
      traits: [{
        name: 'NoteList',
        linkedEntity: 'Note',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'LOAD', name: 'Load' }, { key: 'NotesLoaded', name: 'Notes loaded' }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'Note', { include: ['replies'], emit: { success: 'NotesLoaded' } }]] },
            { from: 'idle', to: 'idle', event: 'NotesLoaded', effects: [] },
          ],
        },
      }],
    }],
  };
}

async function setup() {
  const persistence = new InMemoryPersistence();
  const runtime = new OrbitalServerRuntime({ persistence, debug: false });
  await runtime.register(schema());
  const load = async (): Promise<EntityRow[]> => {
    const res = await runtime.processOrbitalEvent('NotesOrbital', { event: 'LOAD', targetTrait: 'NoteList' });
    const rows = res.emittedEvents.find((e) => e.event === 'NotesLoaded')?.payload?.['data'];
    return Array.isArray(rows) ? rows.filter((r): r is EntityRow => r !== null && typeof r === 'object' && !Array.isArray(r)) : [];
  };
  return { persistence, load };
}

/** The tree under `row` as nested content arrays. */
type Tree = { content: unknown; replies: Tree[] };
function tree(row: { readonly [key: string]: FieldValue | undefined }): Tree {
  const replies = row['replies'];
  return {
    content: row['content'],
    replies: Array.isArray(replies)
      ? replies.flatMap((r) => (r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date) ? [tree(r)] : []))
      : [],
  };
}

describe('self-relation include hydrates the whole tree', () => {
  it('a reply to a reply is loaded under its parent', async () => {
    const { persistence, load } = await setup();
    const grandchild = await persistence.create('Note', { content: 'grandchild', replies: [] });
    const child = await persistence.create('Note', { content: 'child', replies: [grandchild.id] });
    await persistence.create('Note', { content: 'top', replies: [child.id] });
    const top = (await load()).find((r) => r['content'] === 'top');
    expect(top && tree(top)).toEqual({
      content: 'top',
      replies: [{ content: 'child', replies: [{ content: 'grandchild', replies: [] }] }],
    });
  });

  it('control: a one-level reply is loaded as before', async () => {
    const { persistence, load } = await setup();
    const child = await persistence.create('Note', { content: 'child', replies: [] });
    await persistence.create('Note', { content: 'top', replies: [child.id] });
    const top = (await load()).find((r) => r['content'] === 'top');
    expect(top && tree(top)).toEqual({ content: 'top', replies: [{ content: 'child', replies: [] }] });
  });

  it('a cycle stops at the repeated ancestor and stays serializable', async () => {
    const { persistence, load } = await setup();
    const a = await persistence.create('Note', { content: 'a', replies: [] });
    const b = await persistence.create('Note', { content: 'b', replies: [a.id] });
    await persistence.update('Note', a.id, { replies: [b.id] });
    const rows = await load();
    expect(() => JSON.stringify(rows)).not.toThrow();
    const top = rows.find((r) => r['content'] === 'a');
    expect(top && tree(top)).toEqual({ content: 'a', replies: [{ content: 'b', replies: [] }] });
  });

  it('a post listing itself as a reply hydrates no replies', async () => {
    const { persistence, load } = await setup();
    const a = await persistence.create('Note', { content: 'a', replies: [] });
    await persistence.update('Note', a.id, { replies: [a.id] });
    const top = (await load()).find((r) => r['content'] === 'a');
    expect(top && tree(top)).toEqual({ content: 'a', replies: [] });
  });
});
