/**
 * client-role — P4, `docs/Almadar_Runtime_Stateless_Stateful_PLAN.md` §4.2.
 *
 * The JS twin of `orbital-client`'s `ClientKernel` (`client_kernel.rs`) +
 * `orbital-core`'s `RuntimeKernel::{dispatch_with_server_leg,
 * apply_server_response}` / `already_delivered_from`. One in-process Client-
 * env dispatch through the SAME `evaluateOrbitalEvent` composition every
 * other role runs, plus the ONE mode rule (`DispatchMode.compute`, mirrored
 * 1:1 in `@almadar/core`) for whether/how a server leg posts.
 *
 * Rust → JS map:
 * - `RuntimeKernel::dispatch_with_server_leg`  → `dispatchWithServerLeg`
 * - `already_delivered_from`                   → `alreadyDeliveredFrom`
 * - `RuntimeKernel::apply_server_response`     → `applyOrbitalEventResponse`
 * - `ClientKernel::dispatch`'s mode match       → `postServerLeg`
 * - `RuntimeKernel::snapshot_trait`/`restore_trait` → `CircuitStore.snapshot`/`.restore`
 * - `ServerLegCollector` (`server_leg.rs`)     → `./server-leg.js`'s `ServerLegCollector`
 *
 * @packageDocumentation
 */
import type {
  DispatchMode,
  EventPayload,
  OrbitalEventRequest,
  OrbitalEventResponse,
  SExpr,
  TraitEventListener,
  UserContext,
} from '@almadar/core';
import { applyListenPayloadMapping, type BusEventSource, type ClientEffectTuple } from '@almadar/core';
import { createLogger } from '@almadar/logger';
import { createMinimalContext, evaluateGuard, evaluateListenPayloadExpr } from '@almadar/evaluator';
import { evaluateOrbitalEvent, type EvaluateEffectRunner, type EvaluateOrbitalEventDeps } from './evaluateOrbitalEvent.js';
import { findInitialState } from '../traits/StateMachineCore.js';
import type { TraitIndex } from '../traits/trait-index.js';
import type { CircuitStore, TraitSnapshot } from './circuit-store.js';
import { EffectExecutor, clientResolvesRenderBindings } from '../effects/EffectExecutor.js';
import { createClientEffectHandlers } from '../effects/ClientEffectHandlers.js';
import { ServerLegCollector } from '../effects/server-leg.js';
import { parseListenSource } from '../events/identity/routing.js';
import { InMemoryPersistence, type PersistenceAdapter } from '../entities/PersistenceAdapter.js';
import type { EventTransport } from '../server/EventTransport.js';
import type { EvaluationContextExtensions } from '../types.js';

const clientRoleLog = createLogger('almadar:runtime:client-role');

/**
 * Everything the client role needs, held by the caller (an `OrbPreview`,
 * `BrowserPlayground`, or headless test harness) across every dispatch.
 * Mirrors `EvaluateOrbitalEventDeps` for the scalars every deployment
 * shares; `store`/`carriesCircuitState` are the client-role-specific pieces.
 */
export interface ClientRoleOpts {
  orbitalName: string;
  traitIndex: TraitIndex;
  store: CircuitStore;
  /** Offline-preview adapter, or omitted — real persist/fetch/call-service
   *  never reach it (the Client-env delegate intercepts them first); it is
   *  read only for the composition's own frame/persisted-row merge. */
  persistence?: PersistenceAdapter;
  user?: UserContext;
  guardMode?: 'strict' | 'permissive';
  strictBindings?: boolean;
  contextExtensions?: EvaluationContextExtensions;
  debug?: boolean;
  logContext?: { behavior?: string; orbitalName?: string };
  /**
   * From the transport's `register()` result (`EventTransportRegisterResult
   * .carriesCircuitState`): `true` = the stateless topology, a posted leg
   * must carry `traits`/`entityByTrait`; `false` = the host holds circuit
   * state itself, and the leg drops them. Read only by `postServerLeg`.
   */
  carriesCircuitState: boolean;
}

/**
 * One `dispatchWithServerLeg` call's outcome — the twin of
 * `orbital-core`'s `ClientDispatch`. Rust's struct omits the seed trait's
 * own name/entityId/frameKey because `dispatch()`'s CALLER already has them
 * in scope (they're that function's own parameters); JS's `postServerLeg`
 * needs them to roll back the right trait instance on failure, so they
 * travel on the value instead.
 */
export interface ClientDispatch {
  response: OrbitalEventResponse;
  serverLeg?: OrbitalEventRequest;
  mode: DispatchMode;
  snapshot?: TraitSnapshot;
  trait: string;
  entityId?: string;
  frameKey: string;
}

const alreadyDeliveredKey = (trait: string, event: string): string => `${trait}\u0000${event}`;

/**
 * The `(trait, event)` pairs a `ClientDispatch` already realized LOCALLY —
 * every event its own local run emitted, plus the seed dispatch itself (a
 * leg's `targetTrait`/`event` ARE the seed trait's own dispatch — see
 * `dispatchWithServerLeg`). Pass the result to `applyOrbitalEventResponse`
 * so a folded echo of an event this client already ran doesn't run it
 * again. Twin of `orbital-core::already_delivered_from`.
 */
export function alreadyDeliveredFrom(dispatch: ClientDispatch): Set<string> {
  const set = new Set<string>();
  for (const emitted of dispatch.response.emittedEvents) {
    set.add(alreadyDeliveredKey(emitted.source?.trait ?? '', emitted.event));
  }
  if (dispatch.serverLeg?.targetTrait !== undefined) {
    set.add(alreadyDeliveredKey(dispatch.serverLeg.targetTrait, dispatch.serverLeg.event));
  }
  return set;
}

/**
 * Build the CLIENT-env `EvaluateEffectRunner`: an `EffectExecutor` per
 * trait invocation, `environment: 'client'` + `collector` as its delegate
 * (persist/fetch/call-service route to the leg instead of executing —
 * `EffectExecutor`'s own `delegateIfClient`), `createClientEffectHandlers`
 * for the reachable handlers (`emit`/`set`/`render-ui`/`navigate`).
 *
 * Two adaptations at the boundary (NOT a second copy of
 * `createClientEffectHandlers`'s logic): its `emit` prefixes the browser
 * hook's own local-bus convention (`UI:<event>`) onto every event, which
 * would corrupt this composition's `listens` matching (`bareEvent !==
 * emitted.event`) if left on the wire — stripped back off in the `eventBus`
 * sink below, the one place this runner owns the translation.
 */
function createClientEffectRunner(
  deps: { traitIndex: TraitIndex; store: CircuitStore; orbitalName: string },
  collector: ServerLegCollector,
  /**
   * Invoked once per trait whose transition actually ran effects — the
   * composition (`TraitCascade.ts`) only calls `runEffects` when
   * `result.effects.length > 0`, so "this runner was invoked for
   * `traitName`" is an EXACT (not approximate) proxy for "this trait has
   * something the server leg needs to know about" — a bare state-only
   * transition (no effects) can have nothing server-only to replay either.
   */
  onExecuted?: (traitName: string) => void,
): EvaluateEffectRunner {
  return async (traitName, args) => {
    onExecuted?.(traitName);
    const entry = deps.traitIndex.byName.get(traitName);
    const frameKey = entry?.frameKey ?? traitName;
    let frame = deps.store.frames.get(frameKey);
    if (frame === undefined) {
      frame = {};
      deps.store.frames.set(frameKey, frame);
    }

    const pushClientEffect = (effect: ClientEffectTuple): void => {
      args.clientEffects.push(effect);
      args.clientEffectsByTrait?.push({ traitName, effect });
      args.onPush?.({ type: 'effect', data: effect });
    };

    const clientHandlers = createClientEffectHandlers({
      eventBus: {
        emit: (type, payload, source) => {
          const event = type.startsWith('UI:') ? type.slice(3) : type;
          const item = { event, payload, source };
          args.emittedEvents.push(item);
          args.onPush?.({ type: 'event', data: item });
        },
      },
      slotSetter: {
        addPattern: (slot, pattern, props, priority) => {
          pushClientEffect(
            priority !== undefined
              ? ['render-ui', slot, pattern, props, priority]
              : props !== undefined ? ['render-ui', slot, pattern, props] : ['render-ui', slot, pattern],
          );
        },
        clearSlot: (slot) => {
          pushClientEffect(['render-ui', slot, null]);
        },
      },
      navigate: (path, params, crumb) => {
        pushClientEffect(crumb !== undefined ? ['navigate', path, params, { crumb }] : ['navigate', path, params]);
      },
      navigateBack: () => {
        pushClientEffect(['navigate-back']);
      },
      liveEntity: frame,
      orbitalName: entry?.orbitalName ?? deps.orbitalName,
    });

    const state = deps.store.manager.getState(traitName, args.entityId)?.currentState ?? 'unknown';
    const executor = new EffectExecutor({
      handlers: clientHandlers,
      bindings: {
        entity: args.entityData,
        payload: args.payload,
        state,
        ...(args.user !== undefined ? { user: args.user } : {}),
        ...(args.callsitePayload !== undefined ? { callsitePayload: args.callsitePayload } : {}),
      },
      context: {
        traitName,
        orbitalName: entry?.orbitalName ?? deps.orbitalName,
        state,
        transition: 'unknown',
        ...(args.entityId !== undefined ? { entityId: args.entityId } : {}),
        ...(entry?.orbitalId !== undefined ? { orbitalId: entry.orbitalId } : {}),
        ...(entry?.irTrait.id !== undefined ? { traitId: entry.irTrait.id } : {}),
        ...(entry?.irTrait.emits !== undefined ? { emits: entry.irTrait.emits } : {}),
      },
      environment: 'client',
      delegate: collector,
      deferRenderBindings: clientResolvesRenderBindings(entry?.entity),
    });

    await executor.executeAll(args.effects);
  };
}

/**
 * Find every LOCAL listener reacting to `event` from `sourceStamp` — the
 * twin of `orbital-core::collect_listener_targets` (`kernel.rs`) and the
 * inline listens-fan-out block inside `evaluateOrbitalEvent`'s own worklist
 * loop, over the exact same shared primitives (`parseListenSource`,
 * `evaluateGuard`, `applyListenPayloadMapping`) rather than a divergent
 * re-derivation — `evaluateOrbitalEvent` doesn't export this block as its
 * own unit today (see the wave report's interface-gap note).
 */
function collectListenerTargets(
  traitIndex: TraitIndex,
  sourceStamp: BusEventSource | undefined,
  event: string,
  payload: EventPayload | undefined,
): Array<{ listenerTrait: string; triggers: string; payload: EventPayload | undefined; entityId: string | undefined }> {
  const targets: Array<{ listenerTrait: string; triggers: string; payload: EventPayload | undefined; entityId: string | undefined }> = [];
  for (const [listenerName, listenerEntry] of traitIndex.byName) {
    const listeners = (listenerEntry.traitDef.listens ?? []) as TraitEventListener[];
    for (const listener of listeners) {
      const { bareEvent, matcher } = parseListenSource(listener, listenerEntry.orbitalName);
      if (bareEvent !== event || !matcher(sourceStamp)) continue;

      if (listener.guard) {
        let guardPassed: boolean;
        try {
          guardPassed = evaluateGuard(listener.guard as SExpr, createMinimalContext({}, payload));
        } catch {
          guardPassed = false;
        }
        if (!guardPassed) continue;
      }

      const mappedPayload = applyListenPayloadMapping(listener.payloadMapping, payload, evaluateListenPayloadExpr);
      const pickId = (field: string): string | undefined =>
        (mappedPayload?.[field] as string | undefined) ?? (payload?.[field] as string | undefined);
      targets.push({
        listenerTrait: listenerName,
        triggers: listener.triggers,
        payload: mappedPayload,
        entityId: pickId('entityId') ?? pickId('orbitalName'),
      });
    }
  }
  return targets;
}

function resolvePersistence(opts: Pick<ClientRoleOpts, 'persistence'>): PersistenceAdapter {
  return opts.persistence ?? new InMemoryPersistence();
}

function baseEvaluateDeps(
  opts: ClientRoleOpts,
  runEffects: EvaluateEffectRunner,
): EvaluateOrbitalEventDeps {
  return {
    traitIndex: opts.traitIndex,
    manager: opts.store.manager,
    persistence: resolvePersistence(opts),
    frames: opts.store.frames,
    runEffects,
    ...(opts.user !== undefined ? { user: opts.user } : {}),
    ...(opts.guardMode !== undefined ? { guardMode: opts.guardMode } : {}),
    ...(opts.strictBindings !== undefined ? { strictBindings: opts.strictBindings } : {}),
    ...(opts.contextExtensions !== undefined ? { contextExtensions: opts.contextExtensions } : {}),
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
    ...(opts.logContext !== undefined ? { logContext: opts.logContext } : {}),
  };
}

/**
 * Dispatch one event through the seed trait's declared `DispatchMode` — the
 * twin of `RuntimeKernel::dispatch_with_server_leg`. Runs `evaluateOrbitalEvent`
 * LOCALLY (Client env: server-only effects land in `collector`, not
 * executed), takes a pre-commit snapshot first when the mode is
 * `runtimeOptimistic`, and never produces a leg for `hybridClientOnly`
 * (Rust drops one and logs an error if the validator let one through
 * anyway — mirrored here).
 *
 * `request.targetTrait` is the seed trait (required — scoped-listen
 * delivery, `evaluateOrbitalEvent`'s own contract for "dispatch to THIS
 * trait only").
 *
 * The leg's `traits[]` (which traits the server must re-seed) is built from
 * every trait `createClientEffectRunner` was actually invoked for during
 * this call — precise, not approximate (see that function's own doc): a
 * bare state-only transition never reaches `runEffects` at all, and has
 * nothing server-only to replay either, so omitting it costs nothing.
 */
export async function dispatchWithServerLeg(
  opts: ClientRoleOpts,
  request: OrbitalEventRequest,
): Promise<ClientDispatch> {
  const traitName = request.targetTrait;
  if (traitName === undefined) {
    throw new Error('dispatchWithServerLeg requires request.targetTrait (the seed trait)');
  }
  const entry = opts.traitIndex.byName.get(traitName);
  if (entry === undefined) {
    throw new Error(`dispatchWithServerLeg: unknown trait "${traitName}"`);
  }
  const mode = entry.dispatchMode;
  const entityId = request.entityId;

  const snapshot = mode === 'runtimeOptimistic'
    ? opts.store.snapshot(traitName, entityId, entry.frameKey)
    : undefined;

  const beforeStates = new Map<string, string>();
  for (const [name, traitState] of opts.store.manager.getAllStates()) {
    beforeStates.set(name, traitState.currentState);
  }

  const executedTraitNames = new Set<string>();
  const collector = new ServerLegCollector();
  const runEffects = createClientEffectRunner(
    { traitIndex: opts.traitIndex, store: opts.store, orbitalName: opts.orbitalName },
    collector,
    (name) => executedTraitNames.add(name),
  );

  const response = await evaluateOrbitalEvent(
    baseEvaluateDeps(opts, runEffects),
    { event: request.event, payload: request.payload, entityId, targetTrait: traitName },
  );

  opts.store.notify();

  const drained = collector.drain();
  const hybrid = mode === 'hybridClientOnly';
  let serverLeg: OrbitalEventRequest | undefined;
  if (drained.length > 0) {
    if (hybrid) {
      clientRoleLog.error('hybrid-trait-produced-server-leg', {
        trait: traitName,
        event: request.event,
        drained: drained.length,
      });
    } else {
      const executedTraits: Array<{ trait: string; from: string }> = [];
      for (const name of executedTraitNames) {
        const indexed = opts.traitIndex.byName.get(name);
        const from = beforeStates.get(name) ?? (indexed !== undefined ? findInitialState(indexed.traitDef) : '');
        executedTraits.push({ trait: name, from });
      }
      const seedRow = response.entityByTrait?.[traitName];
      serverLeg = {
        event: request.event,
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
        ...(entityId !== undefined ? { entityId } : {}),
        targetTrait: traitName,
        sourceTrait: traitName,
        ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
        ...(executedTraits.length > 0 ? { traits: executedTraits } : {}),
        ...(seedRow !== undefined ? { entityByTrait: { [traitName]: seedRow } } : {}),
      };
    }
  }

  return { response, serverLeg, mode, snapshot, trait: traitName, entityId, frameKey: entry.frameKey };
}

function stripCircuitState(request: OrbitalEventRequest): OrbitalEventRequest {
  const stripped: OrbitalEventRequest = { ...request };
  delete stripped.traits;
  delete stripped.entityByTrait;
  return stripped;
}

/**
 * Fold a server `OrbitalEventResponse` into `store`: `entityByTrait` merges
 * into `frames` (server wins) — fanned out to EVERY trait sharing that row's
 * entity name, not only the trait the response keys it by (G5, mirrors
 * Rust's entity source keyed by linked-entity type) — `states` write through
 * as a RECONCILE (no
 * guard evaluation — the server already decided the transition fired), and
 * every `emittedEvents` entry NOT in `alreadyDelivered` fans out through
 * the SAME `evaluateOrbitalEvent` path (scoped-listen delivery, one call
 * per matched local listener) — the twin of `RuntimeKernel::apply_server_response`.
 *
 * SCOPED OUT (reported, not silently done): `response.data` (fetched
 * COLLECTION rows, keyed by entity type) has no `frames` destination in
 * this wave — `frames` is keyed by `IndexedTrait.frameKey` (one row per
 * trait), not by entity type, and there is no declared mapping from a
 * fetched collection back onto a specific trait's single-row frame slot.
 * Rust's twin merges `data` into `entity_source`, a general persisted-row
 * cache the client-side JS runtime doesn't have yet (that cache is a
 * `@almadar/ui` concern, out of scope for this wave).
 *
 * The G-RUNTIME-029 fix itself — "the fold re-renders AFTER the local arm"
 * — is the RETURNED `clientEffects`/`clientEffectsByTrait`: the server's
 * own direct render (e.g. a persisted trait's listen arm ran its REAL
 * fetch server-side and same-trait-continued into a render-ui bound to the
 * real rows) plus whatever each re-fan-out call below produces. A caller
 * (a later render adapter) applies these AFTER whatever the local
 * (skeleton) dispatch already rendered, so the real data wins last.
 *
 * KNOWN GAP (reported): `evaluateOrbitalEvent` has no hook to seed its
 * internal visited-set from `alreadyDelivered`, so a listener chain that
 * cycles back onto an already-delivered `(trait, event)` pair through a
 * DIFFERENT path than the top-level filter below is not caught (Rust's
 * `apply_server_response` seeds its OWN cascade's visited set from the same
 * `already_delivered`, closing this).
 */
export async function applyOrbitalEventResponse(
  store: CircuitStore,
  response: OrbitalEventResponse,
  alreadyDelivered: ReadonlySet<string>,
  opts: ClientRoleOpts,
): Promise<{
  clientEffects: ClientEffectTuple[];
  clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }>;
}> {
  const clientEffects: ClientEffectTuple[] = [...(response.clientEffects ?? [])];
  const clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }> =
    [...(response.clientEffectsByTrait ?? [])];

  if (response.entityByTrait) {
    for (const [traitName, row] of Object.entries(response.entityByTrait)) {
      const entry = opts.traitIndex.byName.get(traitName);
      // Rust's `apply_server_response` writes into an entity source keyed
      // by (linked-entity TYPE, id) — every trait bound to that entity type
      // sees the row, not only the trait the response happened to name.
      // Mirror that here: fan the row out to every IndexedTrait whose
      // resolved entity shares this trait's entity name (G-RUNTIME-026/027).
      const targetFrameKeys = new Set<string>([entry?.frameKey ?? traitName]);
      if (entry !== undefined) {
        for (const sibling of opts.traitIndex.byName.values()) {
          if (sibling.entity.name === entry.entity.name) targetFrameKeys.add(sibling.frameKey);
        }
      }
      for (const frameKey of targetFrameKeys) {
        const existing = store.frames.get(frameKey);
        store.frames.set(frameKey, existing !== undefined ? { ...existing, ...row } : { ...row });
      }
    }
  }

  const traitEntityIds = new Map<string, string>();
  if (response.entityByTrait) {
    for (const [traitName, row] of Object.entries(response.entityByTrait)) {
      const id = row['id'];
      if (typeof id === 'string' && id !== '') traitEntityIds.set(traitName, id);
    }
  }
  for (const [traitName, stateName] of Object.entries(response.states)) {
    store.manager.seedState(traitName, stateName, traitEntityIds.get(traitName));
  }

  for (const emitted of response.emittedEvents) {
    const sourceTrait = emitted.source?.trait ?? '';
    if (alreadyDelivered.has(alreadyDeliveredKey(sourceTrait, emitted.event))) continue;

    const targets = collectListenerTargets(opts.traitIndex, emitted.source, emitted.event, emitted.payload);
    for (const target of targets) {
      // A fresh, per-fan-out collector — any further server-only effect the
      // fanned listener's arm fires is not drained/posted from here,
      // mirroring `apply_server_response`'s own `run_cascade` call, which
      // runs through the same Client-env executor but posts nothing itself.
      const collector = new ServerLegCollector();
      const runEffects = createClientEffectRunner(
        { traitIndex: opts.traitIndex, store, orbitalName: opts.orbitalName },
        collector,
      );
      const fanned = await evaluateOrbitalEvent(
        baseEvaluateDeps(opts, runEffects),
        {
          event: target.triggers,
          payload: target.payload,
          entityId: target.entityId,
          targetTrait: target.listenerTrait,
        },
      );
      if (fanned.clientEffects) clientEffects.push(...fanned.clientEffects);
      if (fanned.clientEffectsByTrait) clientEffectsByTrait.push(...fanned.clientEffectsByTrait);
    }
  }

  store.notify();
  return { clientEffects, clientEffectsByTrait };
}

/**
 * Post `dispatch.serverLeg` and fold the response — the twin of
 * `ClientKernel::dispatch`'s mode match. `hybridClientOnly` never posts;
 * `runtimeOptimistic` posts, folds and presents the LOCAL response on
 * success, restores the pre-dispatch snapshot and presents the SERVER's
 * response on `success:false`, restores and rethrows on a transport error;
 * `persistedAwaited` posts, folds, presents the local response, and
 * propagates a transport error untouched (no snapshot exists for this mode
 * — nothing to restore).
 *
 * Posting rule (plan §5.1's last bullet): `opts.carriesCircuitState === true`
 * (stateless topology) posts only when `dispatch.serverLeg` was collected —
 * unaffected by `request`. `false` (stateful topology, the server holds the
 * circuit state itself) posts EVERY non-hybrid dispatch — "today's relay
 * behavior" — so when no leg was collected (a bare state-only transition, or
 * a trait whose effects are all client-safe) `request` supplies the plain
 * `event`/`payload`/`clientId` to post instead; omitting `request` here
 * (or `carriesCircuitState === true`) keeps the original "no leg, no post"
 * behavior.
 */
export async function postServerLeg(
  transport: EventTransport,
  orbitalName: string,
  dispatch: ClientDispatch,
  store: CircuitStore,
  opts: ClientRoleOpts,
  request?: OrbitalEventRequest,
): Promise<OrbitalEventResponse> {
  if (dispatch.mode === 'hybridClientOnly') {
    return dispatch.response;
  }

  let legToSend: OrbitalEventRequest;
  if (dispatch.serverLeg !== undefined) {
    legToSend = opts.carriesCircuitState ? dispatch.serverLeg : stripCircuitState(dispatch.serverLeg);
  } else if (!opts.carriesCircuitState && request !== undefined) {
    legToSend = {
      event: request.event,
      ...(request.payload !== undefined ? { payload: request.payload } : {}),
      ...(dispatch.entityId !== undefined ? { entityId: dispatch.entityId } : {}),
      targetTrait: dispatch.trait,
      sourceTrait: dispatch.trait,
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
    };
  } else {
    return dispatch.response;
  }

  let posted: OrbitalEventResponse;
  try {
    posted = await transport.send(orbitalName, legToSend);
  } catch (err) {
    if (dispatch.snapshot !== undefined) {
      store.restore(dispatch.trait, dispatch.entityId, dispatch.snapshot, dispatch.frameKey);
      store.notify();
    }
    throw err;
  }

  if (dispatch.mode === 'runtimeOptimistic') {
    if (posted.success) {
      await applyOrbitalEventResponse(store, posted, alreadyDeliveredFrom(dispatch), opts);
      return dispatch.response;
    }
    if (dispatch.snapshot !== undefined) {
      store.restore(dispatch.trait, dispatch.entityId, dispatch.snapshot, dispatch.frameKey);
      store.notify();
    }
    return posted;
  }

  await applyOrbitalEventResponse(store, posted, alreadyDeliveredFrom(dispatch), opts);
  return dispatch.response;
}
