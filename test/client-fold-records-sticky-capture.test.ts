/**
 * The fold records an embedded child's composing payload (sticky
 * `@callsitePayload`) even while the child is held awaiting its own INIT — the
 * held INIT is exactly the repaint that needs it. std-construction-pm
 * /site-diary: the frame was held, the payload dropped with it, and the
 * child's INIT painted the timeline empty.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventResponse, OrbitalSchema, RenderUIEffect, Trait } from '@almadar/core';
import { applyOrbitalEventResponse, buildTraitIndex, createMemoryCircuitStore } from '../src/index.js';

const render: RenderUIEffect = ['render-ui', 'main', { type: 'timeline' }];
const body: Trait = {
  name: 'Body', scope: 'instance', linkedEntity: 'Entry',
  stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [render] }] },
};
const schema: OrbitalSchema = {
  name: 'sticky', version: '1.0.0',
  orbitals: [{
    name: 'DiaryOrbital',
    entity: { name: 'Entry', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [body],
    pages: [],
  }],
};

const rows = [{ id: 'e1' }];
const response: OrbitalEventResponse = {
  success: true, transitioned: true, states: {}, emittedEvents: [],
  clientEffectsByTrait: [{ traitName: 'Body', effect: ['render-ui', 'main', { type: 'stack', children: [] }], callsitePayload: { data: rows } }],
};

async function fold(awaiting: boolean) {
  const traitIndex = buildTraitIndex(schema.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  if (awaiting) store.mount.mounting(['Body']);
  const out = await applyOrbitalEventResponse(store, response, new Set(), { orbitalName: 'DiaryOrbital', traitIndex, store, carriesCircuitState: false });
  return { store, out, mode: traitIndex.byName.get('Body')?.dispatchMode };
}

describe('fold records the sticky composing payload', () => {
  it('a held child (awaiting INIT) keeps its composing payload though its frame is held', async () => {
    const { store, out, mode } = await fold(true);
    expect(mode).toBe('hybridClientOnly');
    expect(out.clientEffectsByTrait.some((e) => e.traitName === 'Body')).toBe(false);
    expect(store.callsitePayloads.get('Body')).toEqual({ data: rows });
  });

  it('control: an initialized child gets its frame and its payload', async () => {
    const { store, out } = await fold(false);
    expect(out.clientEffectsByTrait.some((e) => e.traitName === 'Body')).toBe(true);
    expect(store.callsitePayloads.get('Body')).toEqual({ data: rows });
  });
});
