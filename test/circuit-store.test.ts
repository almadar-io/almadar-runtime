/**
 * CircuitStore — snapshot/restore round-trip, subscribe/notify; the state book it holds.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMemoryCircuitStore, StateBook } from '../src/index.js';
import type { TraitDefinition } from '../src/index.js';

function trait(name: string): TraitDefinition {
  return {
    name,
    states: [{ name: 'idle', isInitial: true }, { name: 'busy' }],
    transitions: [{ from: 'idle', to: 'busy', event: 'GO' }],
  };
}

describe('CircuitStore — snapshot/restore', () => {
  it('round-trips state + frame back to the pre-dispatch value', () => {
    const store = createMemoryCircuitStore([trait('T')]);
    store.frames.set('T', { count: 1 });
    store.states.seedState('T', 'idle');

    const snap = store.snapshot('T');
    store.states.seedState('T', 'busy');
    store.frames.set('T', { count: 2 });

    expect(store.states.getState('T')?.currentState).toBe('busy');
    expect(store.frames.get('T')).toEqual({ count: 2 });

    store.restore('T', undefined, snap, undefined, 'server-rejected');

    expect(store.states.getState('T')?.currentState).toBe('idle');
    expect(store.frames.get('T')).toEqual({ count: 1 });
  });

  it('restores an absent frame back to absent (never invents a row)', () => {
    const store = createMemoryCircuitStore([trait('T')]);
    store.states.seedState('T', 'idle');
    const snap = store.snapshot('T');

    store.frames.set('T', { count: 99 });
    expect(store.frames.get('T')).toBeDefined();

    store.restore('T', undefined, snap, undefined, 'server-rejected');
    expect(store.frames.has('T')).toBe(false);
  });

  it('snapshot clones the frame — later mutation of the live frame does not retroactively alter it', () => {
    const store = createMemoryCircuitStore([trait('T')]);
    const frame = { count: 1 };
    store.frames.set('T', frame);
    const snap = store.snapshot('T');

    frame.count = 2; // mutate the SAME object still held in `store.frames`
    expect(snap.frame).toEqual({ count: 1 });
  });

  it('honors an explicit frameKey (the [shared]-entity case)', () => {
    const store = createMemoryCircuitStore([trait('A'), trait('B')]);
    store.frames.set('$shared::Entity', { x: 1 });
    const snap = store.snapshot('A', undefined, '$shared::Entity');
    store.frames.set('$shared::Entity', { x: 2 });
    store.restore('A', undefined, snap, '$shared::Entity', 'server-rejected');
    expect(store.frames.get('$shared::Entity')).toEqual({ x: 1 });
  });
});

describe('CircuitStore — subscribe/notify', () => {
  it('notifies subscribers and bumps the version only on notify()', () => {
    const store = createMemoryCircuitStore([trait('T')]);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.getVersion()).toBe(0);
    store.states.seedState('T', 'busy'); // a raw book write — no auto-notify
    expect(listener).not.toHaveBeenCalled();
    expect(store.getVersion()).toBe(0);

    store.notify();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(1);

    unsubscribe();
    store.notify();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(2);
  });
});

describe('StateBook — the states the kernel reports', () => {
  const lifecycle: TraitDefinition = {
    name: 'L',
    states: [{ name: 'idle', isInitial: true }, { name: 'shown' }],
    transitions: [
      { from: 'idle', to: 'shown', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: 'x' }]] },
      { from: 'shown', to: 'shown', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: 'y' }]] },
    ],
  };

  it('reads the initial state until a state is recorded, then the recorded one', () => {
    const book = new StateBook([trait('T')]);
    expect(book.getState('T')?.currentState).toBe('idle');
    book.seedState('T', 'busy');
    expect(book.getState('T')).toMatchObject({ currentState: 'busy', previousState: 'idle' });
  });

  it('control: a trait not on the page has no state and records nothing', () => {
    const book = new StateBook([trait('T')]);
    book.seedState('Other', 'busy');
    expect(book.getState('Other')).toBeUndefined();
    expect([...book.getAllStates().keys()]).toEqual(['T']);
  });

  it('keeps each entity scope apart from the singleton', () => {
    const book = new StateBook([trait('T')]);
    book.seedState('T', 'busy', 'row-1');
    expect(book.getState('T', 'row-1')?.currentState).toBe('busy');
    expect(book.getState('T')?.currentState).toBe('idle');
  });

  it('answers whether the current state has an arm on the event, with or without the UI: prefix', () => {
    const book = new StateBook([trait('T')]);
    expect(book.canHandleEvent('T', 'GO')).toBe(true);
    expect(book.canHandleEvent('T', 'UI:GO')).toBe(true);
    book.seedState('T', 'busy');
    expect(book.canHandleEvent('T', 'GO')).toBe(false);
  });

  it('a lifecycle arm that moves the trait is no repaint; one that stays and only renders is', () => {
    const book = new StateBook([lifecycle]);
    expect(book.repaintLifecycleEvent('L')).toBeUndefined();
    book.seedState('L', 'shown');
    expect(book.repaintLifecycleEvent('L')).toBe('INIT');
  });

  it('reports a rollback hop to the observer, and none when the state does not change', () => {
    const onRollback = vi.fn();
    const book = new StateBook([trait('T')], { onTransition: vi.fn(), onRollback });
    book.seedState('T', 'busy');
    book.rollbackState('T', 'idle', undefined, 'server-rejected');
    book.rollbackState('T', 'idle', undefined, 'server-rejected');
    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(onRollback).toHaveBeenCalledWith({ traitName: 'T', from: 'busy', to: 'idle', cause: 'server-rejected' });
  });
});
