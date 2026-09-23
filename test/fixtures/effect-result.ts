import type { ServerEffectResult } from '../../src/effects/ServerEffectHandlers.js';
import type { EntityRow } from '@almadar/core';

/** `ServerEffectResult.data` is `EntityRow | batch summary | raw service
 *  result`; every non-batch persist/set result really is a row. The batch
 *  summary (`operations`/`completedCount`/`totalCount`) only appears for
 *  `action: 'batch'`, the raw value only for `call-service`/`substrate`. */
function isEntityRow(data: ServerEffectResult['data']): data is EntityRow {
    return (
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        !(data instanceof Date) &&
        !('operations' in data) &&
        'id' in data &&
        typeof data.id === 'string'
    );
}

export function asEntityRow(data: ServerEffectResult['data']): EntityRow {
    if (!isEntityRow(data)) {
        throw new Error('expected ServerEffectResult.data to be an EntityRow, got a batch summary, a service result or undefined');
    }
    return data;
}
