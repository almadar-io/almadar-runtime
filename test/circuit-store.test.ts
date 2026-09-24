/**
 * CircuitStore (P2) — snapshot/restore round-trip, subscribe/notify.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMemoryCircuitStore } from '../src/index.js';
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
    store.manager.seedState('T', 'idle');

    const snap = store.snapshot('T');
    store.manager.commitState('T', 'busy', undefined, 'GO');
    store.frames.set('T', { count: 2 });

    expect(store.manager.getState('T')?.currentState).toBe('busy');
    expect(store.frames.get('T')).toEqual({ count: 2 });

    store.restore('T', undefined, snap, undefined, 'server-rejected');

    expect(store.manager.getState('T')?.currentState).toBe('idle');
    expect(store.frames.get('T')).toEqual({ count: 1 });
  });

  it('restores an absent frame back to absent (never invents a row)', () => {
    const store = createMemoryCircuitStore([trait('T')]);
    store.manager.seedState('T', 'idle');
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
    store.manager.seedState('T', 'busy'); // a raw manager write — no auto-notify
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
