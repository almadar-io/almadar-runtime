// The fold never re-runs a (trait, event) the client already delivered, even when the fan-out reaches it by another path.
// Twin of orbital-core `apply_server_response` seeding `run_cascade` with `already_delivered`.
import { describe, it, expect } from 'vitest';
import type { OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import {
  applyOrbitalEventResponse,
  buildTraitIndex,
  createMemoryCircuitStore,
  type ClientRoleOpts,
} from '../src/index.js';
import { alreadyDeliveredKey } from '../src/evaluation/evaluateOrbitalEvent.js';

function schema(): OrbitalSchema {
  const idle = [{ name: 'idle', isInitial: true }];
  return {
    name: 'already-delivered-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Main',
        pages: [],
        entity: { name: 'Item', persistence: 'runtime', fields: [
          { name: 'id', type: 'string', required: true }, { name: 'heardFrom', type: 'string' }, { name: 'heardEvent', type: 'string' },
        ] },
        traits: [
          { name: 'Source', scope: 'instance', emits: [{ event: 'X' }],
            stateMachine: { states: idle, events: [], transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }] } },
          { name: 'Relay', scope: 'instance', emits: [{ event: 'RING' }],
            listens: [{ event: 'X', triggers: 'GO', source: { kind: 'trait', trait: 'Source' } }],
            stateMachine: { states: idle, events: [], transitions: [{ from: 'idle', to: 'idle', event: 'GO',
              effects: [['set', '@entity.heardFrom', '@event.source.trait'], ['set', '@entity.heardEvent', '@event.event'], ['emit', 'RING']] }] } },
          { name: 'Chime', scope: 'instance',
            listens: [{ event: 'RING', triggers: 'PING', source: { kind: 'trait', trait: 'Relay' } }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'pinged' }],
              events: [],
              transitions: [{ from: 'idle', to: 'pinged', event: 'PING', effects: [] }],
            } },
        ],
      },
    ],
  };
}

function opts(): ClientRoleOpts {
  const traitIndex = buildTraitIndex(schema().orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return { orbitalName: 'Main', traitIndex, store, carriesCircuitState: true };
}

const xFromSource: OrbitalEventResponse = {
  success: true,
  transitioned: true,
  states: {},
  emittedEvents: [{ event: 'X', source: { orbital: 'Main', trait: 'Source' } }],
};

describe('applyOrbitalEventResponse — already-delivered pairs hold through the whole fan-out', () => {
  it('with nothing delivered, the chain reaches Chime', async () => {
    const o = opts();
    await applyOrbitalEventResponse(o.store, xFromSource, new Set(), o);
    expect(o.store.manager.getState('Chime')?.currentState).toBe('pinged');
  });

  it('the folded delivery sees the server emit as @event', async () => {
    const o = opts();
    await applyOrbitalEventResponse(o.store, xFromSource, new Set(), o);
    expect(o.store.frames.get('Relay')).toMatchObject({ heardFrom: 'Source', heardEvent: 'X' });
  });

  it('a pair the client already delivered is skipped two hops down', async () => {
    const o = opts();
    await applyOrbitalEventResponse(o.store, xFromSource, new Set([alreadyDeliveredKey('Chime', 'PING')]), o);
    expect(o.store.manager.getState('Chime')?.currentState ?? 'idle').toBe('idle');
  });
});
