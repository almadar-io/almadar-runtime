/**
 * ServerEffectHandlers — reusable factory for the server-side effect layer.
 *
 * Mirrors the handlers built inline in
 * `OrbitalServerRuntime.executeEffects` so both the real server runtime
 * AND the in-browser mock runtime (`@almadar/ui` OrbPreview autoMock) can
 * share the same `fetch` / `persist` / `set` / `ref` / `deref` / `swap!` /
 * `atomic` / `callService` semantics against a `PersistenceAdapter`.
 *
 * Browser-safe: only imports core + this package's browser-safe modules.
 * Does NOT import express/Node, so it is reachable from `@almadar/ui`.
 *
 * @packageDocumentation
 */

import type { EventPayload, SExpr, ServiceParams } from "@almadar/core";
import type { PersistenceAdapter } from "./PersistenceAdapter.js";
import type {
  EffectHandlers,
  BindingContext,
  EffectContext,
  EntityRow,
} from "./types.js";
import { EffectExecutor } from "./EffectExecutor.js";
import { createContextFromBindings } from "./BindingResolver.js";
import { evaluate } from "@almadar/evaluator";
import { createLogger } from '@almadar/logger';

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

/**
 * Result entry recorded for each effect invocation. Mirrors the server
 * runtime's `EffectResult`. Callers who want telemetry pass an array that
 * the factory appends to; otherwise it's unused.
 */
export interface ServerEffectResult {
  effect:
    | "set"
    | "persist"
    | "call-service"
    | "fetch"
    | "ref"
    | "deref"
    | "swap"
    | "atomic";
  action?: string;
  entityType?: string;
  data?: unknown;
  success: boolean;
  error?: string;
}

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
  /** Per-event emit log. Optional — telemetry only. */
  emittedEvents?: Array<{ event: string; payload?: EventPayload }>;
  /** Source stamp applied to all emits. */
  source?: { orbital?: string; trait?: string };
  /** Consumer-supplied `call-service` handler. When absent, calls warn and return null. */
  callService?: (
    service: string,
    action: string,
    params?: ServiceParams,
  ) => Promise<EventPayload | null>;
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
 * Intentionally does NOT implement:
 * - `renderUI` / `notify` / `navigate` — these are client-side, provided
 *   by `createClientEffectHandlers`. A mock runtime merges both handler
 *   sets.
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
    emittedEvents,
    source,
    callService: consumerCallService,
    debug,
  } = opts;

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
        const operations = (data as { operations?: unknown[] } | undefined)?.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          record({
            effect: "persist",
            action: "batch",
            success: false,
            error: "Batch requires a non-empty operations array",
          });
          return;
        }
        const batchResults: unknown[] = [];
        const completed: unknown[] = [];
        let batchFailed = false;
        let batchError = "";
        for (const op of operations) {
          if (!Array.isArray(op) || op.length < 2) {
            batchFailed = true;
            batchError = `Invalid batch operation format: ${JSON.stringify(op)}`;
            break;
          }
          const [opAction, opEntityType, ...opRest] = op as [
            string,
            string,
            ...unknown[],
          ];
          try {
            switch (opAction) {
              case "create": {
                const createData = (opRest[0] as EntityRow) || ({} as EntityRow);
                const { id: newId } = await persistence.create(
                  opEntityType,
                  createData,
                );
                batchResults.push({
                  action: "create",
                  entityType: opEntityType,
                  id: newId,
                  ...createData,
                });
                completed.push({
                  action: "create",
                  entityType: opEntityType,
                  id: newId,
                });
                break;
              }
              case "update": {
                const updateId = opRest[0] as string;
                const updateData = (opRest[1] as EntityRow) || ({} as EntityRow);
                await persistence.update(opEntityType, updateId, updateData);
                const updated = await persistence.getById(opEntityType, updateId);
                batchResults.push({
                  action: "update",
                  entityType: opEntityType,
                  id: updateId,
                  ...(updated || updateData),
                });
                completed.push({
                  action: "update",
                  entityType: opEntityType,
                  id: updateId,
                });
                break;
              }
              case "delete": {
                const deleteId = opRest[0] as string;
                await persistence.delete(opEntityType, deleteId);
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
        record({
          effect: "persist",
          action: "batch",
          data: {
            operations: batchResults,
            completedCount: completed.length,
            totalCount: operations.length,
          },
          success: !batchFailed,
          ...(batchFailed ? { error: batchError } : {}),
        });
        return;
      }

      const type = targetEntityType || entityType;
      let resultData: EntityRow | undefined;
      const sizeBefore = (await persistence.list(type)).length;
      try {
        switch (action) {
          case "create": {
            const { id } = await persistence.create(type, (data ?? {}) as EntityRow);
            resultData = { id, ...((data ?? {}) as EntityRow) };
            break;
          }
          case "update": {
            const row = (data ?? {}) as EntityRow;
            const idOrFallback = (row.id as string | undefined) ?? entityId;
            if (idOrFallback) {
              await persistence.update(type, idOrFallback, row);
              const updated = await persistence.getById(type, idOrFallback);
              resultData = updated ?? { id: idOrFallback, ...row };
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
            if (deleteId) {
              await persistence.delete(type, deleteId);
              resultData = { id: deleteId, deleted: true } as EntityRow;
            }
            break;
          }
        }
        const sizeAfter = (await persistence.list(type)).length;
        effectLog.debug("persist:store-mutate", {
          action,
          entityType: type,
          resultId: resultData?.id as string | undefined,
          sizeBefore,
          sizeAfter,
          delta: sizeAfter - sizeBefore,
        });
        record({
          effect: "persist",
          action,
          entityType: type,
          data: resultData,
          success: true,
        });
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
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    callService: async (service, action, params) => {
      try {
        let result: EventPayload | null = null;
        if (consumerCallService) {
          result = await consumerCallService(service, action, params);
        } else {
          // Mock fallback: synthetic result satisfying common service-atom
          // emit shapes ({id, clientSecret, success, status, params-echo}).
          // Mirrors createClientEffectHandlers + OrbitalServerRuntime mock
          // mode so service-atom chains advance end-to-end in offline /
          // standalone-preview without explicit handler wiring.
          const mockId = `mock_${service}_${action}_${Math.random().toString(36).slice(2, 10)}`;
          const paramsEcho: Partial<EntityRow> = {};
          if (params && typeof params === "object") {
            for (const [k, v] of Object.entries(params as ServiceParams)) {
              if (
                v !== undefined &&
                (typeof v === "string" ||
                  typeof v === "number" ||
                  typeof v === "boolean" ||
                  v === null ||
                  v instanceof Date)
              ) {
                paramsEcho[k] = v;
              }
            }
          }
          result = {
            id: mockId,
            clientSecret: `secret_${mockId}`,
            success: true,
            status: "succeeded",
            ...paramsEcho,
          } as EntityRow;
          if (debug) {
            effectLog.warn('call-service-not-configured-using-mock', { service, action });
          }
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
        return null;
      }
    },

    fetch: async (fetchEntityType, options) => {
      try {
        effectLog.info("clientFetch:enter", () => ({
          entityType: fetchEntityType,
          hasOptions: options !== undefined && options !== null,
          optionsKeys: options ? Object.keys(options).join(',') : '',
          filterType: typeof options?.filter,
          filterIsArray: Array.isArray(options?.filter),
          filterJson: JSON.stringify(options?.filter ?? null).slice(0, 300),
          payloadJson: JSON.stringify(bindings?.payload ?? null).slice(0, 300),
        }));
        let result: EntityRow | EntityRow[] | null = null;
        let total = 0;
        if (options?.id) {
          const entity = await persistence.getById(fetchEntityType, options.id);
          if (entity) {
            if (fetchedData) fetchedData[fetchEntityType] = [entity];
            result = entity;
            total = 1;
          }
        } else {
          let entities = await persistence.list(fetchEntityType);
          if (options?.filter !== undefined && options.filter !== null) {
            const predicate = options.filter as SExpr;
            entities = entities.filter((entity) => {
              const ctx = createContextFromBindings(
                { entity, payload: bindings?.payload, current: entity },
                false,
              );
              try {
                return Boolean(evaluate(predicate, ctx));
              } catch (err) {
                effectLog.error('fetch-filter-eval-error', {
                  entityType: fetchEntityType,
                  error: err instanceof Error ? err : String(err),
                });
                return false;
              }
            });
          }
          // Capture total AFTER filter, BEFORE offset/limit so paginating
          // consumers receive the count of rows matching the filter.
          total = entities.length;
          if (options?.offset && options.offset > 0) {
            entities = entities.slice(options.offset);
          }
          if (options?.limit && options.limit > 0) {
            entities = entities.slice(0, options.limit);
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
        const matched = options?.id
          ? rows.filter(r => r['id'] === options.id)
          : rows;
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
            error: "swap! transform must be an S-expression or object",
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
      });
      try {
        await atomicExecutor.executeAll(atomicEffects as unknown[]);
        record({ effect: "atomic", success: true });
      } catch (err) {
        record({
          effect: "atomic",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  return handlers;
}
