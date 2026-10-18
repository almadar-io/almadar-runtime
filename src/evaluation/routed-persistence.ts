import type { PersistenceAdapter, QueryCapabilities, RowIdPage, RowQuery, RowQueryPage, RowWriteBatch, RowWriteOp, RowWriteOutcome, WriteCapabilities } from '@almadar/core';

function pushedDown<T>(method: T | undefined, name: string, entityType: string): T {
  if (method === undefined) throw new Error(`${name} is not supported by the store that holds ${entityType}`);
  return method;
}

/**
 * One persistence over two stores: `stored` entities (a program's browser-stored ones) go to `stored`, every other entity to
 * `other`. The kernel reads and writes every entity through one adapter; a batch is one store's transaction, so it stays in one.
 */
export function routeByEntity(storedEntities: ReadonlySet<string>, stored: PersistenceAdapter, other: PersistenceAdapter): PersistenceAdapter {
  const of = (entityType: string): PersistenceAdapter => (storedEntities.has(entityType) ? stored : other);
  return {
    create: (entityType, data) => of(entityType).create(entityType, data),
    update: (entityType, id, data) => of(entityType).update(entityType, id, data),
    delete: (entityType, id) => of(entityType).delete(entityType, id),
    getById: (entityType, id) => of(entityType).getById(entityType, id),
    list: (entityType) => of(entityType).list(entityType),
    bindCollection: (entityType, collection) => of(entityType).bindCollection?.(entityType, collection),
    queryPage: (entityType: string, query: RowQuery): Promise<RowQueryPage> =>
      pushedDown(of(entityType).queryPage, 'queryPage', entityType).call(of(entityType), entityType, query),
    queryIds: (entityType: string, query: RowQuery): Promise<RowIdPage> =>
      pushedDown(of(entityType).queryIds, 'queryIds', entityType).call(of(entityType), entityType, query),
    queryCapabilities: (entityType: string): QueryCapabilities =>
      pushedDown(of(entityType).queryCapabilities, 'queryCapabilities', entityType).call(of(entityType), entityType),
    writeCapabilities: (entityType: string): WriteCapabilities =>
      pushedDown(of(entityType).writeCapabilities, 'writeCapabilities', entityType).call(of(entityType), entityType),
    writeWhere: (op: RowWriteOp): Promise<RowWriteOutcome> => pushedDown(of(op.entityType).writeWhere, 'writeWhere', op.entityType).call(of(op.entityType), op),
    writeBatch: async (batch: RowWriteBatch): Promise<RowWriteOutcome[]> => {
      const homes = new Set(batch.ops.map((op) => of(op.entityType)));
      if (homes.size > 1) throw new Error('A batch spans the browser store and the in-memory rows; a batch runs in one store');
      const [home] = homes;
      if (home === undefined) return [];
      return pushedDown(home.writeBatch, 'writeBatch', batch.ops[0]?.entityType ?? '').call(home, batch);
    },
  };
}
