/**
 * A mount batch (`OrbitalEventRequest.mount`): one request mounts several
 * traits, each running its OWN lifecycle event in list order with the shared
 * payload; the per-trait response maps carry every seed.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  const render = (label: string): TypedEffect => ['render-ui', 'main', { type: 'typography', content: label }];
  return {
    name: 'mount-batch',
    orbitals: [{
      name: 'PageOrbital',
      pages: [],
      entity: { name: 'Item', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        { name: 'Header', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'shown' }], events: [], transitions: [{ from: 'idle', to: 'shown', event: 'INIT', effects: [render('header')] }] } },
        { name: 'Stats', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'loaded' }], events: [], transitions: [{ from: 'idle', to: 'loaded', event: 'LOAD', effects: [render('stats')] }] } },
        { name: 'Clock', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'ticking' }], events: [], transitions: [{ from: 'idle', to: 'ticking', event: '$MOUNT', effects: [render('clock')] }] } },
        { name: 'Inert', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [{ from: 'idle', to: 'idle', event: 'SAVE', effects: [] }] } },
      ],
    }],
  };
}

const effectEvents = (r: Awaited<ReturnType<OrbitalServerRuntime['processOrbitalEvent']>>) =>
  (r.clientEffectsByTrait ?? []).map((e) => `${e.traitName}:${e.event}`);

describe('mount batch', () => {
  it('the stateful host runs a mount batch from its held states', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema());
    const r = await runtime.processOrbitalEvent('PageOrbital', {
      event: 'INIT', clientId: 'tab-1',
      mount: [{ trait: 'Header', event: 'INIT' }, { trait: 'Stats', event: 'LOAD' }],
    });
    expect(r.states).toMatchObject({ Header: 'shown', Stats: 'loaded' });
    expect(effectEvents(r)).toEqual(['Header:INIT', 'Stats:LOAD']);
  });
});
