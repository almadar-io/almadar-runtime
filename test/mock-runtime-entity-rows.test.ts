/**
 * A mock-mode runtime seeds the `[runtime]` entities the kernel holds itself, as it seeds every other entity, so a
 * `fetch` of one returns its mock row (`ui` `BrowserPlayground.listen-loaded-aggregate` painted "rows:0").
 */
import { describe, expect, it } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const schema: OrbitalSchema = {
  name: 'runtime-rows',
  version: '1.0.0',
  orbitals: [{
    name: 'Main',
    pages: [],
    entity: { name: 'Entry', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'hours', type: 'number', default: 3 }] },
    traits: [{
      name: 'Fetcher',
      scope: 'instance',
      linkedEntity: 'Entry',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [],
        transitions: [{ from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'Entry', { emit: { success: 'LOADED' } }]] }],
      },
    }],
  }],
};

async function loadedRows(runtime: OrbitalServerRuntime): Promise<number> {
  const response = await runtime.processOrbitalEvent('Main', { event: 'LOAD', targetTrait: 'Fetcher' });
  const loaded = response.emittedEvents.find((e) => e.event === 'LOADED');
  const data = loaded?.payload?.['data'];
  return Array.isArray(data) ? data.length : -1;
}

describe('a mock runtime seeds its kernel-held [runtime] rows', () => {
  it('a fetch of a [runtime] entity returns its one mock row', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema);
    expect(await loadedRows(runtime)).toBe(1);
  });

  it('edge: a circuit reset keeps the seeded row', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema);
    runtime.resetCircuitState();
    expect(await loadedRows(runtime)).toBe(1);
  });

  it('control: a real-mode runtime seeds nothing', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'real', debug: false });
    await runtime.register(schema);
    expect(await loadedRows(runtime)).toBe(0);
  });
});
