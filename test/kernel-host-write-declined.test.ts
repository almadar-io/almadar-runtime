import { describe, expect, it } from 'vitest';
import { InMemoryPersistence } from '@almadar/db/mock';
import { WriteDeclinedError, type PersistenceAdapter, type RowWriteBatch } from '@almadar/core';
import { writeRows } from '../src/kernel/host.js';

const batch: RowWriteBatch = { ops: [{ kind: 'delete', entityType: 'Note', id: 'n1' }, { kind: 'delete', entityType: 'Note', id: 'n2' }], onFailure: 'atomic' };
const request = { kind: 'writeRows' as const, batch };

function declining(error: Error): PersistenceAdapter {
  const m = new InMemoryPersistence();
  return {
    create: (t, d) => m.create(t, d), update: (t, id, d) => m.update(t, id, d), delete: (t, id) => m.delete(t, id),
    getById: (t, id) => m.getById(t, id), list: (t) => m.list(t),
    writeBatch: async () => { throw error; },
  };
}

describe('kernel host writeRows', () => {
  it('maps a WriteDeclinedError to the wire writeUnsupported with its reason', async () => {
    expect(await writeRows(declining(new WriteDeclinedError('atomic-batch')), request)).toEqual({ kind: 'writeUnsupported', reason: 'atomic-batch' });
  });

  it('control: a plain Error stays a failed write', async () => {
    expect(await writeRows(declining(new Error('boom')), request)).toMatchObject({ kind: 'wrote', result: { error: expect.stringContaining('boom') } });
  });
});
