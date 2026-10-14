/**
 * EXEC-STEP-1: a listener reached by a cross-orbital relay steps the dispatch's frame. A payload field is data, so a
 * field that happens to be called `orbitalName` or `entityId` must not pick another frame: the listener's new state
 * is the one the next delivery sees. Rust twin: `orbital-core/tests/relay_payload_fields_do_not_key_frames.rs`.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(field: string): OrbitalSchema {
  return {
    name: 'relay-payload-fields',
    version: '1.0.0',
    orbitals: [
      {
        name: 'StarterOrbital',
        entity: { name: 'Start', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Starter',
            scope: 'instance',
            linkedEntity: 'Start',
            emits: [{ event: 'ASK', scope: 'external', payloadSchema: [{ name: field, type: 'string' }] }],
            stateMachine: {
              states: [{ name: 'ready', isInitial: true }],
              events: [],
              transitions: [{ from: 'ready', to: 'ready', event: 'GO', effects: [['emit', 'ASK', { [field]: 'card-1' }]] }],
            },
          },
        ],
        pages: [],
      },
      {
        name: 'AskerOrbital',
        entity: { name: 'Ask', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Asker',
            scope: 'instance',
            linkedEntity: 'Ask',
            listens: [{ event: 'ASK', source: { kind: 'orbital', orbital: 'StarterOrbital', trait: 'Starter' }, triggers: 'ASKED' }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'asked' }, { name: 'pinged' }],
              events: [],
              transitions: [
                { from: 'idle', to: 'asked', event: 'ASKED', effects: [] },
                { from: 'asked', to: 'pinged', event: 'PING', effects: [] },
              ],
            },
          },
        ],
        pages: [],
      },
    ],
  } as OrbitalSchema;
}

describe.each([['orbitalName'], ['entityId'], ['request']] as const)('a relayed payload field named %s', (field) => {
  it('leaves the listener in its new state for the next delivery', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await rt.register(schema(field));
    const go = await rt.processOrbitalEvent('StarterOrbital', { event: 'GO', targetTrait: 'Starter' });
    expect(go.success).toBe(true);
    const ping = await rt.processOrbitalEvent('AskerOrbital', { event: 'PING', targetTrait: 'Asker' });
    expect(ping.states?.['Asker']).toBe('pinged');
  });
});
