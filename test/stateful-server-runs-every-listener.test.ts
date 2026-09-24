/**
 * G-RUNTIME-042 — a stateful host HOLDS every trait's state, so it runs every
 * listener itself; the requesting client's mounted set (`_activeTraits`) only
 * scopes which renders come back. Masking the on-page listeners left the
 * server's held state stale (std-time-tracking /reports: the chart's next
 * INIT rendered the server's never-updated empty frame over the client's
 * data). Only a host that holds no state (stateless) leaves them to the client.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalId, OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

function schema(): OrbitalSchema {
  return {
    name: 'stateful-listeners',
    version: '1.0.0',
    orbitals: [{
      name: 'ReportOrbital',
      id: 'orb_report' as OrbitalId,
      pages: [],
      entity: { name: 'Report', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'count', type: 'number', default: 0 }] },
      traits: [
        {
          name: 'Loader',
          linkedEntity: 'Report',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'LOAD', effects: [['emit', 'LOADED', { n: 3 }]] }],
          },
        },
        {
          name: 'Chart',
          linkedEntity: 'Report',
          scope: 'instance',
          listens: [{ event: 'LOADED', source: { kind: 'trait', trait: 'Loader' }, triggers: 'ITEMS' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [
              { from: 'idle', to: 'idle', event: 'ITEMS', effects: [['set', '@entity.count', '@payload.n']] },
              { from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: '@entity.count' }]] },
            ],
          },
        },
      ],
    }],
  } as OrbitalSchema;
}

describe.each([
  ['with the mounted set', { _activeTraits: ['Loader', 'Chart'] }],
  ['without a mounted set', undefined],
] as const)('stateful host %s', (_label, payload) => {
  it('runs the on-page listener itself, so its held state stays current', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false, persistence: new InMemoryPersistence() });
    await runtime.register(schema());
    await runtime.processOrbitalEvent('ReportOrbital', { event: 'LOAD', targetTrait: 'Loader', ...(payload !== undefined ? { payload } : {}) });
    const init = await runtime.processOrbitalEvent('ReportOrbital', { event: 'INIT', targetTrait: 'Chart', ...(payload !== undefined ? { payload } : {}) });
    expect(init.entityByTrait?.['Chart']?.['count']).toBe(3);
  });
});

describe('stateful host: a dispatch target\'s own listens are not masked', () => {
  it('a self-listen chain runs every step', async () => {
    const s = {
      name: 'self-listen',
      version: '1.0.0',
      orbitals: [{
        name: 'Main',
        id: 'orb_main' as OrbitalId,
        pages: [],
        entity: { name: 'Counter', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'steps', type: 'number', default: 0 }] },
        traits: [{
          name: 'Fanner',
          linkedEntity: 'Counter',
          scope: 'instance',
          listens: [{ event: 'STEP_NEXT', source: { kind: 'trait', trait: 'Fanner' }, triggers: 'STEP' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{
              from: 'idle', to: 'idle', event: 'STEP', guard: ['>', '@payload.remaining', 0],
              effects: [
                ['set', '@entity.steps', ['+', '@entity.steps', 1]],
                ['emit', 'STEP_NEXT', { remaining: ['-', '@payload.remaining', 1] }],
              ],
            }],
          },
        }],
      }],
    } as OrbitalSchema;
    const runtime = new OrbitalServerRuntime({ debug: false, persistence: new InMemoryPersistence() });
    await runtime.register(s);
    const r = await runtime.processOrbitalEvent('Main', { event: 'STEP', targetTrait: 'Fanner', payload: { remaining: 3 } });
    expect(r.entityByTrait?.['Fanner']?.['steps']).toBe(3);
  });
});
