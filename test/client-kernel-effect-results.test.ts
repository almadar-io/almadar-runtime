/**
 * The response a posted dispatch settles on carries the server's effect
 * outcomes: a denied/failed persist is only ever executed server-side, so a
 * settled response built from the local run alone reads as "nothing happened".
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, ServerEffectResult } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'SaveApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'NoteOrbital',
        entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'NoteSave',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'saved' }],
              events: [],
              transitions: [
                { from: 'idle', to: 'saved', event: 'DO_SAVE', effects: [['persist', 'create', 'Note', {}]] },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

function kernelAnswering(answer: Partial<OrbitalEventResponse>) {
  const s = schema();
  const transport = createInProcessTransport(async (_orbital: string, _request: OrbitalEventRequest): Promise<OrbitalEventResponse> => ({
    success: true,
    transitioned: true,
    states: { NoteSave: 'saved' },
    emittedEvents: [],
    ...answer,
  }));
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return createClientKernel({ orbitalName: 'NoteOrbital', traitIndex, store, carriesCircuitState: false, transport });
}

describe('createClientKernel — server effect outcomes survive the settle', () => {
  it('a denied persist answered by the server is on the settled response', async () => {
    const denied: ServerEffectResult = { effect: 'persist', action: 'create', entityType: 'Note', success: false, denied: true, error: 'persist denied' };
    const outcome = await kernelAnswering({ effectResults: [denied] }).dispatch({ event: 'DO_SAVE', targetTrait: 'NoteSave' });
    expect(outcome.response.effectResults?.map((r) => r.denied)).toEqual([true]);
  });

  it('control: a server answer with no effect outcomes leaves the settled response without any', async () => {
    const outcome = await kernelAnswering({}).dispatch({ event: 'DO_SAVE', targetTrait: 'NoteSave' });
    expect(outcome.response.effectResults ?? []).toEqual([]);
  });
});
