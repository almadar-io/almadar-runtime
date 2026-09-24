// An optimistic dispatch that rolls back reports the rollback hop to the TransitionObserver, so its trace never keeps a transition the store undid.
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createMemoryCircuitStore, dispatchWithServerLeg, postServerLeg, type ClientRoleOpts, type EventTransport, type TransitionObserver } from '../src/index.js';

const schema: OrbitalSchema = {
  name: 'rollback-observer', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Cursor', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }] },
    traits: [{
      name: 'Move', linkedEntity: 'Cursor', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'moved' }],
        events: [],
        transitions: [{ from: 'idle', to: 'moved', event: 'MOVE', effects: [['set', '@entity.x', 5], ['call-service', 'Sync', 'move', {}]] }],
      },
    }],
  }],
};

type Hop = { kind: 'transition' | 'rollback'; from: string; to: string; cause?: string };

function setup() {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const hops: Hop[] = [];
  const observer: TransitionObserver = {
    onTransition: (t) => { hops.push({ kind: 'transition', from: t.from, to: t.to }); },
    onRollback: (r) => { hops.push({ kind: 'rollback', from: r.from, to: r.to, cause: r.cause }); },
  };
  store.manager.setObserver(observer);
  const o: ClientRoleOpts = { orbitalName: 'Main', traitIndex, store, carriesCircuitState: true };
  return { o, hops };
}

const transport = (send: EventTransport['send']): EventTransport => ({
  register: async () => ({ success: true, carriesCircuitState: true }),
  unregister: async () => {},
  send,
});

const rejected: OrbitalEventResponse = { success: false, transitioned: false, states: {}, emittedEvents: [], error: 'sync rejected' };
const accepted: OrbitalEventResponse = { success: true, transitioned: true, states: { Move: 'moved' }, emittedEvents: [] };

describe('optimistic rollback reaches the observer', () => {
  it('a server rejection reports the hop back to the source state', async () => {
    const { o, hops } = setup();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });
    await postServerLeg(transport(vi.fn(async () => rejected)), 'Main', dispatch, o.store, o);
    expect(hops).toEqual([
      { kind: 'transition', from: 'idle', to: 'moved' },
      { kind: 'rollback', from: 'moved', to: 'idle', cause: 'server-rejected' },
    ]);
  });

  it('a transport error reports it with its own cause', async () => {
    const { o, hops } = setup();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });
    await expect(postServerLeg(transport(vi.fn(async () => { throw new Error('network down'); })), 'Main', dispatch, o.store, o)).rejects.toThrow('network down');
    expect(hops.at(-1)).toEqual({ kind: 'rollback', from: 'moved', to: 'idle', cause: 'transport-error' });
  });

  it('an accepted dispatch reports no rollback', async () => {
    const { o, hops } = setup();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });
    await postServerLeg(transport(vi.fn(async () => accepted)), 'Main', dispatch, o.store, o);
    expect(hops.filter((h) => h.kind === 'rollback')).toEqual([]);
  });

  it('after a rollback the trace and the store end in the same state', async () => {
    const { o, hops } = setup();
    const dispatch = await dispatchWithServerLeg(o, { event: 'MOVE', targetTrait: 'Move' });
    await postServerLeg(transport(vi.fn(async () => rejected)), 'Main', dispatch, o.store, o);
    expect(hops.at(-1)?.to).toBe(o.store.manager.getState('Move')?.currentState);
  });
});
