/**
 * Every trait bound to a shared frame reports the frame's FINAL row: a trait
 * that stepped before a sibling wrote the frame must not carry the older
 * snapshot back, or the client's fold merges it over the fresh value
 * (std-realtime-chat: the composer's activeChannel reverted to "").
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createIndexStageRunner, evaluateOrbitalEvent, InMemoryPersistence, StateMachineManager, type EvaluateOrbitalEventDeps } from '../src/index.js';

function schema(shared: boolean): OrbitalSchema {
  return {
    name: 'shared-frame',
    orbitals: [{
      name: 'Chat',
      pages: [],
      entity: { name: 'Msg', persistence: 'runtime', ...(shared ? { shared: true } : {}), fields: [{ name: 'id', type: 'string' }, { name: 'channel', type: 'string', default: '' }] },
      traits: [
        { name: 'Thread', linkedEntity: 'Msg', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [
          { from: 'idle', to: 'idle', event: 'INIT', effects: [['emit', 'OPENED', { channel: 'c1' }]] },
        ] } },
        { name: 'Composer', linkedEntity: 'Msg', scope: 'instance', listens: [{ event: 'Thread.OPENED', triggers: 'SELECT' }], stateMachine: { states: [{ name: 'ready', isInitial: true }], events: [], transitions: [
          { from: 'ready', to: 'ready', event: 'SELECT', effects: [['set', '@entity.channel', '@payload.channel']] },
        ] } },
      ],
    }],
  };
}

function deps(s: OrbitalSchema): EvaluateOrbitalEventDeps {
  const traitIndex = buildTraitIndex(s.orbitals);
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, EntityRow>();
  return { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) };
}

describe('shared frame — every bound trait reports the final row', () => {
  it('a trait that stepped before its sibling wrote the shared frame carries the written value', async () => {
    const r = await evaluateOrbitalEvent(deps(schema(true)), { event: 'INIT', targetTrait: 'Thread' });
    expect(r.entityByTrait?.['Composer']?.['channel']).toBe('c1');
    expect(r.entityByTrait?.['Thread']?.['channel']).toBe('c1');
  });

  it('control: unshared frames stay per trait (the sibling write never reaches Thread)', async () => {
    const r = await evaluateOrbitalEvent(deps(schema(false)), { event: 'INIT', targetTrait: 'Thread' });
    expect(r.entityByTrait?.['Composer']?.['channel']).toBe('c1');
    expect(r.entityByTrait?.['Thread']?.['channel'] ?? '').toBe('');
  });
});
