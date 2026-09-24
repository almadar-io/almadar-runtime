/**
 * std-realtime-chat "sending does nothing" (stateless): legs in flight carry the
 * client's rows as they were at dispatch. The rail's leg auto-opened a
 * conversation (`activeChannel: "C"` folded into the shared frame); a sibling
 * INIT leg posted BEFORE that fold carried `activeChannel: ""` and its
 * response — which never touched the field — echoed "" back, clobbering "C".
 * The composer's SEND guard then read an empty channel forever. A fold applies
 * only what the server CHANGED relative to the row the leg carried.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalId, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createInProcessTransport,
  createMemoryCircuitStore,
  postServerLeg,
  type ClientDispatch,
  type ClientRoleOpts,
} from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'fold-delta',
    version: '1.0.0',
    orbitals: [{
      name: 'O',
      id: 'orb_o' as OrbitalId,
      pages: [],
      entity: { name: 'Msg', persistence: 'persistent', shared: true, fields: [{ name: 'id', type: 'string' }, { name: 'activeChannel', type: 'string' }, { name: 'draft', type: 'string' }] },
      traits: [
        { name: 'Thread', linkedEntity: 'Msg', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] } },
        { name: 'Composer', linkedEntity: 'Msg', scope: 'instance', stateMachine: { states: [{ name: 'ready', isInitial: true }], events: [], transitions: [] } },
      ],
    }],
  };
}

describe('postServerLeg fold — carried-row delta', () => {
  it('keeps a field the server did not change even when its echo is stale', async () => {
    const s = schema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frameKey = traitIndex.byName.get('Thread')!.frameKey;
    store.frames.set(frameKey, { activeChannel: 'C', draft: '' });
    const opts: ClientRoleOpts = { orbitalName: 'O', traitIndex, store, carriesCircuitState: true };

    const leg: OrbitalEventRequest = {
      event: 'INIT', targetTrait: 'Thread', traits: [{ trait: 'Thread', from: 'idle' }],
      entityByTrait: { Thread: { activeChannel: '', draft: '' } },
    };
    const staleEcho: OrbitalEventResponse = {
      success: true, transitioned: true, states: { Thread: 'idle' }, emittedEvents: [],
      entityByTrait: { Thread: { activeChannel: '', draft: 'server wrote this' }, Composer: { activeChannel: '', draft: 'server wrote this' } },
    };
    const dispatch: ClientDispatch = {
      response: { success: true, transitioned: true, states: {}, emittedEvents: [] },
      serverLeg: leg, mode: 'persistedAwaited', writtenTraits: new Set(['Thread']), trait: 'Thread', frameKey,
    };
    await postServerLeg(createInProcessTransport(async () => staleEcho), 'O', dispatch, store, opts);
    expect(store.frames.get(frameKey)).toEqual({ activeChannel: 'C', draft: 'server wrote this' });
  });
});
