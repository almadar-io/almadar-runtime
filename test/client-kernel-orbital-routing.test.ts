/**
 * Client-kernel orbital routing (multi-orbital apps, stateful topology).
 *
 * Observed on runtime-verify --catalog 2026-09-23: navigating to a page whose
 * traits belong to a NON-FIRST orbital produced a burst of server responses
 * shaped exactly like
 *
 *   { success: true, transitioned: false, states: {},
 *     emittedEvents: [], rejections: [{ code: 'no-dispatchable-traits',
 *     event: 'INIT' }] }
 *
 * and the page sat in its loading state forever. `states: {}` + that
 * rejection is the composition's "targeted request, target trait absent from
 * THIS orbital's index" answer — the INIT had been posted to the wrong
 * orbital's endpoint.
 *
 * Root cause: `createClientKernel` bakes ONE `orbitalName` (the caller passes
 * `orbitals[0].name` — see `useCircuitKernel`) into the client role, and
 * EVERY posted dispatch — regardless of which orbital actually owns the seed
 * trait — goes to `POST /{orbitalName}/events`. A multi-orbital app
 * navigating to a second-orbital page posts that orbital's traits to the
 * first orbital's endpoint; the stateful host's per-orbital traitIndex has no
 * entry for them, target resolution yields zero targets, and the mount
 * INIT(s) die with the rejection above. The client-side local run cannot
 * rescue it: a persisted trait's `fetch` is a server-only effect, so no data
 * ever arrives and the loading skeleton stays.
 *
 * The fix routes each dispatch to its SEED TRAIT's owning orbital
 * (`traitIndex.byName.get(targetTrait)?.orbitalName`), falling back to the
 * baked `orbitalName`. The `TraitIndex` already stamps `orbitalName` per
 * trait (`buildTraitIndex`), so no new wiring is needed anywhere else —
 * `@almadar/ui`, the playground, and every other `createClientKernel` caller
 * pick the fix up through the one composition.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import {
  buildTraitIndex,
  createClientKernel,
  createMemoryCircuitStore,
  createInProcessTransport,
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

describe('createClientKernel — multi-orbital stateful dispatch routing', () => {
  it('routes a dispatch to the SEED TRAIT\'s owning orbital, not orbitals[0]', async () => {
    const schema = twoOrbitalSchema();
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema);

    // The stateful host answers per-orbital — exactly like the real server's
    // per-orbital registration + router.
    const posts: Array<{ orbital: string; request: OrbitalEventRequest }> = [];
    const serverResponses: OrbitalEventResponse[] = [];
    const transport = createInProcessTransport(async (orbitalName, request) => {
      posts.push({ orbital: orbitalName, request });
      const response = await runtime.processOrbitalEvent(orbitalName, request);
      serverResponses.push(response);
      return response;
    });

    // The client composes exactly like `useCircuitKernel` does: ONE kernel
    // for the page, orbitalName = orbitals[0].name, traitIndex spanning the
    // full schema.
    const traitIndex = buildTraitIndex(schema.orbitals);
    const traitDefs = [...traitIndex.byName.values()].map((entry) => entry.traitDef);
    const store = createMemoryCircuitStore(traitDefs);
    const kernel = createClientKernel({
      orbitalName: schema.orbitals[0].name,
      traitIndex,
      store,
      carriesCircuitState: false,
      transport,
    });

    // Page nav into BetaOrbital's page: the mount lifecycle fires BetaBrowse's
    // INIT (a persisted trait — the local run cannot fetch, so the server
    // round-trip is what produces the page's data).
    await kernel.dispatch({ event: 'INIT', targetTrait: 'BetaBrowse' });

    // The contract: the INIT reached BETA's endpoint and the server ran the
    // fetch arm. Pre-fix the post went to AlphaOrbital and the server
    // answered with the observed no-dispatchable-traits / states:{} shape.
    const initPost = posts.find((p) => p.request.event === 'INIT');
    expect(initPost?.orbital).toBe('BetaOrbital');

    const initResponse = serverResponses[serverResponses.length - 1];
    expect(initResponse.rejections).toBeUndefined();
    expect(initResponse.transitioned).toBe(true);
    expect(initResponse.states['BetaBrowse']).toBe('ready');
  });
});
