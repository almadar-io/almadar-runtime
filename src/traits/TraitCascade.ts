/**
 * Same-trait cascade completion — shared by `OrbitalServerRuntime.processOrbitalEvent`
 * (stateful) and `@almadar-io/playground-runtime`'s stateless `evaluateTransition`.
 *
 * The gap this closes: a trait's `INIT` arm does
 * `(fetch Entity {emit: {success: Loaded}})`, and a SEPARATE arm
 * `Loaded -> newState` applies `(set @entity.X ...)` using the fetched data.
 * Neither server path ever re-invoked the state machine for a trait's own
 * emitted event — `processEvent` runs once, effects run once, and the
 * `Loaded` event was only ever completed by a CLIENT-side mechanism
 * (`useTraitStateMachine.ts`'s self-subscribe/self-fire), which requires the
 * writer trait to be mounted in a browser. A `[lifecycle, instance]`
 * aggregator with no renderer of its own, or a server-only/headless caller
 * (`orbital_play`, a webhook handler), has nothing to complete it — confirmed
 * live via `orbital_play` against `OrbitalServerRuntime` directly (no
 * browser involved): `DashboardHoursLoaded` fired with real fetched data, but
 * the aggregator's own `(set @entity.totalHours ...)` arm never ran.
 *
 * `orbital-core`'s compiled-path kernel (`RuntimeKernel::dispatch`) already
 * proves the right general shape for this: a worklist that drains until no
 * new targets are found, with a `visited` cycle-guard — it just never
 * registers a trait's own native arm as an implicit target for its own
 * emitted event (only explicit `listens {}` cross-trait targets). This
 * module gives the JS interpreter the equivalent same-trait half; cross-trait
 * `listens` fan-out is untouched here (each caller keeps its own existing
 * mechanism for that).
 *
 * @packageDocumentation
 */

import {
    processEvent,
    findMatchingTransitions,
    type ProcessEventOptions,
} from './StateMachineCore.js';
import type { TransitionResult } from '../types.js';
import { createLogger } from '@almadar/logger';
import { dispatchVisitKey, type BusEventSource, type DeliveryRecord, type EntityRow, type EventPayload } from '@almadar/core';
import { DispatchMemory, type EffectDispatch } from '../evaluation/dispatch-memory.js';

const cascadeLog = createLogger('almadar:runtime:trait-cascade');

/** Generous safety cap — real cascades are 1-3 hops. Never silently
 *  truncate: hitting this logs loudly and stops, keeping whatever the
 *  cascade already accumulated. */
const DEFAULT_MAX_STEPS = 20;

/** One step's own emitted events, as the caller's effect-runner reports them. */
export interface CascadeEmittedEvent {
    event: string;
    payload?: EventPayload;
    /** Mutated in place to `{ ...source, dispatched: true }` when this
     *  specific event was the one the cascade consumed to advance to the
     *  next step — see this module's doc for why (reuses `BusEventSource.dispatched`,
     *  the existing client-side "already delivered, don't reprocess" contract,
     *  instead of inventing a second one). Left untouched for every event
     *  this cascade does NOT itself consume (cross-trait, or same-trait but
     *  no matching arm) — the client remains free to react to those exactly
     *  as today. */
    source?: BusEventSource;
}

/** One step's outcome, as the caller's own effect-execution mechanism reports it. */
export interface CascadeStepEffectsResult<TEffectResult> {
    effectResults: TEffectResult[];
    emitted: CascadeEmittedEvent[];
}

export interface RunTraitCascadeOptions<TEffectResult> {
    trait: ProcessEventOptions['trait'];
    /** The starting state to process `eventKey` from. */
    fromState: string;
    eventKey: string;
    payload?: EventPayload;
    /** Re-read fresh before EACH step — a prior step's `set`/`persist`
     *  effect may have mutated the persisted row, and the next step's guard
     *  and `@entity.X` bindings must see that, exactly like a fresh
     *  request would. */
    getEntityData: () => Promise<EntityRow> | EntityRow;
    config?: ProcessEventOptions['config'];
    user?: ProcessEventOptions['user'];
    now?: ProcessEventOptions['now'];
    guardMode?: ProcessEventOptions['guardMode'];
    strictBindings?: ProcessEventOptions['strictBindings'];
    contextExtensions?: ProcessEventOptions['contextExtensions'];
    /** The seed's delivery record; a direct dispatch with no emitter has an empty `source`. */
    delivery?: DeliveryRecord;
    /** The enclosing dispatch's memory, shared across every trait it reaches. */
    memory?: DispatchMemory;
    /** Runs one step's effects (the caller's own `EffectExecutor`/
     *  `executeEffects` wiring — the two callers' setups differ too much to
     *  share this part) and reports what it emitted, so this loop can decide
     *  whether to keep going. `step.payload` is THIS step's own event
     *  payload (the previous step's emit, for step 2+) — effect bindings
     *  must read `@payload.X` off it, not the original top-level request's. */
    runEffects: (
        effects: TransitionResult['effects'],
        step: { fromState: string; toState: string; event: string; payload?: EventPayload; dispatch: EffectDispatch },
    ) => Promise<CascadeStepEffectsResult<TEffectResult>>;
    maxSteps?: number;
    /** Named identifiers for the cap-hit warning log only — e.g. the
     *  behavior/orbital name, so a runaway cascade is diagnosable without
     *  reproducing it. */
    logContext?: { behavior?: string; orbitalName?: string };
}

export interface TraitCascadeResult<TEffectResult> {
    /** Whether the FIRST step (the originally requested event) matched and executed. */
    executed: boolean;
    /** State after the whole cascade settled (or after the first step, if it didn't cascade further). */
    finalState: string;
    /** Every step's effect results, in order, flattened. */
    effectResults: TEffectResult[];
    /** Every step's emitted events, in order, flattened. Same-trait-consumed
     *  entries are stamped `source.dispatched = true` in place — see
     *  `CascadeEmittedEvent`'s doc. */
    emitted: CascadeEmittedEvent[];
    /** Number of steps actually run (1 if no cascade occurred, 0 if the
     *  initial event didn't match anything). */
    steps: number;
    /** Set when `maxSteps` was hit — the cascade stopped early, logged, not thrown. */
    cappedAt?: number;
}

/**
 * Run `eventKey` on `trait` from `fromState`, then keep advancing through
 * the SAME trait's own emitted events as long as its own transition table
 * has a matching arm from the new state — a same-trait fixed-point worklist,
 * bounded by `maxSteps`. Cross-trait `listens` fan-out is the caller's own
 * concern (unchanged); this only ever re-invokes `processEvent` for `trait`
 * itself.
 */
export async function runTraitCascade<TEffectResult>(
    options: RunTraitCascadeOptions<TEffectResult>,
): Promise<TraitCascadeResult<TEffectResult>> {
    const {
        trait, fromState, eventKey, payload, getEntityData, config, user, now,
        guardMode, strictBindings, contextExtensions, runEffects,
        maxSteps = DEFAULT_MAX_STEPS, logContext,
    } = options;
    const memory = options.memory ?? new DispatchMemory();

    const effectResults: TEffectResult[] = [];
    const emitted: CascadeEmittedEvent[] = [];
    // `dispatchVisitKey`, the one delivery identity both runtimes share.
    const visited = new Set<string>();

    // A WORKLIST, not a single cursor: one step's effects can emit several
    // SIBLING events, and more than one can have its own matching arm from
    // the state that step just landed in — confirmed live 2026-09-18 via
    // GlobalSearch's `SEARCH -> searching` arm, which emits BOTH
    // `QUERY_SAVED` (a persist-success callback) and `FAN_OUT_STEP` in the
    // same step. The first draft of this loop only ever continued the
    // FIRST matching sibling it found (`.find()`), silently discarding
    // every other one — `FAN_OUT_STEP` never advanced past its first hop.
    // A trait still occupies exactly one state at a time, so each queued
    // sibling is re-checked against the trait's ACTUAL current state at the
    // moment it's dequeued (not a stale snapshot from when it was queued):
    // if an earlier sibling already moved the state somewhere this one's
    // arm no longer matches, `processEvent` reports `executed: false` and
    // this branch simply drops — the same outcome a real client's own
    // independent dispatch of the same event would reach.
    interface QueuedEvent { event: string; payload?: EventPayload; delivery: DeliveryRecord }
    const queue: QueuedEvent[] = [{
        event: eventKey,
        payload,
        delivery: options.delivery ?? { event: eventKey, ...(payload !== undefined ? { payload } : {}), source: {} },
    }];

    let currentState = fromState;
    let steps = 0;
    let executed = false;
    let cappedAt: number | undefined;

    while (queue.length > 0 && steps < maxSteps) {
        const item = queue.shift() as QueuedEvent;
        const stepFromState = currentState;
        // Payload is part of the identity, not just event+state — a
        // decrementing fan-out counter (`FAN_OUT_STEP {remaining: 2}` ->
        // `FAN_OUT_STEP {remaining: 1}`, both `searching -> searching`
        // self-loops) is genuine progress toward termination, not a cycle;
        // keying on event+state ALONE (as this originally did) treated it
        // as one after a single hop — confirmed live 2026-09-18 via
        // GlobalSearch, whose fan-out never advanced past its first step.
        // A TRUE cycle (no payload change either) still gets caught, same
        // as before; anything that genuinely never converges still hits
        // the numeric `maxSteps` cap below.
        const stepKey = dispatchVisitKey(trait.name, item.event, stepFromState, item.payload);
        if (visited.has(stepKey)) continue; // this branch cycles — drop it, keep draining the rest of the queue
        visited.add(stepKey);

        const entityData = await getEntityData();
        const view = memory.view(trait.name, item.delivery);
        const result = processEvent({
            traitState: { traitName: trait.name, currentState: stepFromState, previousState: null, lastEvent: null, context: {} },
            trait,
            eventKey: item.event,
            payload: item.payload,
            entityData,
            config,
            user,
            ...(now !== undefined ? { now } : {}),
            guardMode,
            strictBindings,
            contextExtensions,
            dispatch: view,
        });
        memory.recordDelivery(trait.name, item.delivery);

        if (!result.executed) continue; // no matching/guarded-through arm from the CURRENT state — drop this branch
        steps += 1;
        if (steps === 1) executed = true;
        currentState = result.newState;
        memory.recordTransition(trait.name, stepFromState, result.newState);

        if (result.effects.length > 0) {
            const stepOutcome = await runEffects(result.effects, {
                fromState: stepFromState,
                toState: result.newState,
                event: item.event,
                payload: item.payload,
                dispatch: { ...view, fromState: stepFromState, toState: result.newState },
            });
            effectResults.push(...stepOutcome.effectResults);
            emitted.push(...stepOutcome.emitted);

            // Enqueue EVERY sibling emit from this step that the trait's OWN
            // table has an arm for, from the state it just landed in — not
            // just the first.
            for (const e of stepOutcome.emitted) {
                if (findMatchingTransitions(trait, result.newState, e.event).length === 0) continue;
                // Mark consumed so the caller's response doesn't hand the
                // client an event that was actually already fully processed
                // server-side (would otherwise double-apply client-side if
                // that trait happens to also be mounted there). Stamped at
                // enqueue time, same as before this event carried siblings —
                // a branch that later turns out stale (a sibling already
                // moved the state past it) still no-ops identically on a
                // client re-running the same state machine, so this is safe
                // either way.
                const delivery: DeliveryRecord = {
                    event: e.event,
                    ...(e.payload !== undefined ? { payload: e.payload } : {}),
                    source: { ...(e.source ?? {}) },
                };
                e.source = { ...e.source, dispatched: true };
                // The next step's guard/effect bindings must see THIS
                // event's own payload (e.g. a fetch's `{data: [...]}`), not
                // the original top-level request's — a `(set @entity.total
                // (array/sum @payload.data amount))` arm reads
                // `@payload.data` off whatever event it's reacting to.
                queue.push({ event: e.event, payload: e.payload, delivery });
            }
        }
    }

    if (steps >= maxSteps) {
        cappedAt = maxSteps;
        cascadeLog.warn('cascade:cap-hit', { trait: trait.name, maxSteps, ...logContext });
    }

    return { executed, finalState: currentState, effectResults, emitted, steps, cappedAt };
}
