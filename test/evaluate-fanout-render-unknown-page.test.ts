/**
 * A fan-out step's render is withheld only for a trait KNOWN to be off the
 * requester's page. With no `_activeTraits` (a stateful client never sends
 * it) the server cannot know, so withholding dropped every listener's render —
 * std-realtime-chat's thread refetch after a channel pick painted nothing. The
 * client filters renders by its own mounted set anyway.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, EventPayload, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createIndexStageRunner,
  evaluateOrbitalEvent,
  InMemoryPersistence,
  StateMachineManager,
} from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'fanout-render',
    version: '1.0.0',
    orbitals: [{
      name: 'O',
      pages: [],
      entity: { name: 'E', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        {
          name: 'Picker',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'ready', isInitial: true }],
            events: [],
            transitions: [{ from: 'ready', to: 'ready', event: 'PICK', effects: [['emit', 'PICKED', { v: 1 }]] }],
          },
        },
        {
          name: 'Pane',
          scope: 'instance',
          listens: [{ event: 'PICKED', source: { kind: 'trait', trait: 'Picker' }, triggers: 'SHOW' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'SHOW', effects: [['render-ui', 'main', { type: 'typography', content: 'picked' }]] }],
          },
        },
      ],
    }],
  } as OrbitalSchema;
}

function run(payload?: EventPayload) {
  const s = schema();
  const traitIndex = buildTraitIndex(s.orbitals);
  const persistence = new InMemoryPersistence();
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const frames = new Map<string, EntityRow>();
  return evaluateOrbitalEvent(
    { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) },
    { event: 'PICK', targetTrait: 'Picker', ...(payload !== undefined ? { payload } : {}) },
  );
}

describe('fan-out render delivery', () => {
  it('delivers a listener\'s render when the requester\'s page is unknown', async () => {
    const response = await run();
    expect((response.clientEffectsByTrait ?? []).some((e) => e.traitName === 'Pane')).toBe(true);
  });

  it('withholds it for a trait known to be off the requester\'s page', async () => {
    const response = await run({ _activeTraits: ['Picker'] });
    expect((response.clientEffectsByTrait ?? []).some((e) => e.traitName === 'Pane')).toBe(false);
  });
});
