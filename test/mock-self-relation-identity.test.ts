/**
 * A same-store (self) relation field that `ownerFieldsFromSchema` also
 * classifies as an owner column (e.g. `Person.staffAccount : Person`) means
 * "this row's own account is itself" — an identity self-pointer, not a
 * parent-child tree. `linkRelationFields`'s `sameStore` branch must seed
 * every row's own id into such a field instead of building the deterministic
 * forest `linkSelfRelationField` uses for a genuine parent-child self-relation
 * (`Tag.parentId`, `ThreadPost.replies`) — the forest's own root-stays-blank
 * rule is exactly wrong for identity, since the viewer's own row is the one
 * row that must never be blank.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/MockPersistenceAdapter.js';

const personSchema: EntitySchema = {
  name: 'Person',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    {
      name: 'staffAccount',
      type: 'relation',
      relation: { entity: 'Person', cardinality: 'one' },
    },
  ],
};

const tagSchema: EntitySchema = {
  name: 'Tag',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'label', type: 'string', required: true },
    {
      name: 'parentId',
      type: 'relation',
      relation: { entity: 'Tag', cardinality: 'many-to-one' },
    },
  ],
};

describe('self-relation identity column', () => {
  it('seeds every row its own id when the self-relation is also an owner column', async () => {
    const adapter = new MockPersistenceAdapter({
      ownerFields: ['Person.staffAccount'],
    });
    adapter.registerEntity(personSchema, 6);
    const people = await adapter.list('Person');

    expect(people.length).toBe(6);
    for (const row of people) {
      expect(row.staffAccount).toBe(row.id);
    }
  });

  it('leaves a genuine (non-owner) self-relation building the deterministic forest, unchanged', async () => {
    const adapter = new MockPersistenceAdapter({});
    adapter.registerEntity(tagSchema, 6);
    const tags = await adapter.list('Tag');

    expect(tags.length).toBe(6);
    // Root (row 0) stays unreferenced/blank — the forest's own contract,
    // confirmed unaffected by the owner-column branch added alongside it.
    expect(tags[0]!.parentId).toBeFalsy();
    // Every non-root row parents to an earlier row in the forest ⌊(i-1)/2⌋,
    // never to itself (the identity-column behavior this test distinguishes
    // from).
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i]!.parentId).not.toBe(tags[i]!.id);
    }
  });
});
