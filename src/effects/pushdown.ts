/**
 * The JS engine's side of store push-down (docs/Almadar_Embedded_Kernel.md D-A46). The driver itself — which fetch
 * becomes one `queryPage`, which persist one `writeWhere`/`writeBatch`, the fallback notices — is
 * `@almadar/db/pushdown`, shared with every compiled server. This module injects the interpreter into it
 * (`rowAccess` from `@almadar/evaluator/entityAccess`) and turns the driver's outcomes into this engine's results and
 * failures.
 */
import { isPersistBatchOperation, omitFrameFields, type EntityRow, type PersistenceAdapter, type RowQueryPage, type RowSetRef, type RowWriteOp, type RowWriteOutcome, type RuntimeValue, type ServerEffectResult, type SExpr } from '@almadar/core';
import {
  PushdownViolation,
  hasOwnId,
  noteFallback,
  planWrite as planDriverWrite,
  pushFetch as pushDriverFetch,
  fetchRowSet as fetchDriverRowSet,
  compileFetchQuery,
  runBatch,
  settleOutcome,
  type BatchOp,
  type PushedPage,
  type RequiredFields,
  type WritePlan,
} from '@almadar/db/pushdown';
import { accessDeniedMessage, applyRowAccess, rowAccess, type AccessBindings } from '@almadar/evaluator/entityAccess';
import type { PersistBatchSummary } from '../types.js';
import { duplicateIdFailure, notFoundFailure } from './persist-failure.js';
import { resolveRowSetFromRows, resolveRowSetFromStore } from './row-set-resolve.js';

export interface FetchPushdownRequest {
  persistence: PersistenceAdapter;
  entityType: string;
  readPolicy: SExpr | undefined;
  filter: SExpr | undefined;
  orderBy: string | undefined;
  offset: number | undefined;
  limit: number | undefined;
  /** `none`: the store need not count every match; absent = exact. */
  total?: 'exact' | 'none';
  bindings: AccessBindings;
  /** Fields the entity declares required or with a default; ordering comparisons push down on these, or under a presence guard. */
  requiredFields: RequiredFields;
}

/** One `queryPage` for a collection fetch, or null when the caller must take the list path (the notice is logged). */
export function pushFetch(req: FetchPushdownRequest): Promise<PushedPage | null> {
  const { persistence, bindings, ...request } = req;
  return pushDriverFetch(persistence, { ...request, access: rowAccess(bindings) });
}

/** A collection fetch delivered by reference (`deliver: ids`); rejects when the fetch is not a row query. */
export function pushFetchRowSet(req: FetchPushdownRequest): Promise<RowSetRef> {
  const { persistence, bindings, ...request } = req;
  return fetchDriverRowSet(persistence, { ...request, access: rowAccess(bindings) });
}

/**
 * `ref` resolved against `persistence` for the viewer in `bindings` (the JS engine's `resolveRows`): the rows that still
 * match the reference's query and the viewer's `@read`, in the reference's order, a missing or hidden row omitted. A
 * store that can `queryPage` with a `@read` the row query expresses answers in one pushed read; any other store is
 * listed and the interpreter applies the policy, as a fetch does.
 */
export async function resolveRowSetFromPersistence(
  persistence: PersistenceAdapter,
  ref: RowSetRef,
  readPolicy: SExpr | undefined,
  bindings: AccessBindings,
  requiredFields: RequiredFields,
): Promise<RowQueryPage> {
  const compiled = compileFetchQuery({
    entityType: ref.entityType,
    readPolicy,
    filter: undefined,
    orderBy: undefined,
    offset: undefined,
    limit: undefined,
    requiredFields,
    access: rowAccess(bindings),
  });
  if (compiled.kind === 'query' && persistence.queryPage) {
    return resolveRowSetFromStore({ queryPage: persistence.queryPage.bind(persistence) }, ref, compiled.policy);
  }
  const readable = applyRowAccess(await persistence.list(ref.entityType), readPolicy, undefined, bindings);
  return resolveRowSetFromRows(readable, ref);
}

/** Whether a persist update/delete goes out as one guarded `writeWhere`; `policy` is the entity's `@update`/`@delete`. */
export function planWrite(persistence: PersistenceAdapter, entityType: string, policy: SExpr | undefined, bindings: AccessBindings, requiredFields: RequiredFields): WritePlan {
  return planDriverWrite(persistence, entityType, policy, rowAccess(bindings), requiredFields);
}

/**
 * A pushed write's outcome, as the per-op path would have ended: the row (or `{ id, deleted }`), or the failure it
 * throws. `onDenied` lets the caller mark the effect result `denied` before the throw.
 */
export function settleWrite(outcome: RowWriteOutcome, write: RowWriteOp, guard: Parameters<typeof settleOutcome>[2], onDenied: () => void): EntityRow {
  const settled = settleOutcome(outcome, write, guard);
  switch (settled.kind) {
    case 'row':
      return settled.row;
    case 'deleted':
      if (write.kind !== 'delete') throw new PushdownViolation(`persist ${write.kind} ${write.entityType}: the adapter answered deleted`);
      return { id: write.id, deleted: true };
    case 'not-found':
      throw notFoundFailure(write.entityType, write.kind === 'create' || write.kind === 'upsert' ? String(write.data.id ?? '') : write.id);
    case 'duplicate-id':
      throw duplicateIdFailure(write.entityType, write.kind === 'create' || write.kind === 'upsert' ? String(write.data.id ?? '') : write.id);
    case 'denied':
      onDenied();
      throw new Error(accessDeniedMessage(write.kind === 'delete' ? 'delete' : 'update', write.entityType));
    case 'failed':
      throw new Error(settled.message);
    case 'violation':
      throw new PushdownViolation(settled.message);
  }
}

/**
 * One atomic `writeBatch` for a whole `persist batch` when every entity's store declares it (ruling Q2); the summary the
 * per-op path would return, or null to take the per-op path. Records its own `ServerEffectResult`.
 */
export async function pushPersistBatch(
  persistence: PersistenceAdapter,
  operations: readonly RuntimeValue[],
  intrinsicFieldNames: (entityType: string) => string[],
  record: (result: ServerEffectResult) => void,
): Promise<PersistBatchSummary | null> {
  const ops: BatchOp[] = [];
  for (const op of operations) {
    if (!isPersistBatchOperation(op)) return null;
    const opType = op[1];
    const intrinsic = intrinsicFieldNames(opType);
    const strip = (row: EntityRow): EntityRow => (intrinsic.length > 0 ? omitFrameFields(row, intrinsic) : row);
    if (op[0] === 'create') {
      const row = strip(op[2] ?? {});
      if (!hasOwnId(row)) {
        noteFallback(persistence, 'kernel.write.pushdown-fallback', opType, 'create-mints-id');
        return null;
      }
      ops.push({ action: 'create', entity: opType, collection: opType, id: String(row.id), data: row });
    } else if (op[0] === 'update') ops.push({ action: 'update', entity: opType, collection: opType, id: op[2], data: strip(op[3] ?? {}) });
    else if (op[0] === 'delete') ops.push({ action: 'delete', entity: opType, collection: opType, id: op[2] });
    else return null;
  }
  const run = await runBatch(persistence, ops, rowAccess({}));
  if (run === null) return null;
  let error = '';
  if (run.kind === 'threw') {
    error = `Batch operation [${run.first.action}, ${run.first.entity}] failed: ${run.message}`;
  } else if (run.kind === 'failed') {
    const { at, failure } = run;
    const reason =
      failure.kind === 'no-outcome' ? 'the store answered no outcome'
      : failure.settled.kind === 'not-found' ? `${at.entity} ${at.id} not found`
      : failure.settled.kind === 'duplicate-id' ? `${at.entity} ${at.id} already exists`
      : failure.settled.kind === 'denied' ? 'refused'
      : failure.settled.message;
    error = `Batch operation [${at.action}, ${at.entity}] failed: ${reason}`;
  }
  const results = run.kind === 'done' ? run.done : [];
  const summary: PersistBatchSummary = { operations: results, completedCount: results.length, totalCount: ops.length };
  record({ effect: 'persist', action: 'batch', data: summary, success: error === '', ...(error !== '' ? { error } : {}) });
  return summary;
}
