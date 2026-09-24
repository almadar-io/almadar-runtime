/**
 * G-RUNTIME-041 / G-RUNTIME-042 — std-global-search: the on-page searcher
 * emits REQUESTED; an OFF-page responder in ANOTHER orbital answers RESULTS
 * inside the stateful server's cross-orbital relay. A stateful host holds
 * every trait's state, so it delivers that answer itself whether or not the
 * client sent its mounted set: the listener's render and state ride the
 * response, and the server's held state advances (a later event sees it).
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'cross-orbital-answer',
    version: '1.0.0',
    orbitals: [
      {
        name: 'SearchOrbital',
        entity: { name: 'Query', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Searcher',
            scope: 'instance',
            linkedEntity: 'Query',
            emits: [{ event: 'REQUESTED', scope: 'external', payloadSchema: [{ name: 'moduleKey', type: 'string' }] }],
            listens: [{ event: 'RESULTS', source: { kind: 'any' }, triggers: 'RESULTS' }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'searching' }, { name: 'done' }],
              events: [],
              transitions: [
                { from: 'idle', to: 'searching', event: 'GO', effects: [['emit', 'REQUESTED', { moduleKey: 'tasks' }]] },
                { from: 'searching', to: 'done', event: 'RESULTS', effects: [['render-ui', 'main', { type: 'typography', content: 'answered' }]] },
                { from: 'done', to: 'done', event: 'PING', effects: [] },
              ],
            },
          },
        ],
        pages: [],
      },
      {
        name: 'TaskOrbital',
        entity: { name: 'Task', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'TaskResponder',
            scope: 'instance',
            linkedEntity: 'Task',
            emits: [{ event: 'RESULTS', scope: 'external', payloadSchema: [{ name: 'moduleKey', type: 'string' }] }],
            listens: [{ event: 'REQUESTED', source: { kind: 'any' }, triggers: 'REQUESTED' }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [
                { from: 'idle', to: 'idle', event: 'REQUESTED', effects: [['emit', 'RESULTS', { moduleKey: 'tasks' }]] },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  } as OrbitalSchema;
}

describe.each([
  ['with the client mounted set', { _activeTraits: ['Searcher'] }],
  ['with no mounted set (headless peer)', undefined],
] as const)('stateful cross-orbital relay %s', (_label, payload) => {
  it('delivers the answer server-side and folds its work into the response', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await rt.register(schema());
    const go = await rt.processOrbitalEvent('SearchOrbital', {
      event: 'GO',
      targetTrait: 'Searcher',
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(go.success).toBe(true);
    expect((go.clientEffectsByTrait ?? []).some((e) => e.traitName === 'Searcher' && JSON.stringify(e.effect).includes('answered'))).toBe(true);
    expect(go.states?.['Searcher']).toBe('done');
    const ping = await rt.processOrbitalEvent('SearchOrbital', { event: 'PING', targetTrait: 'Searcher' });
    expect(ping.transitioned).toBe(true);
  });
});
