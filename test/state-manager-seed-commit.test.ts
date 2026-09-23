/**
 * `StateMachineManager.seedState` / `commitState` — the per-request
 * lifecycle hooks the unified `evaluateOrbitalEvent` composition uses:
 * seedState replays a client's round-tripped state into a fresh manager;
 * commitState upserts a cascade's final state and replays the observer
 * trace `sendEvent` would have emitted.
 */
import { describe, it, expect } from 'vitest';
import { StateMachineManager, type TraitDefinition } from '../src/StateMachineCore.js';
import type { TransitionObserver } from '../src/types.js';

const trait = (name: string): TraitDefinition => ({
  name,
  states: [{ name: 'idle', isInitial: true }, { name: 'running' }, { name: 'done' }],
  transitions: [
    { from: 'idle', to: 'running', event: 'START' },
    { from: 'running', to: 'done', event: 'STOP' },
  ],
});

describe('seedState', () => {
  it('upserts a non-initial current state so canHandleEvent sees it', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.seedState('T', 'running');
    expect(mgr.getState('T')?.currentState).toBe('running');
    expect(mgr.canHandleEvent('T', 'STOP')).toBe(true);
    expect(mgr.canHandleEvent('T', 'START')).toBe(false);
  });

  it('overwrites an existing state and keeps the prior as previousState', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.sendEvent('START');
    mgr.seedState('T', 'done');
    expect(mgr.getState('T')?.currentState).toBe('done');
    expect(mgr.getState('T')?.previousState).toBe('running');
  });

  it('scopes by entityId like every other manager read', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.seedState('T', 'running', 'row-1');
    expect(mgr.getState('T', 'row-1')?.currentState).toBe('running');
    expect(mgr.getState('T')?.currentState).toBe('idle');
  });

  it('is a no-op for an unregistered trait', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.seedState('Nope', 'running');
    expect(mgr.getState('Nope')).toBeUndefined();
  });
});

describe('commitState', () => {
  it('upserts the final state (also for a trait with no tracked state yet)', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.commitState('T', 'done', undefined, 'STOP');
    expect(mgr.getState('T')?.currentState).toBe('done');
    expect(mgr.getState('T')?.lastEvent).toBe('STOP');
  });

  it('sets previousState to the prior currentState', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.seedState('T', 'running');
    mgr.commitState('T', 'done', undefined, 'STOP');
    expect(mgr.getState('T')?.previousState).toBe('running');
  });

  it('notifies the observer once per executed hop, same trace shape as sendEvent', () => {
    const traces: Array<{ traitName: string; from: string; to: string; event: string }> = [];
    const observer: TransitionObserver = {
      onTransition: (t) => {
        traces.push({ traitName: t.traitName, from: t.from, to: t.to, event: t.event });
      },
    };
    const mgr = new StateMachineManager([trait('T')], {}, observer);
    mgr.commitState('T', 'done', undefined, 'STOP', [
      { from: 'idle', to: 'running', event: 'START' },
      { from: 'running', to: 'done', event: 'STOP' },
    ]);
    expect(traces).toEqual([
      { traitName: 'T', from: 'idle', to: 'running', event: 'START' },
      { traitName: 'T', from: 'running', to: 'done', event: 'STOP' },
    ]);
    // No steps → no observer calls (a no-op dispatch stays silent, like sendEvent).
    traces.length = 0;
    mgr.commitState('T', 'done', undefined, 'STOP');
    expect(traces).toEqual([]);
  });

  it('is a no-op for an unregistered trait', () => {
    const mgr = new StateMachineManager([trait('T')]);
    mgr.commitState('Nope', 'done', undefined, 'STOP');
    expect(mgr.getState('Nope')).toBeUndefined();
  });
});
