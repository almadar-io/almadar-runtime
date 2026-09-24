/**
 * evaluateOrbitalEvent — THE event-evaluation composition, one owner for
 * every server-side execution path (design: docs/Almadar_Runtime_Stateless_Stateful_PLAN.md).
 *
 * A deployment differs from another ONLY in the deps it supplies:
 *
 * - **Stateful** (`OrbitalServerRuntime`): a long-lived `manager` holding
 *   every registered trait's state, a long-lived `frames` map
 *   (`traitFieldStates`), and a `runEffects` runner whose stage delivers
 *   emits to the live broadcast. The host strips `request.traits` /
 *   `request.entityByTrait` from NON-TARGETED requests — the server is
 *   authoritative and discovers targets via `canHandleEvent` over its own
 *   held states. A TARGETED request carrying circuit state is the client
 *   role's delegated server leg and passes through: the seed's `from`
 *   and `[runtime]` rows are the client's truth, and the relay mask
 *   derived for it is empty (the server runs the whole circuit).
 *   Cross-orbital listeners (a different registered orbital's trait) are
 *   the host's relay, driven by the exported {@link collectListenerTargets}.
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
  type BusEventSource,
  type ClientEffectByTrait,
  type ClientEffectTuple,
  type EntityRow,
  type EventId,
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
  evaluateGuard,
  evaluateListenPayloadExpr,
} from '@almadar/evaluator';
import { createContextFromBindings } from './BindingResolver.js';
import {
  findInitialState,
  findTransition,
  normalizeEventKey,
  runTraitCascade,
  selectDispatchCandidates,
  StateMachineManager,
} from '../index.js';
import { parseListenSource } from '../events/identity/routing.js';
import { collectDeclaredEntityDefaults } from '../traits/config-defaults.js';
import type { ServerEffectStageArgs } from '../effects/effect-stage.js';
import {
  formatPayloadValidationError,
  validateEventPayload,
  type PayloadValidationFailure,
} from '../traits/PayloadValidator.js';
import type { IndexedTrait, TraitIndex } from '../traits/trait-index.js';
import type { BindingContext, EvaluationContextExtensions } from '../types.js';
import type { PersistenceAdapter } from '../entities/PersistenceAdapter.js';
import { dispatchVisitKey, type DeliveryRecord, type SExpr } from '@almadar/core';
import { isLifecycleEvent, type MountLifecycle } from './mount-lifecycle.js';
import { DispatchMemory } from './dispatch-memory.js';

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
   * relay/mount/dispatch completes them). When omitted, the composition
   * derives the mask from the request's shape: a delegated server leg masks
   * nothing (the client folds, never relays); a client-declared dispatch
   * masks the declared set (those traits already ran on the client); a
   * discovery dispatch masks the resolved targets (the server just ran
   * them, and the mount-time client did no local dispatch at all).
   * Off-page listeners (never mounted on the origin page) always run
   * server-side — G-RUNTIME-031.
   */
  relayMask?: ReadonlySet<string>;
  /** Normalized viewer (hosts normalize `request.user` claims). */
  user?: UserContext;
  /** Override for the dispatch's `now` stamp (tests); otherwise stamped once at entry. */
  now?: number;
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
  /**
   * `(trait, event)` pairs the caller already delivered elsewhere (the client
   * role's `alreadyDeliveredKey` format). The worklist skips them on every
   * path, not only at the top level; twin of Rust `run_cascade`'s
   * `already_delivered`. Hosts that deliver every emit themselves leave it unset.
   */
  seedVisited?: ReadonlySet<string>;
  /** The mount's lifecycle: routed deliveries to a trait wait for its own INIT/LOAD/$MOUNT (see `mount-lifecycle.ts`). */
  mount?: MountLifecycle<WorklistItem>;
  /** `@event` for the seed when it is itself a delivery (a relayed or folded emit); a direct dispatch has none. */
  seedDelivery?: DeliveryRecord;
}

/** One dispatched trait's per-step effect output (see `runTraitCascade`). */
interface StepOutcome {
  results: ServerEffectResult[];
  from: string;
  to: string;
  event: string;
}

export interface WorklistItem {
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
  /** What `@event` reads for this delivery (the source emit for a listens delivery). */
  delivery: DeliveryRecord;
  /** A listens `when`, evaluated when the delivery is processed so it sees the listener's log. */
  listenGuard?: SExpr;
  /** A fan-out delivery runs from the listener's state when it is processed, not when it was queued (Clause 5.3). */
  fromAtDelivery?: boolean;
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
  const now = deps.now ?? Date.now();
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
  const awaitingSidecar = rawPayload?.['_awaitingInit'];
  const awaitingInit = Array.isArray(awaitingSidecar)
    ? awaitingSidecar.filter((t): t is string => typeof t === 'string')
    : undefined;
  const cleanPayload = rawPayload ? { ...rawPayload } : undefined;
  if (cleanPayload) {
    delete cleanPayload['_activeTraits'];
    delete cleanPayload['_targetTrait'];
    delete cleanPayload['_awaitingInit'];
  }
  const delegatedServerLeg = request.targetTrait !== undefined &&
    (request.traits !== undefined || request.entityByTrait !== undefined);

  // ------------------------------------------------------------------
  // 1. Seed per-request state (a no-op for the stateful host, which
  //    strips `traits`/`entityByTrait` from the request). `traits`
  //    seeding happens in the explicit-dispatch branch BELOW, after the
  //    active-set filter — a filtered-out off-page declaration is
  //    deliberately never seeded (it neither transitions nor appears in
  //    the response's `states` map).
  // ------------------------------------------------------------------
  const entityId = request.entityId ?? deps.entityId;
  // Per-trait directly-addressed row ids (a round-tripped row carrying an
  // id — including the `'runtime'` sentinel — keeps its own addressing).
  const traitEntityIds = new Map<string, string>();
  if (request.entityByTrait) {
    for (const [traitName, row] of Object.entries(request.entityByTrait)) {
      const rowId = row['id'];
      const entry = traitIndex.byName.get(traitName);
      if (typeof rowId === 'string' && rowId !== '') {
        traitEntityIds.set(traitName, rowId);
        // A `[runtime]` entity has no authoritative store — the client's
        // round-trip IS the source of truth (the id is only addressing, the
        // `'runtime'` sentinel included). Fold the row into the frame like
        // an id-less one so `set`-written fields survive the round-trip; a
        // persisted read (the host's mock seed) merges underneath it.
        if (entry && isRuntimeEntity(entry.entity)) {
          const existing = frames.get(entry.frameKey);
          frames.set(entry.frameKey, existing === undefined ? { ...row } : { ...existing, ...row });
        }
        continue;
      }
      // An id-less row is the entity's shared scratch frame: fold every
      // bound trait's round-trip into the ONE row (later rows overwrite
      // on conflict — they arrive identical from the response echo).
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
  const targetEntry = targetTrait !== undefined ? traitIndex.byName.get(targetTrait) : undefined;
  // The payload `_targetTrait` sidecar is the CLIENT's page-scoped fallback
  // (its own local dispatch could not reach the trait) — it never bypasses
  // the page's active set. The canonical `request.targetTrait` field is the
  // server-authoritative scoped-listen delivery, which does (G-RUNTIME-031:
  // an off-page listener must still run).
  const sidecarOutOfScope = request.targetTrait === undefined &&
    activeTraits !== undefined && targetTrait !== undefined && !activeTraits.has(targetTrait);
  if (targetTrait !== undefined) {
    if (sidecarOutOfScope || targetEntry === undefined) {
      targets = [];
    } else {
      const declared = request.traits?.find((t) => t.trait === targetTrait);
      const from = declared?.from ?? manager.getState(targetTrait, entityId)?.currentState ??
        findInitialState(targetEntry.traitDef);
      // Whose truth is `from`? The canonical `request.targetTrait` (the
      // server-authoritative scoped delivery) and a client-DECLARED trait
      // both dispatch from a known state in every case. The client-fallback
      // SIDECAR, though, may only guess an initial state for a SINGLE-state
      // trait (its one state is a fact) — a stateless server can never know
      // a multi-state trait's current state, and guessing could fire an arm
      // the client already left. (The stateful host's manager lazy-inits
      // never-used traits to their declared initial state — server-held
      // truth — so this gate only ever fires on the stateless path.)
      const stateIsFact = request.targetTrait !== undefined || declared !== undefined ||
        (targetEntry.traitDef.states?.length ?? 0) === 1;
      targets = stateIsFact ? [{ trait: targetTrait, from }] : [];
    }
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
    // Seed the surviving declarations (the client's own current states).
    for (const { trait, from } of targets) {
      manager.seedState(trait, from, entityId);
    }
  } else {
    // Discovery (a fresh mount — the stateful host's registration-time
    // contract): materialize EVERY active trait's declared initial state
    // first (`getState`'s lazy init IS the seed — it materializes only
    // when absent, so a long-lived stateful manager's live states are never
    // clobbered), so the response's `states` map echoes the whole active
    // set, then dispatch only the traits whose held state declares a
    // matching arm.
    const activeSet = selectDispatchCandidates(traitIndex.byName.keys(), { activeTraits });
    for (const trait of activeSet) {
      if (traitIndex.byName.has(trait)) manager.getState(trait, entityId);
    }
    const dispatchable = selectDispatchCandidates(activeSet, {
      activeTraits,
      canHandle: (trait) => manager.canHandleEvent(trait, event, entityId, request.eventId),
    });
    targets = dispatchable.map((trait) => ({
      trait,
      from: manager.getState(trait, entityId)?.currentState ?? findInitialState(traitIndex.byName.get(trait)!.traitDef),
    }));
  }

  if (targets.length === 0) {
    // Discovery echoes the manager's held states even when NOTHING could
    // handle the event — a fresh mount's INIT asks "what is everything on
    // this page's state?", and the materialized active set IS the answer
    // (the client-declared/targetTrait no-op shapes stay bare `{}`).
    const discoveryEcho = request.traits === undefined && targetTrait === undefined;
    const heldStates: Record<string, string> = {};
    if (discoveryEcho) {
      for (const [name, state] of manager.getAllStates()) {
        heldStates[name] = state.currentState;
      }
    }
    return {
      success: true,
      transitioned: false,
      states: heldStates,
      emittedEvents: [],
      rejections: [{ code: 'no-dispatchable-traits', event }],
    };
  }

  // The relay mask — traits the CLIENT completes itself, which the fan-out
  // therefore skips — is topology-derived (an explicit `deps.relayMask`
  // always wins):
  // - A DELEGATED server leg (canonical `targetTrait` + carried circuit
  //   state): the client folds the response instead of relaying anything —
  //   nothing is client-completed, the mask is empty, and the server runs
  //   the whole circuit (incl. a delegated fetch's listeners,
  //   G-RUNTIME-029).
  // - Client-declared dispatch: the mask is the DECLARED set — those traits
  //   already ran on the client (a re-dispatch would double-apply their
  //   effects); a listen-armed trait NOT in the dispatch set (the chat
  //   thread) ran nowhere client-side and MUST run here.
  // - Discovery (mount-time INIT, no local dispatch): the mask is the
  //   resolved target set — the server just ran those; everything else
  //   (a listener that didn't match the original event) runs here too,
  //   the pre-unification stateless contract.
  const relayMask = deps.relayMask ?? (delegatedServerLeg
    ? undefined
    : request.traits !== undefined
      ? new Set(request.traits.map((t) => t.trait))
      : new Set(targets.map((t) => t.trait)));

  evaluateLog.info('dispatch:targets', {
    event,
    mode: request.traits !== undefined
      ? 'declared'
      : targetTrait !== undefined ? 'targetTrait' : 'discovery',
    targets: targets.map((t) => `${t.trait}@${t.from}`),
    ...(relayMask !== undefined ? { relayMask: [...relayMask] } : {}),
    ...(deps.logContext ?? {}),
  });

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
  const clientEffectsByTrait: ClientEffectByTrait[] = [];
  const fetchedData: { [entityType: string]: EntityRow | EntityRow[] } = {};
  const entityByTrait: Record<string, EntityRow> = {};
  let transitioned = false;
  let guardFailed: string | undefined;
  const rejections: TransitionRejection[] = [];
  const truncatedTraits: string[] = [];

  const seedDelivery: DeliveryRecord = deps.seedDelivery ?? request.delivery ??
    { event, ...(cleanPayload !== undefined ? { payload: cleanPayload } : {}), source: {} };
  const queue: WorklistItem[] = targets.map(({ trait, from }) => ({
    trait,
    from,
    event,
    payload: cleanPayload,
    entityId: traitEntityIds.get(trait) ?? entityId,
    onPage: true,
    delivery: seedDelivery,
  }));
  // A server leg carries the client's mount: deliveries held for a trait the
  // client has since initialized go out first, ahead of this request's seeds.
  if (deps.mount !== undefined && awaitingInit !== undefined) {
    const lifecycleTarget = isLifecycleEvent(event) ? targetTrait : undefined;
    queue.unshift(...deps.mount.sync(awaitingInit, lifecycleTarget));
  }
  const memory = new DispatchMemory();
  if (request.dispatchLog !== undefined && request.targetTrait !== undefined) {
    memory.seed(request.targetTrait, request.dispatchLog);
  }
  // A trait's own addressing, the ONE rule both a step (which commits state
  // under it) and the fan-out (which reads a listener's from-state under
  // it) use: a forwarded/round-tripped id wins, then the stateless
  // `[runtime]` sentinel.
  // The scope a trait last committed under in THIS request is its address for
  // every later delivery.
  const scopeByTrait = new Map<string, string | undefined>();
  // A row a step minted mid-arm (persist create): later READS use it, the
  // state machine stays addressed where the event came in.
  const rowByTrait = new Map<string, string>();
  const stepEntityId = (traitName: string, entry: IndexedTrait, forwarded: string | undefined): string | undefined =>
    forwarded ??
    (scopeByTrait.has(traitName) ? scopeByTrait.get(traitName) : undefined) ??
    (deps.runtimeRowSentinel === true && isRuntimeEntity(entry.entity) ? 'runtime' : undefined);
  // Traits the requester itself dispatched are on its page by construction
  // — a fan-out landing back on one must still deliver its render.
  const requesterTraits = new Set(targets.map((t) => t.trait));
  const visited = new Set<string>();
  let steps = 0;

  while (queue.length > 0 && steps < CROSS_TRAIT_CASCADE_CAP) {
    const item = queue.shift();
    if (!item) break;
    if (item.fromAtDelivery === true) {
      const listenerEntry = traitIndex.byName.get(item.trait);
      if (listenerEntry !== undefined) {
        item.from = manager.getState(item.trait, stepEntityId(item.trait, listenerEntry, item.entityId))?.currentState ??
          findInitialState(listenerEntry.traitDef);
      }
    }
    if (deps.seedVisited?.has(alreadyDeliveredKey(item.trait, item.event)) === true) {
      evaluateLog.info('dispatch:already-delivered', {
        trait: item.trait,
        event: item.event,
        from: item.from,
        ...(deps.logContext ?? {}),
      });
      continue;
    }
    if (item.fromAtDelivery === true && !isLifecycleEvent(item.event) && deps.mount?.isAwaiting(item.trait) === true) {
      evaluateLog.info('fanout:held-until-init', { trait: item.trait, event: item.event, ...(deps.logContext ?? {}) });
      deps.mount.hold(item.trait, item);
      continue;
    }
    const visitKey = dispatchVisitKey(item.trait, item.event, item.from, item.payload);
    if (visited.has(visitKey)) continue;
    if (item.listenGuard !== undefined && !listenGuardPasses(item.listenGuard, {
      payload: item.delivery.payload,
      state: item.from,
      fromState: item.from,
      ...memory.view(item.trait, item.delivery),
    })) {
      evaluateLog.info('fanout:listen-guard-blocked', { trait: item.trait, event: item.event, ...(deps.logContext ?? {}) });
      continue;
    }
    visited.add(visitKey);
    steps += 1;

    const entry = traitIndex.byName.get(item.trait);
    if (!entry) {
      // A client-declared name that isn't in the schema is garbage input
      // — skip it loudly rather than failing the whole request.
      evaluateLog.warn('dispatch:unknown-trait', { trait: item.trait, event: item.event });
      continue;
    }

    const currentEntityId = stepEntityId(item.trait, entry, item.entityId);
    let rowId = rowByTrait.get(item.trait) ?? currentEntityId;

    const readFrame = async (): Promise<EntityRow> => {
      const persisted = rowId
        ? ((await persistence.getById(entry.entity.name, rowId)) ?? {})
        : {};
      return {
        ...(collectDeclaredEntityDefaults(entry.entity) ?? {}),
        ...persisted,
        ...(frames.get(entry.frameKey) ?? {}),
      };
    };

    const cascade = await runTraitCascade<StepOutcome>({
      trait: entry.traitDef,
      delivery: item.delivery,
      memory,
      fromState: item.from,
      eventKey: item.event,
      payload: item.payload,
      config: entry.config,
      user: deps.user,
      now,
      ...(deps.guardMode !== undefined ? { guardMode: deps.guardMode } : {}),
      ...(deps.strictBindings !== undefined ? { strictBindings: deps.strictBindings } : {}),
      ...(deps.contextExtensions !== undefined ? { contextExtensions: deps.contextExtensions } : {}),
      getEntityData: readFrame,
      runEffects: async (stepEffects, step) => {
        const emittedStart = emittedEvents.length;
        const effectStart = effectResults.length;
        const itemClientEffects: ClientEffectTuple[] = [];
        const itemClientEffectsByTrait: ClientEffectByTrait[] = [];
        // A fresh persisted read per step (the stage re-merges frames +
        // declared defaults internally); a prior step's persist must be
        // visible to this step, exactly like a fresh request would.
        const persistedEntity = rowId
          ? ((await persistence.getById(entry.entity.name, rowId)) ?? {})
          : {};
        await deps.runEffects(item.trait, {
          effects: stepEffects,
          payload: step.payload,
          entityData: persistedEntity,
          entityId: rowId,
          emittedEvents,
          fetchedData,
          clientEffects: itemClientEffects,
          effectResults,
          ...(deps.user !== undefined ? { user: deps.user } : {}),
          now,
          clientEffectsByTrait: itemClientEffectsByTrait,
          firing: { event: step.event, fromState: step.fromState },
          ...(deps.originClientId !== undefined ? { originClientId: deps.originClientId } : {}),
          dispatch: step.dispatch,
        });
        // Render-facing effects are delivered only for traits the
        // requesting page hosts (an off-page listener's effects ran, but
        // nothing off-page renders them).
        if (item.onPage || activeTraits?.has(item.trait) === true) {
          clientEffects.push(...itemClientEffects);
          clientEffectsByTrait.push(...itemClientEffectsByTrait);
        }
        // A step's `persist create` on a row that had none mints the real
        // id — every read from here on uses it; the state stays addressed
        // where the event came in. A `[shared]` entity's frame is the one
        // working instance its traits share: a create records a row, it
        // never re-addresses that instance.
        if (rowId === undefined && !entry.isSharedEntity) {
          const created = effectResults.slice(effectStart).find(
            (r) => r.effect === 'persist' && r.action === 'create' && r.entityType === entry.entity.name && r.success,
          );
          const createdId = (created?.data as EntityRow | undefined)?.id;
          if (typeof createdId === 'string') {
            rowId = createdId;
            rowByTrait.set(item.trait, createdId);
          }
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
    scopeByTrait.set(item.trait, currentEntityId);
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
    evaluateLog.info('dispatch:step', {
      trait: item.trait,
      event: item.event,
      from: item.from,
      to: cascade.finalState,
      executed: cascade.executed,
      emitted: cascade.emitted.length,
      onPage: item.onPage,
      ...(deps.logContext ?? {}),
    });
    // NOTE: the step runner already appended each step's results to the
    // SHARED `effectResults` array (it receives the array in its args) —
    // `cascade.effectResults`' slices are the cascade's own bookkeeping
    // (commitState's hop trace), re-pushing them here double-counted every
    // effect (seen as a duplicated persist entry in the client-role fold).

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
      const rejection = rejections[rejections.length - 1];
      evaluateLog.info('dispatch:rejected', {
        code: rejection.code,
        trait: item.trait,
        from: item.from,
        event: item.event,
        ...(rejection.transition !== undefined ? { transition: rejection.transition } : {}),
        ...(candidate?.guard !== undefined ? { guard: JSON.stringify(candidate.guard) } : {}),
        ...(deps.logContext ?? {}),
      });
    }

    // The response-side entity round-trip: the trait's final row (fresh
    // persisted read layered under its frame).
    entityByTrait[item.trait] = await readFrame();

    // Cross-trait `listens` fan-out: any event a step emitted that
    // ANOTHER trait declares a matching listen for gets that trait's own
    // transition run too. Skipped for relay-masked traits — the origin
    // client's own relay completes those (its mounted set is the mask).
    if (isLifecycleEvent(item.event) && deps.mount?.isAwaiting(item.trait) === true) {
      for (const held of deps.mount.initialized(item.trait)) queue.push(held);
    }
    for (const emitted of cascade.emitted) {
      const delivery = deliveryOf(emitted);
      for (const target of collectListenerTargets(traitIndex, emitted.source, emitted.event, emitted.payload, relayMask, { deferGuards: true })) {
        // Mark consumed so the client's own relay (if the source trait
        // is also on-page) doesn't ALSO re-apply this hop.
        emitted.source = { ...emitted.source, dispatched: true };

        evaluateLog.info('fanout:enqueue', {
          listener: target.listenerTrait,
          triggers: target.triggers,
          source: emitted.source.trait ?? emitted.source.orbital,
          event: emitted.event,
          ...(deps.logContext ?? {}),
        });

        queue.push({
          trait: target.listenerTrait,
          from: findInitialState(target.entry.traitDef),
          fromAtDelivery: true,
          event: target.triggers,
          payload: target.payload,
          ...(target.entityId !== undefined ? { entityId: target.entityId } : {}),
          // Withheld only when the requester's page is KNOWN and excludes it
          // — the client filters renders by its own mounted set anyway.
          onPage: activeTraits === undefined || activeTraits.has(target.listenerTrait) || requesterTraits.has(target.listenerTrait),
          delivery,
          ...(target.listener.guard !== undefined ? { listenGuard: target.listener.guard as SExpr } : {}),
        });
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
 * One matched `listens` subscriber: the listener trait plus everything a
 * dispatch of its `triggers` event needs (mapped payload, forwarded row
 * id, the trigger's V4 id for rename-proof matching).
 */
/** The record `@event` reads for an emit delivered to a listener. */
export function deliveryOf(emitted: { event: string; payload?: EventPayload; source?: BusEventSource }): DeliveryRecord {
  return {
    event: emitted.event,
    ...(emitted.payload !== undefined ? { payload: emitted.payload } : {}),
    source: { ...(emitted.source ?? {}) },
  };
}

/** A listens `when` view for a delivery that starts a fresh dispatch: the emit as `@event`, empty logs. */
export function freshDeliveryGuardBindings(
  delivery: DeliveryRecord,
  stateOf: (listenerTrait: string) => string,
): (listenerTrait: string) => BindingContext {
  return (listenerTrait) => {
    const state = stateOf(listenerTrait);
    return {
      payload: delivery.payload,
      state,
      fromState: state,
      ...new DispatchMemory().view(listenerTrait, delivery),
    };
  };
}

/** A listens `when` over the listener's view; an evaluation error blocks the delivery. */
function listenGuardPasses(guard: SExpr, bindings: BindingContext): boolean {
  try {
    return evaluateGuard(guard, createContextFromBindings(bindings));
  } catch {
    return false;
  }
}

/** A `(trait, event)` pair a client already delivered; the one format `seedVisited` and `alreadyDeliveredFrom` share. */
export function alreadyDeliveredKey(trait: string, event: string): string {
  return `${trait}\u0000${event}`;
}

export interface CollectedListenerTarget {
  listenerTrait: string;
  /** The listener's index entry (initial-state fallback, emit stamping). */
  entry: IndexedTrait;
  /** The matched listener declaration (guard already applied). */
  listener: TraitEventListener;
  triggers: string;
  triggersId?: EventId;
  payload: EventPayload | undefined;
  entityId: string | undefined;
}

/**
 * Find every trait in `traitIndex` whose declared `listens` reacts to
 * `event` from `sourceStamp` — the ONE listens-matching implementation,
 * shared by the composition's in-band fan-out, the stateful host's
 * cross-orbital relay, and the client role's response fold (the twin of
 * `orbital-core::collect_listener_targets`).
 *
 * Semantics (kernel parity): the listen-level guard runs against the RAW
 * payload before payload mapping; false or an evaluation error skips.
 * `skip` is the relay mask — traits the requesting client completes
 * itself, which the fan-out therefore never re-dispatches.
 */
export function collectListenerTargets(
  traitIndex: TraitIndex,
  sourceStamp: BusEventSource | undefined,
  event: string,
  payload: EventPayload | undefined,
  skip?: ReadonlySet<string>,
  opts: {
    /** Leave each `when` to the caller, which evaluates it at delivery time. */
    deferGuards?: boolean;
    /** The listener's view for a `when` evaluated here (a fresh dispatch: empty logs). */
    guardBindings?: (listenerTrait: string) => BindingContext;
  } = {},
): CollectedListenerTarget[] {
  const targets: CollectedListenerTarget[] = [];
  for (const [listenerName, listenerEntry] of traitIndex.byName) {
    const masked = skip?.has(listenerName) === true;
    const listeners = (listenerEntry.traitDef.listens ?? []) as TraitEventListener[];
    for (const listener of listeners) {
      const { bareEvent, matcher } = parseListenSource(listener, listenerEntry.orbitalName);
      if (bareEvent !== event || !matcher(sourceStamp)) continue;
      if (masked) {
        evaluateLog.info('fanout:masked', {
          listener: listenerName,
          event,
          source: sourceStamp?.trait ?? sourceStamp?.orbital,
        });
        continue;
      }

      if (listener.guard && opts.deferGuards !== true) {
        const bindings = opts.guardBindings?.(listenerName) ?? { payload };
        if (!listenGuardPasses(listener.guard as SExpr, bindings)) continue;
      }

      const mappedPayload = applyListenPayloadMapping(
        listener.payloadMapping,
        payload,
        evaluateListenPayloadExpr,
      );
      const pickId = (field: string): string | undefined =>
        (mappedPayload?.[field] as string | undefined) ?? (payload?.[field] as string | undefined);

      targets.push({
        listenerTrait: listenerName,
        entry: listenerEntry,
        listener,
        triggers: listener.triggers,
        ...(listener.triggersId !== undefined ? { triggersId: listener.triggersId } : {}),
        payload: mappedPayload,
        entityId: pickId('entityId') ?? pickId('orbitalName'),
      });
    }
  }
  return targets;
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
