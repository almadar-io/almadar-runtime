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
import { TraitMountError } from './trait-mount-error.js';
import { appNavItems, sigilThemeKey } from './render-sigils.js';
import { buildConfigBinding, buildEntityBinding } from '../traits/config-defaults.js';
import type {
  AwaitingTrait,
  MessageCatalogs,
  DeliveryRecord,
  DispatchLog,
  DispatchMode,
  EventPayload,
  MountSeed,
  OrbitalEventRequest,
  OrbitalEventResponse,
  UserContext,
} from '@almadar/core';
import { storesRowsInBrowser, type ClientEffectByTrait, type ClientEffectTuple } from '@almadar/core';
import { createLogger } from '@almadar/logger';
import {
  alreadyDeliveredKey,
  collectListenerTargets,
  deliveryOf,
  evaluateOrbitalEvent,
  freshDeliveryGuardBindings,
  type CollectedListenerTarget,
  type EvaluateEffectRunner,
  type EvaluateOrbitalEventDeps,
} from './evaluateOrbitalEvent.js';
import { findInitialState, findMatchingTransitions } from '../traits/StateMachineCore.js';
import { browserLegEvents, type TraitIndex } from '../traits/trait-index.js';
import type { CircuitStore, TraitSnapshot } from './circuit-store.js';
import type { EntityRow, SExpr, TransitionRejection } from '@almadar/core';
import { EffectExecutor, clientResolvesRenderBindings } from '../effects/EffectExecutor.js';
import { createClientEffectHandlers } from '../effects/ClientEffectHandlers.js';
import { ServerLegCollector } from '../effects/server-leg.js';
import type { PersistenceAdapter } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EventTransport } from '../server/EventTransport.js';
import type { EvaluationContextExtensions, RollbackCause } from '../types.js';

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
  /** The viewer's locale for the local arm's `i18n/t` / `@locale` (the host's active locale). */
  locale?: string;
  /** The program's message catalogs (locale → qualified key → message). */
  messages?: MessageCatalogs;
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
  /**
   * The whole schema's index when `traitIndex` is restricted to one page's
   * mounted traits. A local dispatch whose emit has a listener present here
   * but absent from `traitIndex` (an off-page listener) needs the server to
   * run it, so it posts a server leg even when no server-only effect was
   * collected.
   */
  fullTraitIndex?: TraitIndex;
}

/**
 * One `dispatchWithServerLeg` call's outcome — the twin of
 * `orbital-core`'s `ClientDispatch`. Rust's struct omits the seed trait's
 * own name/entityId/frameKey because `dispatch()`'s CALLER already has them
 * in scope (they're that function's own parameters); JS's `postServerLeg`
 * needs them to roll back the right trait instance on failure, so they
 * travel on the value instead.
 */
/** A delivery a client-only seed's emit owes an off-page listener (LOLO §7). */
export interface ClientContinuation {
  orbital: string;
  request: OrbitalEventRequest;
}

export interface ClientDispatch {
  response: OrbitalEventResponse;
  serverLeg?: OrbitalEventRequest;
  /** A client-only seed's off-page deliveries: posted to their listeners, never re-running the seed on a host. */
  continuations?: readonly ClientContinuation[];
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
  /** The transition each trait's local run took (seed and cascaded listeners) — keys their awaiting-server entries. */
  firings?: ReadonlyMap<string, { event: string; fromState: string }>;
}

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

function restoreDispatch(store: CircuitStore, dispatch: ClientDispatch, cause: RollbackCause): void {
  if (dispatch.snapshot === undefined) return;
  for (const [frameKey, row] of dispatch.siblingSnapshots ?? []) {
    if (row === undefined) store.frames.delete(frameKey);
    else store.frames.set(frameKey, { ...row });
  }
  store.restore(dispatch.trait, dispatch.entityId, dispatch.snapshot, dispatch.frameKey, cause);
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
function i18nOpts(opts: Pick<ClientRoleOpts, 'locale' | 'messages'>): { locale?: string; messages?: MessageCatalogs } {
  return {
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(opts.messages !== undefined ? { messages: opts.messages } : {}),
  };
}

function createClientEffectRunner(
  deps: { traitIndex: TraitIndex; fullTraitIndex?: TraitIndex; store: CircuitStore; orbitalName: string; locale?: string; messages?: MessageCatalogs },
  collector: ServerLegCollector,
  /**
   * Invoked once per trait whose transition actually ran effects — the
   * composition (`TraitCascade.ts`) only calls `runEffects` when
   * `result.effects.length > 0`, so "this runner was invoked for
   * `traitName`" is an EXACT (not approximate) proxy for "this trait has
   * something the server leg needs to know about" — a bare state-only
   * transition (no effects) can have nothing server-only to replay either.
   */
  onExecuted?: (traitName: string, firing: { event: string; fromState: string } | undefined, step: Omit<CascadeFiring, 'trait' | 'event' | 'fromState' | 'row'>) => void,
): EvaluateEffectRunner {
  return async (traitName, args) => {
    onExecuted?.(traitName, args.firing, {
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
      ...(args.entityId !== undefined ? { entityId: args.entityId } : {}),
      ...(args.received !== undefined ? args.received : {}),
    });
    const entry = deps.traitIndex.byName.get(traitName);
    const frameKey = entry?.frameKey ?? traitName;
    let frame = deps.store.frames.get(frameKey);
    if (frame === undefined) {
      frame = {};
      deps.store.frames.set(frameKey, frame);
    }

    const capture = args.callsitePayload ?? deps.store.callsitePayloads.get(traitName);
    if (args.callsitePayload !== undefined) deps.store.callsitePayloads.set(traitName, args.callsitePayload);
    const pushClientEffect = (effect: ClientEffectTuple): void => {
      args.clientEffects.push(effect);
      args.clientEffectsByTrait?.push({ traitName, effect, ...args.firing, ...(capture !== undefined ? { callsitePayload: capture } : {}) });
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

    const state = args.dispatch?.toState ?? deps.store.manager.getState(traitName, args.entityId)?.currentState ?? 'unknown';
    const config = buildConfigBinding({
      traitDef: entry?.irTrait,
      resolvedDefaults: undefined,
      callSiteOverride: entry?.config,
      user: args.user,
    });
    const executor = new EffectExecutor({
      handlers: clientHandlers,
      bindings: {
        entity: buildEntityBinding({ entity: entry?.entity, persisted: args.entityData, frame }),
        payload: args.payload,
        state,
        ...(config !== undefined ? { config } : {}),
        ...(args.user !== undefined ? { user: args.user } : {}),
        ...(args.now !== undefined ? { now: args.now } : {}),
        ...(deps.locale !== undefined ? { locale: deps.locale, messages: deps.messages?.[deps.locale] ?? {} } : {}),
        ...(capture !== undefined ? { callsitePayload: capture } : {}),
        pages: appNavItems((deps.fullTraitIndex ?? deps.traitIndex).orbitals.map((o) => o.schema)),
        currentTheme: sigilThemeKey(deps.traitIndex.orbitals.find((o) => o.schema.name === (entry?.orbitalName ?? deps.orbitalName))?.schema.theme),
        ...(args.dispatch !== undefined ? args.dispatch : {}),
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

    await collector.attribute(traitName, () => executor.executeAll(args.effects).then(() => undefined));
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
    mount: opts.store.mount,
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

  // The leg replays the event from the pre-dispatch state, so it carries the
  // pre-dispatch row too (a transition that clears a guarded field would
  // otherwise fail its own replayed guard).
  const beforeFrame = opts.store.frames.get(entry.frameKey);
  const seedRow = beforeFrame !== undefined ? { ...beforeFrame } : undefined;

  const beforeStates = new Map<string, string>();
  for (const [name, traitState] of opts.store.manager.getAllStates()) {
    beforeStates.set(name, traitState.currentState);
  }

  const executedTraitNames = new Set<string>();
  const firings = new Map<string, { event: string; fromState: string }>();
  const cascadeFirings: CascadeFiring[] = [];
  const collector = new ServerLegCollector();
  const runEffects = createClientEffectRunner(
    { traitIndex: opts.traitIndex, ...(opts.fullTraitIndex !== undefined ? { fullTraitIndex: opts.fullTraitIndex } : {}), store: opts.store, orbitalName: opts.orbitalName, ...i18nOpts(opts) },
    collector,
    (name, firing, step) => {
      executedTraitNames.add(name);
      if (firing === undefined) return;
      if (!firings.has(name)) firings.set(name, firing);
      const row = opts.store.frames.get(opts.traitIndex.byName.get(name)?.frameKey ?? name);
      cascadeFirings.push({ trait: name, ...firing, ...step, ...(row !== undefined ? { row: { ...row } } : {}) });
    },
  );

  const response = await evaluateOrbitalEvent(
    baseEvaluateDeps(opts, runEffects),
    { event: request.event, payload: request.payload, entityId, targetTrait: traitName },
  );

  if (response.entityByTrait) fanOutEntityRows(opts.store, opts.traitIndex, response.entityByTrait, executedTraitNames);
  opts.store.notify();

  const drained = collector.drain();
  const hybrid = mode === 'hybridClientOnly';
  const full = opts.fullTraitIndex;
  const offPage = full === undefined ? [] : response.emittedEvents.flatMap((emitted) =>
    collectListenerTargets(full, emitted.source, emitted.event, emitted.payload)
      .filter((target) => !opts.traitIndex.byName.has(target.listenerTrait))
      .map((target) => ({ emitted, target })));
  const reachesOffPage = offPage.length > 0;
  // A local (hybrid) seed never needs the server for ITS OWN effects — but the
  // traits its cascade reached (a persistor, a refetching list) may.
  const downstreamNeedsServer = [...collector.delegatingTraits()].some((t) => t !== traitName);
  const browserStored = new Set(opts.traitIndex.allEntities.filter(storesRowsInBrowser).map((e) => e.name));
  // A trait the seed's cascade reached on a browser-leg event writes the browser
  // store; that store relays nothing, so the write goes as the trait's own request.
  const browserWrites = cascadeFirings.flatMap((f) => {
    const indexed = opts.traitIndex.byName.get(f.trait);
    return f.trait !== traitName && indexed !== undefined &&
      browserLegEvents(indexed.traitDef, (t) => browserStored.has(t), indexed.config).has(f.event)
      ? [{ firing: f, orbital: indexed.orbitalName }]
      : [];
  });
  const writingTraits = new Set(browserWrites.map((w) => w.firing.trait));
  const delegating = [...collector.delegatingTraits()];
  let serverLeg: OrbitalEventRequest | undefined;
  let continuations: ClientContinuation[] | undefined;
  if (hybrid && delegating.length > 0 && delegating.every((t) => writingTraits.has(t))) {
    continuations = [
      ...offPage.map(({ emitted, target }) => offPageContinuation(emitted, target, request)),
      ...browserWrites.map((w) => browserWriteContinuation(w.firing, w.orbital, request)),
    ];
  } else if (hybrid && !downstreamNeedsServer && drained.length === 0 && reachesOffPage) {
    // LOLO §7: a client-only seed takes no server round trip of its own; only
    // the deliveries its emits owe off-page listeners leave the client.
    continuations = offPage.map(({ emitted, target }) => offPageContinuation(emitted, target, request));
  } else if (drained.length > 0 || reachesOffPage) {
    // A browser-stored entity's data effects run in the browser store, so a
    // client-only seed's browser-leg event owes that leg.
    const seedBrowserLeg = browserLegEvents(entry.traitDef, (t) => browserStored.has(t), entry.config).has(request.event);
    if (hybrid && !downstreamNeedsServer && !reachesOffPage && !seedBrowserLeg) {
      clientRoleLog.error('hybrid-trait-produced-server-leg', {
        trait: traitName,
        event: request.event,
        drained: drained.length,
      });
    } else {
      // The seed's leg masks the deliveries the client relayed, so a cascade trait's
      // browser-store work goes as its own continuation, exactly as when the seed delegates nothing.
      if (hybrid && browserWrites.length > 0) {
        continuations = browserWrites.map((w) => browserWriteContinuation(w.firing, w.orbital, request));
      }
      const executedTraits: Array<{ trait: string; from: string; event?: string }> = [];
      for (const name of executedTraitNames) {
        if (continuations !== undefined && writingTraits.has(name)) continue;
        const indexed = opts.traitIndex.byName.get(name);
        const from = beforeStates.get(name) ?? (indexed !== undefined ? findInitialState(indexed.traitDef) : '');
        const event = firings.get(name)?.event;
        executedTraits.push({ trait: name, from, ...(event !== undefined ? { event } : {}) });
      }
      serverLeg = {
        event: request.event,
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
        ...(entityId !== undefined ? { entityId } : {}),
        targetTrait: traitName,
        sourceTrait: traitName,
        ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
        ...(request.locale !== undefined ? { locale: request.locale } : {}),
        ...(executedTraits.length > 0 ? { traits: executedTraits } : {}),
        ...(seedRow !== undefined ? { entityByTrait: { [traitName]: seedRow } } : {}),
        ...(request.delivery !== undefined ? { delivery: request.delivery } : {}),
        ...(request.dispatchLog !== undefined ? { dispatchLog: request.dispatchLog } : {}),
      };
    }
  }

  return {
    response,
    serverLeg,
    ...(continuations !== undefined ? { continuations } : {}),
    mode,
    snapshot,
    ...(siblingSnapshots !== undefined ? { siblingSnapshots } : {}),
    writtenTraits: executedTraitNames,
    trait: traitName,
    entityId,
    frameKey: entry.frameKey,
    firings,
  };
}

type Emitted = OrbitalEventResponse['emittedEvents'][number];

function offPageContinuation(emitted: Emitted, target: CollectedListenerTarget, request: OrbitalEventRequest): ClientContinuation {
  return {
    orbital: target.entry.orbitalName,
    request: {
      event: target.triggers,
      ...(target.payload !== undefined ? { payload: target.payload } : {}),
      ...(target.entityId !== undefined ? { entityId: target.entityId } : {}),
      targetTrait: target.listenerTrait,
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
      delivery: deliveryOf(emitted),
    },
  };
}

/** One transition a dispatch's local run took, with what the browser store needs to run it again. */
interface CascadeFiring {
  trait: string;
  event: string;
  fromState: string;
  payload?: EventPayload;
  entityId?: string;
  row?: EntityRow;
  delivery?: DeliveryRecord;
  log?: DispatchLog;
}

/** The browser store's request for one cascaded firing's write: its own event, payload, pre-step state, `@event` and log. */
function browserWriteContinuation(f: CascadeFiring, orbital: string, request: OrbitalEventRequest): ClientContinuation {
  return {
    orbital,
    request: {
      event: f.event,
      ...(f.payload !== undefined ? { payload: f.payload } : {}),
      ...(f.entityId !== undefined ? { entityId: f.entityId } : {}),
      targetTrait: f.trait,
      sourceTrait: f.trait,
      traits: [{ trait: f.trait, from: f.fromState, event: f.event }],
      ...(f.row !== undefined ? { entityByTrait: { [f.trait]: f.row } } : {}),
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
      ...(request.locale !== undefined ? { locale: request.locale } : {}),
      ...(f.delivery !== undefined ? { delivery: f.delivery } : {}),
      ...(f.log !== undefined ? { dispatchLog: f.log } : {}),
    },
  };
}

/**
 * A stateless leg carries the client's rows as they were at dispatch; other
 * legs may fold newer values into the same frames before this response lands.
 * A returned field equal to what the leg carried is the server echoing the
 * client, not a write — folding it would clobber the newer value. Keep only
 * what the server changed (and the row id, which addresses the frame). Rows
 * with no carried counterpart fold whole.
 */
/**
 * The fold's delta base. A seeded leg (a client-only trait's dispatch) CARRIES
 * the seeding trait's pre-dispatch row, because the server re-runs that arm
 * from it; the client already shows the arm's result. So the seeding trait's
 * base is its frame as the leg is sent: a field the arm changed and the
 * cascade moved back equals the carry, yet differs from what the client
 * shows. Every other trait keeps the carry, so a stale echo can't clobber a
 * sibling's newer write.
 */
function foldBase(
  store: CircuitStore,
  carried: Record<string, EntityRow> | undefined,
  seeded: readonly string[],
  traitIndex: TraitIndex,
): Record<string, EntityRow> | undefined {
  if (carried === undefined) return undefined;
  const out: Record<string, EntityRow> = { ...carried };
  for (const trait of seeded) {
    if (!(trait in carried)) continue;
    const frame = store.frames.get(traitIndex.byName.get(trait)?.frameKey ?? trait);
    if (frame !== undefined) out[trait] = { ...frame };
  }
  return out;
}

function changedSinceCarried(
  response: OrbitalEventResponse,
  carried: Record<string, EntityRow> | undefined,
  traitIndex: TraitIndex,
): OrbitalEventResponse {
  if (carried === undefined || response.entityByTrait === undefined) return response;
  const carriedByFrame = new Map<string, EntityRow>();
  for (const [trait, row] of Object.entries(carried)) {
    carriedByFrame.set(traitIndex.byName.get(trait)?.frameKey ?? trait, row);
  }
  const entityByTrait: Record<string, EntityRow> = {};
  for (const [trait, row] of Object.entries(response.entityByTrait)) {
    const base = carriedByFrame.get(traitIndex.byName.get(trait)?.frameKey ?? trait);
    if (base === undefined) {
      entityByTrait[trait] = row;
      continue;
    }
    const delta: EntityRow = {};
    for (const [field, value] of Object.entries(row)) {
      if (field === 'id' || JSON.stringify(value) !== JSON.stringify(base[field])) delta[field] = value;
    }
    entityByTrait[trait] = delta;
  }
  return { ...response, entityByTrait };
}

/**
 * A page-restricted kernel (one given `fullTraitIndex`) on the stateless
 * topology tells the server which traits this page mounts: `_activeTraits`
 * scopes discovery and on-page render delivery. (A stateful host would also
 * turn it into a relay mask — G-RUNTIME-042 — so it is not sent there.)
 */
function withMountedSet(request: OrbitalEventRequest, opts: ClientRoleOpts): OrbitalEventRequest {
  if (opts.fullTraitIndex === undefined) return request;
  return {
    ...request,
    payload: {
      ...(request.payload ?? {}),
      _activeTraits: [...opts.traitIndex.byName.keys()],
      // Only traits whose dispatches reach the host: a client-only trait's
      // INIT never posts, so the host would hold its deliveries forever.
      _awaitingInit: opts.store.mount.awaitingTraits()
        .filter((trait) => opts.traitIndex.byName.get(trait)?.dispatchMode !== 'hybridClientOnly'),
    },
  };
}

function stripCircuitState(request: OrbitalEventRequest): OrbitalEventRequest {
  const stripped: OrbitalEventRequest = { ...request };
  delete stripped.traits;
  delete stripped.entityByTrait;
  return stripped;
}

/** The response minus everything it carries for `traits` (rows, states, renders). */
/** The page's client-only traits (LOLO §7): their state never comes from a host. */
function clientOnlyTraits(traitIndex: TraitIndex): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of traitIndex.byName) if (entry.dispatchMode === 'hybridClientOnly') out.add(name);
  return out;
}

/**
 * Drop what a host computed for client-only traits — their states, rows and
 * own transition renders. A capture repaint (`callsitePayload`) stays: that
 * render is the embedder's composition, not the child's own run.
 */
function withoutClientOnlyRuns(response: OrbitalEventResponse, clientOnly: ReadonlySet<string>): OrbitalEventResponse {
  if (clientOnly.size === 0) return response;
  const keep = <T>(record: Record<string, T> | undefined): Record<string, T> | undefined =>
    record === undefined ? undefined : Object.fromEntries(Object.entries(record).filter(([trait]) => !clientOnly.has(trait)));
  const byTrait = response.clientEffectsByTrait?.filter((e) => !clientOnly.has(e.traitName) || e.callsitePayload !== undefined);
  return {
    ...response,
    states: keep(response.states) ?? {},
    ...(response.entityByTrait !== undefined ? { entityByTrait: keep(response.entityByTrait) } : {}),
    ...(byTrait !== undefined ? { clientEffectsByTrait: byTrait, clientEffects: byTrait.map((e) => e.effect) } : {}),
  };
}

function withoutTraits(response: OrbitalEventResponse, traits: ReadonlySet<string>): OrbitalEventResponse {
  const keep = <T>(record: Record<string, T> | undefined): Record<string, T> | undefined =>
    record === undefined ? undefined : Object.fromEntries(Object.entries(record).filter(([trait]) => !traits.has(trait)));
  const byTrait = response.clientEffectsByTrait?.filter((e) => !traits.has(e.traitName));
  return {
    ...response,
    states: keep(response.states) ?? {},
    ...(response.entityByTrait !== undefined ? { entityByTrait: keep(response.entityByTrait) } : {}),
    ...(byTrait !== undefined ? { clientEffectsByTrait: byTrait, clientEffects: byTrait.map((e) => e.effect) } : {}),
  };
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
 */
export async function applyOrbitalEventResponse(
  store: CircuitStore,
  serverResponse: OrbitalEventResponse,
  alreadyDelivered: ReadonlySet<string>,
  opts: ClientRoleOpts,
  writtenTraits: ReadonlySet<string> = new Set(),
): Promise<{
  clientEffects: ClientEffectTuple[];
  clientEffectsByTrait: ClientEffectByTrait[];
  /** A client-only trait's own unconsumed emits, for the caller to dispatch. */
  ownContinuations: OrbitalEventRequest[];
  /** Browser-store work a locally fanned cascade reached, for the caller to send. */
  browserWrites: ClientContinuation[];
}> {
  // A client-only trait still awaiting its INIT on this mount: no host holds
  // its deliveries (its INIT never posts), so whatever the host ran for it ran
  // before INIT. Drop that and hold the delivery here until INIT (Clause 4.1).
  const heldHere = new Set(store.mount.awaitingTraits().filter((trait) =>
    opts.traitIndex.byName.get(trait)?.dispatchMode === 'hybridClientOnly'));
  // LOLO §7: a client-only trait's state is the client's own. Whatever a host
  // computed for it is dropped; the events that reached it run here instead.
  const clientOnly = clientOnlyTraits(opts.traitIndex);
  const browserStored = new Set(opts.traitIndex.allEntities.filter(storesRowsInBrowser).map((e) => e.name));
  const response = withoutClientOnlyRuns(heldHere.size > 0 ? withoutTraits(serverResponse, heldHere) : serverResponse, clientOnly);
  const clientEffects: ClientEffectTuple[] = [...(response.clientEffects ?? [])];
  const clientEffectsByTrait: ClientEffectByTrait[] =
    [...(response.clientEffectsByTrait ?? [])];
  const ownContinuations: OrbitalEventRequest[] = [];
  const browserWrites: ClientContinuation[] = [];

  clientRoleLog.debug('fold:apply', {
    rows: Object.keys(response.entityByTrait ?? {}),
    serverClientEffects: clientEffects.length,
    emitted: response.emittedEvents.map((e) => e.event),
  });
  if (response.entityByTrait) fanOutEntityRows(store, opts.traitIndex, response.entityByTrait, writtenTraits);
  // A held child's frame waits for its INIT, but the payload it was composed
  // with is exactly what that INIT's repaint needs.
  for (const frame of serverResponse.clientEffectsByTrait ?? []) {
    if (frame.callsitePayload !== undefined) store.callsitePayloads.set(frame.traitName, frame.callsitePayload);
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

    const delivery = deliveryOf(emitted);
    for (const target of collectListenerTargets(opts.traitIndex, emitted.source, emitted.event, emitted.payload, undefined, { deferGuards: true })) {
      if (!heldHere.has(target.listenerTrait)) continue;
      store.mount.hold(target.listenerTrait, {
        trait: target.listenerTrait,
        from: findInitialState(target.entry.traitDef),
        fromAtDelivery: true,
        event: target.triggers,
        payload: target.payload,
        ...(target.entityId !== undefined ? { entityId: target.entityId } : {}),
        onPage: true,
        delivery,
        ...(target.listener.guard !== undefined ? { listenGuard: target.listener.guard as SExpr } : {}),
      });
    }
    // The server's own fan-out already ran this emit's listeners (their
    // rows/renders are in this response) — re-running them here doubles
    // every effect. Client-only listeners are the exception: their host run
    // was dropped above.
    const hostRan = emitted.source?.dispatched === true;

    const targets = collectListenerTargets(opts.traitIndex, emitted.source, emitted.event, emitted.payload, undefined, {
      guardBindings: freshDeliveryGuardBindings(delivery, (listener) => {
        const entry = opts.traitIndex.byName.get(listener);
        return store.manager.getState(listener)?.currentState ?? (entry !== undefined ? findInitialState(entry.traitDef) : '');
      }),
    }).filter((target) => !heldHere.has(target.listenerTrait) && (!hostRan || clientOnly.has(target.listenerTrait)));
    for (const target of targets) {
      // Its rows live in the browser store: a local run here would drop the
      // leg, so it takes the full client path like an own continuation.
      if (browserLegEvents(target.entry.traitDef, (t) => browserStored.has(t), target.entry.config).has(target.triggers)) {
        ownContinuations.push({
          event: target.triggers,
          ...(target.payload !== undefined ? { payload: target.payload } : {}),
          ...(target.entityId !== undefined ? { entityId: target.entityId } : {}),
          targetTrait: target.listenerTrait,
          delivery,
        });
        continue;
      }
      // A fresh, per-fan-out collector — any further server-only effect the
      // fanned listener's arm fires is not drained/posted from here,
      // mirroring `apply_server_response`'s own `run_cascade` call, which
      // runs through the same Client-env executor but posts nothing itself.
      const collector = new ServerLegCollector();
      const fannedFirings: CascadeFiring[] = [];
      const runEffects = createClientEffectRunner(
        { traitIndex: opts.traitIndex, ...(opts.fullTraitIndex !== undefined ? { fullTraitIndex: opts.fullTraitIndex } : {}), store, orbitalName: opts.orbitalName, ...i18nOpts(opts) },
        collector,
        (name, firing, step) => {
          if (firing === undefined) return;
          const row = store.frames.get(opts.traitIndex.byName.get(name)?.frameKey ?? name);
          fannedFirings.push({ trait: name, ...firing, ...step, ...(row !== undefined ? { row: { ...row } } : {}) });
        },
      );
      const fanned = await evaluateOrbitalEvent(
        { ...baseEvaluateDeps(opts, runEffects), seedVisited: alreadyDelivered, seedDelivery: delivery },
        {
          event: target.triggers,
          payload: target.payload,
          entityId: target.entityId,
          targetTrait: target.listenerTrait,
        },
      );
      if (fanned.clientEffects) clientEffects.push(...fanned.clientEffects);
      if (fanned.clientEffectsByTrait) clientEffectsByTrait.push(...fanned.clientEffectsByTrait);
      // The local run only collected the browser-store work its cascade reached (a desk's emit
      // opening a browser-stored detail); each such firing goes to the store as its own request.
      for (const f of fannedFirings) {
        const indexed = opts.traitIndex.byName.get(f.trait);
        if (indexed !== undefined && browserLegEvents(indexed.traitDef, (t) => browserStored.has(t), indexed.config).has(f.event)) {
          browserWrites.push(browserWriteContinuation(f, indexed.orbitalName, { event: f.event, ...(opts.locale !== undefined ? { locale: opts.locale } : {}) }));
        }
      }
      // Land this delivery's rows before the next one reads the frame.
      if (fanned.entityByTrait) {
        fanOutEntityRows(store, opts.traitIndex, fanned.entityByTrait, new Set([target.listenerTrait]));
      }
    }

    // A client-only trait's own emit that the host left unconsumed (a
    // browser-store leg relays back to its client) continues that trait's
    // cascade on this client — dispatched by the caller, whose transport
    // carries any leg the continuation owes.
    const own = emitted.source?.trait;
    const ownEntry = own !== undefined ? opts.traitIndex.byName.get(own) : undefined;
    if (own !== undefined && ownEntry !== undefined && !hostRan && clientOnly.has(own) && !heldHere.has(own)) {
      const from = store.manager.getState(own)?.currentState ?? findInitialState(ownEntry.traitDef);
      if (findMatchingTransitions(ownEntry.traitDef, from, emitted.event).length > 0) {
        ownContinuations.push({ event: emitted.event, ...(emitted.payload !== undefined ? { payload: emitted.payload } : {}), targetTrait: own });
      }
    }
  }

  store.notify();
  return { clientEffects, clientEffectsByTrait, ownContinuations, browserWrites };
}

/**
 * Dispatch the own-trait continuations a fold handed back, each through the
 * full client path (local run, then its own leg), and gather their effects.
 */
async function dispatchOwnContinuations(
  transport: EventTransport,
  orbitalName: string,
  folded: { ownContinuations: readonly OrbitalEventRequest[]; browserWrites: readonly ClientContinuation[] },
  store: CircuitStore,
  opts: ClientRoleOpts,
): Promise<{ clientEffects: ClientEffectTuple[]; clientEffectsByTrait: ClientEffectByTrait[] }> {
  const out = { clientEffects: [] as ClientEffectTuple[], clientEffectsByTrait: [] as ClientEffectByTrait[] };
  for (const write of folded.browserWrites) {
    const posted = await transport.send(write.orbital, write.request);
    const written = await applyOrbitalEventResponse(store, posted, new Set(), opts, new Set([write.request.targetTrait ?? '']));
    const continued = await dispatchOwnContinuations(transport, write.orbital, written, store, opts);
    out.clientEffects.push(...written.clientEffects, ...continued.clientEffects);
    out.clientEffectsByTrait.push(...written.clientEffectsByTrait, ...continued.clientEffectsByTrait);
  }
  for (const request of folded.ownContinuations) {
    const continued = await dispatchWithServerLeg(opts, request);
    const presented = await postServerLeg(transport, orbitalName, continued, store, opts);
    out.clientEffects.push(...(presented.clientEffects ?? []));
    out.clientEffectsByTrait.push(...(presented.clientEffectsByTrait ?? []));
  }
  return out;
}

/** The awaiting-server entries for a posted dispatch: each non-local trait its local run executed, keyed by the transition it took. */
function awaitingEntries(dispatch: ClientDispatch, opts: ClientRoleOpts): AwaitingTrait[] {
  const out: AwaitingTrait[] = [];
  for (const [trait, firing] of dispatch.firings ?? []) {
    if (opts.traitIndex.byName.get(trait)?.dispatchMode === 'hybridClientOnly') continue;
    out.push({ trait, event: firing.event, from: firing.fromState });
  }
  return out;
}

/** The server's effect outcomes appended to the local run's: a persist executes for real only on the server, so the settled response must carry its verdict. */
function serverEffectResults(local: OrbitalEventResponse, posted: OrbitalEventResponse): Pick<OrbitalEventResponse, 'effectResults'> {
  const merged = [...(local.effectResults ?? []), ...(posted.effectResults ?? [])];
  return merged.length > 0 ? { effectResults: merged } : {};
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
  onBeforeSend?: () => void,
  /** A progress-lane leg: never marks traits awaiting (nothing waits on it). */
  progress = false,
): Promise<OrbitalEventResponse> {
  if (dispatch.continuations !== undefined && dispatch.serverLeg === undefined) {
    return postContinuations(transport, dispatch, store, opts);
  }
  if (dispatch.mode === 'hybridClientOnly' && dispatch.serverLeg === undefined) {
    return dispatch.response;
  }

  let legToSend: OrbitalEventRequest;
  if (dispatch.serverLeg !== undefined) {
    // No server ever holds a local (hybrid) trait's state, so a leg it seeds
    // carries that state on every topology — the server re-runs the seed arm.
    legToSend = opts.carriesCircuitState || dispatch.mode === 'hybridClientOnly'
      ? dispatch.serverLeg
      : stripCircuitState(dispatch.serverLeg);
  } else if (!opts.carriesCircuitState && request !== undefined) {
    legToSend = {
      event: request.event,
      ...(request.payload !== undefined ? { payload: request.payload } : {}),
      ...(dispatch.entityId !== undefined ? { entityId: dispatch.entityId } : {}),
      targetTrait: dispatch.trait,
      sourceTrait: dispatch.trait,
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
      ...(request.locale !== undefined ? { locale: request.locale } : {}),
    };
  } else {
    return dispatch.response;
  }

  legToSend = withMountedSet(legToSend, opts);

  // Awaiting-server window: from this send until the fold (or error), for every
  // non-local trait the local run executed — tick legs never (latest-state broadcasts).
  const awaiting = request?.tick === undefined && !progress ? awaitingEntries(dispatch, opts) : [];
  store.awaiting.begin(awaiting);
  try {
    onBeforeSend?.();
    const shownAtSend = foldBase(store, legToSend.entityByTrait, dispatch.mode === 'hybridClientOnly' ? [dispatch.trait] : [], opts.traitIndex);
    let posted: OrbitalEventResponse;
    try {
      posted = await transport.send(orbitalName, legToSend);
    } catch (err) {
      restoreDispatch(store, dispatch, 'transport-error');
      throw err;
    }

    if (dispatch.mode === 'runtimeOptimistic' && !posted.success) {
      restoreDispatch(store, dispatch, 'server-rejected');
      return posted;
    }

    // G-RUNTIME-029: the fold's effects render AFTER the local arm's, so the
    // server's real data wins last.
    const delivered = alreadyDeliveredFrom(dispatch);
    const folded = await applyOrbitalEventResponse(
      store,
      changedSinceCarried(posted, shownAtSend, opts.traitIndex),
      delivered,
      opts,
      dispatch.writtenTraits,
    );
    const local = dispatch.response;
    const continued = await dispatchOwnContinuations(transport, orbitalName, folded, store, opts);
    const answer = await answerContinuations(transport, dispatch, store, opts);
    return {
      ...local,
      emittedEvents: [
        ...local.emittedEvents,
        ...posted.emittedEvents.filter((e) => !delivered.has(alreadyDeliveredKey(e.source?.trait ?? '', e.event))),
        ...answer.emittedEvents,
      ],
      clientEffects: [...(local.clientEffects ?? []), ...folded.clientEffects, ...continued.clientEffects, ...answer.clientEffects],
      clientEffectsByTrait: [...(local.clientEffectsByTrait ?? []), ...folded.clientEffectsByTrait, ...continued.clientEffectsByTrait, ...answer.clientEffectsByTrait],
      ...serverEffectResults(local, posted),
    };
  } finally {
    store.awaiting.end(awaiting.map((a) => a.trait));
  }
}

/** What a client-only seed's posted continuations added on top of its local run. */
export interface ContinuationAnswer {
  emittedEvents: OrbitalEventResponse['emittedEvents'];
  clientEffects: ClientEffectTuple[];
  clientEffectsByTrait: ClientEffectByTrait[];
}

/**
 * Post a client-only seed's off-page deliveries, each to its listener's
 * orbital, and fold every answer: the hosts' events reach this page's
 * client-only listeners through `applyOrbitalEventResponse`.
 */
export async function answerContinuations(
  transport: EventTransport,
  dispatch: ClientDispatch,
  store: CircuitStore,
  opts: ClientRoleOpts,
): Promise<ContinuationAnswer> {
  const delivered = alreadyDeliveredFrom(dispatch);
  const answer: ContinuationAnswer = { emittedEvents: [], clientEffects: [], clientEffectsByTrait: [] };
  for (const continuation of dispatch.continuations ?? []) {
    const posted = await transport.send(continuation.orbital, continuation.request);
    const folded = await applyOrbitalEventResponse(store, posted, delivered, opts, dispatch.writtenTraits);
    const continued = await dispatchOwnContinuations(transport, continuation.orbital, folded, store, opts);
    answer.emittedEvents.push(...posted.emittedEvents.filter((e) => !delivered.has(alreadyDeliveredKey(e.source?.trait ?? '', e.event))));
    answer.clientEffects.push(...folded.clientEffects, ...continued.clientEffects);
    answer.clientEffectsByTrait.push(...folded.clientEffectsByTrait, ...continued.clientEffectsByTrait);
  }
  return answer;
}

async function postContinuations(
  transport: EventTransport,
  dispatch: ClientDispatch,
  store: CircuitStore,
  opts: ClientRoleOpts,
): Promise<OrbitalEventResponse> {
  const local = dispatch.response;
  const answer = await answerContinuations(transport, dispatch, store, opts);
  return {
    ...local,
    emittedEvents: [...local.emittedEvents, ...answer.emittedEvents],
    clientEffects: [...(local.clientEffects ?? []), ...answer.clientEffects],
    clientEffectsByTrait: [...(local.clientEffectsByTrait ?? []), ...answer.clientEffectsByTrait],
  };
}

/** One seed of a mount batch with its local run. */
export interface MountedDispatch {
  seed: MountSeed;
  dispatch: ClientDispatch;
}

/** What a posted mount leg added on top of the seeds' local runs. */
export interface MountLegResult {
  success: boolean;
  states: Record<string, string>;
  /** Per-trait effect failures the server reported (`effect-failed`). */
  rejections: TransitionRejection[];
  emittedEvents: OrbitalEventResponse['emittedEvents'];
  clientEffects: ClientEffectTuple[];
  clientEffectsByTrait: ClientEffectByTrait[];
  error?: string;
}

/**
 * Post several seeds' local runs as ONE `mount` leg and fold it once — the
 * mount-batch form of `postServerLeg` (same leg shaping per topology, same
 * awaiting window, same rollback). The leg's `traits`/`entityByTrait` are the
 * union of the seeds' stateless addressing, each trait at its first
 * (pre-batch) occurrence, since the server replays the seeds in order.
 */
export async function postMountLeg(
  transport: EventTransport,
  orbitalName: string,
  mounted: readonly MountedDispatch[],
  store: CircuitStore,
  opts: ClientRoleOpts,
  base: Pick<OrbitalEventRequest, 'payload' | 'entityId' | 'clientId' | 'locale'> = {},
): Promise<MountLegResult> {
  const traits: Array<{ trait: string; from: string }> = [];
  const entityByTrait: Record<string, EntityRow> = {};
  // As in `postServerLeg`: no server holds a local (hybrid) seed's state, so its leg carries it on every topology.
  const carried = mounted.filter(({ dispatch }) => opts.carriesCircuitState || dispatch.mode === 'hybridClientOnly');
  {
    const seen = new Set<string>();
    for (const { dispatch } of carried) {
      for (const t of dispatch.serverLeg?.traits ?? []) {
        if (seen.has(t.trait)) continue;
        seen.add(t.trait);
        traits.push(t);
      }
      for (const [trait, row] of Object.entries(dispatch.serverLeg?.entityByTrait ?? {})) {
        if (!(trait in entityByTrait)) entityByTrait[trait] = row;
      }
    }
  }
  const mount = mounted.map(({ seed }) => seed);
  const request = withMountedSet({
    event: mount[0]?.event ?? 'INIT',
    ...(base.payload !== undefined ? { payload: base.payload } : {}),
    ...(base.entityId !== undefined ? { entityId: base.entityId } : {}),
    ...(base.clientId !== undefined ? { clientId: base.clientId } : {}),
    ...(base.locale !== undefined ? { locale: base.locale } : {}),
    mount,
    ...(traits.length > 0 ? { traits } : {}),
    ...(Object.keys(entityByTrait).length > 0 ? { entityByTrait } : {}),
  }, opts);

  const awaiting = mounted.flatMap(({ dispatch }) => awaitingEntries(dispatch, opts));
  store.awaiting.begin(awaiting);
  try {
    const shownAtMountSend = foldBase(store, request.entityByTrait, mounted.filter((m) => m.dispatch.mode === 'hybridClientOnly').map((m) => m.dispatch.trait), opts.traitIndex);
    let posted: OrbitalEventResponse;
    try {
      posted = await transport.send(orbitalName, request);
    } catch (err) {
      for (const { dispatch } of mounted) restoreDispatch(store, dispatch, 'transport-error');
      throw err;
    }
    if (!posted.success) {
      for (const { dispatch } of mounted) {
        if (dispatch.mode === 'runtimeOptimistic') restoreDispatch(store, dispatch, 'server-rejected');
      }
    }
    const delivered = new Set<string>();
    const written = new Set<string>();
    for (const { dispatch } of mounted) {
      for (const key of alreadyDeliveredFrom(dispatch)) delivered.add(key);
      for (const trait of dispatch.writtenTraits) written.add(trait);
    }
    const folded = await applyOrbitalEventResponse(
      store,
      changedSinceCarried(posted, shownAtMountSend, opts.traitIndex),
      delivered,
      opts,
      written,
    );
    const continued = await dispatchOwnContinuations(transport, orbitalName, folded, store, opts);
    return {
      success: posted.success,
      states: posted.states,
      rejections: (posted.rejections ?? []).filter((r) => r.code === 'effect-failed'),
      emittedEvents: posted.emittedEvents.filter((e) => !delivered.has(alreadyDeliveredKey(e.source?.trait ?? '', e.event))),
      clientEffects: [...folded.clientEffects, ...continued.clientEffects],
      clientEffectsByTrait: [...folded.clientEffectsByTrait, ...continued.clientEffectsByTrait],
      ...(posted.error !== undefined ? { error: posted.error } : {}),
    };
  } finally {
    store.awaiting.end(awaiting.map((a) => a.trait));
  }
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
  /**
   * The transport's topology while its `register()` is pending. Local arms
   * and their paints never wait for it; every post does, and is shaped by
   * the confirmed `carriesCircuitState` (overriding the role's own).
   */
  topology?: Promise<{ carriesCircuitState: boolean }>;
}

/** One `ClientKernel.dispatch()` call's settled outcome. */
export interface ClientKernelOutcome {
  response: OrbitalEventResponse;
  mode: DispatchMode;
  /**
   * True when `onLocal` already received the local arm's response (the leg
   * was posted). `serverEffects` then holds only what the server's fold
   * added — the local ones were painted before the round trip.
   */
  localPainted?: boolean;
  serverEffects?: Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'>;
  /**
   * A tick-lane dispatch: what its post's fold added on top of the local run,
   * once the post settles (undefined when a newer firing superseded it). The
   * drain never waits on it; the caller paints it when it lands.
   */
  tickSettled?: Promise<Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'> | undefined>;
}

/** Per-dispatch hooks: `onLocal` sees the locally-evaluated response before its server leg is sent. */
export interface ClientDispatchHooks {
  onLocal?: (local: OrbitalEventResponse) => void;
}

/** Mount hooks: `onLocal` sees each seed's local response before the mount leg is sent. */
export interface ClientMountHooks {
  onLocal?: (trait: string, local: OrbitalEventResponse) => void;
}

/** One `ClientKernel.dispatchMount()` call's settled outcome. */
export interface ClientMountOutcome {
  /** Each seed's local run, in seed order (already painted through `onLocal`). */
  seeds: Array<{ trait: string; event: string; mode: DispatchMode; local: OrbitalEventResponse }>;
  /** Whether any mount leg was posted. */
  posted: boolean;
  success: boolean;
  error?: string;
  /** Per-trait effect failures the posted legs reported (`effect-failed`). */
  rejections: TransitionRejection[];
  /** What the posted legs added: the server's effects and the emits the client had not run. */
  serverEffects: Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'>;
  emittedEvents: OrbitalEventResponse['emittedEvents'];
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
  dispatch(request: OrbitalEventRequest, hooks?: ClientDispatchHooks): Promise<ClientKernelOutcome>;
  /**
   * Dispatch a server-pushed live message of THIS client's own running
   * request (`PushTarget` `origin`). Outside the FIFO, because the request
   * producing it is the entry the FIFO is waiting on; progress dispatches run
   * one at a time, in push order, and never mark traits awaiting.
   */
  dispatchProgress(request: OrbitalEventRequest): Promise<ClientKernelOutcome>;
  /**
   * Show the result of a dispatch the host ran on its own (`EventTransport.subscribeHostDispatches`):
   * the host's states, rows and render land in this view. Nothing runs here and nothing is posted,
   * so the dispatch's effects happen once, on the host. Host dispatches fold one at a time, in order.
   */
  foldHostDispatch(request: OrbitalEventRequest, response: OrbitalEventResponse): Promise<ClientKernelOutcome>;
  /**
   * Mount several traits in ONE FIFO entry: every seed's local arm runs and
   * paints, then one `mount` leg per owning orbital is posted and folded.
   */
  dispatchMount(
    seeds: readonly MountSeed[],
    hooks?: ClientMountHooks,
    base?: Pick<OrbitalEventRequest, 'payload' | 'entityId' | 'clientId' | 'locale'>,
  ): Promise<ClientMountOutcome>;
  readonly store: CircuitStore;
}

interface QueuedKernelEntry {
  kind?: undefined;
  request: OrbitalEventRequest;
  hooks: ClientDispatchHooks[];
  resolvers: Array<(outcome: ClientKernelOutcome) => void>;
  rejecters: Array<(err: Error) => void>;
}

/** A dispatch the host ran on its own: applied in queue order, after whatever request was in flight when it arrived. */
interface QueuedHostEntry {
  kind: 'host';
  request: OrbitalEventRequest;
  response: OrbitalEventResponse;
  resolve: (outcome: ClientKernelOutcome) => void;
  reject: (err: Error) => void;
}

interface QueuedMountEntry {
  kind: 'mount';
  seeds: readonly MountSeed[];
  hooks?: ClientMountHooks;
  base: Pick<OrbitalEventRequest, 'payload' | 'entityId' | 'clientId' | 'locale'>;
  resolve: (outcome: ClientMountOutcome) => void;
  reject: (err: Error) => void;
}

/**
 * The server's share of a posted dispatch's effects. A successful post
 * returns `[...local, ...folded]` (postServerLeg's merge), so the server's are
 * what follows the local arm's; a rejected post returns the server's response
 * alone, every effect of which is the server's.
 */
function serverOnlyEffects(
  local: OrbitalEventResponse,
  response: OrbitalEventResponse,
): Pick<OrbitalEventResponse, 'clientEffects' | 'clientEffectsByTrait'> {
  if (!response.success) return { clientEffects: response.clientEffects, clientEffectsByTrait: response.clientEffectsByTrait };
  return {
    clientEffects: (response.clientEffects ?? []).slice((local.clientEffects ?? []).length),
    clientEffectsByTrait: response.clientEffectsByTrait?.slice((local.clientEffectsByTrait ?? []).length),
  };
}

/**
 * Build one `ClientKernel` — one FIFO queue over `opts.store`, the twin of
 * orbital-client's `ClientKernel` (`client_kernel.rs`): a per-dispatch
 * `dispatchWithServerLeg` run, `postServerLeg` deciding whether/what to post
 * per `opts.carriesCircuitState`, and one `applyOrbitalEventResponse` fold
 * (done inside `postServerLeg`) before the next queued entry starts.
 */
export function createClientKernel(opts: ClientKernelOpts): ClientKernel {
  const { transport, topology, ...roleOpts } = opts;
  const queue: Array<QueuedKernelEntry | QueuedMountEntry | QueuedHostEntry> = [];
  let pumping = false;

  // Posts are shaped by the confirmed topology; local arms never wait for it.
  let postRoleOpts: ClientRoleOpts | undefined = topology === undefined ? roleOpts : undefined;
  const postRole = async (): Promise<ClientRoleOpts> => {
    if (postRoleOpts !== undefined) return postRoleOpts;
    const confirmed = await (topology ?? Promise.resolve({ carriesCircuitState: roleOpts.carriesCircuitState }));
    postRoleOpts = { ...roleOpts, carriesCircuitState: confirmed.carriesCircuitState };
    return postRoleOpts;
  };

  // Multi-orbital routing: every posted dispatch goes to the orbital that
  // OWNS the seed trait (`traitIndex` stamps `orbitalName` per trait at
  // `buildTraitIndex`), NOT the kernel's single baked `orbitalName` — which
  // every caller sets to its FIRST orbital (`useCircuitKernel` passes
  // `orbitals[0].name`). Pre-fix, a page mounting a non-first orbital's
  // traits posted their INITs to the first orbital's endpoint and the
  // stateful host answered `no-dispatchable-traits` with an empty `states`
  // map (the 2026-09-23 catalog nav regression); a trait missing from the
  // index (garbage input) falls back to the baked name.
  const orbitalFor = (request: OrbitalEventRequest): string =>
    (request.targetTrait !== undefined
      ? roleOpts.traitIndex.byName.get(request.targetTrait)?.orbitalName
      : undefined) ?? roleOpts.orbitalName;

  // Tick-stamped posts leave the FIFO: a tick is a latest-state broadcast,
  // so its round trip must never delay a queued command (R-CLIENT-TICK-POST-
  // BACKLOG). One lane per (event, trait): at most one post in flight,
  // newer firings replace the pending one, the newest goes out on settle.
  type TickPost = { dispatch: ClientDispatch; request: OrbitalEventRequest; settle: (response: OrbitalEventResponse | undefined) => void };
  const tickLanes = new Map<string, { inFlight: boolean; pending?: TickPost }>();
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
    void postRole()
      .then((role) => postServerLeg(transport, orbitalFor(next.request), next.dispatch, roleOpts.store, role, next.request))
      .then((response) => next.settle(response))
      .catch((err: Error) => {
        clientRoleLog.warn('tick-post-failed', { event: next.request.event, trait: next.request.targetTrait, error: String(err) });
        next.settle(undefined);
      })
      .then(() => flushTickLane(key));
  };
  const postTick = (dispatch: ClientDispatch, request: OrbitalEventRequest): Promise<OrbitalEventResponse | undefined> => {
    const key = `${request.targetTrait ?? ''}\u0000${request.event}`;
    const lane = tickLanes.get(key) ?? { inFlight: false };
    tickLanes.set(key, lane);
    // No rollback point: the post settles after later commands have run, so
    // restoring this snapshot would clobber them; the next tick supersedes.
    const { snapshot: _snapshot, siblingSnapshots: _siblings, ...unrollable } = dispatch;
    return new Promise((settle) => {
      lane.pending?.settle(undefined);
      lane.pending = { dispatch: unrollable, request, settle };
      if (!lane.inFlight) flushTickLane(key);
    });
  };

  let progressChain: Promise<void> = Promise.resolve();
  const runHostDispatch = async (request: OrbitalEventRequest, response: OrbitalEventResponse): Promise<ClientKernelOutcome> => {
    const mode = (request.targetTrait !== undefined ? roleOpts.traitIndex.byName.get(request.targetTrait)?.dispatchMode : undefined) ?? 'persistedAwaited';
    if (!response.success) return { response: { ...response, clientEffects: [], clientEffectsByTrait: [] }, mode };
    const folded = await applyOrbitalEventResponse(roleOpts.store, response, new Set(), roleOpts);
    roleOpts.store.notify();
    return { response: { ...response, clientEffects: folded.clientEffects, clientEffectsByTrait: folded.clientEffectsByTrait }, mode };
  };

  const runProgress = async (request: OrbitalEventRequest): Promise<ClientKernelOutcome> => {
    const dispatch = await dispatchWithServerLeg(roleOpts, request);
    // A live message is for this tab only, never in-band (LOLO §call-service onMessage): only the
    // arm's own server work is sent, never the message itself.
    const hasServerWork = dispatch.serverLeg !== undefined || dispatch.continuations !== undefined;
    const response = transport !== undefined && hasServerWork
      ? await postServerLeg(transport, orbitalFor(request), dispatch, roleOpts.store, await postRole(), request, undefined, true)
      : dispatch.response;
    return { response, mode: dispatch.mode };
  };

  async function runMount(entry: QueuedMountEntry): Promise<void> {
    try {
      const mounted: MountedDispatch[] = [];
      for (const seed of entry.seeds) {
        const dispatch = await dispatchWithServerLeg(roleOpts, { ...entry.base, event: seed.event, targetTrait: seed.trait }).catch((err: unknown) => {
          throw new TraitMountError(seed.trait, seed.event, err instanceof Error ? err : new Error(String(err)));
        });
        mounted.push({ seed, dispatch });
      }
      for (const { seed, dispatch } of mounted) entry.hooks?.onLocal?.(seed.trait, dispatch.response);
      const seeds = mounted.map(({ seed, dispatch }) => ({ trait: seed.trait, event: seed.event, mode: dispatch.mode, local: dispatch.response }));
      const outcome: ClientMountOutcome = { seeds, posted: false, success: true, rejections: [], serverEffects: { clientEffects: [], clientEffectsByTrait: [] }, emittedEvents: [] };
      if (transport !== undefined) {
        const role = await postRole();
        const byOrbital = new Map<string, MountedDispatch[]>();
        for (const m of mounted) {
          const posts = m.dispatch.serverLeg !== undefined || (!role.carriesCircuitState && m.dispatch.mode !== 'hybridClientOnly');
          if (!posts) continue;
          const orbital = orbitalFor({ event: m.seed.event, targetTrait: m.seed.trait });
          byOrbital.set(orbital, [...(byOrbital.get(orbital) ?? []), m]);
        }
        for (const [orbital, group] of byOrbital) {
          const leg = await postMountLeg(transport, orbital, group, roleOpts.store, role, entry.base);
          outcome.posted = true;
          outcome.success = outcome.success && leg.success;
          if (leg.error !== undefined) outcome.error = leg.error;
          outcome.rejections.push(...leg.rejections);
          outcome.serverEffects.clientEffects?.push(...leg.clientEffects);
          outcome.serverEffects.clientEffectsByTrait?.push(...leg.clientEffectsByTrait);
          outcome.emittedEvents.push(...leg.emittedEvents);
        }
        for (const m of mounted) {
          if (m.dispatch.continuations === undefined) continue;
          const answer = await answerContinuations(transport, m.dispatch, roleOpts.store, role);
          outcome.posted = true;
          outcome.serverEffects.clientEffects?.push(...answer.clientEffects);
          outcome.serverEffects.clientEffectsByTrait?.push(...answer.clientEffectsByTrait);
          outcome.emittedEvents.push(...answer.emittedEvents);
        }
      }
      entry.resolve(outcome);
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (queue.length > 0) {
          const entry = queue.shift()!;
          if (entry.kind === 'mount') {
            await runMount(entry);
            continue;
          }
          if (entry.kind === 'host') {
            await runHostDispatch(entry.request, entry.response).then(entry.resolve, entry.reject);
            continue;
          }
          try {
            const dispatch = await dispatchWithServerLeg(roleOpts, entry.request);
            let response = dispatch.response;
            let localPainted = false;
            let tickSettled: ClientKernelOutcome['tickSettled'];
            if (transport !== undefined) {
              if (entry.request.tick !== undefined) {
                const local = dispatch.response;
                tickSettled = postTick(dispatch, entry.request).then((posted) => (posted === undefined ? undefined : serverOnlyEffects(local, posted)));
              } else {
                // Paint before waiting on the topology or the round trip.
                const painters = entry.hooks.filter((h) => h.onLocal !== undefined);
                if (painters.length > 0) {
                  localPainted = true;
                  for (const h of painters) h.onLocal?.(dispatch.response);
                }
                response = await postServerLeg(transport, orbitalFor(entry.request), dispatch, roleOpts.store, await postRole(), entry.request);
              }
            }
            const outcome: ClientKernelOutcome = localPainted
              ? { response, mode: dispatch.mode, localPainted, serverEffects: serverOnlyEffects(dispatch.response, response) }
              : { response, mode: dispatch.mode, ...(tickSettled !== undefined ? { tickSettled } : {}) };
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
    dispatchProgress(request: OrbitalEventRequest): Promise<ClientKernelOutcome> {
      const outcome = progressChain.then(() => runProgress(request));
      progressChain = outcome.then(() => undefined, () => undefined);
      return outcome;
    },
    foldHostDispatch(request: OrbitalEventRequest, response: OrbitalEventResponse): Promise<ClientKernelOutcome> {
      return new Promise<ClientKernelOutcome>((resolve, reject) => {
        queue.push({ kind: 'host', request, response, resolve, reject });
        pump();
      });
    },
    dispatchMount(seeds, hooks, base = {}): Promise<ClientMountOutcome> {
      return new Promise<ClientMountOutcome>((resolve, reject) => {
        queue.push({ kind: 'mount', seeds, ...(hooks !== undefined ? { hooks } : {}), base, resolve, reject });
        pump();
      });
    },
    dispatch(request: OrbitalEventRequest, hooks?: ClientDispatchHooks): Promise<ClientKernelOutcome> {
      return new Promise<ClientKernelOutcome>((resolve, reject) => {
        if (request.tick !== undefined) {
          const pending = queue.find(
            (e): e is QueuedKernelEntry => e.kind === undefined && e.request.tick !== undefined
              && e.request.event === request.event
              && e.request.targetTrait === request.targetTrait,
          );
          if (pending !== undefined) {
            pending.request = { ...pending.request, payload: request.payload };
            pending.resolvers.push(resolve);
            pending.rejecters.push(reject);
            if (hooks !== undefined) pending.hooks.push(hooks);
            return;
          }
        }
        queue.push({ request, hooks: hooks !== undefined ? [hooks] : [], resolvers: [resolve], rejecters: [reject] });
        pump();
      });
    },
  };
}
