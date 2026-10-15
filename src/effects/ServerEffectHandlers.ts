/**
 * ServerEffectHandlers — reusable factory for the server-side effect layer.
 *
 * Mirrors the handlers built inline in
 * `OrbitalServerRuntime.executeEffects` so both the real server runtime
 * AND the in-browser mock runtime (`@almadar/ui` OrbPreview autoMock) can
 * share the same `fetch` / `persist` / `set` / `ref` / `deref` / `swap` /
 * `atomic` / `callService` semantics against a `PersistenceAdapter`.
 *
 * Browser-safe: only imports core + this package's browser-safe modules.
 * Does NOT import express/Node, so it is reachable from `@almadar/ui`.
 *
 * @packageDocumentation
 */

import { orderFetchedRows } from './fetch-order.js';
import { PushdownViolation, compensateBatch, hasOwnId, noteFallback, type AppliedBatchOp, type WritePlan } from '@almadar/db/pushdown';
import { pushPersistBatch, planWrite, pushFetch, pushFetchRowSet, settleWrite } from './pushdown.js';
import type { EntityAccessPolicies, EventPayload, SExpr, ServiceParams, RuntimeValue } from "@almadar/core";
import { isPersistBatchOperation } from "@almadar/core";
// Single upstream owner (`@almadar/core`'s `types/effect-result.ts`) —
// promoted from this file (the JS interpreter's own definition, canonical
// per CLAUDE.md's "converge on the TypeScript implementation" ruling).
// Re-exported here so every existing importer keeps working unchanged.
import type { ClientEffectByTrait, ServerBatchSummary, ServerEffectResult } from "@almadar/core";
export type { ServerBatchSummary, ServerEffectResult } from "@almadar/core";
import type { PersistenceAdapter, RowSetRef, RowWriteOp, RowWriteOutcome } from '@almadar/core';
// Type-only — erased before runtime (isolatedModules), so this does not pull
// OrbitalServerRuntime's Express/Node code into this browser-safe module.
// Mirrors the identical reverse edge OrbitalServerRuntime.ts already has
// (`import type { ServerEffectResult } from "./ServerEffectHandlers.js"`).
import type { ClientEffectTuple } from "../server/OrbitalServerRuntime.js";
import {
  applyRowAccess,
  checkMutationAccess,
  accessDeniedMessage,
  type AccessBindings,
} from "@almadar/evaluator/entityAccess";
import type {
  EffectHandlers,
  BindingContext,
  EffectContext,
  EntityRow,
  PersistBatchSummary,
  ServiceCallContext,
} from "../types.js";
import { EffectExecutor } from "./EffectExecutor.js";
import type { InFlightCalls } from "./in-flight-calls.js";
import { createContextFromBindings } from "../evaluation/BindingResolver.js";
import { evaluate } from "@almadar/evaluator";
import { defaultCallService } from './defaultCallService.js';
import { codeOf, duplicateIdFailure, noRowKeyFailure, notFoundFailure } from './persist-failure.js';
import { createLogger } from '@almadar/logger';

/** FATAL: re-measured and gated clean — a persist that resolves no row key
 *  now fails the write instead of silently no-opping it. */
const NO_ROW_KEY_IS_FATAL = true;

const effectLog = createLogger("almadar:runtime:effects");

/**
 * Minimal event-bus contract the server handlers need. Narrower than the
 * full `IEventBus` so clients with a React-context bus (only `emit` is
 * relevant for effect dispatch) can hand it in without adapter code.
 */
export interface ServerEffectEventBus {
  emit(
    event: string,
    payload?: EventPayload,
    source?: { orbital?: string; trait?: string },
  ): void;
}

// `ServerBatchSummary` / `ServerEffectResult` are owned by `@almadar/core`
// (re-exported above).

export interface CreateServerEffectHandlersOptions {
  /** Persistent store backing `fetch` / `persist` / `ref` / `deref` / `swap`. */
  persistence: PersistenceAdapter;
  /** Event bus that `emit` delegates to. Only `.emit()` is required. */
  eventBus: ServerEffectEventBus;
  /** The trait's linked entity type (used as the default for persist/set). */
  entityType: string;
  /** Current entity row id (used by `set`, `persist update/delete` fallback). */
  entityId?: string;
  /**
   * Binding object passed to inner `atomic` evaluator. When absent, atomic
   * effects still run but have no access to `@entity` / `@payload` bindings.
   */
  bindings?: BindingContext;
  /** Effect context passed to the inner `atomic` executor. */
  context?: EffectContext;
  /** Per-event result sink. Optional — telemetry only. */
  effectResults?: ServerEffectResult[];
  /**
   * Per-event fetched-data cache. `fetch` writes here so downstream UI
   * renderers can resolve `@entity` bindings from the latest load without
   * a separate round-trip.
   */
  fetchedData?: Record<string, EntityRow[]>;
  /** Per-event pages fetched by reference (`deliver: ids`), by entity type. */
  fetchedRefs?: Record<string, RowSetRef>;
  /** Per-event emit log. Optional — telemetry only. */
  emittedEvents?: Array<{ event: string; payload?: EventPayload }>;
  /**
   * Per-event `render-ui`/`navigate`/`navigate-back` capture sinks. When
   * supplied, `renderUI`/`navigate`/`navigateBack` handlers are wired to
   * push into them (wire-format-identical to `OrbitalServerRuntime`'s own
   * `pushClientEffect`) instead of the default no-op — a caller that needs
   * to hand these effects back to a remote client (e.g. an HTTP response)
   * supplies both; a caller that doesn't (offline preview) leaves them
   * unset and gets today's `EffectExecutor.logUnsupported` no-op exactly
   * as before.
   */
  clientEffects?: ClientEffectTuple[];
  /** Same effects as `clientEffects`, tagged per originating trait — see `context.traitName`. */
  clientEffectsByTrait?: ClientEffectByTrait[];
  /** Source stamp applied to all emits. */
  source?: { orbital?: string; trait?: string };
  /** Consumer-supplied `call-service` handler. When absent, calls warn and return null. */
  callService?: (
    service: string,
    action: string,
    params?: ServiceParams,
    context?: ServiceCallContext,
  ) => Promise<EventPayload | null>;
  /**
   * The declared `@read`/`@create`/`@update`/`@delete` directives, keyed by
   * entity name. Build it with `entityAccessTable(schema)` from `@almadar/core`.
   *
   * Optional: a caller that holds no schema (the client offline-preview path)
   * passes nothing and gets today's unrestricted behavior. A preview is not a
   * security boundary — the generated server is, and that one always has the
   * policies compiled in.
   */
  entityAccess?: ReadonlyMap<string, EntityAccessPolicies>;
  /** The running app's in-flight call registry (`cancel-call`). */
  inFlightCalls?: InFlightCalls;
  /** Verbose logging. */
  debug?: boolean;
}

/**
 * Build the full server-side effect handler set bound to a persistence
 * adapter. The returned object satisfies `EffectHandlers` and can be
 * handed directly to `EffectExecutor`.
 *
 * Scope: one handler object per transition — capture `entityId`,
 * `bindings`, `context`, and the sink arrays at build time. For a new
 * transition, call this factory again.
 *
 * `renderUI` / `navigate` / `navigateBack` ARE implemented, but only
 * capture into the `clientEffects`/`clientEffectsByTrait` sinks (mirroring
 * `OrbitalServerRuntime`'s own `pushClientEffect` wire format exactly) —
 * they never actually render/navigate here. A caller with no use for these
 * effects (e.g. the client offline-preview path, which still prefers its
 * own `createClientEffectHandlers` for REAL rendering) simply omits the
 * sinks and gets `EffectExecutor`'s default no-op, unchanged from before.
 *
 * Intentionally does NOT implement:
 * - `os/watch-*` observers — these are a no-op outside the server.
 * - Schema-aware relation cardinality / on-delete cascades — those live
 *   in `OrbitalServerRuntime` and depend on the full registered schema.
 *   Clients that need them can wrap the persist handler with their own
 *   validation.
 */
export function createServerEffectHandlers(
  opts: CreateServerEffectHandlersOptions,
): EffectHandlers {
  const {
    persistence,
    eventBus,
    entityType,
    entityId,
    bindings,
    context,
    effectResults,
    fetchedData,
    fetchedRefs,
    emittedEvents,
    clientEffects,
    clientEffectsByTrait,
    source,
    callService: consumerCallService,
    entityAccess,
    debug,
  } = opts;

  const pushClientEffect = (effect: ClientEffectTuple): void => {
    clientEffects?.push(effect);
    clientEffectsByTrait?.push({ traitName: context?.traitName ?? "", effect });
  };

  /**
   * Bindings every access check evaluates against. `config` is load-bearing:
   * dropping it made every `@config.*`-guarded filter fail closed and empty
   * the list (R-ENTITY-ACCESS-CONFIG-DROPPED-IN-ROW-CTX).
   */
  const accessBindings = (forEntityType: string): AccessBindings => ({
    user: bindings?.user,
    payload: bindings?.payload,
    config: bindings?.config,
    onPredicateError: (err) => {
      effectLog.error('access-predicate-eval-error', {
        entityType: forEntityType,
        error: err instanceof Error ? err : String(err),
      });
    },
  });

  const record = (entry: ServerEffectResult): void => {
    effectResults?.push(entry);
  };

  const handlers: EffectHandlers = {
    emit: (event, eventPayload, emitSource) => {
      if (debug) {
        effectLog.debug('emit', {
          event,
          payloadKeys: eventPayload ? Object.keys(eventPayload).join(',') : '',
        });
      }
      const stamp = emitSource ?? source;
      eventBus.emit(event, eventPayload, stamp);
      emittedEvents?.push({ event, payload: eventPayload });
      effectLog.debug("emit:push", {
        event,
        cumulativeEmittedCount: emittedEvents?.length,
        sourceTrait: stamp?.trait,
        sourceOrbital: stamp?.orbital,
        emittedEventsBound: emittedEvents !== undefined,
      });
    },

    set: async (targetId, field, value) => {
      const id = targetId || entityId;
      if (!id) return;
      try {
        await persistence.update(entityType, id, { [field]: value } as EntityRow);
        record({
          effect: "set",
          entityType,
          data: { id, field, value },
          success: true,
        });
      } catch (err) {
        record({
          effect: "set",
          entityType,
          data: { id, field, value },
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    persist: async (action, targetEntityType, data) => {
      if (action === "batch") {
        const operations = data?.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          record({
            effect: "persist",
            action: "batch",
            success: false,
            error: "Batch requires a non-empty operations array",
          });
          return;
        }
        const pushedBatch = await pushPersistBatch(persistence, operations, () => [], record);
        if (pushedBatch !== null) return pushedBatch;
        const batchResults: EntityRow[] = [];
        const completed: Array<{ action: string; entityType: string; id?: string }> = [];
        const applied: AppliedBatchOp[] = [];
        let batchFailed = false;
        let batchError = "";
        const ops: readonly RuntimeValue[] = operations;
        for (const op of ops) {
          if (!isPersistBatchOperation(op)) {
            batchFailed = true;
            batchError = `Invalid batch operation format: ${JSON.stringify(op)}`;
            break;
          }
          const opAction = op[0];
          const opEntityType = op[1];
          try {
            switch (op[0]) {
              case "create": {
                const createData = op[2] ?? {};
                if (hasOwnId(createData) && (await persistence.getById(opEntityType, String(createData.id))) !== null) {
                  throw new Error(`${opEntityType} ${String(createData.id)} already exists`);
                }
                const { id: newId } = await persistence.create(
                  opEntityType,
                  createData,
                );
                batchResults.push({
                  ...createData,
                  action: "create",
                  entityType: opEntityType,
                  id: newId,
                });
                completed.push({
                  action: "create",
                  entityType: opEntityType,
                  id: newId,
                });
                applied.push({ kind: "create", entityType: opEntityType, id: newId });
                break;
              }
              case "update": {
                const updateId = op[2];
                const updateData = op[3] ?? {};
                const updateBefore = await persistence.getById(opEntityType, updateId);
                if (updateBefore === null) throw notFoundFailure(opEntityType, updateId);
                await persistence.update(opEntityType, updateId, updateData);
                const updated = await persistence.getById(opEntityType, updateId);
                applied.push({ kind: "update", entityType: opEntityType, id: updateId, before: { ...updateBefore }, after: updated });
                batchResults.push({
                  ...(updated || updateData),
                  action: "update",
                  entityType: opEntityType,
                  id: updateId,
                });
                completed.push({
                  action: "update",
                  entityType: opEntityType,
                  id: updateId,
                });
                break;
              }
              case "delete": {
                const deleteId = op[2];
                const deleteBefore = await persistence.getById(opEntityType, deleteId);
                await persistence.delete(opEntityType, deleteId);
                applied.push({ kind: "delete", entityType: opEntityType, id: deleteId, before: deleteBefore ? { ...deleteBefore } : null });
                batchResults.push({
                  action: "delete",
                  entityType: opEntityType,
                  id: deleteId,
                  deleted: true,
                });
                completed.push({
                  action: "delete",
                  entityType: opEntityType,
                  id: deleteId,
                });
                break;
              }
              default:
                batchFailed = true;
                batchError = `Unknown batch operation action: ${opAction}`;
                break;
            }
          } catch (err) {
            batchFailed = true;
            batchError = `Batch operation [${opAction}, ${opEntityType}] failed: ${
              err instanceof Error ? err.message : String(err)
            }`;
            break;
          }
          if (batchFailed) break;
        }
        if (batchFailed && applied.length > 0) {
          await compensateBatch(persistence, applied);
          batchResults.length = 0;
          completed.length = 0;
        }
        const batchSummary: PersistBatchSummary = {
          operations: batchResults,
          completedCount: completed.length,
          totalCount: operations.length,
        };
        record({
          effect: "persist",
          action: "batch",
          data: batchSummary,
          success: !batchFailed,
          ...(batchFailed ? { error: batchError } : {}),
        });
        // Return the summary rather than dropping it: it is the shape
        // `canonical-operators.json` declares for persist's batch branch, and
        // the caller's `emit:{success}` envelope had been emitting the raw
        // INPUT array instead, so `?completedCount` / `?totalCount` read
        // undefined at runtime.
        return batchSummary;
      }

      const type = targetEntityType || entityType;
      let resultData: EntityRow | undefined;
      const mutationPolicy = entityAccess?.get(type)?.[action === 'upsert' ? 'create' : action];
      // This handler set enforces no on-delete rules, so a delete is pushable like an update. A create or upsert has no
      // pre-image to guard: its `@create` directive is checked on the incoming row, so the plan carries no policy.
      const writesRow = action === 'create' || action === 'upsert';
      const incoming: EntityRow = typeof data === 'object' && data !== null ? data : {};
      const mintsId = action === 'create' && !hasOwnId(incoming);
      if (mintsId) noteFallback(persistence, 'kernel.write.pushdown-fallback', type, 'create-mints-id');
      const plan: WritePlan = mintsId ? { push: false } : planWrite(persistence, type, writesRow ? undefined : mutationPolicy, accessBindings(type), new Set<string>());
      const sizeBefore = plan.push ? 0 : (await persistence.list(type)).length;
      // Distinguishes a policy/row-key REJECTION from any other thrown
      // failure — see OrbitalServerRuntime's persist handler (same shape).
      let deniedReason: 'access-denied' | 'no-row-key' | undefined;
      try {
        const settle = (outcome: RowWriteOutcome, write: RowWriteOp): EntityRow =>
          settleWrite(outcome, write, plan.push ? plan.guard : undefined, () => { deniedReason = 'access-denied'; });
        switch (action) {
          case "create": {
            // `@create` is checked against the INCOMING data — no row exists yet.
            if (!checkMutationAccess((data ?? {}) as EntityRow, mutationPolicy, accessBindings(type))) {
              deniedReason = 'access-denied';
              throw new Error(accessDeniedMessage("create", type));
            }
            if (plan.push) {
              const write: RowWriteOp = { kind: 'create', entityType: type, data: incoming };
              resultData = settle(await persistence.writeWhere!(write), write);
              break;
            }
            if (hasOwnId(incoming) && (await persistence.getById(type, String(incoming.id))) !== null) throw duplicateIdFailure(type, String(incoming.id));
            const { id } = await persistence.create(type, incoming);
            resultData = { ...incoming, id };
            break;
          }
          case "upsert": {
            // `@create` is checked on the incoming row, and `@update` (when declared) on the row it replaces.
            if (!checkMutationAccess(incoming, mutationPolicy, accessBindings(type))) {
              deniedReason = 'access-denied';
              throw new Error(accessDeniedMessage("create", type));
            }
            if (!hasOwnId(incoming)) {
              effectLog.error('persist:no-row-key', { action, entityType: type });
              deniedReason = 'no-row-key';
              throw noRowKeyFailure(action, type);
            }
            const upsertId = String(incoming.id);
            const updatePolicy = entityAccess?.get(type)?.update;
            let existing: EntityRow | null | undefined;
            if (updatePolicy !== undefined) {
              existing = await persistence.getById(type, upsertId);
              if (existing !== null && !checkMutationAccess(existing, updatePolicy, accessBindings(type))) {
                deniedReason = 'access-denied';
                throw new Error(accessDeniedMessage("update", type));
              }
            }
            if (plan.push) {
              const write: RowWriteOp = { kind: 'upsert', entityType: type, data: incoming };
              resultData = settle(await persistence.writeWhere!(write), write);
              break;
            }
            existing ??= await persistence.getById(type, upsertId);
            if (existing === null) {
              await persistence.create(type, incoming);
            } else {
              await persistence.delete(type, upsertId);
              await persistence.create(type, existing.createdAt === undefined ? incoming : { ...incoming, createdAt: existing.createdAt });
            }
            resultData = (await persistence.getById(type, upsertId)) ?? incoming;
            break;
          }
          case "update": {
            const row = (data ?? {}) as EntityRow;
            const idOrFallback = (row.id as string | undefined) ?? entityId;
            if (idOrFallback && plan.push) {
              const write: RowWriteOp = { kind: 'update', entityType: type, id: idOrFallback, data: row, ...(plan.guard ? { guard: plan.guard } : {}) };
              resultData = settle(await persistence.writeWhere!(write), write);
            } else if (idOrFallback) {
              // The row is read fresh before the write: absent is `not-found`, and
              // `@update` is checked against the EXISTING row — the incoming patch is
              // what the caller wants, not what they may touch.
              const existing = await persistence.getById(type, idOrFallback);
              if (existing === null) throw notFoundFailure(type, idOrFallback);
              if (mutationPolicy !== undefined && !checkMutationAccess(existing, mutationPolicy, accessBindings(type))) {
                deniedReason = 'access-denied';
                throw new Error(accessDeniedMessage("update", type));
              }
              await persistence.update(type, idOrFallback, row);
              const updated = await persistence.getById(type, idOrFallback);
              resultData = updated ?? { ...row, id: idOrFallback };
            } else {
              // See OrbitalServerRuntime's persist handler: no row key is a
              // failed write, not a silent success.
              effectLog.error('persist:no-row-key', { action, entityType: type });
              if (NO_ROW_KEY_IS_FATAL) {
                deniedReason = 'no-row-key';
                throw noRowKeyFailure(action, type);
              }
            }
            break;
          }
          case "delete": {
            const directId = typeof data === "string" ? data : undefined;
            const nestedId =
              typeof data === "object" && data !== null
                ? ((data as { id?: string }).id)
                : undefined;
            const deleteId = directId ?? nestedId ?? entityId;
            if (deleteId && plan.push) {
              const write: RowWriteOp = { kind: 'delete', entityType: type, id: deleteId, ...(plan.guard ? { guard: plan.guard } : {}) };
              resultData = settle(await persistence.writeWhere!(write), write);
            } else if (deleteId) {
              const existing = await persistence.getById(type, deleteId);
              if (existing === null) throw notFoundFailure(type, deleteId);
              if (mutationPolicy !== undefined && !checkMutationAccess(existing, mutationPolicy, accessBindings(type))) {
                deniedReason = 'access-denied';
                throw new Error(accessDeniedMessage("delete", type));
              }
              await persistence.delete(type, deleteId);
              resultData = { id: deleteId, deleted: true } as EntityRow;
            } else {
              // No row key is a failed write, not a silent success.
              effectLog.error('persist:no-row-key', { action, entityType: type });
              if (NO_ROW_KEY_IS_FATAL) {
                deniedReason = 'no-row-key';
                throw noRowKeyFailure(action, type);
              }
            }
            break;
          }
        }

        // `NO_ROW_KEY_IS_FATAL === false` falls through the update/delete
        // else-branches above without setting `resultData` or throwing —
        // that is a write that never happened, not a success.
        if (resultData === undefined && (action === 'update' || action === 'delete')) {
          record({
            effect: 'persist',
            action,
            entityType: type,
            success: false,
            denied: true,
            code: 'no-row-key',
            error: `persist ${action} ${type} resolved no row key`,
          });
          return undefined;
        }

        if (plan.push) {
          effectLog.debug("persist:store-mutate", { action, entityType: type, resultId: resultData?.id as string | undefined });
        } else {
          const sizeAfter = (await persistence.list(type)).length;
          effectLog.debug("persist:store-mutate", {
            action,
            entityType: type,
            resultId: resultData?.id as string | undefined,
            sizeBefore,
            sizeAfter,
            delta: sizeAfter - sizeBefore,
          });
        }
        record({
          effect: "persist",
          action,
          entityType: type,
          data: resultData,
          success: true,
        });
        return resultData;
      } catch (err) {
        effectLog.error("persist:store-mutate-error", {
          action,
          entityType: type,
          error: err instanceof Error ? err.message : String(err),
        });
        record({
          effect: "persist",
          action,
          entityType: type,
          ...(deniedReason !== undefined ? { denied: true as const } : {}),
          ...codeOf(err),
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return undefined;
    },

    callService: async (service, action, params, callerContext) => {
      try {
        let result: EventPayload | null = null;
        const signal = callerContext?.signal;
        const identity = (): ServiceCallContext | undefined => {
          const viewer = bindings?.user;
          return viewer || signal
            ? { ...(viewer ? { principal: viewer.id, role: viewer.role } : {}), ...(signal ? { signal } : {}) }
            : undefined;
        };
        if (consumerCallService) {
          result = await consumerCallService(service, action, params, identity());
        } else {
          // No host handler: the same @almadar/integrations provider compiled
          // apps use, configured from the env (a missing key is a named failure).
          result = await defaultCallService(service, action, params, identity());
        }
        record({
          effect: "call-service",
          action: `${service}.${action}`,
          data: result,
          success: true,
        });
        return result;
      } catch (err) {
        record({
          effect: "call-service",
          action: `${service}.${action}`,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        // The executor routes a throw to the declared `emit.failure`.
        throw err;
      }
    },

    fetchRowSet: async (fetchEntityType, options) => {
      const reference = await pushFetchRowSet({
        persistence,
        entityType: fetchEntityType,
        readPolicy: entityAccess?.get(fetchEntityType)?.read,
        filter: options?.filter as SExpr | undefined,
        orderBy: options?.orderBy,
        offset: options?.offset,
        limit: options?.limit,
        ...(options?.total !== undefined ? { total: options.total } : {}),
        bindings: accessBindings(fetchEntityType),
        requiredFields: new Set<string>(),
      });
      if (fetchedRefs) fetchedRefs[fetchEntityType] = reference;
      return reference;
    },

    fetch: async (fetchEntityType, options) => {
      try {
        let result: EntityRow | EntityRow[] | null = null;
        let total = 0;
        if (options?.id) {
          const entity = await persistence.getById(fetchEntityType, options.id);
          // Fetching by id is still a read: the policy applies, the call-site
          // `filter:` does not (there is nothing to narrow). Same split as
          // OrbitalServerRuntime.
          const visible = entity
            ? applyRowAccess(
                [entity],
                entityAccess?.get(fetchEntityType)?.read,
                undefined,
                accessBindings(fetchEntityType),
              )
            : [];
          if (visible.length > 0) {
            if (fetchedData) fetchedData[fetchEntityType] = visible;
            result = visible[0] ?? null;
            total = 1;
          }
        } else {
          const readPolicy = entityAccess?.get(fetchEntityType)?.read;
          const callSiteFilter = options?.filter as SExpr | undefined;
          const pushed = await pushFetch({
            persistence,
            entityType: fetchEntityType,
            readPolicy,
            filter: callSiteFilter,
            orderBy: options?.orderBy,
            offset: options?.offset,
            limit: options?.limit,
        ...(options?.total !== undefined ? { total: options.total } : {}),
            bindings: accessBindings(fetchEntityType),
            requiredFields: new Set<string>(),
          });
          let entities: EntityRow[];
          if (pushed !== null) {
            entities = pushed.rows;
            total = pushed.total;
          } else {
            entities = await persistence.list(fetchEntityType);
            // The declared `@read` directive AND the call-site `filter:`, through
            // the one evaluator OrbitalServerRuntime uses — a second inline copy
            // here is how this path silently diverged before.
            entities = applyRowAccess(entities, readPolicy, callSiteFilter, accessBindings(fetchEntityType));
            // Capture total AFTER filter, BEFORE offset/limit so paginating
            // consumers receive the count of rows matching the filter.
            total = entities.length;
            entities = orderFetchedRows(entities, options?.orderBy);
            if (options?.offset && options.offset > 0) {
              entities = entities.slice(options.offset);
            }
            if (options?.limit && options.limit > 0) {
              entities = entities.slice(0, options.limit);
            }
          }
          if (fetchedData) fetchedData[fetchEntityType] = entities;
          result = entities;
        }
        return result === null ? null : { rows: result, total };
      } catch (err) {
        effectLog.error('fetch-error', {
          entityType: fetchEntityType,
          error: err instanceof Error ? err : String(err),
        });
        if (err instanceof PushdownViolation) throw err;
        return null;
      }
    },

    fetchStream: async (streamEntityType, options, onChunk) => {
      // Default implementation: load all rows and call onChunk per row.
      // Real streaming (SSE/LLM) is wired by the server runtime via the
      // streaming SSE endpoint added in B2. This fallback keeps orbital-verify
      // and test environments working without a live SSE transport.
      try {
        const rows = await persistence.list(streamEntityType);
        // A stream is a read: the `@read` directive scopes it like any other.
        const visible = applyRowAccess(
          rows,
          entityAccess?.get(streamEntityType)?.read,
          undefined,
          accessBindings(streamEntityType),
        );
        const matched = options?.id
          ? visible.filter(r => r['id'] === options.id)
          : visible;
        for (const row of matched) {
          onChunk(row);
        }
        return matched;
      } catch (err) {
        effectLog.error('fetch-stream-error', {
          entityType: streamEntityType,
          error: err instanceof Error ? err : String(err),
        });
        return null;
      }
    },

    ref: async (refEntityType, options) => {
      // `ref` = `fetch` for mock/dev runtimes; real server uses the same
      // underlying persistence read, the difference (reactive subscription
      // vs one-shot) is a render-layer concern.
      return handlers.fetch!(refEntityType, options);
    },

    deref: async (derefEntityType, options) => {
      try {
        let result: EntityRow | EntityRow[] | null = null;
        let total = 0;
        if (options?.id) {
          const entity = await persistence.getById(derefEntityType, options.id);
          if (entity) {
            if (fetchedData) fetchedData[derefEntityType] = [entity];
            result = entity;
            total = 1;
          }
        } else {
          const entities = await persistence.list(derefEntityType);
          if (fetchedData) fetchedData[derefEntityType] = entities;
          result = entities;
          total = entities.length;
        }
        record({
          effect: "deref",
          entityType: derefEntityType,
          success: true,
        });
        return result === null ? null : { rows: result, total };
      } catch (err) {
        record({
          effect: "deref",
          entityType: derefEntityType,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    swap: async (swapEntityType, swapEntityId, transform) => {
      try {
        const current = await persistence.getById(swapEntityType, swapEntityId);
        if (!current) {
          record({
            effect: "swap",
            entityType: swapEntityType,
            success: false,
            error: `Entity ${swapEntityType}/${swapEntityId} not found`,
          });
          return null;
        }
        const ctx = createContextFromBindings(
          { current, entity: bindings?.entity, payload: bindings?.payload },
          false,
        );
        let newData: EntityRow;
        if (Array.isArray(transform)) {
          const evalResult = evaluate(transform as SExpr, ctx);
          if (
            evalResult &&
            typeof evalResult === "object" &&
            !Array.isArray(evalResult)
          ) {
            newData = evalResult as EntityRow;
          } else {
            newData = current;
          }
        } else if (typeof transform === "object" && transform !== null) {
          newData = { ...current, ...transform };
        } else {
          record({
            effect: "swap",
            entityType: swapEntityType,
            success: false,
            error: "swap transform must be an S-expression or object",
          });
          return null;
        }
        await persistence.update(swapEntityType, swapEntityId, newData);
        record({
          effect: "swap",
          entityType: swapEntityType,
          data: { id: swapEntityId, ...newData },
          success: true,
        });
        return newData;
      } catch (err) {
        record({
          effect: "swap",
          entityType: swapEntityType,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    watch: (_watchEntityType: string) => {
      // watch is a server-only reactive subscription. In the browser mock
      // runtime there is no long-lived observation — every render already
      // re-reads the persistence snapshot, so this is a no-op.
    },

    atomic: async (atomicEffects) => {
      const atomicExecutor = new EffectExecutor({
        handlers,
        bindings: bindings ?? ({} as BindingContext),
        context:
          context ?? ({
            traitName: "atomic",
            state: "unknown",
            transition: "unknown",
          } as EffectContext),
        inFlightCalls: opts.inFlightCalls,
      });
      try {
        await atomicExecutor.executeAll(atomicEffects as RuntimeValue[]);
        record({ effect: "atomic", success: true });
      } catch (err) {
        record({
          effect: "atomic",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    renderUI: (slot, pattern, props, priority) => {
      pushClientEffect(["render-ui", slot, pattern, props ?? null, priority ?? null]);
    },

    navigate: (path, params, crumb) => {
      if (crumb !== undefined) {
        pushClientEffect(["navigate", path, params ?? null, { crumb }]);
      } else {
        pushClientEffect(["navigate", path, params ?? null]);
      }
    },

    navigateBack: () => {
      pushClientEffect(["navigate-back"]);
    },
  };

  return handlers;
}
