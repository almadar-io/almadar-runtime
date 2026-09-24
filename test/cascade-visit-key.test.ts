// Twin of orbital-core `tests/cascade_visit_key.rs`: a delivery is `(trait, event, from, payload)`; only an exact repeat is a cycle.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Transition } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function fanner(transitions: Transition[], states: Array<{ name: string; isInitial?: boolean }>): OrbitalSchema {
  return {
    name: 'visit-key-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Main',
        pages: [],
        entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [
          {
            name: 'Fanner',
            scope: 'instance',
            listens: [{ event: 'STEP_NEXT', triggers: 'STEP', source: { kind: 'trait', trait: 'Fanner' } }],
            emits: [{ event: 'STEP_NEXT' }, { event: 'DONE' }],
            stateMachine: { states, events: [{ key: 'STEP', name: 'STEP' }], transitions },
          },
        ],
      },
    ],
  };
}

const oneState = [{ name: 'searching', isInitial: true }];

async function run(schema: OrbitalSchema, payload: Record<string, number>) {
  const runtime = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  await runtime.register(schema);
  const response = await runtime.processOrbitalEvent('Main', { event: 'STEP', payload, targetTrait: 'Fanner' });
  runtime.unregisterAll();
  const emitted = response.emittedEvents.map((e) => e.event);
  return { response, count: (event: string) => emitted.filter((e) => e === event).length };
}

describe('cascade visit key', () => {
  it('a decrementing fan-out delivers every step', async () => {
    const { count } = await run(
      fanner(
        [{ from: 'searching', to: 'searching', event: 'STEP', guard: ['>', '@payload.remaining', 0],
           effects: [['emit', 'STEP_NEXT', { remaining: ['-', '@payload.remaining', 1] }]] }],
        oneState,
      ),
      { remaining: 3 },
    );
    expect(count('STEP_NEXT')).toBe(3);
  });

  it('an exact repeat is a cycle and stops', async () => {
    const { count, response } = await run(
      fanner([{ from: 'searching', to: 'searching', event: 'STEP', effects: [['emit', 'STEP_NEXT', { k: 1 }]] }], oneState),
      { k: 1 },
    );
    expect(count('STEP_NEXT')).toBe(1);
    expect(response.cascadeTruncated).toBeUndefined();
  });

  it('the same payload from a new state is new work', async () => {
    const { count } = await run(
      fanner(
        [
          { from: 'idle', to: 'busy', event: 'STEP', effects: [['emit', 'STEP_NEXT', { k: 1 }]] },
          { from: 'busy', to: 'busy', event: 'STEP', effects: [['emit', 'DONE']] },
        ],
        [{ name: 'idle', isInitial: true }, { name: 'busy' }],
      ),
      { k: 1 },
    );
    expect(count('DONE')).toBe(1);
  });

  it('a chain that never repeats stops at the cap and says so', async () => {
    const { count, response } = await run(
      fanner(
        [{ from: 'searching', to: 'searching', event: 'STEP', effects: [['emit', 'STEP_NEXT', { n: ['+', '@payload.n', 1] }]] }],
        oneState,
      ),
      { n: 0 },
    );
    expect(count('STEP_NEXT')).toBeGreaterThan(1);
    expect(count('STEP_NEXT')).toBeLessThanOrEqual(2001);
    expect(response.cascadeTruncated).toContain('Fanner');
  });
});
