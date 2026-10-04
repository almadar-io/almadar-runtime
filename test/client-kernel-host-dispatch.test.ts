/**
 * A view of a program its host runs entirely (an extension's side panel over its worker) shows the
 * results of dispatches the host ran on its own — a declared input from a watched page — by folding
 * the host's result: the host's states and render land in the view; nothing runs or posts here.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createInProcessTransport, createMemoryCircuitStore } from '../src/index.js';

const schema: OrbitalSchema = {
  name: 'Feed',
  orbitals: [{
    name: 'Feed',
    entity: { name: 'Item', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
    traits: [{
      name: 'Watch', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'seen' }],
        events: [{ key: 'ITEM_SEEN', name: 'ITEM_SEEN', external: true }, { key: 'RESET', name: 'RESET' }],
        transitions: [
          { from: 'idle', to: 'seen', event: 'ITEM_SEEN', effects: [['render-ui', 'main', { type: 'typography', content: 'Seen here' }]] },
          { from: 'seen', to: 'idle', event: 'RESET', effects: [] },
        ],
      },
    }],
    pages: [],
  }],
};

function kernel() {
  const posted: OrbitalEventRequest[] = [];
  const transport = createInProcessTransport(async (_o, req) => {
    posted.push(req);
    return { success: true, transitioned: true, states: { Watch: 'idle' }, emittedEvents: [] };
  });
  const traitIndex = buildTraitIndex(schema.orbitals);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  return { k: createClientKernel({ orbitalName: 'Feed', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false, transport }), store, posted };
}

const hostRan: OrbitalEventResponse = {
  success: true,
  transitioned: true,
  states: { Watch: 'seen' },
  emittedEvents: [],
  clientEffects: [['render-ui', 'main', { type: 'typography', content: 'Seen by the host' }]],
};

describe('ClientKernel.foldHostDispatch', () => {
  it('lands the host\'s state and render in the view without running or posting anything', async () => {
    const { k, store, posted } = kernel();
    const outcome = await k.foldHostDispatch({ event: 'ITEM_SEEN', targetTrait: 'Watch', payload: {} }, hostRan);
    expect(store.manager.getState('Watch')?.currentState).toBe('seen');
    expect(outcome.response.clientEffects).toEqual([['render-ui', 'main', { type: 'typography', content: 'Seen by the host' }]]);
    expect(posted).toEqual([]);
  });

  it('control: the view\'s own dispatch runs here and posts its leg to the host', async () => {
    const { k, posted } = kernel();
    await k.dispatch({ event: 'ITEM_SEEN', targetTrait: 'Watch', payload: {} });
    expect(posted.map((r) => r.event)).toEqual(['ITEM_SEEN']);
  });

  it('edge: a failed host dispatch changes nothing in the view', async () => {
    const { k, store } = kernel();
    await k.foldHostDispatch({ event: 'ITEM_SEEN', targetTrait: 'Watch', payload: {} }, { success: false, transitioned: false, states: {}, emittedEvents: [], error: 'refused' });
    expect(store.manager.getState('Watch')?.currentState).toBe('idle');
  });
});
