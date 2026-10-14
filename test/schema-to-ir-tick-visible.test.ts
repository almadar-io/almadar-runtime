import { describe, it, expect } from 'vitest';
import { schemaToIR } from '../src/entities/resolver/schema-to-ir.js';
import type { OrbitalSchema } from '@almadar/core';

// A browser tick tagged `[visible]` pauses off screen; the runtime resolver carries the tag like core's.
const schema: OrbitalSchema = {
  name: 'App',
  version: '1.0.0',
  orbitals: [{
    name: 'ClockOrbital',
    entity: { name: 'Clock', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{
      name: 'ClockTrait',
      scope: 'instance',
      linkedEntity: 'Clock',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
      ticks: [
        { name: 'kept', interval: 100, whileVisible: true, effects: [] },
        { name: 'paused', interval: 100, effects: [] },
      ],
    }],
    pages: [],
  }],
};

describe('schemaToIR — tick visible tag', () => {
  const ticks = schemaToIR(schema).traits.get('ClockTrait')?.ticks ?? [];
  it('a [visible] tick keeps the tag', () => {
    expect(ticks.find((t) => t.name === 'kept')?.whileVisible).toBe(true);
  });
  it('control: an untagged tick is not visible-only', () => {
    expect(ticks.find((t) => t.name === 'paused')?.whileVisible).toBe(false);
  });
});
