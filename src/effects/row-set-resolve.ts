/**
 * The one resolve of a row-set reference against a store that can `queryPage` (Speed Design 5.4): the ids as a
 * `member` filter with the viewer's `@read` policy, re-checked by core's `resolveRowSet`, and `total` a true re-count
 * of the reference's query (a `total: none` reference is not re-counted: the total is the resolved window). Used by
 * the browser store's resolver (`@almadar/ui`) and by the JS server engine, so a store location has one path.
 *
 * @packageDocumentation
 */
import {
  resolveRowSet,
  type EntityRow,
  type PersistenceAdapter,
  type RowPredicate,
  type RowQuery,
  type RowQueryPage,
  type RowSetRef,
} from '@almadar/core';

export type RowSetStore = { queryPage: NonNullable<PersistenceAdapter['queryPage']> };

export async function resolveRowSetFromStore(store: RowSetStore, ref: RowSetRef, policy?: RowPredicate): Promise<RowQueryPage> {
  const withPolicy = (query: RowQuery): RowQuery => ({
    ...query,
    ...(policy === undefined ? {} : { policy: query.policy === undefined ? policy : ({ kind: 'all', of: [query.policy, policy] } as RowPredicate) }),
  });
  const ids: RowPredicate = { kind: 'member', field: 'id', values: ref.ids };
  const uncounted = ref.query.total === 'none';
  const byId = store.queryPage(ref.entityType, withPolicy({ filter: ids, total: 'none' }));
  const count = uncounted
    ? undefined
    : store.queryPage(
        ref.entityType,
        withPolicy({
          ...(ref.query.policy !== undefined ? { policy: ref.query.policy } : {}),
          ...(ref.query.filter !== undefined ? { filter: ref.query.filter } : {}),
          limit: 0,
          total: 'exact',
        }),
      );
  const [page, counted] = await Promise.all([byId, count]);
  const checked = resolveRowSet(page.rows, ref, policy);
  return { rows: checked.rows, total: counted === undefined ? checked.rows.length : counted.total };
}

/** `rows` (already readable by the viewer) resolved against `ref`: the interpreted twin of [`resolveRowSetFromStore`]. */
export function resolveRowSetFromRows(rows: readonly EntityRow[], ref: RowSetRef): RowQueryPage {
  const page = resolveRowSet(rows, ref);
  return ref.query.total === 'none' ? { rows: page.rows, total: page.rows.length } : page;
}
