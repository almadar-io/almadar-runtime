/**
 * evaluateOrbitalEvent — THE event-evaluation composition, one owner for
 * every server-side execution path (design: docs/Almadar_Runtime_Stateless_Stateful_PLAN.md).
 *
 * A deployment differs from another ONLY in the deps it supplies:
 *
 * - **Stateful** (`OrbitalServerRuntime`): a long-lived `manager` holding
 *   every registered trait's state, a long-lived `frames` map
 *   (`traitFieldStates`), and a `runEffects` runner whose stage delivers
 *   emits to the live bus/broadcast. The host STRIPS `request.traits` /
 *   `request.entityByTrait` before calling — the server is authoritative
 *   and discovers targets via `canHandleEvent` over its own held states.
 * - **Stateless** (the playground's per-request handler): a FRESH manager
 *   + frames map per request, seeded from the client's round-tripped
 *   `traits[].from` and `entityByTrait` (the client is the source of
 *   truth for circuit state — see the PLAN's §1 definitions), and a
 *   `runEffects` runner whose stage only records emits (the in-band
 *   fan-out below IS the cross-trait circuit; there is no standing bus).
 *
 * The composition owns, identically on both paths: target resolution,
 * payload validation, the same-trait cascade drive (`runTraitCascade` +
 * `commitState`), the cross-trait `listens` fan-out (ONE termination
 * policy), the relay mask (which traits the CLIENT completes itself —
 * G-RUNTIME-031's fix is this mask being data instead of a blanket
 * `originClientId` skip), structured rejections, and `OrbitalEventResponse`
 * assembly. Emit stamping lives in the effect stage (`stampEmitSource`) —
 * G-RUNTIME-030's hole stays closed by having one stamper.
 *
 * @packageDocumentation
 */
import {
  applyListenPayloadMapping,
  isRuntimeEntity,
  type ClientEffectTuple,
  type EntityRow,
  type EventPayload,
  type OrbitalEventRequest,
  type OrbitalEventResponse,
  type ServerEffectResult,
  type TraitEventListener,
  type TransitionRejection,
  type UserContext,
} from '@almadar/core';
import { createLogger } from '@almadar/logger';
import {
  createMinimalContext,
  evaluateGuard,
  evaluateListenPayloadExpr,
} from '@almadar/evaluator';
import {
  findInitialState,
  findTransition,
  normalizeEventKey,
  runTraitCascade,
  selectDispatchCandidates,
  StateMachineManager,
} from './index.js';
import { parseListenSource } from './identity/routing.js';
import { collectDeclaredEntityDefaults } from './config-defaults.js';
import type { ServerEffectStageArgs } from './effect-stage.js';
import {
  formatPayloadValidationError,
  validateEventPayload,
  type PayloadValidationFailure,
} from './PayloadValidator.js';
import type { TraitIndex } from './trait-index.js';
import type { Effect, EvaluationContextExtensions } from './types.js';
import type { PersistenceAdapter } from './PersistenceAdapter.js';
import type { SExpr } from '@almadar/core';

const evaluateLog = createLogger('almadar:runtime:evaluate');

/**
 * Circuit breaker, NOT a page-size budget. The visited set already bounds
 * work to distinct (trait, event, from) triples — termination is
 * structurally guaranteed — so this cap exists only to bound worst-case
 * latency if a compiler bug ever spawns an absurd number of distinct
 * triples. Truncation is surfaced in the response (`cascadeTruncated`) +
 * a warning, never silent (G-RUNTIME-027).
 */
const CROSS_TRAIT_CASCADE_CAP = 2000;

/** Per-trait effect execution, supplied by the host. The host resolves
 *  the trait's own stage deps (its entity, frame key, orbital identity)
 *  and calls the shared effect stage. */
export type EvaluateEffectRunner = (
  traitName: string,
  args: Omit<ServerEffectStageArgs, 'traitName'>,
) => Promise<void>;

export interface EvaluateOrbitalEventDeps {
  /** The resolved evaluation index (see `buildTraitIndex`). */
  traitIndex: TraitIndex;
  /** Long-lived (stateful) or fresh-per-request (stateless, seeded from
   *  `request.traits` by this composition) state holder. */
  manager: StateMachineManager;
  persistence: PersistenceAdapter;
  /** The entity-frame map (`set @entity.X` writes; frameKey-keyed). */
  frames: Map<string, EntityRow>;
  runEffects: EvaluateEffectRunner;
  /**
   * Traits the CLIENT completes itself — the fan-out skips these (its own
   * relay/mount completes them). Defaults to the request's
   * `_activeTraits` sidecar, which is exactly the origin tab's mounted
   * set on both paths. Off-page listeners (never mounted on the origin
   * page) run server-side — G-RUNTIME-031.
   */
  relayMask?: ReadonlySet<string>;
  /** Normalized viewer (hosts normalize `request.user` claims). */
  user?: UserContext;
  /** Default directly-addressed row id (request.entityId wins). */
  entityId?: string;
  originClientId?: string;
  guardMode?: 'strict' | 'permissive';
  strictBindings?: boolean;
  contextExtensions?: EvaluationContextExtensions;
  debug?: boolean;
  logContext?: { behavior?: string; orbitalName?: string };
  /**
   * The stateless round-trip contract: a `[runtime]` entity's own row is
   * addressed via the literal sentinel id `'runtime'` when no explicit id
   * is present (the client holds that singleton row across requests). The
   * stateful server has no such contract — its `[runtime]` frames live in
   * the `frames` map only — so it leaves this unset.
   */
  runtimeRowSentinel?: boolean;
}

/** One dispatched trait's per-step effect output (see `runTraitCascade`). */
interface StepOutcome {
  results: ServerEffectResult[];
  from: string;
  to: string;
  event: string;
}

interface WorklistItem {
  trait: string;
  from: string;
  event: string;
  payload?: EventPayload;
  /** Only set for a listens-discovered item with no full row available
   *  (matches `OrbitalServerRuntime.setupEventListeners`, which also only
   *  ever forwards `entityId`, never a full row). */
  entityId?: string;
  /** In the request's own dispatch set (vs fan-out-discovered) — drives
   *  the render-effect split: only on-page traits' client effects are
   *  delivered (nothing off-page hosts the render). */
  onPage: boolean;
}

/**
 * Play one event against the resolved schema and return the wire response
 * every path speaks (`@almadar/core`'s `OrbitalEventResponse`).
 *
 * @throws Only on genuine execution failures (effect errors) — hosts map
 *   those to their transport's error shape (the stateful host's
 *   `success:false + error`, the stateless route's 500). An unknown
 *   client-declared trait name is skipped with a warning, not thrown.
 */
export async function evaluateOrbitalEvent(
  deps: EvaluateOrbitalEventDeps,
  request: OrbitalEventRequest,
): Promise<OrbitalEventResponse> {
  const { traitIndex, manager, persistence, frames } = deps;
  const event = request.event;
  const eventKey = normalizeEventKey(event);

  // Sidecars ride inside the payload on both paths; strip before dispatch.
  const rawPayload = request.payload as EventPayload | undefined;
  const activeTraitsList = rawPayload?.['_activeTraits'] as string[] | undefined;
  const activeTraits = activeTraitsList && activeTraitsList.length > 0
    ? new Set(activeTraitsList)
    : undefined;
  const targetTrait = request.targetTrait ??
    (rawPayload?.['_targetTrait'] as string | undefined);
  const cleanPayload = rawPayload ? { ...rawPayload } : undefined;
  if (cleanPayload) {
    delete cleanPayload['_activeTraits'];
    delete cleanPayload['_targetTrait'];
  }
  const relayMask = deps.relayMask ?? activeTraits;

  // ------------------------------------------------------------------
  // 1. Seed per-request state (a no-op for the stateful host, which
  //    strips `traits`/`entityByTrait` from the request).
  // ------------------------------------------------------------------
  const entityId = request.entityId ?? deps.entityId;
  if (request.traits) {
    for (const { trait, from } of request.traits) {
      manager.seedState(trait, from, entityId);
    }
  }
  // Per-trait directly-addressed row ids (a round-tripped row carrying an
  // id — including the `'runtime'` sentinel — keeps its own addressing).
  const traitEntityIds = new Map<string, string>();
  if (request.entityByTrait) {
    for (const [traitName, row] of Object.entries(request.entityByTrait)) {
      const rowId = row['id'];
      if (typeof rowId === 'string' && rowId !== '') {
        traitEntityIds.set(traitName, rowId);
        continue;
      }
      // An id-less row is the entity's shared scratch frame: fold every
      // bound trait's round-trip into the ONE row (later rows overwrite
      // on conflict — they arrive identical from the response echo).
      const entry = traitIndex.byName.get(traitName);
      if (!entry) continue;
      const existing = frames.get(entry.frameKey);
      frames.set(entry.frameKey, existing === undefined ? { ...row } : { ...existing, ...row });
    }
  }

  // ------------------------------------------------------------------
  // 2. Target resolution — client-declared (stateless: the client's own
  //    local dispatch IS the dispatch) vs discovery (stateful: the
  //    server is authoritative and asks its held states).
  // ------------------------------------------------------------------
  let targets: Array<{ trait: string; from: string }>;
  if (targetTrait !== undefined) {
    // Scoped-listen delivery: addressed to exactly one trait, bypassing
    // the active set (same contract as `sendEvent`'s `targetTrait`).
    targets = traitIndex.byName.has(targetTrait)
      ? [{ trait: targetTrait, from: manager.getState(targetTrait, entityId)?.currentState ?? findInitialState(traitIndex.byName.get(targetTrait)!.traitDef) }]
      : [];
  } else if (request.traits !== undefined) {
    if (request.traits.length === 0) {
      // An explicit empty list is an inert no-op — the client's own
      // dispatch matched nothing; consulting server state would reintroduce
      // the cross-visitor race the stateless design eliminates.
      return {
        success: true,
        transitioned: false,
        states: {},
        emittedEvents: [],
        rejections: [{ code: 'no-dispatchable-traits', event }],
      };
    }
    // Defense in depth: the client's own local dispatch is already
    // page-scoped in practice, but never trust that off-page traits
    // reach effect execution here.
    const dispatchable = new Set(
      selectDispatchCandidates(request.traits.map(({ trait }) => trait), { activeTraits }),
    );
    targets = request.traits.filter(({ trait }) => dispatchable.has(trait));
  } else {
    // Discovery: every ACTIVE trait whose held (or initial, for a fresh
    // per-request manager) state declares a matching arm — identical to
    // the stateful path's `canHandleEvent` discovery.
    const dispatchable = selectDispatchCandidates(traitIndex.byName.keys(), {
      activeTraits,
      canHandle: (trait) => manager.canHandleEvent(trait, event, entityId, request.eventId),
    });
    targets = dispatchable.map((trait) => ({
      trait,
      from: manager.getState(trait, entityId)?.currentState ?? findInitialState(traitIndex.byName.get(trait)!.traitDef),
    }));
  }

  if (targets.length === 0) {
    return {
      success: true,
      transitioned: false,
      states: {},
      emittedEvents: [],
      rejections: [{ code: 'no-dispatchable-traits', event }],
    };
  }

  // ------------------------------------------------------------------
  // 3. Payload validation (both paths converge on the stateful rule:
  //    required fields are enforced at the API boundary).
  // ------------------------------------------------------------------
  const validationFailures: PayloadValidationFailure[] = [];
  for (const { trait } of targets) {
    const entry = traitIndex.byName.get(trait);
    const eventSchema = entry?.irTrait.stateMachine?.events?.find((e) => e.key === event);
    if (eventSchema?.payloadSchema && eventSchema.payloadSchema.length > 0) {
      validationFailures.push(
        ...validateEventPayload(event, cleanPayload, eventSchema.payloadSchema),
      );
    }
  }
  if (validationFailures.length > 0) {
    return {
      success: false,
      transitioned: false,
      states: {},
      emittedEvents: [],
      error: formatPayloadValidationError(validationFailures),
    };
  }

  // ------------------------------------------------------------------
  // 4. The dispatch + fan-out worklist (one loop, one termination
  //    policy, both paths).
  // ------------------------------------------------------------------
  const states: Record<string, string> = {};
  const emittedEvents: OrbitalEventResponse['emittedEvents'] = [];
  const effectResults: ServerEffectResult[] = [];
  const clientEffects: ClientEffectTuple[] = [];
  const clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }> = [];
  const fetchedData: { [entityType: string]: EntityRow | EntityRow[] } = {};
  const entityByTrait: Record<string, EntityRow> = {};
  let transitioned = false;
  let guardFailed: string | undefined;
  const rejections: TransitionRejection[] = [];
  const truncatedTraits: string[] = [];

  const queue: WorklistItem[] = targets.map(({ trait, from }) => ({
    trait,
    from,
    event,
    payload: cleanPayload,
    entityId: traitEntityIds.get(trait) ?? entityId,
    onPage: true,
  }));
  const visited = new Set<string>();
  let steps = 0;

  while (queue.length > 0 && steps < CROSS_TRAIT_CASCADE_CAP) {
    const item = queue.shift();
    if (!item) break;
    const visitKey = `${item.trait}:${item.event}:${item.from}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    steps += 1;

    const entry = traitIndex.byName.get(item.trait);
    if (!entry) {
      // A client-declared name that isn't in the schema is garbage input
      // — skip it loudly rather than failing the whole request.
      evaluateLog.warn('dispatch:unknown-trait', { trait: item.trait, event: item.event });
      continue;
    }

    // The trait's own addressing: a forwarded/round-tripped id wins, then
    // the request-level id, then the stateless `[runtime]` sentinel.
    let currentEntityId = item.entityId ??
      (deps.runtimeRowSentinel === true && isRuntimeEntity(entry.entity) ? 'runtime' : undefined);

    const readFrame = async (): Promise<EntityRow> => {
      const persisted = currentEntityId
        ? ((await persistence.getById(entry.entity.name, currentEntityId)) ?? {})
        : {};
      return {
        ...(collectDeclaredEntityDefaults(entry.entity) ?? {}),
        ...persisted,
        ...(frames.get(entry.frameKey) ?? {}),
      };
    };

    const cascade = await runTraitCascade<StepOutcome>({
      trait: entry.traitDef,
      fromState: item.from,
      eventKey: item.event,
      payload: item.payload,
      config: entry.config,
      user: deps.user,
      ...(deps.guardMode !== undefined ? { guardMode: deps.guardMode } : {}),
      ...(deps.strictBindings !== undefined ? { strictBindings: deps.strictBindings } : {}),
      ...(deps.contextExtensions !== undefined ? { contextExtensions: deps.contextExtensions } : {}),
      getEntityData: readFrame,
      runEffects: async (stepEffects, step) => {
        const emittedStart = emittedEvents.length;
        const effectStart = effectResults.length;
        const itemClientEffects: ClientEffectTuple[] = [];
        const itemClientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }> = [];
        // A fresh persisted read per step (the stage re-merges frames +
        // declared defaults internally); a prior step's persist must be
        // visible to this step, exactly like a fresh request would.
        const persistedEntity = currentEntityId
          ? ((await persistence.getById(entry.entity.name, currentEntityId)) ?? {})
          : {};
        await deps.runEffects(item.trait, {
          effects: stepEffects as Effect[],
          payload: step.payload,
          entityData: persistedEntity,
          entityId: currentEntityId,
          emittedEvents,
          fetchedData,
          clientEffects: itemClientEffects,
          effectResults,
          ...(deps.user !== undefined ? { user: deps.user } : {}),
          clientEffectsByTrait: itemClientEffectsByTrait,
          ...(deps.originClientId !== undefined ? { originClientId: deps.originClientId } : {}),
        });
        // Render-facing effects are delivered only for traits the
        // requesting page hosts (an off-page listener's effects ran, but
        // nothing off-page renders them).
        if (item.onPage || activeTraits?.has(item.trait) === true) {
          clientEffects.push(...itemClientEffects);
          clientEffectsByTrait.push(...itemClientEffectsByTrait);
        }
        // A step's `persist create` on a row that had none mints the real
        // id — every read from here on must use it.
        if (currentEntityId === undefined) {
          const created = effectResults.slice(effectStart).find(
            (r) => r.effect === 'persist' && r.action === 'create' && r.entityType === entry.entity.name && r.success,
          );
          const createdId = (created?.data as EntityRow | undefined)?.id;
          if (typeof createdId === 'string') currentEntityId = createdId;
        }
        return {
          effectResults: [{
            results: effectResults.slice(effectStart),
            from: step.fromState,
            to: step.toState,
            event: step.event,
          }],
          emitted: emittedEvents.slice(emittedStart),
        };
      },
      ...(deps.logContext !== undefined ? { logContext: deps.logContext } : {}),
    });

    // Commit the cascade's final state (+ observer trace per hop — the
    // same contract `sendEvent` fulfills for the verification registry).
    manager.commitState(
      item.trait,
      cascade.finalState,
      currentEntityId,
      item.event,
      cascade.executed
        ? cascade.effectResults.map((s) => ({ from: s.from, to: s.to, event: s.event }))
        : undefined,
    );
    states[item.trait] = cascade.finalState;
    transitioned = transitioned || cascade.executed;
    for (const step of cascade.effectResults) effectResults.push(...step.results);

    // Structured rejection per non-fired dispatch (reported only when
    // NOTHING transitioned, below).
    if (!cascade.executed) {
      const candidate = findTransition(entry.traitDef, item.from, normalizeEventKey(item.event));
      if (candidate !== undefined) {
        if (guardFailed === undefined) guardFailed = `${item.trait}.${item.event}`;
        rejections.push({
          code: 'guard-rejected',
          trait: item.trait,
          from: item.from,
          event: item.event,
          transition: `${item.from}--${normalizeEventKey(item.event)}-->${candidate.to}`,
          ...(candidate.guard !== undefined ? { guard: candidate.guard } : {}),
        });
      } else {
        rejections.push({
          code: 'no-matching-transition',
          trait: item.trait,
          from: item.from,
          event: item.event,
          statesDeclaringEvent: statesDeclaringEvent(entry.traitDef, normalizeEventKey(item.event)),
        });
      }
    }

    // The response-side entity round-trip: the trait's final row (fresh
    // persisted read layered under its frame).
    entityByTrait[item.trait] = await readFrame();

    // Cross-trait `listens` fan-out: any event a step emitted that
    // ANOTHER trait declares a matching listen for gets that trait's own
    // transition run too. Skipped for relay-masked traits — the origin
    // client's own relay completes those (its mounted set is the mask).
    for (const emitted of cascade.emitted) {
      for (const [listenerName, listenerEntry] of traitIndex.byName) {
        if (relayMask?.has(listenerName) === true) continue;
        const listeners = (listenerEntry.traitDef.listens ?? []) as TraitEventListener[];
        for (const listener of listeners) {
          const { bareEvent, matcher } = parseListenSource(listener, listenerEntry.orbitalName);
          if (bareEvent !== emitted.event || !matcher(emitted.source)) continue;

          // Listen-level guard, kernel parity: evaluated against the RAW
          // payload before payload mapping; false or an error skips.
          if (listener.guard) {
            let guardPassed: boolean;
            try {
              guardPassed = evaluateGuard(
                listener.guard as SExpr,
                createMinimalContext({}, emitted.payload),
              );
            } catch {
              guardPassed = false;
            }
            if (!guardPassed) continue;
          }

          const mappedPayload = applyListenPayloadMapping(
            listener.payloadMapping,
            emitted.payload,
            evaluateListenPayloadExpr,
          );
          const pickId = (field: string): string | undefined =>
            (mappedPayload?.[field] as string | undefined) ?? (emitted.payload?.[field] as string | undefined);
          const forwardedEntityId = pickId('entityId') ?? pickId('orbitalName');

          // Mark consumed so the client's own relay (if the source trait
          // is also on-page) doesn't ALSO re-apply this hop.
          emitted.source = { ...emitted.source, dispatched: true };

          queue.push({
            trait: listenerName,
            from: manager.getState(listenerName, forwardedEntityId)?.currentState ??
              findInitialState(listenerEntry.traitDef),
            event: listener.triggers,
            payload: mappedPayload,
            ...(forwardedEntityId !== undefined ? { entityId: forwardedEntityId } : {}),
            onPage: activeTraits?.has(listenerName) === true,
          });
        }
      }
    }
  }

  if (queue.length > 0) {
    for (const remaining of queue) {
      if (!truncatedTraits.includes(remaining.trait)) truncatedTraits.push(remaining.trait);
    }
    evaluateLog.warn('cascade-truncated', {
      event,
      steps,
      dropped: truncatedTraits,
      ...(deps.logContext ?? {}),
    });
  }

  // Echo every non-empty frame to EVERY trait bound to it, not just the
  // ones this cascade evaluated — a bound trait that never ran must still
  // converge its row, or its stale round-trip clobbers the fresh one in
  // the NEXT request's merge.
  for (const [frameKey, row] of frames) {
    if (Object.keys(row).length === 0) continue;
    for (const [traitName, entry] of traitIndex.byName) {
      if (entry.frameKey !== frameKey) continue;
      if (entityByTrait[traitName] !== undefined) continue;
      entityByTrait[traitName] = { ...row };
    }
  }

  // The full state picture: everything the manager holds (the stateful
  // contract — every registered trait) overlaid with every trait this
  // dispatch evaluated (the stateless contract — only dispatched traits
  // exist in a per-request manager, so this union IS its contract too).
  const allStates: Record<string, string> = {};
  for (const [name, state] of manager.getAllStates()) {
    allStates[name] = state.currentState;
  }
  Object.assign(allStates, states);

  return {
    success: true,
    transitioned,
    states: allStates,
    emittedEvents,
    ...(Object.keys(entityByTrait).length > 0 ? { entityByTrait } : {}),
    ...(clientEffects.length > 0 ? { clientEffects } : {}),
    ...(clientEffectsByTrait.length > 0 ? { clientEffectsByTrait } : {}),
    ...(effectResults.length > 0 ? { effectResults } : {}),
    ...(guardFailed !== undefined ? { guardFailed } : {}),
    ...(!transitioned && rejections.length > 0 ? { rejections } : {}),
    ...(truncatedTraits.length > 0 ? { cascadeTruncated: truncatedTraits } : {}),
  };
}

/**
 * States whose transition table declares `eventKey` — collected from the
 * trait's WHOLE table (not just the current state), so a rejection can
 * say "you dispatched from `X`, but only states `Y`/`Z` handle this
 * event" (a stale-state signal for the client).
 */
function statesDeclaringEvent(
  traitDef: { transitions: Array<{ event: string; from: string | string[] }> },
  eventKey: string,
): string[] {
  const declaring = new Set<string>();
  for (const t of traitDef.transitions) {
    if (t.event !== eventKey) continue;
    if (Array.isArray(t.from)) {
      for (const f of t.from) declaring.add(f);
    } else {
      declaring.add(t.from);
    }
  }
  return Array.from(declaring);
}
