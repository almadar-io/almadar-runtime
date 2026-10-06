// `fetch … { include: [rel] }` hydrates a relation on an orbital's AUXILIARY
// entity (a composed atom's own entity, e.g. std-thread's ThreadPost.replies on a
// task page) exactly as it does on the primary entity. The compiled shell looks
// relations up across every module entity; the interpreter must too.
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, Entity } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const note: Entity = {
  name: 'Note',
  persistence: 'persistent',
  fields: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'content', type: 'string' },
    { name: 'replies', type: 'relation', relation: { entity: 'Note', cardinality: 'many' } },
  ],
};
const task: Entity = {
  name: 'Task',
  persistence: 'persistent',
  fields: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'title', type: 'string' }],
};

function schema(noteIsPrimary: boolean): OrbitalSchema {
  return {
    name: 'notes-app',
    version: '1.0.0',
    orbitals: [{
      name: 'NotesOrbital',
      pages: [],
      entity: noteIsPrimary ? note : task,
      ...(noteIsPrimary ? {} : { auxiliaryEntities: [note] }),
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

async function loadedReplies(noteIsPrimary: boolean): Promise<unknown> {
  const persistence = new InMemoryPersistence();
  const runtime = new OrbitalServerRuntime({ persistence, debug: false });
  await runtime.register(schema(noteIsPrimary));
  const child = await persistence.create('Note', { content: 'a reply', replies: [] });
  await persistence.create('Note', { content: 'top', replies: [child.id] });
  const res = await runtime.processOrbitalEvent('NotesOrbital', { event: 'LOAD', targetTrait: 'NoteList' });
  const rows = res.emittedEvents.find((e) => e.event === 'NotesLoaded')?.payload?.['data'];
  const top = Array.isArray(rows) ? rows.find((r): r is EntityRow => r !== null && typeof r === 'object' && !Array.isArray(r) && r['content'] === 'top') : undefined;
  const replies = top?.['replies'];
  return Array.isArray(replies) ? replies.map((r) => (r !== null && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date) ? r['content'] : r)) : replies;
}

describe('include hydrates relations on auxiliary entities', () => {
  it('an auxiliary entity\'s self-relation is hydrated to rows', async () => {
    expect(await loadedReplies(false)).toEqual(['a reply']);
  });

  it('control: the primary entity\'s self-relation is hydrated to rows', async () => {
    expect(await loadedReplies(true)).toEqual(['a reply']);
  });
});
