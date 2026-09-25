/**
 * effect-stage — the server effect-execution stage, extracted from
 * `OrbitalServerRuntime.executeEffects` as a behavior-identical move
 * (workstream W1.4, docs/Almadar_Runtime_Stateless_Stateful_PLAN.md).
 * Instance/closure state arrives as `deps`; per-call parameters as `args`.
 *
 * @packageDocumentation
 */
import { createLogger } from '@almadar/logger';
import { EffectExecutor, clientResolvesRenderBindings } from './EffectExecutor.js';
import type { ServerEffectResult } from './ServerEffectHandlers.js';
import type { PersistenceAdapter } from '../entities/PersistenceAdapter.js';
import { stampEmitSource } from '../events/emit-stamp.js';
import type { EffectDispatch } from '../evaluation/dispatch-memory.js';
import { buildConfigBinding, buildEntityBinding } from '../traits/config-defaults.js';
import { createContextFromBindings } from '../evaluation/BindingResolver.js';
import { evaluate } from '@almadar/evaluator';
import type {
  BindingContext,
  EffectContext,
  EffectHandlers,
  EntityRow,
  EventPayload,
  EvaluationContextExtensions,
  RuntimeRenderPattern,
  RuntimePatternValue,
  TraitState,
} from '../types.js';
import { isEffectTuple } from '../types.js';
import type {
  BusEventSource,
  ClientEffectByTrait,
  ClientEffectTuple,
  Entity,
  EntityField,
  NavItem,
  OrbitalDefinition,
  OrbitalId,
  OrbitalSchema,
  PatternConfig,
  SExpr,
  Trait,
  TraitConfig,
  TraitConfigValue,
  UserContext,
  FieldValue,
  RuntimeValue,
  FetchOptions,
} from '@almadar/core';
import {
  getNestedValue,
  omitFrameFields,
  isPersistBatchOperation,
  orbitalInlineEntities,
} from '@almadar/core';
import { entityAccessPolicies } from '@almadar/core/mock';
import { applyRowAccess, checkMutationAccess, accessDeniedMessage } from '../entities/entityAccess.js';
import { findEntityAmongOrbitals } from '../traits/OrbitalTraitParsing.js';
import { defaultCallService } from './defaultCallService.js';
import { getPatternFieldsContract } from '@almadar/core/patterns';

const effectLog = createLogger("almadar:runtime:effects");
const busLog = createLogger("almadar:runtime:bus");
const renderLog = createLogger("almadar:runtime:render-ui");
const xOrbitalLog = createLogger("almadar:runtime:cross-orbital");
const dynamicLog = createLogger("almadar:runtime:dynamic");

/** FATAL: re-measured and gated clean — a persist that resolves no row key
 *  now fails the write instead of silently no-opping it. */
const NO_ROW_KEY_IS_FATAL = true;

/**
 * The caller's emit-delivery concern: bus emit under the event-id route key,
 * plus the persist-envelope success broadcast to the live-broadcast sink.
 */
export type DeliverEmit = (
  event: string,
  payload: EventPayload | undefined,
  stamp: BusEventSource,
  fromPersistSuccess: boolean,
) => void;

/**
 * What was `OrbitalServerRuntime` instance/closure state at the
 * `executeEffects` call site.
 */
export interface ServerEffectStageDeps {
  persistence: PersistenceAdapter;
  /** The orbital's `traitFieldStates` frame map (`(set @entity.X Y)` writes). */
  frames: Map<string, EntityRow>;
  frameKeyFor: (traitName: string) => string;
  orbitalName: string;
  orbitalId?: OrbitalId;
  irTraits: Trait[];
  entity: Entity;
  configByTrait: Map<string, TraitConfig>;
  resolvedTraitConfigs: Record<string, TraitConfig>;
  resolvedSchema: OrbitalSchema | null;
  registeredOrbitals: Iterable<{ schema: OrbitalDefinition; entity: Entity }>;
  getTraitState: (traitName: string) => TraitState | undefined;
  intrinsicFieldNames: (entityType: string) => string[];
  entityFieldsFor: (entityType: string) => EntityField[];
  /**
   * Relation-cardinality validation before create/update. Optional: the
   * stateful server supplies it (schema-aware); a stateless per-request
   * host without schema-wide relation metadata skips the check (its
   * pre-unification path never had it — recorded as a convergence gap,
   * not a behavior change).
   */
  validateRelationCardinality?: (entityType: string, data: EntityRow) => void;
  /** On-delete cascade rules. Optional for the same reason as
   *  `validateRelationCardinality`. */
  enforceOnDeleteRules?: (entityType: string, deletedId: string) => Promise<void>;
  /** Relation population on fetched rows. Optional for the same reason —
   *  absent means fetched rows carry raw foreign keys, no joined labels. */
  populateRelations?: (entities: EntityRow[], entityType: string, include: string[]) => Promise<void>;
  /** App-wide `@pages` sigil (union of root pages across registered orbitals). */
  sigilPages: NavItem[];
  /** `@currentTheme` sigil: the orbital's theme, else app theme, else default. */
  sigilTheme: string;
  /** Custom handlers — spread LAST over the built-ins, as before. */
  extraEffectHandlers?: Partial<EffectHandlers>;
  deliverEmit?: DeliverEmit;
  /** Whether a live-broadcast sink is wired (read by the sink-call debug log). */
  liveBroadcastSinkWired?: boolean;
  debug?: boolean;
  mockMode?: boolean;
  contextExtensions?: EvaluationContextExtensions;
}

/** What was `executeEffects`' per-call parameter list. */
export interface ServerEffectStageArgs {
  traitName: string;
  /** Wire-level effects from the transition. `RuntimeValue[]` (not `SExpr[]`)
   *  because tick sources carry core's `TypedEffect[]`, whose interface option
   *  objects are not `SExprObject`-assignable; the stage narrows to executable
   *  tuples internally via `isEffectTuple` where tuple shape is required. */
  effects: RuntimeValue[];
  payload: EventPayload | undefined;
  entityData: EntityRow;
  entityId: string | undefined;
  emittedEvents: Array<{ event: string; payload?: EventPayload; source?: BusEventSource }>;
  fetchedData: { [entityType: string]: EntityRow | EntityRow[] };
  clientEffects: ClientEffectTuple[];
  effectResults: ServerEffectResult[];
  /** Already-normalized viewer (see `processOrbitalEvent`'s `viewer`). */
  user?: UserContext;
  /** The dispatch's `now` stamp. */
  now?: number;
  clientEffectsByTrait?: ClientEffectByTrait[];
  /** The transition whose effects these are; tags each client effect with its provenance. */
  firing?: { event: string; fromState: string };
  onPush?: (item: { type: 'event'; data: { event: string; payload?: EventPayload; source?: BusEventSource } } | { type: 'effect'; data: ClientEffectTuple }) => void;
  /** Per-request originating client (from `OrbitalEventRequest.clientId`); absent for ticks. Carried through to persist-envelope broadcast items so the sink can exclude the origin. */
  originClientId?: string;
  /**
   * The composing effect's triggering payload, when `traitName` is an
   * embedded child (`@trait.X`) being re-run under its embedder's
   * transition. Surfaced on the binding context as `@callsitePayload.<field>`
   * — see `BindingContext.callsitePayload`. Absent for a trait's own,
   * non-embedded execution.
   */
  callsitePayload?: EventPayload;
  /** The transition being run: `state`/`@toState` read its target, `@fromState` its source (Runtime Spec Clause 3.3). Absent for ticks. */
  dispatch?: EffectDispatch;
}

/**
 * Resolve an entity definition by name across every registered orbital's
 * resolved primary entity AND auxiliary entities (Gap #22 — an imported
 * atom's own entity, surfaced on `schema.auxiliaryEntities` when a trait
 * reference omits the `-> Entity` rebind, is a legitimate relation TARGET
 * too: e.g. `WebhookOrbitalWebhookDeliveryBrowseList`'s `linkedEntity`
 * names `WebhookOrbitalWebhookDelivery`, which is that orbital's auxiliary
 * entity, not its primary `WebhookEndpoint`). Used by relation-option
 * injection to find the relation TARGET entity.
 */
function findEntityDefByName(
  registeredOrbitals: Iterable<{ schema: OrbitalDefinition; entity: Entity }>,
  name: string,
): Entity | undefined {
  const registered = Array.from(registeredOrbitals);
  return findEntityAmongOrbitals(
    registered.map((reg) => reg.entity),
    name,
  ) ?? findEntityAmongOrbitals(
    registered.flatMap((reg) =>
      orbitalInlineEntities(reg.schema).filter((e) => e.name !== reg.entity.name),
    ),
    name,
  );
}

/**
 * Server-side relation-option injection — the interpreter's mirror of the
 * compiled path's build-time `relationsData` generation (orbital-rust
 * registry.rs). Walks a render-ui pattern tree; for every pattern declaring
 * a `@fieldsContract` (form / form-section / inline-edit-form / wizard-step,
 * detail-panel, and the column-bearing display patterns — table-view /
 * data-list / data-grid / entity-table) whose linked entity declares
 * relation-typed fields among the node's `fields`/`columns`, reads the
 * relation TARGET entity's rows from the persistence adapter and attaches
 * `relationsData: { <field>: [{value, label}] }`.
 * Label contract identical to codegen: `name || title || id`. Options are
 * re-read on every render-ui, so they refresh with each re-render exactly
 * like any fetch. Authored `relationsData` is never overwritten.
 */
async function injectRelationOptions(
  deps: ServerEffectStageDeps,
  pattern: PatternConfig | null,
  traitName: string,
): Promise<void> {
  if (pattern === null || typeof pattern !== 'object') return;

  const linkedEntityName =
    deps.irTraits.find((t) => t.name === traitName)?.linkedEntity ??
    deps.entity?.name;
  if (!linkedEntityName) return;
  const entityDef = findEntityDefByName(deps.registeredOrbitals, linkedEntityName);
  if (!entityDef?.fields) return;

  const relationTargets = new Map<string, string>();
  for (const field of entityDef.fields) {
    if (field.type === 'relation' && field.relation?.entity && field.name) {
      relationTargets.set(field.name, field.relation.entity);
    }
  }
  if (relationTargets.size === 0) return;

  interface MutableRenderPattern {
    [prop: string]: RuntimePatternValue;
  }

  const visit = async (node: RuntimePatternValue): Promise<void> => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) await visit(child);
      return;
    }
    const record = node as MutableRenderPattern;
    const nodeType = record['type'];
    // Column-bearing display patterns (table-view/data-list/data-grid/
    // entity-table) wire their entity-bound field list under `columns`;
    // form/detail patterns use `fields`. Try both — never a hardcoded
    // pattern-name list, same doctrine as the `@fieldsContract` lookup below.
    const fields = record['fields'] ?? record['columns'];
    if (
      typeof nodeType === 'string' &&
      // Which patterns consume entity-bound field lists is DECLARED per
      // component via `@fieldsContract` and read from the pattern registry
      // — never a hardcoded name list. Both contracts get relation options
      // (form selects need choices; display fields need label resolution).
      getPatternFieldsContract(nodeType) !== undefined &&
      Array.isArray(fields) &&
      record['relationsData'] === undefined
    ) {
      const relationsData: MutableRenderPattern = {};
      for (const fieldEntry of fields) {
        const fieldName =
          typeof fieldEntry === 'string'
            ? fieldEntry
            : fieldEntry !== null && typeof fieldEntry === 'object' && !Array.isArray(fieldEntry)
              ? String(
                  // `field` is TableView's column-to-entity-field override
                  // (defaults to `key`); `name`/`key` cover every other
                  // field-def shape (DetailPanel, DataList, DataGrid, DataTable).
                  (fieldEntry as MutableRenderPattern)['field'] ??
                    (fieldEntry as MutableRenderPattern)['name'] ??
                    (fieldEntry as MutableRenderPattern)['key'] ??
                    '',
                )
              : '';
        const targetEntity = fieldName ? relationTargets.get(fieldName) : undefined;
        if (!targetEntity) continue;
        try {
          const rows = await deps.persistence.list(targetEntity);
          relationsData[fieldName] = rows.map((r) => ({
            value: String(r.id ?? ''),
            label: String(r.name ?? r.title ?? r.id ?? ''),
          }));
        } catch {
          // A missing/unregistered target collection means no options —
          // the select renders empty rather than the render failing.
        }
      }
      if (Object.keys(relationsData).length > 0) {
        record['relationsData'] = relationsData;
      }
    }
    const children = record['children'];
    if (children !== undefined) await visit(children);
  };

  await visit(pattern as RuntimePatternValue);
}

/**
 * Execute effects from a transition
 */
export async function runServerEffectStage(
  deps: ServerEffectStageDeps,
  args: ServerEffectStageArgs,
): Promise<void> {
  const {
    traitName,
    effects,
    payload,
    entityData,
    entityId,
    emittedEvents,
    fetchedData,
    clientEffects,
    effectResults,
    user,
    now,
    clientEffectsByTrait,
    firing,
    onPush,
    originClientId,
    callsitePayload,
    dispatch,
  } = args;
  const entityType = deps.entity.name;

  // Every fetch this dispatch will run, with its option keys — the one line
  // that shows when a SIBLING trait's unfiltered fetch of the same entity
  // bypasses a scoped call site (R-FETCH-SCOPE-SIBLING-BYPASS).
  for (const eff of effects) {
    if (isEffectTuple(eff) && eff[0] === 'fetch') {
      xOrbitalLog.debug('fetch:pre-exec-keys', () => ({
        trait: traitName,
        entity: String(eff[1]),
        optKeys: Object.keys((eff[2] as FetchOptions | undefined) ?? {}).join('+'),
      }));
    }
  }

  // Push to both the flat `clientEffects` array (legacy wire shape) and the
  // tagged `clientEffectsByTrait` sidecar in lockstep. Closure captures
  // `traitName` from this invocation's scope, so cascade emits — which run
  // through their own executeEffects call with their own traitName —
  // attribute correctly.
  const pushClientEffect = (effect: ClientEffectTuple): void => {
    clientEffects.push(effect);
    clientEffectsByTrait?.push({ traitName, effect, ...firing });
    onPush?.({ type: 'effect', data: effect });
  };

  // Forward refs - assigned after construction, used by fetch/atomic handlers
  let bindingsRef: BindingContext | null = null;
  let contextRef: EffectContext | null = null;

  const handlers: EffectHandlers = {
    emit: (event, eventPayload, source, fromPersistSuccess) => {
      if (deps.debug) {
        busLog.debug('emit:dispatch', () => ({
          event,
          payloadJson: JSON.stringify(eventPayload ?? null),
          sourceOrbital: source?.orbital,
          sourceTrait: source?.trait,
        }));
      }
      // Forward the source stamp to the bus. If the caller didn't supply
      // one (legacy callers), synthesize one from the handler's lexical
      // closure so source-scoped listeners still match.
      //
      // V4 identity: stamp the emitting orbital/trait/event IDS (when the
      // schema carries them) so id-scoped listeners match after a rename,
      // and route delivery under the event-id key. All three are optional
      // dual-carry — absent → name stamp + name routing (legacy).
      const emittingTrait = deps.irTraits.find((t) => t.name === traitName);
      const emitContract = emittingTrait?.emits?.find((e) => e.event === event);
      // Stamp the originating client so the listens fan-out can tell a
      // client-driven cascade (the client relays every hop itself) from a
      // headless one (this fan-out IS the circuit). See BusEventSource.
      const stamp = stampEmitSource(source, {
        orbitalName: deps.orbitalName,
        traitName,
        orbitalId: deps.orbitalId,
        traitId: emittingTrait?.id,
        emitContractEventId: emitContract?.eventId,
        originClientId,
      });
      deps.deliverEmit?.(event, eventPayload, stamp, fromPersistSuccess === true);
      const emittedItem = { event, payload: eventPayload, source: stamp };
      emittedEvents.push(emittedItem);
      onPush?.({ type: 'event', data: emittedItem });
      effectLog.debug("emit:push", {
        event,
        cumulativeEmittedCount: emittedEvents.length,
        sourceTrait: stamp.trait,
        sourceOrbital: stamp.orbital,
      });
      xOrbitalLog.info('emit:server', {
        event,
        sourceOrbital: stamp.orbital,
        sourceTrait: stamp.trait,
        dispatchOrbital: deps.orbitalName,
      });
      // Live-push (docs/Almadar_Live_Push.md): broadcast ONLY the
      // persist-envelope success emit, positionally signaled by
      // EffectExecutor's persist case — reuses the exact `stamp` object
      // already pushed to `emittedEvents` so the broadcast payload is
      // identical to the origin's response.
      if (fromPersistSuccess) {
        busLog.debug('live-broadcast:sink-call', {
          event,
          sourceOrbital: stamp.orbital,
          sourceTrait: stamp.trait,
          originClientId,
          sinkWired: deps.liveBroadcastSinkWired === true,
        });
      }
    },

    set: async (targetId, field, value) => {
      // `(set @entity.X Y)` writes to per-trait scalar state, not
      // persistence. Persistence writes only via explicit
      // `(persist update ...)`. Mirrors compiled's `state.fields` reducer.
      // A `[shared]` linked entity writes through the shared key — one
      // frame across its bound traits (see sharedFieldKey).
      const fieldKey = deps.frameKeyFor(traitName);
      let fieldState = deps.frames.get(fieldKey);
      if (!fieldState) {
        fieldState = {} as EntityRow;
        deps.frames.set(fieldKey, fieldState);
      }
      fieldState[field] = value as FieldValue;
      effectResults.push({
        effect: 'set',
        entityType,
        data: { id: targetId || entityId || '', field, value: value as FieldValue },
        success: true,
      });
    },

    persist: async (action, targetEntityType, data) => {
      // ----------------------------------------------------------------
      // Batch mode: ["persist", "batch", [...operations]]
      // Each operation: ["create", "collection", {...data}],
      //                 ["update", "collection", "id", {...data}],
      //                 ["delete", "collection", "id"]
      // ----------------------------------------------------------------
      if (action === 'batch') {
        const operations = data?.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          effectResults.push({
            effect: 'persist',
            action: 'batch',
            success: false,
            error: 'Batch requires a non-empty operations array',
          });
          return;
        }

        const batchResults: Array<EntityRow> = [];
        // Track completed ops for rollback on failure (best-effort)
        const completed: Array<{ action: string; entityType: string; id?: string }> = [];
        let batchFailed = false;
        let batchError = '';

        // Widened to the guard's own input type so the predicate narrows to
        // every variant, not to the one tuple assignable to `string[]`.
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
              case 'create': {
                // `@intrinsic` fields are NEVER a persisted column — strip
                // them from every create write, whatever expression form
                // produced `createData` (bare `@entity`, an explicit
                // literal that names one, an `object/merge` result, …).
                // Deterministic on the entity's declared schema, not on
                // how the value was constructed.
                const createIntrinsicFields = deps.intrinsicFieldNames(opEntityType);
                const createData = createIntrinsicFields.length > 0
                  ? omitFrameFields(op[2] ?? {}, createIntrinsicFields)
                  : op[2] ?? {};
                const { id: newId } = await deps.persistence.create(opEntityType, createData);
                batchResults.push({ ...createData, action: 'create', entityType: opEntityType, id: newId });
                completed.push({ action: 'create', entityType: opEntityType, id: newId });
                break;
              }
              case 'update': {
                const updateId = op[2];
                const updateIntrinsicFields = deps.intrinsicFieldNames(opEntityType);
                const updateData = updateIntrinsicFields.length > 0
                  ? omitFrameFields(op[3] ?? {}, updateIntrinsicFields)
                  : op[3] ?? {};
                await deps.persistence.update(opEntityType, updateId, updateData);
                const updated = await deps.persistence.getById(opEntityType, updateId);
                batchResults.push({ ...(updated || updateData), action: 'update', entityType: opEntityType, id: updateId });
                completed.push({ action: 'update', entityType: opEntityType, id: updateId });
                break;
              }
              case 'delete': {
                const deleteId = op[2];
                // Snapshot before delete for potential rollback info
                await deps.persistence.delete(opEntityType, deleteId);
                batchResults.push({ action: 'delete', entityType: opEntityType, id: deleteId, deleted: true });
                completed.push({ action: 'delete', entityType: opEntityType, id: deleteId });
                break;
              }
              default:
                batchFailed = true;
                batchError = `Unknown batch operation action: ${opAction}`;
                break;
            }
          } catch (err) {
            batchFailed = true;
            batchError = `Batch operation [${opAction}, ${opEntityType}] failed: ${err instanceof Error ? err.message : String(err)}`;
            break;
          }

          if (batchFailed) break;
        }

        effectResults.push({
          effect: 'persist',
          action: 'batch',
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

      // ----------------------------------------------------------------
      // Single operation mode: create / update / delete
      // ----------------------------------------------------------------
      const type = targetEntityType || entityType;
      // `@intrinsic` fields are NEVER a persisted column — strip them from
      // every create/update write regardless of what expression produced
      // `data` (bare `@entity`, an explicit literal that names one, an
      // `object/merge` result, …). Deterministic on the entity's declared
      // schema, not on how the value was constructed.
      if ((action === 'create' || action === 'update') && data !== undefined) {
        const intrinsicFields = deps.intrinsicFieldNames(type);
        if (intrinsicFields.length > 0) data = omitFrameFields(data, intrinsicFields);
      }
      let resultData: EntityRow | undefined;
      const sizeBefore = (await deps.persistence.list(type)).length;
      // Distinguishes a policy/row-key REJECTION from any other thrown
      // failure (a persistence-backend error, a validation exception) so
      // the catch below can stamp `denied: true` on the pushed result —
      // tracked explicitly rather than pattern-matching the error message.
      let deniedReason: 'access-denied' | 'no-row-key' | undefined;

      try {
        // Validate relation cardinality before create/update
        if (action === 'create' || action === 'update') {
          deps.validateRelationCardinality?.(type, data || {});
        }

        const accessBindings = { user: bindingsRef?.user, payload: bindingsRef?.payload, config: bindingsRef?.config, now: bindingsRef?.now };
        const mutationPolicy = deps.resolvedSchema
          ? entityAccessPolicies(deps.resolvedSchema, type)?.[
              action === 'create' ? 'create' : action === 'update' ? 'update' : 'delete'
            ]
          : undefined;

        switch (action) {
          case "create": {
            if (!checkMutationAccess(data || {}, mutationPolicy, accessBindings)) {
              deniedReason = 'access-denied';
              throw new Error(accessDeniedMessage('create', type));
            }
            const { id } = await deps.persistence.create(type, data || {});
            resultData = { ...(data || {}), id };
            break;
          }
          case "update":
            if (data?.id || entityId) {
              const updateId = (data?.id as string) || entityId!;
              if (mutationPolicy !== undefined) {
                const existing = await deps.persistence.getById(type, updateId);
                if (!existing || !checkMutationAccess(existing, mutationPolicy, accessBindings)) {
                  deniedReason = 'access-denied';
                  throw new Error(accessDeniedMessage('update', type));
                }
              }
              await deps.persistence.update(type, updateId, data || {});
              // Return the updated entity
              const updated = await deps.persistence.getById(type, updateId);
              resultData = updated || { ...(data || {}), id: updateId };
            } else {
              // A write with NO row key is a FAILED write, not a silent
              // no-op. This branch used to fall through to the unconditional
              // `success: true` push below, so the update vanished and the
              // caller was told it worked — `std-trait-wars`' LEVEL_UP
              // discarded every level-up that way, and JOIN_SESSION advanced
              // the state machine without ever joining. The compiled path
              // resolved the same condition to the empty-string key instead;
              // both now fail identically.
              effectLog.error('persist:no-row-key', { action, entityType: type });
              if (NO_ROW_KEY_IS_FATAL) {
                deniedReason = 'no-row-key';
                throw new Error(
                  `persist ${action} ${type} resolved no row key — the id was neither `
                  + `on the row being written nor on the request. Bind it before the `
                  + `write, e.g. (set @entity.id ?row.id) on the transition that selects it.`,
                );
              }
            }
            break;
          case "delete": {
            // `(persist delete Entity @payload.id)` resolves to a raw
            // id STRING as the 4th arg, not `{id: ...}`. Accept both
            // shapes — the .lolo authoring form is string, and batch
            // callers may pass {id} too — so VG31-delete's cascade
            // doesn't silently no-op when `data` is a scalar id.
            const directId = typeof data === 'string' ? data : undefined;
            const nestedId = typeof data === 'object' && data !== null
              ? (data.id as string | undefined)
              : undefined;
            const deleteId = directId ?? nestedId ?? entityId;
            if (deleteId) {
              if (mutationPolicy !== undefined) {
                const existing = await deps.persistence.getById(type, deleteId);
                if (!existing || !checkMutationAccess(existing, mutationPolicy, accessBindings)) {
                  deniedReason = 'access-denied';
                  throw new Error(accessDeniedMessage('delete', type));
                }
              }
              // Enforce onDelete relation rules before deleting
              await deps.enforceOnDeleteRules?.(type, deleteId);
              await deps.persistence.delete(type, deleteId);
              resultData = { id: deleteId, deleted: true };
            } else {
              // No row key is a failed write, not a silent no-op.
              effectLog.error('persist:no-row-key', { action, entityType: type });
              if (NO_ROW_KEY_IS_FATAL) {
                deniedReason = 'no-row-key';
                throw new Error(
                  `persist ${action} ${type} resolved no row key — the id was neither `
                  + `on the row being written nor on the request. Bind it before the `
                  + `write, e.g. (set @entity.id ?row.id) on the transition that selects it.`,
                );
              }
            }
            break;
          }
        }

        // `NO_ROW_KEY_IS_FATAL === false` falls through the update/delete
        // else-branches above without setting `resultData` or throwing —
        // that is a write that never happened, not a success. Fail it
        // explicitly instead of reaching the unconditional `success: true`
        // push below with an empty `data`.
        if (resultData === undefined && (action === 'update' || action === 'delete')) {
          effectResults.push({
            effect: 'persist',
            action,
            entityType: type,
            success: false,
            denied: true,
            error: `persist ${action} ${type} resolved no row key`,
          });
          return undefined;
        }

        const sizeAfter = (await deps.persistence.list(type)).length;
        effectLog.debug("persist:store-mutate", {
          action,
          entityType: type,
          resultId: resultData?.id as string | undefined,
          sizeBefore,
          sizeAfter,
          delta: sizeAfter - sizeBefore,
        });

        effectResults.push({
          effect: 'persist',
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
        effectResults.push({
          effect: 'persist',
          action,
          entityType: type,
          success: false,
          ...(deniedReason !== undefined ? { denied: true as const } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return undefined;
    },

    callService: async (service, action, params) => {
      try {
        let result = null;
        // Custom handlers can override this
        if (deps.extraEffectHandlers?.callService) {
          result = await deps.extraEffectHandlers.callService(
            service,
            action,
            params,
            user ? { principal: user.id, role: user.role } : undefined,
          );
        } else if (deps.mockMode === true) {
          // Mock mode: return a useful default so service-atom chains
          // (e.g. std-service-stripe createPaymentIntent → PAYMENT_CREATED
          // → confirmPayment → PAYMENT_CONFIRMED) advance instead of
          // stalling at an empty payload. Fields cover the common
          // service-result shapes:
          //   - `id` / `clientSecret` for payment-intent style results
          //   - `success` / `status` for boolean-ish action results
          //   - `result` (object) for actions that wrap a result
          //   - echo `params` so consumers reading the request shape see it
          const mockId = `mock_${service}_${action}_${Math.random().toString(36).slice(2, 10)}`;
          const paramsEcho: Partial<EntityRow> = {};
          if (params) {
            for (const [k, v] of Object.entries(params)) {
              if (v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null || v instanceof Date)) {
                paramsEcho[k] = v;
              }
            }
          }
          result = {
            id: mockId,
            clientSecret: `secret_${mockId}`,
            success: true,
            status: 'succeeded',
            ...paramsEcho,
          } as EntityRow;
        } else {
          result = await defaultCallService(service, action, params, user ? { principal: user.id, role: user.role } : undefined);
        }

        effectResults.push({
          effect: 'call-service',
          action: `${service}.${action}`,
          data: result as EntityRow | undefined,
          success: true,
        });

        return result;
      } catch (err) {
        effectResults.push({
          effect: 'call-service',
          action: `${service}.${action}`,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        // The executor routes a throw to the declared `emit.failure`.
        throw err;
      }
    },

    fetch: async (fetchEntityType, options) => {
      try {
        let result: EntityRow | EntityRow[] | null = null;
        let total = 0;

        // The entity's declared `@read` policy — ANDed with any call-site
        // `filter:`, applied to every fetch (id or collection) no matter
        // which trait issues it. The un-bypassable half of row visibility
        // (R-FETCH-SCOPE-SIBLING-BYPASS).
        const readPolicy = deps.resolvedSchema
          ? entityAccessPolicies(deps.resolvedSchema, fetchEntityType)?.read
          : undefined;
        const accessBindings = { user: bindingsRef?.user, payload: bindingsRef?.payload, config: bindingsRef?.config, now: bindingsRef?.now };

        if (options?.id) {
          // Single entity fetch
          const stored = await deps.persistence.getById(fetchEntityType, options.id);
          if (stored && applyRowAccess([stored], readPolicy, undefined, accessBindings).length > 0) {
            // Hydrate a CLONE, never the store's row: populateRelations
            // attaches related objects over the FK columns, and an
            // in-memory persistence layer returns live references — a
            // mutated store row then fails later filters/validation and
            // silently vanishes from every subsequent fetch.
            const entity = { ...stored };
            // Populate relations if include specified
            if (options?.include && options.include.length > 0) {
              await deps.populateRelations?.([entity], fetchEntityType, options.include);
            }
            // Always store as array for consistent access via FetchedDataContext
            fetchedData[fetchEntityType] = [entity];
            result = entity;
            total = 1;
          }
        } else {
          // Collection fetch. `applyRowAccess` ANDs the declared @read
          // policy with the call-site filter (either may be absent).
          let entities = await deps.persistence.list(fetchEntityType);
          entities = applyRowAccess(
            entities,
            readPolicy,
            options?.filter !== undefined && options.filter !== null
              ? (options.filter as SExpr)
              : undefined,
            accessBindings,
          );

          // Capture total AFTER filter, BEFORE offset/limit — paginating
          // consumers need the count of rows matching the filter, not
          // just the slice length.
          total = entities.length;

          // Apply pagination
          if (options?.offset && options.offset > 0) {
            entities = entities.slice(options.offset);
          }
          if (options?.limit && options.limit > 0) {
            entities = entities.slice(0, options.limit);
          }

          // Populate relations if include specified — on CLONES, for the
          // same store-corruption reason as the single-row branch above.
          if (options?.include && options.include.length > 0) {
            entities = entities.map((row) => ({ ...row }));
            await deps.populateRelations?.(entities, fetchEntityType, options.include);
          }

          fetchedData[fetchEntityType] = entities;
          result = entities;
        }

        return result === null
          ? null
          : { rows: result, total };
      } catch (error) {
        effectLog.error('fetch:error', {
          entityType: fetchEntityType,
          error: error instanceof Error ? error : String(error),
        });
        return null;
      }
    },

    // Resource operators: ref, deref, swap, watch, atomic

    ref: async (refEntityType, options) => {
      // ref is identical to fetch on the server: query persistence, populate fetchedData
      try {
        return await handlers.fetch!(refEntityType, options);
      } catch (error) {
        effectLog.error('ref:error', {
          entityType: refEntityType,
          error: error instanceof Error ? error : String(error),
        });
        return null;
      }
    },

    deref: async (derefEntityType, options) => {
      // deref is identical to fetch on the server: one-shot read
      try {
        let result: EntityRow | EntityRow[] | null = null;
        let total = 0;

        if (options?.id) {
          const entity = await deps.persistence.getById(derefEntityType, options.id);
          if (entity) {
            fetchedData[derefEntityType] = [entity];
            result = entity;
            total = 1;
          }
        } else {
          const entities = await deps.persistence.list(derefEntityType);
          fetchedData[derefEntityType] = entities;
          result = entities;
          total = entities.length;
        }

        effectResults.push({
          effect: 'deref',
          entityType: derefEntityType,
          success: true,
        });

        return result === null ? null : { rows: result, total };
      } catch (error) {
        effectResults.push({
          effect: 'deref',
          entityType: derefEntityType,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    swap: async (swapEntityType, swapEntityId, transform) => {
      // Read-modify-write: read entity, apply transform S-expression, write back
      try {
        const current = await deps.persistence.getById(swapEntityType, swapEntityId);
        if (!current) {
          effectResults.push({
            effect: 'swap',
            entityType: swapEntityType,
            success: false,
            error: `Entity ${swapEntityType}/${swapEntityId} not found`,
          });
          return null;
        }

        // Evaluate the transform S-expression with @current binding
        const ctx = createContextFromBindings({
          current,
          entity: entityData,
          payload,
        }, false, deps.contextExtensions);

        let newData: EntityRow;
        if (Array.isArray(transform)) {
          // S-expression transform: evaluate with @current bound to the entity
          const result = evaluate(
            transform as Parameters<typeof evaluate>[0],
            ctx,
          );
          // The result should be a record (the transformed entity)
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            newData = result as EntityRow;
          } else {
            // If transform returned a non-object, treat it as a partial update
            newData = current;
          }
        } else if (typeof transform === 'object' && transform !== null) {
          // Plain object merge: simple field updates
          newData = { ...current, ...(transform as EntityRow) };
        } else {
          effectResults.push({
            effect: 'swap',
            entityType: swapEntityType,
            success: false,
            error: 'swap transform must be an S-expression or object',
          });
          return null;
        }

        // Write back (without version check for now, full OCC in future pass)
        await deps.persistence.update(swapEntityType, swapEntityId, newData);

        effectResults.push({
          effect: 'swap',
          entityType: swapEntityType,
          data: { id: swapEntityId, ...newData },
          success: true,
        });

        return newData;
      } catch (error) {
        effectResults.push({
          effect: 'swap',
          entityType: swapEntityType,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    watch: (_watchEntityType, _watchOptions) => {
      // Watch is a no-op on server. Client subscribes to real-time updates.
      if (deps.debug) {
        effectLog.debug('watch:noop-server', { entityType: _watchEntityType });
      }
    },

    atomic: async (atomicEffects) => {
      // Execute inner effects sequentially. If any fails, mark all as failed.
      // Full transaction/rollback support is a future enhancement.
      let atomicFailed = false;
      let atomicError = '';

      const atomicExecutor = new EffectExecutor({
        handlers,
        bindings: bindingsRef ?? {},
        context: contextRef ?? { traitName, orbitalName: deps.orbitalName, state: 'unknown', transition: 'unknown' },
        debug: deps.debug,
        contextExtensions: deps.contextExtensions,
        // Same render-time marker boundary as the outer executor
        // (including the [shared]-defers-regardless-of-persistence rule).
        deferRenderBindings: clientResolvesRenderBindings(deps.entity),
        resolveIntrinsicFields: (type) => deps.intrinsicFieldNames(type),
        resolveEntityFields: (type) => deps.entityFieldsFor(type),
      });

      for (const innerEffect of atomicEffects) {
        if (atomicFailed) break;
        try {
          await atomicExecutor.execute(innerEffect);
        } catch (err) {
          atomicFailed = true;
          atomicError = err instanceof Error ? err.message : String(err);
        }
      }

      if (atomicFailed) {
        // Mark the atomic block as failed
        effectResults.push({
          effect: 'atomic',
          success: false,
          error: `Atomic block failed: ${atomicError}`,
        });
      } else {
        effectResults.push({
          effect: 'atomic',
          success: true,
          data: { innerCount: atomicEffects.length },
        });
      }
    },

    // Client-side effects - collect for forwarding to client
    renderUI: async (slot, pattern, props, priority) => {
      // Relation-option injection (server-side, mirrors compiled codegen):
      // fieldsContract patterns with relation-typed fields get relationsData
      // read from the persistence adapter before the effect ships.
      await injectRelationOptions(deps, pattern, traitName);
      // Snapshot the resolved row reference (if any) so the log can
      // tell whether successive render-ui pushes for the same slot
      // carry the SAME row object (stable, no remount expected) or a
      // freshly-cloned one (would invalidate Form's normalizedInitialData
      // memo and reset typed values). We read `pattern.entity` because
      // form-section binds the row to `entity: @payload.row`.
      const patternNode: RuntimeRenderPattern | null =
        pattern !== null && typeof pattern === 'object' && !Array.isArray(pattern)
          ? (pattern as RuntimeRenderPattern)
          : null;
      const patternEntity = patternNode?.entity;
      const entityRow: EntityRow | null =
        patternEntity !== null && typeof patternEntity === 'object' && !Array.isArray(patternEntity)
          ? (patternEntity as EntityRow)
          : null;
      const patternTypeRaw = patternNode?.['type'];
      renderLog.debug('renderUI:push', {
        trait: traitName,
        slot,
        patternType: typeof patternTypeRaw === 'string' ? patternTypeRaw : undefined,
        entityRowId: typeof entityRow?.id === 'string' ? entityRow.id : undefined,
        entityIsObject: entityRow !== null,
      });
      pushClientEffect(['render-ui', slot, pattern, props, priority]);
    },
    navigate: (path, params, crumb) => {
      if (crumb !== undefined) {
        pushClientEffect(['navigate', path, params, { crumb }]);
      } else {
        pushClientEffect(['navigate', path, params]);
      }
    },

    navigateBack: () => {
      pushClientEffect(['navigate-back']);
    },

    log: (message, level) => {
      if (level === 'error') {
        dynamicLog.error(message);
      } else if (level === 'warn') {
        dynamicLog.warn(message);
      } else {
        dynamicLog.debug(message);
      }
    },

    // Allow custom handlers to override
    ...deps.extraEffectHandlers,
  };

  const state = deps.getTraitState(traitName);
  // Build binding context with @entity AND @EntityName aliases.
  // @entity is the standard binding root. @EntityName (e.g., @SpriteEntity)
  // is used by some behaviors for explicit entity references in render-ui patterns.
  // The compiled app resolves @EntityName at compile time; the interpreter
  // needs it in the runtime binding context.
  //
  // NOTE: fetchedData is populated by fetch effects DURING execution.
  // The syncFetchedBindings() helper is called from the fetch handler
  // to update bindings after each fetch, so render-ui effects that
  // run after fetch see the correct @EntityName.field values.
  const bindings: BindingContext = {
    entity: entityData,
    payload,
    state: dispatch?.toState ?? (state?.currentState || "unknown"),
    user,
    ...(now !== undefined ? { now } : {}),
    ...(dispatch !== undefined ? dispatch : {}),
  };
  // Surface the composing effect's triggering payload for a JSX-hoisted
  // inline child trait's `@callsitePayload.<field>` captures — both a
  // call-site config override AND the trait's own declared config default
  // resolve it through the standard `@config.*` binding-forward recursion
  // in `interpolateString` once `ctx.callsitePayload` is populated (see
  // `createContextFromBindings`). One owner: the binding root, not a
  // preprocessing pass over `configByTrait`.
  if (callsitePayload) {
    bindings.callsitePayload = callsitePayload;
  }

  // Call-site `config: { ... }` injection. Reference-resolver captures the
  // trait ref's config block into RegisteredOrbital.configByTrait at
  // registration time (see registerOrbitalAsync). Here we surface it on the
  // binding context so render-ui patterns can read `@config.icon`,
  // `@config.title`, `@config.fields`, etc. — the mechanism that lets a
  // molecule parameterize an imported atom's UI without duplicating the
  // render-ui body.
  // Defaults from the trait's DECLARED config schema must merge BEHIND the
  // call-site override so atoms verified standalone (no consumer override)
  // still see their declared icon/title/fields/mode values. Without this,
  // `@config.icon` resolved to undefined → Icon fell back to "?", and
  // `@config.title` rendered as empty. The compiled path's Solution-1 in
  // backend.rs emits `DEFAULT_<TRAIT>_CONFIG` + `mergedConfig`; the runtime
  // path needs the same merge or std-modal/std-confirmation render bare in
  // playground while the compiled bundle renders correctly.
  const config = buildConfigBinding({
    traitDef: deps.irTraits.find((t) => t.name === traitName),
    resolvedDefaults: deps.resolvedTraitConfigs[traitName],
    callSiteOverride: deps.configByTrait.get(traitName),
    user,
  });
  if (config !== undefined) bindings.config = config;

  // Render-resolved schema sigils (`@pages`, `@currentTheme`). `@pages` is
  // APP-WIDE: an orbital is authored in isolation and cannot know its
  // siblings, so the nav is assembled from the union of root pages across
  // ALL registered orbitals (deduped by path). Mirrors the compiler's
  // resolver in `resolve_to_oir`. `@currentTheme` stays per-orbital.
  if (deps.sigilPages.length > 0) {
    bindings.pages = deps.sigilPages;
  }
  bindings.currentTheme = deps.sigilTheme;

  // `@entity` resolves to a three-layer merge (outermost wins):
  //   1. Declared entity field defaults (schema `default:` values)  — base
  //   2. entityData from persistence (already in bindings.entity above)     — middle
  //   3. Explicit `(set @entity.X Y)` scalar state (traitFieldStates)       — top
  // Without layer 1, behaviors that render `@entity.title` on first load
  // (before any event fires a `(set)`) see undefined → blank UI even though
  // the entity schema declares a sensible default. Mirrors the `@config`
  // merge applied above (declared defaults < call-site override). RC-2.
  // The defaults are the trait's OWN entity's, not the orbital's primary one.
  const traitEntityName = deps.irTraits.find((t) => t.name === traitName)?.linkedEntity ?? entityType;
  const entityBinding = buildEntityBinding({
    entity: { fields: deps.entityFieldsFor(traitEntityName) },
    persisted: bindings.entity,
    frame: deps.frames.get(deps.frameKeyFor(traitName)),
  });
  if (entityBinding !== undefined) bindings.entity = entityBinding;

  // Add initial named entity binding
  if (entityType) {
    bindings[entityType] = bindings.entity ?? entityData;
  }

  // Wire forward refs so fetch/atomic handlers can access bindings and context
  bindingsRef = bindings;

  const context: EffectContext = {
    traitName,
    orbitalName: deps.orbitalName,
    state: state?.currentState || "unknown",
    transition: "unknown",
    entityId,
  };
  contextRef = context;

  const executor = new EffectExecutor({
    handlers,
    bindings,
    context,
    debug: deps.debug,
    contextExtensions: deps.contextExtensions,
    // Carry `@entity`-dependent render-ui leaves as render-time markers
    // for runtime-only (and unlinked) entities: the client's local state
    // machines execute the same `(set)` writes, so the renderer resolves
    // markers against its live store — otherwise these SSE-pushed eager
    // props clobber the client's live marker frames on every event.
    // Persistent NON-shared entities stay eager: their `@entity` merges
    // persistence rows the client does not hold. A `[shared]` entity is
    // deferred REGARDLESS of persistence — its trait frame's scalars are
    // client-held by contract (one live frame across bound traits), and
    // the eager clobber pinned the chat composer's controlled input to
    // the server's flush-time "" on every keystroke round-trip.
    deferRenderBindings: clientResolvesRenderBindings(deps.entity),
    resolveIntrinsicFields: (type) => deps.intrinsicFieldNames(type),
    resolveEntityFields: (type) => deps.entityFieldsFor(type),
  });

  await executor.executeAll(effects);
}
