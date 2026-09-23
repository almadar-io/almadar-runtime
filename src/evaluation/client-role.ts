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
  OrbitalEventRequest,
  OrbitalEventResponse,
  UserContext,
} from '@almadar/core';
import { type ClientEffectTuple } from '@almadar/core';
import { createLogger } from '@almadar/logger';
import {
  collectListenerTargets,
  evaluateOrbitalEvent,
  type EvaluateEffectRunner,
  type EvaluateOrbitalEventDeps,
} from './evaluateOrbitalEvent.js';
import { findInitialState } from '../traits/StateMachineCore.js';
import type { TraitIndex } from '../traits/trait-index.js';
import type { CircuitStore, TraitSnapshot } from './circuit-store.js';
import type { EntityRow } from '@almadar/core';
import { EffectExecutor, clientResolvesRenderBindings } from '../effects/EffectExecutor.js';
import { createClientEffectHandlers } from '../effects/ClientEffectHandlers.js';
import { ServerLegCollector } from '../effects/server-leg.js';
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
  /** `runtimeOptimistic` only: the pre-dispatch rows of every sibling frame
   *  the local dispatch may fan its row into (see `fanOutEntityRows`). */
  siblingSnapshots?: Map<string, EntityRow | undefined>;
  /** Traits whose effects ran locally in this dispatch — the rows the local
   *  run and the response fold fan out to same-entity siblings. */
  writtenTraits: ReadonlySet<string>;
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
 * Every frame bound to the same entity instance as `traitName`'s own frame:
 * same entity name, and either no row yet or a row with the same `id` — the
 * JS twin of Rust's entity source keyed by (linked-entity TYPE, id).
 */
function sameEntityFrameKeys(traitIndex: TraitIndex, store: CircuitStore, traitName: string, rowId: string | undefined): Set<string> {
  const entry = traitIndex.byName.get(traitName);
  const keys = new Set<string>([entry?.frameKey ?? traitName]);
  if (entry === undefined) return keys;
  for (const sibling of traitIndex.byName.values()) {
    if (sibling.entity.name !== entry.entity.name) continue;
    const siblingId = store.frames.get(sibling.frameKey)?.['id'];
    if (rowId === undefined || siblingId === undefined || siblingId === rowId) keys.add(sibling.frameKey);
  }
  return keys;
}

function rowIdOf(row: EntityRow): string | undefined {
  const id = row['id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Merge each `entityByTrait` row into its own frame, then fan the rows of
 * `writtenTraits` into every frame sharing their entity instance
 * (G-RUNTIME-026/027). Only written traits fan out, and last: the other
 * rows are echoes that may predate this write, and fanning one of those
 * would clobber the fresh row.
 */
function fanOutEntityRows(
  store: CircuitStore,
  traitIndex: TraitIndex,
  entityByTrait: Record<string, EntityRow>,
  writtenTraits: ReadonlySet<string>,
): void {
  const merge = (frameKey: string, row: EntityRow): void => {
    const existing = store.frames.get(frameKey);
    if (existing === row) return;
    store.frames.set(frameKey, existing !== undefined ? { ...existing, ...row } : { ...row });
  };
  for (const [traitName, row] of Object.entries(entityByTrait)) {
    merge(traitIndex.byName.get(traitName)?.frameKey ?? traitName, row);
  }
  for (const traitName of writtenTraits) {
    const row = entityByTrait[traitName];
    if (row === undefined) continue;
    for (const frameKey of sameEntityFrameKeys(traitIndex, store, traitName, rowIdOf(row))) merge(frameKey, row);
  }
}

function restoreDispatch(store: CircuitStore, dispatch: ClientDispatch): void {
  if (dispatch.snapshot === undefined) return;
  for (const [frameKey, row] of dispatch.siblingSnapshots ?? []) {
    if (row === undefined) store.frames.delete(frameKey);
    else store.frames.set(frameKey, { ...row });
  }
  store.restore(dispatch.trait, dispatch.entityId, dispatch.snapshot, dispatch.frameKey);
  store.notify();
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
  let siblingSnapshots: Map<string, EntityRow | undefined> | undefined;
  if (snapshot !== undefined) {
    siblingSnapshots = new Map();
    for (const frameKey of sameEntityFrameKeys(opts.traitIndex, opts.store, traitName, undefined)) {
      if (frameKey === entry.frameKey) continue;
      const row = opts.store.frames.get(frameKey);
      siblingSnapshots.set(frameKey, row !== undefined ? { ...row } : undefined);
    }
  }

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

  if (response.entityByTrait) fanOutEntityRows(opts.store, opts.traitIndex, response.entityByTrait, executedTraitNames);
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

  return {
    response,
    serverLeg,
    mode,
    snapshot,
    ...(siblingSnapshots !== undefined ? { siblingSnapshots } : {}),
    writtenTraits: executedTraitNames,
    trait: traitName,
    entityId,
    frameKey: entry.frameKey,
  };
}

function stripCircuitState(request: OrbitalEventRequest): OrbitalEventRequest {
  const stripped: OrbitalEventRequest = { ...request };
  delete stripped.traits;
  delete stripped.entityByTrait;
  return stripped;
}

/**
 * Fold a server `OrbitalEventResponse` into `store`: `entityByTrait` merges
 * into `frames` (server wins), and the rows of `writtenTraits` fan out to
 * every frame bound to the same entity instance (G5, mirrors Rust's entity
 * source keyed by linked-entity type + id; see `fanOutEntityRows`) —
 * `states` write through as a RECONCILE (no guard evaluation — the server already decided the transition fired), and
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
  writtenTraits: ReadonlySet<string> = new Set(),
): Promise<{
  clientEffects: ClientEffectTuple[];
  clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }>;
}> {
  const clientEffects: ClientEffectTuple[] = [...(response.clientEffects ?? [])];
  const clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }> =
    [...(response.clientEffectsByTrait ?? [])];

  if (response.entityByTrait) fanOutEntityRows(store, opts.traitIndex, response.entityByTrait, writtenTraits);

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
    restoreDispatch(store, dispatch);
    throw err;
  }

  if (dispatch.mode === 'runtimeOptimistic' && !posted.success) {
    restoreDispatch(store, dispatch);
    return posted;
  }

  // G-RUNTIME-029: the fold's effects render AFTER the local arm's, so the
  // server's real data wins last.
  const delivered = alreadyDeliveredFrom(dispatch);
  const folded = await applyOrbitalEventResponse(store, posted, delivered, opts, dispatch.writtenTraits);
  const local = dispatch.response;
  return {
    ...local,
    emittedEvents: [
      ...local.emittedEvents,
      ...posted.emittedEvents.filter((e) => !delivered.has(alreadyDeliveredKey(e.source?.trait ?? '', e.event))),
    ],
    clientEffects: [...(local.clientEffects ?? []), ...folded.clientEffects],
    clientEffectsByTrait: [...(local.clientEffectsByTrait ?? []), ...folded.clientEffectsByTrait],
  };
}

// ============================================================================
// ClientKernel — G1, plan §5.1's first bullet
// ============================================================================

/**
 * `createClientKernel`'s own opts: every `ClientRoleOpts` field plus the
 * transport a dispatch's server leg posts through. `transport` is optional —
 * omitted means offline/no-bridge (plan G7): every dispatch runs locally,
 * nothing is ever posted, mirroring `ClientKernel::new(schema, bridge: None)`.
 * A caller wanting an in-process local server supplies
 * `createInProcessTransport(...)` here instead of leaving it unset.
 */
export interface ClientKernelOpts extends ClientRoleOpts {
  transport?: EventTransport;
}

/** One `ClientKernel.dispatch()` call's settled outcome. */
export interface ClientKernelOutcome {
  response: OrbitalEventResponse;
  mode: DispatchMode;
}

export interface ClientKernel {
  /**
   * Enqueue one event. FIFO per kernel: this entry's local dispatch → post
   * (per the posting rule) → fold → `store.notify()` all complete before the
   * next queued entry's local dispatch begins — the twin of orbital-client's
   * `ClientKernel::dispatch` being called serially off one queue, ported to
   * JS's single-threaded-but-concurrent-microtask model where two `dispatch`
   * calls made back to back would otherwise interleave.
   *
   * A `request.tick`-stamped entry coalesces onto a pending entry with the
   * SAME `(event, targetTrait)` that is itself tick-stamped — same contract
   * as `@almadar/ui`'s `lib/event-queue-coalesce.ts` `enqueueEvent` (see
   * that file's tests, mirrored in `client-kernel.test.ts`): only the
   * pending entry's `payload` is replaced (its FIFO slot and every other
   * field are kept), a sourceless/non-tick entry is never coalesced, and an
   * entry already shifted off the queue (in flight) is never a coalesce
   * target. Every caller coalesced onto the same pending entry resolves to
   * that ONE entry's eventual outcome.
   *
   * A tick-stamped entry resolves after its LOCAL dispatch; its post goes
   * out on a per-(event, trait) newest-wins lane outside the FIFO, with no
   * rollback, so a tick round trip never delays a command.
   */
  dispatch(request: OrbitalEventRequest): Promise<ClientKernelOutcome>;
  readonly store: CircuitStore;
}

interface QueuedKernelEntry {
  request: OrbitalEventRequest;
  resolvers: Array<(outcome: ClientKernelOutcome) => void>;
  rejecters: Array<(err: Error) => void>;
}

/**
 * Build one `ClientKernel` — one FIFO queue over `opts.store`, the twin of
 * orbital-client's `ClientKernel` (`client_kernel.rs`): a per-dispatch
 * `dispatchWithServerLeg` run, `postServerLeg` deciding whether/what to post
 * per `opts.carriesCircuitState`, and one `applyOrbitalEventResponse` fold
 * (done inside `postServerLeg`) before the next queued entry starts.
 */
export function createClientKernel(opts: ClientKernelOpts): ClientKernel {
  const { transport, ...roleOpts } = opts;
  const queue: QueuedKernelEntry[] = [];
  let pumping = false;

  // Tick-stamped posts leave the FIFO: a tick is a latest-state broadcast,
  // so its round trip must never delay a queued command (R-CLIENT-TICK-POST-
  // BACKLOG). One lane per (event, trait): at most one post in flight,
  // newer firings replace the pending one, the newest goes out on settle.
  const tickLanes = new Map<string, { inFlight: boolean; pending?: { dispatch: ClientDispatch; request: OrbitalEventRequest } }>();
  const flushTickLane = (key: string): void => {
    const lane = tickLanes.get(key);
    if (lane === undefined || transport === undefined) return;
    const next = lane.pending;
    lane.pending = undefined;
    if (next === undefined) {
      lane.inFlight = false;
      return;
    }
    lane.inFlight = true;
    void postServerLeg(transport, roleOpts.orbitalName, next.dispatch, roleOpts.store, roleOpts, next.request)
      .catch((err: Error) => {
        clientRoleLog.warn('tick-post-failed', { event: next.request.event, trait: next.request.targetTrait, error: String(err) });
      })
      .then(() => flushTickLane(key));
  };
  const postTick = (dispatch: ClientDispatch, request: OrbitalEventRequest): void => {
    const key = `${request.targetTrait ?? ''}\u0000${request.event}`;
    const lane = tickLanes.get(key) ?? { inFlight: false };
    tickLanes.set(key, lane);
    // No rollback point: the post settles after later commands have run, so
    // restoring this snapshot would clobber them; the next tick supersedes.
    const { snapshot: _snapshot, siblingSnapshots: _siblings, ...unrollable } = dispatch;
    lane.pending = { dispatch: unrollable, request };
    if (!lane.inFlight) flushTickLane(key);
  };

  function pump(): void {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (queue.length > 0) {
          const entry = queue.shift()!;
          try {
            const dispatch = await dispatchWithServerLeg(roleOpts, entry.request);
            let response = dispatch.response;
            if (transport !== undefined) {
              if (entry.request.tick !== undefined) postTick(dispatch, entry.request);
              else response = await postServerLeg(transport, roleOpts.orbitalName, dispatch, roleOpts.store, roleOpts, entry.request);
            }
            const outcome: ClientKernelOutcome = { response, mode: dispatch.mode };
            for (const resolve of entry.resolvers) resolve(outcome);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            for (const reject of entry.rejecters) reject(error);
          }
        }
      } finally {
        pumping = false;
      }
    })();
  }

  return {
    store: roleOpts.store,
    dispatch(request: OrbitalEventRequest): Promise<ClientKernelOutcome> {
      return new Promise<ClientKernelOutcome>((resolve, reject) => {
        if (request.tick !== undefined) {
          const pending = queue.find(
            (e) => e.request.tick !== undefined
              && e.request.event === request.event
              && e.request.targetTrait === request.targetTrait,
          );
          if (pending !== undefined) {
            pending.request = { ...pending.request, payload: request.payload };
            pending.resolvers.push(resolve);
            pending.rejecters.push(reject);
            return;
          }
        }
        queue.push({ request, resolvers: [resolve], rejecters: [reject] });
        pump();
      });
    },
  };
}
