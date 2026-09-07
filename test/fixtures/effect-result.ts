import type { ServerEffectResult } from '../../src/ServerEffectHandlers.js';
import type { EntityRow } from '@almadar/core';

/** Narrow an `ServerEffectResult.data` (`EntityRow | batch summary`) to the row
 *  branch — every non-batch persist/set effect result really is a row, the
 *  batch summary shape (`operations`/`completedCount`/`totalCount`) only
 *  appears for `action: 'batch'`. */
export function asEntityRow(data: ServerEffectResult['data']): EntityRow {
    if (data === undefined || data === null || 'operations' in data || typeof data.id !== 'string') {
        throw new Error('expected ServerEffectResult.data to be an EntityRow, got a batch summary, a service result or undefined');
    }
    return { ...data, id: data.id };
}
