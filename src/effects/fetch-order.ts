import type { EntityRow } from '@almadar/core';
import { sortRows } from '@almadar/db/rows';

/** A fetch's `orderBy` (`"field"` or `"field:asc|desc"`), the compiled path's rule: ascending unless `desc`, missing values last. */
export function orderFetchedRows(rows: EntityRow[], orderBy: string | undefined): EntityRow[] {
  if (typeof orderBy !== 'string' || orderBy === '') return rows;
  const [field, direction] = orderBy.split(':');
  return sortRows(rows, field, direction === 'desc' ? 'desc' : 'asc');
}
