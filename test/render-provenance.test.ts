// Each client effect carries the transition that produced it: its own event key and from-state, a cascaded listener's included. Twin of orbital-core `tests/render_provenance.rs`.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const schema: OrbitalSchema = {
  name: 'provenance', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [
      {
        name: 'Form', scope: 'instance',
        stateMachine: {
          states: [{ name: 'editing', isInitial: true }, { name: 'saved' }], events: [],
          transitions: [
            { from: 'editing', to: 'editing', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: 'form' }]] },
            { from: 'editing', to: 'saved', event: 'SAVE', effects: [['render-ui', 'main', { type: 'alert', message: 'Saved' }], ['emit', 'SAVED']] },
          ],
        },
      },
      {
        name: 'Catalog', scope: 'instance',
        listens: [{ event: 'SAVED', triggers: 'REFRESH', source: { kind: 'trait', trait: 'Form' } }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }], events: [],
          transitions: [{ from: 'idle', to: 'idle', event: 'REFRESH', effects: [['render-ui', 'sidebar', { type: 'typography', content: 'list' }]] }],
        },
      },
    ],
  }],
};

async function byTrait(event: string) {
  const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  await rt.register(schema);
  const r = await rt.processOrbitalEvent('Main', { event, payload: {}, targetTrait: 'Form' });
  return r.clientEffectsByTrait ?? [];
}

describe('render provenance', () => {
  it('a mount render is tagged with INIT and its source state', async () => {
    expect((await byTrait('INIT')).map(({ traitName, event, fromState }) => ({ traitName, event, fromState }))).toEqual([
      { traitName: 'Form', event: 'INIT', fromState: 'editing' },
    ]);
  });

  it("a cascaded listener's render carries its own triggered event, not the seed's or the source emit's", async () => {
    expect((await byTrait('SAVE')).map(({ traitName, event, fromState }) => ({ traitName, event, fromState }))).toEqual([
      { traitName: 'Form', event: 'SAVE', fromState: 'editing' },
      { traitName: 'Catalog', event: 'REFRESH', fromState: 'idle' },
    ]);
  });

  it('the effect itself is unchanged and stays 1:1 with the flat list', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema);
    const r = await rt.processOrbitalEvent('Main', { event: 'SAVE', payload: {}, targetTrait: 'Form' });
    expect((r.clientEffectsByTrait ?? []).map((e) => e.effect)).toEqual(r.clientEffects);
  });

  it('a blocked event renders untagged', async () => {
    const entries = await byTrait('NO_SUCH_EVENT');
    expect(entries.every((e) => e.event === undefined && e.fromState === undefined)).toBe(true);
  });
});
