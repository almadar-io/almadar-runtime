import { orderRows, parseFetchOrder, type EntityRow } from '@almadar/core';

/** A fetch's `orderBy` (`"field"` or `"field:asc|desc"`): ascending unless `desc`, missing values last, ties by `id` ascending. No `orderBy` means `createdAt` ascending, then `id` (EXEC-FETCH-1). */
export function orderFetchedRows(rows: EntityRow[], orderBy: string | undefined): EntityRow[] {
  return orderRows(rows, parseFetchOrder(orderBy));
}
