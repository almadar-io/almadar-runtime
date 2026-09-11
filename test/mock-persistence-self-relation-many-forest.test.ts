/**
 * A self-referential `many` relation (`ChatMessage.replies : [ChatMessage]`,
 * as in std-realtime-chat) must link through the SAME deterministic forest as
 * a `one`/`many-to-one` self-relation, not 2-4 random sibling ids. Random
 * cross-linking meant every row ended up referenced by several others, so
 * under the runtime's default `onDelete: restrict` nothing was ever
 * deletable — see docs/Almadar_Runtime_Gaps.md
 * R-MOCK-SELF-RELATION-MANY-RANDOM-LINKING.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/MockPersistenceAdapter.js';

const chatMessageSchema: EntitySchema = {
  name: 'ChatMessage',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
    {
      name: 'replies',
      type: 'relation',
      relation: { entity: 'ChatMessage', cardinality: 'many' },
    },
  ],
};

describe('self-relation many forest (ChatMessage.replies)', () => {
  it('row 0 (root) is never listed in any row\'s replies', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity(chatMessageSchema, 6);
    const rows = await adapter.list('ChatMessage');
    expect(rows).toHaveLength(6);

    const rootId = rows[0]!.id as string;
    for (const row of rows) {
      const replies = row.replies as string[];
      expect(replies).not.toContain(rootId);
    }
  });

  it('no row lists itself as a reply', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity(chatMessageSchema, 6);
    const rows = await adapter.list('ChatMessage');

    for (const row of rows) {
      const replies = row.replies as string[];
      expect(replies).not.toContain(row.id);
    }
  });

  it('every listed child has exactly one parent', async () => {
    const adapter = new MockPersistenceAdapter();
    adapter.registerEntity(chatMessageSchema, 6);
    const rows = await adapter.list('ChatMessage');

    const parentCountByChild = new Map<string, number>();
    for (const row of rows) {
      const replies = row.replies as string[];
      for (const childId of replies) {
        parentCountByChild.set(childId, (parentCountByChild.get(childId) ?? 0) + 1);
      }
    }
    for (const count of parentCountByChild.values()) {
      expect(count).toBe(1);
    }
    // Every non-root row is listed as exactly one parent's child.
    const rootId = rows[0]!.id as string;
    for (const row of rows) {
      if (row.id === rootId) continue;
      expect(parentCountByChild.get(row.id as string)).toBe(1);
    }
  });

  it('is deterministic across re-registration with the same seed', async () => {
    const first = new MockPersistenceAdapter();
    first.registerEntity(chatMessageSchema, 6);
    const firstRows = await first.list('ChatMessage');

    const second = new MockPersistenceAdapter();
    second.registerEntity(chatMessageSchema, 6);
    const secondRows = await second.list('ChatMessage');

    expect(firstRows.map((r) => r.replies)).toEqual(secondRows.map((r) => r.replies));
  });
});
