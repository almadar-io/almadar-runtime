// Runtime Spec 5.3: a trait's own emit that it handles from its new state runs within the same dispatch, before fan-out. Twin of orbital-core `tests/same_trait_cascade.rs`.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const schema: OrbitalSchema = {
  name: 'loop', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [
      {
        name: 'Counter', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'running' }], events: [],
          transitions: [
            { from: 'idle', to: 'running', event: 'GO', effects: [['emit', 'STEP', { n: 3 }], ['emit', 'UNHANDLED', {}]] },
            { from: 'running', to: 'running', event: 'STEP', guard: ['>', '@payload.n', 0], effects: [['emit', 'STEP', { n: ['-', '@payload.n', 1] }]] },
            { from: 'running', to: 'idle', event: 'STEP', guard: ['=', '@payload.n', 0], effects: [['emit', 'DONE', {}]] },
          ],
        },
      },
      {
        name: 'Watcher', scope: 'instance',
        listens: [{ event: 'STEP', triggers: 'SAW', source: { kind: 'trait', trait: 'Counter' } }],
        stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [{ from: 'idle', to: 'idle', event: 'SAW', effects: [['emit', 'WATCHED', { n: '@payload.n' }]] }] },
      },
    ],
  }],
};

async function run() {
  const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  await rt.register(schema);
  const r = await rt.processOrbitalEvent('Main', { event: 'GO', payload: {}, targetTrait: 'Counter' });
  const tags = r.emittedEvents.map((e) => (typeof e.payload?.['n'] === 'number' ? `${e.event}:${e.payload['n']}` : e.event));
  return { tags, states: r.states };
}

describe('same-trait cascade', () => {
  it('a trait drives its own loop to completion in one dispatch', async () => {
    const { tags, states } = await run();
    expect(tags).toContain('DONE');
    expect(states['Counter']).toBe('idle');
  });

  it('every step still fans out to other listeners', async () => {
    const { tags } = await run();
    expect(tags.filter((t) => t.startsWith('WATCHED'))).toEqual(['WATCHED:3', 'WATCHED:2', 'WATCHED:1', 'WATCHED:0']);
  });

  it('an emit the trait has no arm for is not looped back', async () => {
    const { tags } = await run();
    expect(tags.filter((t) => t === 'UNHANDLED')).toHaveLength(1);
  });
});
