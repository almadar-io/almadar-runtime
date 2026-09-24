// The hermetic reset (`/api/mock/reset`) returns a stateful host's circuit to boot: trait states, frames and the mount's held deliveries all go, so a reset walk never inherits the previous one.
import { describe, it, expect } from 'vitest';
import type { EventPayload, OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const schema: OrbitalSchema = {
  name: 'reset', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'n', type: 'number' }] },
    traits: [
      {
        name: 'A', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'open' }], events: [],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
            { from: 'idle', to: 'open', event: 'OPEN', effects: [['set', '@entity.n', 7]] },
            { from: 'idle', to: 'idle', event: 'GO', effects: [['emit', 'PING']] },
          ],
        },
      },
      {
        name: 'B', scope: 'instance',
        listens: [{ event: 'PING', triggers: 'PINGED', source: { kind: 'trait', trait: 'A' } }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'pinged' }], events: [],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
            { from: 'idle', to: 'pinged', event: 'PINGED', effects: [] },
          ],
        },
      },
    ],
  }],
};

async function runtime(): Promise<OrbitalServerRuntime> {
  const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  await rt.register(schema);
  return rt;
}

const send = (rt: OrbitalServerRuntime, targetTrait: string, event: string, payload: EventPayload = {}) =>
  rt.processOrbitalEvent('Main', { event, payload, targetTrait });

describe('hermetic reset', () => {
  it('a trait left in a later state is back at its initial state', async () => {
    const rt = await runtime();
    await send(rt, 'A', 'OPEN');
    rt.resetCircuitState();
    const r = await send(rt, 'A', 'INIT');
    expect(r.transitioned).toBe(true);
    expect(r.states['A']).toBe('idle');
  });

  it('control: without the reset the same INIT is rejected from the later state', async () => {
    const rt = await runtime();
    await send(rt, 'A', 'OPEN');
    const r = await send(rt, 'A', 'INIT');
    expect(r.transitioned).toBe(false);
  });

  it('frames written before the reset are gone', async () => {
    const rt = await runtime();
    await send(rt, 'A', 'OPEN');
    expect((await send(rt, 'A', 'INIT')).entityByTrait?.['A']?.['n']).toBe(7);
    rt.resetCircuitState();
    expect((await send(rt, 'A', 'INIT')).entityByTrait?.['A']?.['n']).toBeUndefined();
  });

  it("a delivery held for a trait awaiting INIT is not released into the next mount", async () => {
    const rt = await runtime();
    await send(rt, 'A', 'GO', { _awaitingInit: ['B'] });
    rt.resetCircuitState();
    const r = await send(rt, 'B', 'INIT');
    expect(r.states['B']).toBe('idle');
  });

  it('control: without the reset the held delivery is released on INIT', async () => {
    const rt = await runtime();
    await send(rt, 'A', 'GO', { _awaitingInit: ['B'] });
    const r = await send(rt, 'B', 'INIT');
    expect(r.states['B']).toBe('pinged');
  });
});
