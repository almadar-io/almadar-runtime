// Runtime Spec Clause 5.4: a stateless host derives the relay mask from the request's shape — delegated leg masks nothing, declared dispatch masks its declared set, discovery masks its resolved targets.
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, Trait, Transition } from '@almadar/core';
import { buildTraitIndex, createIndexStageRunner, evaluateOrbitalEvent, InMemoryPersistence, StateMachineManager, type EvaluateOrbitalEventDeps, type OrbitalEventRequest } from '../src/index.js';

const listener = (name: string, extra: Transition[] = []): Trait => ({
  name,
  scope: 'instance',
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }, { name: 'heard' }],
    events: [],
    transitions: [{ from: 'idle', to: 'heard', event: 'HEAR', effects: [] }, ...extra],
  },
  listens: [{ event: 'Src.PING', triggers: 'HEAR' }],
});

const schema: OrbitalSchema = {
  name: 'mask', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [
      { name: 'Src', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [{ from: 'idle', to: 'idle', event: 'GO', effects: [['emit', 'PING']] }] } },
      listener('Echo', [{ from: 'idle', to: 'idle', event: 'GO', effects: [] }]),
      listener('Other'),
    ],
  }],
};

function deps(): EvaluateOrbitalEventDeps {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, EntityRow>();
  return { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema }) };
}

async function states(request: OrbitalEventRequest): Promise<Record<string, string>> {
  const response = await evaluateOrbitalEvent(deps(), request);
  expect(response.success).toBe(true);
  return response.states;
}

describe('relay mask by request shape (stateless host)', () => {
  it('a declared dispatch masks exactly its declared traits', async () => {
    const s = await states({ event: 'GO', payload: {}, traits: [{ trait: 'Src', from: 'idle' }, { trait: 'Echo', from: 'idle' }] });
    expect(s['Echo']).toBe('idle');
    expect(s['Other']).toBe('heard');
  });

  it('control: a trait left out of the declared set is delivered', async () => {
    const s = await states({ event: 'GO', payload: {}, traits: [{ trait: 'Src', from: 'idle' }] });
    expect(s['Echo']).toBe('heard');
  });

  it('a discovery dispatch masks the targets it resolved', async () => {
    const s = await states({ event: 'GO', payload: {} });
    expect(s['Echo']).toBe('idle');
    expect(s['Other']).toBe('heard');
  });

  it('a delegated leg masks nothing, even a trait it carries', async () => {
    const s = await states({ event: 'GO', payload: {}, targetTrait: 'Src', traits: [{ trait: 'Src', from: 'idle' }, { trait: 'Echo', from: 'idle' }] });
    expect(s['Echo']).toBe('heard');
    expect(s['Other']).toBe('heard');
  });
});
