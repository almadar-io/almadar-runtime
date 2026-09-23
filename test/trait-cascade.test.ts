/**
 * `runTraitCascade` — the shared same-trait fetch->emit->self-apply cascade
 * completion, used by both `OrbitalServerRuntime.processOrbitalEvent` and
 * the stateless `evaluateTransition`. Pure unit tests against a minimal
 * fake trait definition and an injected `runEffects` stub — the real
 * effect-execution wiring (EffectExecutor, persistence) is each caller's own
 * concern and is covered by their own integration tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { runTraitCascade } from '../src/traits/TraitCascade.js';
import type { TraitDefinition } from '../src/types.js';

/** A trait shaped exactly like the real-world bug: INIT fetches, and a
 *  SEPARATE arm (same state, "idle -> idle") applies the fetched data when
 *  the fetch's own success event fires. */
const aggregatorTrait: TraitDefinition = {
  name: 'TestAggregator',
  states: [{ name: 'idle', isInitial: true }],
  transitions: [
    { from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'Entity', { emit: { success: 'Loaded' } }]] },
    { from: 'idle', to: 'idle', event: 'Loaded', effects: [['set', '@entity.total', '@payload.total']] },
  ],
};

describe('runTraitCascade', () => {
  it('completes a same-trait fetch->emit->self-apply cascade in one call', async () => {
    const runEffects = vi.fn(async (effects, step) => {
      if (step.event === 'INIT') {
        return { effectResults: ['fetched'], emitted: [{ event: 'Loaded', payload: { total: 42 } }] };
      }
      return { effectResults: ['applied-set'], emitted: [] };
    });

    const result = await runTraitCascade({
      trait: aggregatorTrait,
      fromState: 'idle',
      eventKey: 'INIT',
      getEntityData: () => ({}),
      runEffects,
    });

    expect(result.executed).toBe(true);
    expect(result.steps).toBe(2);
    expect(result.effectResults).toEqual(['fetched', 'applied-set']);
    expect(runEffects).toHaveBeenCalledTimes(2);
  });

  it('stamps the consumed cascade event dispatched:true so a client does not re-apply it', async () => {
    const runEffects = vi.fn(async (effects, step) => {
      if (step.event === 'INIT') {
        return { effectResults: [], emitted: [{ event: 'Loaded', payload: {} }] };
      }
      return { effectResults: [], emitted: [] };
    });

    const result = await runTraitCascade({
      trait: aggregatorTrait,
      fromState: 'idle',
      eventKey: 'INIT',
      getEntityData: () => ({}),
      runEffects,
    });

    const loaded = result.emitted.find((e) => e.event === 'Loaded');
    expect(loaded?.source?.dispatched).toBe(true);
  });

  it('does not cascade an emitted event the trait has no arm for — it stays unstamped', async () => {
    const runEffects = vi.fn(async () => ({
      effectResults: [],
      emitted: [{ event: 'UnrelatedEvent', payload: {} }],
    }));

    const result = await runTraitCascade({
      trait: aggregatorTrait,
      fromState: 'idle',
      eventKey: 'INIT',
      getEntityData: () => ({}),
      runEffects,
    });

    expect(result.steps).toBe(1);
    const unrelated = result.emitted.find((e) => e.event === 'UnrelatedEvent');
    expect(unrelated?.source?.dispatched).toBeUndefined();
  });

  it('a same-state cycle (A emits B, B emits A) is caught by the visited-set guard, not the step cap', async () => {
    const cyclicTrait: TraitDefinition = {
      name: 'CyclicTrait',
      states: [{ name: 'idle', isInitial: true }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'A', effects: [['emit', 'B', {}]] },
        { from: 'idle', to: 'idle', event: 'B', effects: [['emit', 'A', {}]] },
      ],
    };
    let call = 0;
    const runEffects = vi.fn(async () => {
      call += 1;
      // A -> emits B, B -> emits A, forever, never changing state — the
      // `visited` set (keyed on event+state+payload) revisits "A:idle:{}" on
      // the third step and stops right there, well before any numeric cap
      // would. The initial call below passes the SAME `payload: {}` this
      // mock always re-emits, so the cycle key matches from the first hop —
      // payload is part of cycle identity (a decrementing fan-out counter
      // is genuine progress, not a cycle), so an inconsistent "no payload"
      // (`undefined`) vs. "empty payload" (`{}`) on the very first vs. every
      // subsequent hop would otherwise cost one extra, harmless hop before
      // the guard catches on — not a behavior this test is about.
      return { effectResults: [], emitted: [{ event: call % 2 === 1 ? 'B' : 'A', payload: {} }] };
    });

    const result = await runTraitCascade({
      trait: cyclicTrait,
      fromState: 'idle',
      eventKey: 'A',
      payload: {},
      getEntityData: () => ({}),
      runEffects,
      maxSteps: 20,
    });

    expect(result.cappedAt).toBeUndefined();
    expect(result.steps).toBe(2); // A, then B — the second B->A re-visit is what breaks the loop
  });

  it('a genuinely unbounded cascade (each step advances to a fresh state) hits the numeric cap and stops', async () => {
    const N = 30;
    const longTrait: TraitDefinition = {
      name: 'LongChainTrait',
      states: Array.from({ length: N + 1 }, (_, i) => ({ name: `state${i}`, isInitial: i === 0 })),
      transitions: Array.from({ length: N }, (_, i) => ({
        from: `state${i}`,
        to: `state${i + 1}`,
        event: `Next${i}`,
        effects: [['emit', `Next${i + 1}`, {}]],
      })),
    };
    const runEffects = vi.fn(async (effects, step) => {
      const i = Number(step.event.replace('Next', ''));
      return { effectResults: [], emitted: [{ event: `Next${i + 1}`, payload: {} }] };
    });

    const result = await runTraitCascade({
      trait: longTrait,
      fromState: 'state0',
      eventKey: 'Next0',
      getEntityData: () => ({}),
      runEffects,
      maxSteps: 5,
    });

    expect(result.cappedAt).toBe(5);
    expect(result.steps).toBe(5);
  });

  it('threads each step\'s OWN emitted payload into the NEXT step — not the original request payload', async () => {
    // Regression: the first implementation reused the top-level `payload`
    // argument for every cascade step, so a `Loaded -> idle (set @entity.total
    // (array/sum @payload.data amount))` arm always read the ORIGINAL
    // event's payload (typically empty/undefined for INIT) instead of the
    // fetch's own `{data: [...]}` — caught live via a real fetch-then-apply
    // integration test where `total` came back 0 instead of the real sum.
    const seenPayloads: unknown[] = [];
    const runEffects = vi.fn(async (effects, step) => {
      seenPayloads.push(step.payload);
      if (step.event === 'INIT') {
        return { effectResults: [], emitted: [{ event: 'Loaded', payload: { total: 99 } }] };
      }
      return { effectResults: [], emitted: [] };
    });

    await runTraitCascade({
      trait: aggregatorTrait,
      fromState: 'idle',
      eventKey: 'INIT',
      payload: undefined,
      getEntityData: () => ({}),
      runEffects,
    });

    expect(seenPayloads).toEqual([undefined, { total: 99 }]);
  });

  it('re-reads entity data fresh before each step', async () => {
    let entity = { total: 0 };
    const getEntityData = vi.fn(() => entity);
    const runEffects = vi.fn(async (effects, step) => {
      if (step.event === 'INIT') {
        entity = { total: 10 }; // simulate a persist effect mutating the row
        return { effectResults: [], emitted: [{ event: 'Loaded', payload: {} }] };
      }
      return { effectResults: [], emitted: [] };
    });

    await runTraitCascade({
      trait: aggregatorTrait,
      fromState: 'idle',
      eventKey: 'INIT',
      getEntityData,
      runEffects,
    });

    expect(getEntityData).toHaveBeenCalledTimes(2);
  });

  it('follows EVERY sibling emit with a matching arm, not just the first — GlobalSearch\'s SEARCH shape', async () => {
    // Regression: SEARCH emits TWO events in the same step — QUERY_SAVED
    // (a persist-success callback) and FAN_OUT_STEP (a direct emit). The
    // first draft of this loop used `.find()` and only ever continued
    // whichever one it found first, silently dropping the other —
    // confirmed live via GlobalSearch, where FAN_OUT_STEP never advanced
    // past its first hop server-side.
    const fanOutTrait: TraitDefinition = {
      name: 'FanOutTrait',
      states: [{ name: 'idle', isInitial: true }, { name: 'searching' }],
      transitions: [
        {
          from: 'idle', to: 'searching', event: 'SEARCH',
          effects: [['emit', 'QUERY_SAVED', {}], ['emit', 'FAN_OUT_STEP', { remaining: 2 }]],
        },
        { from: 'searching', to: 'searching', event: 'QUERY_SAVED', effects: [['set', '@entity.savedQueryId', 1]] },
        {
          from: 'searching', to: 'searching', event: 'FAN_OUT_STEP',
          effects: [['emit', 'FAN_OUT_STEP', { remaining: 1 }]],
        },
      ],
    };
    const seenEvents: string[] = [];
    const runEffects = vi.fn(async (effects, step) => {
      seenEvents.push(step.event);
      if (step.event === 'SEARCH') {
        return {
          effectResults: [],
          emitted: [{ event: 'QUERY_SAVED', payload: {} }, { event: 'FAN_OUT_STEP', payload: { remaining: 2 } }],
        };
      }
      if (step.event === 'FAN_OUT_STEP' && (step.payload as { remaining?: number } | undefined)?.remaining === 2) {
        return { effectResults: [], emitted: [{ event: 'FAN_OUT_STEP', payload: { remaining: 1 } }] };
      }
      return { effectResults: [], emitted: [] };
    });

    const result = await runTraitCascade({
      trait: fanOutTrait,
      fromState: 'idle',
      eventKey: 'SEARCH',
      getEntityData: () => ({}),
      runEffects,
    });

    // Both siblings ran (QUERY_SAVED, and FAN_OUT_STEP through BOTH its own
    // hops) — not just whichever one `.find()` used to pick first.
    expect(seenEvents).toEqual(['SEARCH', 'QUERY_SAVED', 'FAN_OUT_STEP', 'FAN_OUT_STEP']);
    expect(result.steps).toBe(4);
    const fanOutEmits = result.emitted.filter((e) => e.event === 'FAN_OUT_STEP');
    expect(fanOutEmits.every((e) => e.source?.dispatched === true)).toBe(true);
  });

  it('returns executed: false when the initial event has no matching arm', async () => {
    const runEffects = vi.fn();
    const result = await runTraitCascade({
      trait: aggregatorTrait,
      fromState: 'idle',
      eventKey: 'NO_SUCH_EVENT',
      getEntityData: () => ({}),
      runEffects,
    });

    expect(result.executed).toBe(false);
    expect(result.steps).toBe(0);
    expect(runEffects).not.toHaveBeenCalled();
  });
});
