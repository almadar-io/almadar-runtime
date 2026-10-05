// Twin of orbital-core `tests/cascade_visit_key.rs`: a delivery is `(trait, event, from, payload, frame)`; only an exact repeat is a cycle.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Transition } from '@almadar/core';
import { isEntityCall, isEntityReference } from '@almadar/core';
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

  // G-CROSS-057: `set` moves the trait's frame; the guard bounds the loop at n = 3.
  const counting = (setValue: number | ['+', '@entity.n', number]): OrbitalSchema => {
    const schema = fanner(
      [{ from: 'searching', to: 'searching', event: 'STEP', guard: ['<', '@entity.n', 3],
         effects: [['set', '@entity.n', setValue], ['emit', 'STEP_NEXT', { k: 1 }]] }],
      oneState,
    );
    const entity = schema.orbitals[0].entity;
    if (isEntityReference(entity) || isEntityCall(entity)) throw new Error('fixture: the entity is inline');
    entity.fields.push({ name: 'n', type: 'number', default: 0 });
    return schema;
  };

  it('an identical payload with a moved frame is progress, not a cycle', async () => {
    const { count } = await run(counting(['+', '@entity.n', 1]), { k: 1 });
    expect(count('STEP_NEXT')).toBe(3);
  });

  it('control: an identical payload with an unchanged frame is still a cycle', async () => {
    const { count, response } = await run(counting(1), { k: 1 });
    expect(count('STEP_NEXT')).toBe(2);
    expect(response.cascadeTruncated).toBeUndefined();
  });

  // One budget per dispatch, as the Rust kernel counts it: a trait's own follow-up steps draw from the
  // same CROSS_TRAIT_CASCADE_CAP as every other step; there is no separate per-trait cap.
  const selfLoop = (guard: boolean): OrbitalSchema => ({
    name: 'self-loop-app',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }, { name: 'n', type: 'number', default: 0 }] },
      traits: [{
        name: 'Looper',
        scope: 'instance',
        emits: [{ event: 'TICK' }],
        stateMachine: {
          states: [{ name: 'running', isInitial: true }],
          events: [{ key: 'TICK', name: 'TICK' }],
          transitions: [{ from: 'running', to: 'running', event: 'TICK', ...(guard ? { guard: ['<', '@entity.n', 30] } : {}),
            effects: [['set', '@entity.n', ['+', '@entity.n', 1]], ['emit', 'TICK']] }],
        },
      }],
    }],
  });
  const loop = async (schema: OrbitalSchema) => {
    const runtime = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await runtime.register(schema);
    const response = await runtime.processOrbitalEvent('Main', { event: 'TICK', payload: {}, targetTrait: 'Looper' });
    runtime.unregisterAll();
    return { response, ticks: response.emittedEvents.filter((e) => e.event === 'TICK').length };
  };

  it('a trait’s own 30-step loop runs to the end: no per-trait cap below the dispatch budget', async () => {
    const { ticks, response } = await loop(selfLoop(true));
    expect(ticks).toBe(30);
    expect(response.cascadeTruncated).toBeUndefined();
  });

  it('edge: a trait’s own endless loop stops at the dispatch budget and says so', async () => {
    const { ticks, response } = await loop(selfLoop(false));
    // The requested step plus the dispatch's 2000 follow-ups, exactly as the Rust kernel counts.
    expect(ticks).toBe(2001);
    expect(response.cascadeTruncated).toContain('Looper');
  });
});

