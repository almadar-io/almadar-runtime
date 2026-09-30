/**
 * An owner column a `@read` policy scopes by ownership (`(= staffAccount @user.id)`)
 * is owned by the identities `@read` admits — the viewer keeps every other row,
 * the rest go round-robin over the admitted roster — so every ownership-scoped
 * persona, the default one included, sees rows of its own. std-hr-portal: every Employee.staffAccount went to the first
 * @create-eligible HR identity and the default employee persona saw none.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/entities/MockPersistenceAdapter.js';
import type { EntityRow } from '@almadar/core';

const staffSchema: EntitySchema = {
  name: 'Staff',
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'role', type: 'string', required: true }],
  seedData: [
    { id: 's1', role: 'employee' },
    { id: 's2', role: 'manager' },
    { id: 's3', role: 'hr' },
    { id: 's4', role: 'employee' },
  ],
};

const employeeSchema: EntitySchema = {
  name: 'Employee',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'staffAccount', type: 'relation', relation: { entity: 'Staff', cardinality: 'one' } },
  ],
};

type ReadPolicy = (row: EntityRow, user: EntityRow) => boolean;
const ownershipRead: ReadPolicy = (row, user) => user.role === 'hr' || user.role === 'manager' || row.staffAccount === user.id;
const roleOnlyRead: ReadPolicy = (_row, user) => user.role === 'hr';

function build(read: ReadPolicy | undefined): MockPersistenceAdapter {
  const adapter = new MockPersistenceAdapter({ ownerId: 's1', ownerFields: ['Employee.staffAccount'] });
  adapter.setOwnerGate(() => false);
  adapter.setOwnerCandidateGate((_store, _row, identity) => identity.role === 'hr');
  if (read !== undefined) {
    adapter.setOwnerReadGate((_store, row, identity) => read(row, identity));
  }
  adapter.registerEntity(staffSchema);
  adapter.registerEntity(employeeSchema, 6);
  return adapter;
}

const owners = async (adapter: MockPersistenceAdapter) => (await adapter.list('Employee')).map((e) => e.staffAccount);

describe('ownership-scoped owner columns follow @read', () => {
  it('the viewer keeps every other row; the rest go round-robin over the admitted roster', async () => {
    expect(await owners(build(ownershipRead))).toEqual(['s1', 's2', 's1', 's4', 's1', 's2']);
  });

  it('control: without a read gate the @create authority still decides', async () => {
    expect(new Set(await owners(build(undefined)))).toEqual(new Set(['s3']));
  });

  it('edge: a role-only @read admits nobody by ownership, so @create decides', async () => {
    expect(new Set(await owners(build(roleOnlyRead)))).toEqual(new Set(['s3']));
  });
});
