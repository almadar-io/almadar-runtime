/**
 * G-RUNTIME-041: every server-side page scoping rule (discovery scope,
 * on-page render delivery, the stateful relay mask) keys on the client's
 * mounted set `_activeTraits`. The client kernel stopped sending it in the W5b
 * hook split, so a page's mount INIT ran discovery over the WHOLE behavior
 * (project-friday: hundreds of traits) and the server could not tell which
 * listeners the client owns. The kernel's own (page-restricted) index IS the
 * mounted set; it rides every posted leg.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createClientKernel,
  createMemoryCircuitStore,
  createInProcessTransport,
  type TraitIndex,
} from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function twoOrbitalSchema(): OrbitalSchema {
  return {
    name: 'TwoOrbitalApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'AlphaOrbital',
        entity: { name: 'AlphaItem', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'AlphaHome',
            scope: 'instance',
            linkedEntity: 'AlphaItem',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [
                { from: 'idle', to: 'idle', event: 'INIT', effects: [['set', '@entity.booted', true]] },
              ],
            },
          },
        ],
        pages: [],
      },
      {
        name: 'BetaOrbital',
        entity: { name: 'BetaItem', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'BetaBrowse',
            scope: 'instance',
            linkedEntity: 'BetaItem',
            stateMachine: {
              states: [{ name: 'loading', isInitial: true }, { name: 'ready' }],
              events: [],
              transitions: [
                {
                  from: 'loading',
                  to: 'ready',
                  event: 'INIT',
                  effects: [['fetch', 'BetaItem', { emit: { success: 'LOADED' } }]],
                },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  };
}

describe('createClientKernel — mounted set rides every stateless posted leg', () => {
  it('stamps the page-restricted index as _activeTraits', async () => {
    const schema = twoOrbitalSchema();
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema);
    const posts: OrbitalEventRequest[] = [];
    const transport = createInProcessTransport(async (orbitalName, request) => {
      posts.push(request);
      return runtime.processOrbitalEvent(orbitalName, request);
    });
    const full = buildTraitIndex(schema.orbitals);
    const mounted: TraitIndex = {
      byName: new Map([...full.byName].filter(([name]) => name === 'BetaBrowse')),
      allEntities: full.allEntities,
      orbitals: full.orbitals,
    };
    const store = createMemoryCircuitStore([...mounted.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({
      orbitalName: schema.orbitals[0].name,
      traitIndex: mounted,
      fullTraitIndex: full,
      store,
      carriesCircuitState: true,
      transport,
    });
    await kernel.dispatch({ event: 'INIT', targetTrait: 'BetaBrowse' });
    expect(posts[0]?.payload?.['_activeTraits']).toEqual(['BetaBrowse']);
  });
});
