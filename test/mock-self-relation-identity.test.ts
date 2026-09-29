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
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/entities/MockPersistenceAdapter.js';

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

describe('self-identity owner column (`id` compared to @user.id)', () => {
  const employee: EntitySchema = {
    name: 'Employee',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
    ],
  };

  it('makes exactly one row the viewer, keeping every row and its store key', async () => {
    const adapter = new MockPersistenceAdapter({ ownerId: 'viewer-1', ownerFields: ['Employee.id'] });
    adapter.registerEntity(employee, 6);
    const rows = await adapter.list('Employee');
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.id === 'viewer-1')).toHaveLength(1);
    expect(await adapter.getById('Employee', 'viewer-1')).toMatchObject({ id: 'viewer-1' });
    expect(new Set(rows.map((r) => r.id)).size).toBe(6);
  });

  it('a persona switch moves that one row to the new viewer and the store follows', async () => {
    const adapter = new MockPersistenceAdapter({ ownerId: 'viewer-1', ownerFields: ['Employee.id'] });
    adapter.registerEntity(employee, 6);
    adapter.restampOwner('viewer-2');
    expect(await adapter.getById('Employee', 'viewer-1')).toBeNull();
    expect(await adapter.getById('Employee', 'viewer-2')).toMatchObject({ id: 'viewer-2' });
    expect(await adapter.list('Employee')).toHaveLength(6);
  });

  it('control: a non-id owner column still gives the viewer every other row', async () => {
    const adapter = new MockPersistenceAdapter({ ownerId: 'viewer-1', ownerFields: ['Note.authorId'] });
    adapter.registerEntity({ name: 'Note', fields: [{ name: 'id', type: 'string', required: true }, { name: 'authorId', type: 'string', required: true }] }, 6);
    expect((await adapter.list('Note')).filter((r) => r.authorId === 'viewer-1')).toHaveLength(3);
  });
});
