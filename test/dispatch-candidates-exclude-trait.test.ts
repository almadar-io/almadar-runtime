/**
 * G-RUNTIME-020 — `excludeTrait` on the untargeted broadcast (interpreter path).
 *
 * A trait's transition whose own effects re-emit the SAME event it fires on
 * used to loop forever: the client's bare-cascade broadcast re-delivered the
 * re-emitted event back to the SAME trait that just emitted it, over and
 * over (SnakePlay.RESTART -> playing re-emitting RESTART wedged the whole
 * game). `StateMachineManager.sendEvent`'s new trailing `excludeTrait`
 * parameter (threaded from `useTraitStateMachine.ts`'s `sourceTrait`) drops
 * exactly that one trait from an untargeted broadcast, mirroring the
 * compiled path's `t.name != source_trait` filter.
 */
import { describe, it, expect } from 'vitest';
import { StateMachineManager, type TraitDefinition } from '../src/StateMachineCore.js';

describe('G-RUNTIME-020 — excludeTrait drops one trait from an untargeted broadcast', () => {
  it('excludes the named trait from the broadcast; only the other trait fires and advances', () => {
    const traitA: TraitDefinition = {
      name: 'A',
      states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
      transitions: [{ from: 'idle', to: 'done', event: 'PING' }],
    };
    const traitB: TraitDefinition = {
      name: 'B',
      states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
      transitions: [{ from: 'idle', to: 'done', event: 'PING' }],
    };
    const mgr = new StateMachineManager([traitA, traitB]);

    const results = mgr.sendEvent(
      'PING', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'A',
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.traitName).toBe('B');
    expect(mgr.getState('B')?.currentState).toBe('done');
    // A was excluded from the broadcast entirely — its state never advanced.
    expect(mgr.getState('A')?.currentState).toBe('idle');
  });

  it('without excludeTrait both traits fire (existing broadcast behavior unchanged)', () => {
    const traitA: TraitDefinition = {
      name: 'A',
      states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
      transitions: [{ from: 'idle', to: 'done', event: 'PING' }],
    };
    const traitB: TraitDefinition = {
      name: 'B',
      states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
      transitions: [{ from: 'idle', to: 'done', event: 'PING' }],
    };
    const mgr = new StateMachineManager([traitA, traitB]);

    const results = mgr.sendEvent('PING');

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.traitName).sort()).toEqual(['A', 'B']);
    expect(mgr.getState('A')?.currentState).toBe('done');
    expect(mgr.getState('B')?.currentState).toBe('done');
  });

  it('targetTrait naming the same trait as excludeTrait still wins (scoped delivery is never dropped)', () => {
    const traitA: TraitDefinition = {
      name: 'A',
      states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
      transitions: [{ from: 'idle', to: 'done', event: 'PING' }],
    };
    const traitB: TraitDefinition = {
      name: 'B',
      states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
      transitions: [{ from: 'idle', to: 'done', event: 'PING' }],
    };
    const mgr = new StateMachineManager([traitA, traitB]);

    const results = mgr.sendEvent(
      'PING', undefined, undefined, undefined, undefined, 'A', undefined, undefined, 'A',
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.traitName).toBe('A');
    expect(results[0]?.result.executed).toBe(true);
    expect(mgr.getState('A')?.currentState).toBe('done');
  });

  it('self-looping trait does not receive its own re-emitted event back, but still fires on a genuine send', () => {
    const restarter: TraitDefinition = {
      name: 'Restarter',
      states: [{ name: 'idle' }, { name: 'playing', isInitial: true }],
      transitions: [{ from: 'playing', to: 'playing', event: 'RESTART' }],
    };
    const mgr = new StateMachineManager([restarter]);

    // Simulates the fixed bare-cascade re-delivery: the trait that just
    // emitted RESTART is excluded from receiving its own echo back.
    const looped = mgr.sendEvent(
      'RESTART', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'Restarter',
    );
    expect(looped).toHaveLength(0);

    // A genuine dispatch (no sourceTrait/excludeTrait — a top-level user
    // click, never the trait's own emit) still fires normally.
    const direct = mgr.sendEvent('RESTART');
    expect(direct).toHaveLength(1);
    expect(direct[0]?.traitName).toBe('Restarter');
    expect(mgr.getState('Restarter')?.currentState).toBe('playing');
  });
});
