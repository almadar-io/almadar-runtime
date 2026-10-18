// The browser host's kernel store: the program's browser-stored entities in the browser database, every other entity in memory.
import { describe, expect, it } from 'vitest';
import type { RowQuery } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { routeByEntity } from '../src/evaluation/routed-persistence';

const everything: RowQuery = { offset: 0, limit: 10, total: 'exact' };

function stores() {
  const stored = new InMemoryPersistence();
  const rest = new InMemoryPersistence();
  return { stored, rest, routed: routeByEntity(new Set(['Note']), stored, rest) };
}

describe('routeByEntity', () => {
  it('sends a browser-stored entity to the browser store and any other to the other store', async () => {
    const { stored, rest, routed } = stores();
    await routed.create('Note', { id: 'n1', title: 'a' });
    await routed.create('Clock', { id: 'c1', n: 1 });
    expect(await stored.list('Note')).toHaveLength(1);
    expect(await stored.list('Clock')).toHaveLength(0);
    expect(await rest.list('Clock')).toHaveLength(1);
    expect(await rest.list('Note')).toHaveLength(0);
    expect(await routed.getById('Note', 'n1')).toMatchObject({ title: 'a' });
    expect(await routed.getById('Clock', 'n1')).toBeNull();
    await routed.update('Clock', 'c1', { n: 2 });
    await routed.delete('Note', 'n1');
    expect(await routed.list('Clock')).toMatchObject([{ n: 2 }]);
    expect(await routed.list('Note')).toEqual([]);
  });

  it('pushes queries and conditional writes down to the store that holds the entity', async () => {
    const { rest, routed } = stores();
    expect(await routed.writeWhere?.({ kind: 'create', entityType: 'Clock', data: { id: 'c1', n: 1 } })).toMatchObject({ kind: 'created' });
    expect(await rest.list('Clock')).toHaveLength(1);
    expect((await routed.queryPage?.('Clock', everything))?.rows).toHaveLength(1);
    expect((await routed.queryPage?.('Note', everything))?.rows).toHaveLength(0);
    expect(routed.queryCapabilities?.('Note')).toBeDefined();
    expect(routed.writeCapabilities?.('Clock')).toBeDefined();
  });

  it('a batch within one store runs in it, and a batch spanning both is refused', async () => {
    const { stored, routed } = stores();
    const outcomes = await routed.writeBatch?.({ ops: [{ kind: 'create', entityType: 'Note', data: { id: 'n1' } }, { kind: 'create', entityType: 'Note', data: { id: 'n2' } }], onFailure: 'atomic' });
    expect(outcomes).toHaveLength(2);
    expect(await stored.list('Note')).toHaveLength(2);
    await expect(
      routed.writeBatch?.({ ops: [{ kind: 'create', entityType: 'Note', data: { id: 'n3' } }, { kind: 'create', entityType: 'Clock', data: { id: 'c1' } }], onFailure: 'atomic' }),
    ).rejects.toThrow(/spans/);
    expect(await stored.list('Note')).toHaveLength(2);
  });

  it('control: with no browser-stored entity every entity is the other store', async () => {
    const stored = new InMemoryPersistence();
    const rest = new InMemoryPersistence();
    const routed = routeByEntity(new Set(), stored, rest);
    await routed.create('Note', { id: 'n1' });
    expect(await rest.list('Note')).toHaveLength(1);
    expect(await stored.list('Note')).toHaveLength(0);
  });
});
