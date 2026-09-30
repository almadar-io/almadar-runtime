/**
 * `StateMachineManager.repaintLifecycleEvent` — the lifecycle event an
 * embedded child may be repainted with (callsite capture): only one whose
 * every matching arm from the current state stays in that state.
 */
import { describe, it, expect } from 'vitest';
import { StateMachineManager, type TraitDefinition } from '../src/traits/StateMachineCore.js';

const ledger: TraitDefinition = {
  name: 'Ledger',
  states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }, { name: 'closed' }, { name: 'split' }],
  transitions: [
    { from: 'loading', to: 'loading', event: 'INIT' },
    { from: 'loading', to: 'browsing', event: 'LOADED' },
    { from: 'browsing', to: 'loading', event: 'INIT' },
    { from: 'loading', to: 'closed', event: 'CLOSE' },
    { from: 'split', to: 'split', event: 'INIT', guard: ['=', '@entity.x', 1] },
    { from: 'split', to: 'loading', event: 'INIT' },
  ],
};

const reloader: TraitDefinition = {
  name: 'Reports',
  states: [{ name: 'browsing', isInitial: true }],
  transitions: [
    { from: 'browsing', to: 'browsing', event: 'INIT', effects: [['fetch', 'Report', { emit: { success: 'LOADED' } }], ['render-ui', 'main', { type: 'spinner' }]] },
    { from: 'browsing', to: 'browsing', event: 'LOADED', effects: [['render-ui', 'main', { type: 'table-view' }]] },
  ],
};

const painter: TraitDefinition = {
  name: 'Body',
  states: [{ name: 'idle', isInitial: true }],
  transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'timeline' }]] }],
};

describe('repaintLifecycleEvent', () => {
  it('a self-loop lifecycle arm is repaintable', () => {
    const mgr = new StateMachineManager([ledger]);
    expect(mgr.repaintLifecycleEvent('Ledger')).toBe('INIT');
  });

  it('an arm that leaves the current state is not', () => {
    const mgr = new StateMachineManager([ledger]);
    mgr.seedState('Ledger', 'browsing');
    expect(mgr.repaintLifecycleEvent('Ledger')).toBeUndefined();
  });

  it('edge: no lifecycle arm from the current state', () => {
    const mgr = new StateMachineManager([ledger]);
    mgr.seedState('Ledger', 'closed');
    expect(mgr.repaintLifecycleEvent('Ledger')).toBeUndefined();
  });

  it('edge: guarded siblings where any one leaves the state are not repaintable', () => {
    const mgr = new StateMachineManager([ledger]);
    mgr.seedState('Ledger', 'split');
    expect(mgr.repaintLifecycleEvent('Ledger')).toBeUndefined();
  });

  it('edge: a self-loop that reloads (fetch + spinner) is a reload, not a repaint', () => {
    expect(new StateMachineManager([reloader]).repaintLifecycleEvent('Reports')).toBeUndefined();
  });

  it('control: a self-loop that only renders is a repaint', () => {
    expect(new StateMachineManager([painter]).repaintLifecycleEvent('Body')).toBe('INIT');
  });

  it('edge: an unknown trait', () => {
    expect(new StateMachineManager([ledger]).repaintLifecycleEvent('Nope')).toBeUndefined();
  });
});
