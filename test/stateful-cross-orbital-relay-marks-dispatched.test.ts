/**
 * An emit the cross-orbital relay delivered is marked `dispatched` on the requesting response,
 * like an in-orbital fan-out: the client fold skips re-running a listener the host already ran.
 * Without it, a generator's CHAT_REPLIED reaching a page workspace in another orbital ran the
 * workspace's arm twice and appended its reply twice.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, TraitEventListener } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(listens: TraitEventListener[]): OrbitalSchema {
  return {
    name: 'relay-dispatched',
    version: '1.0.0',
    orbitals: [
      {
        name: 'GeneratorOrbital',
        entity: { name: 'Run', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [{
          name: 'Generator',
          scope: 'instance',
          linkedEntity: 'Run',
          emits: [{ event: 'REPLIED', scope: 'external', payloadSchema: [{ name: 'text', type: 'string' }] }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'ASK', effects: [['emit', 'REPLIED', { text: 'hello' }]] }],
          },
        }],
        pages: [],
      },
      {
        name: 'PageOrbital',
        entity: { name: 'View', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [{
          name: 'Workspace',
          scope: 'instance',
          linkedEntity: 'View',
          listens,
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'REPLIED', effects: [['render-ui', 'main', { type: 'typography', content: 'replied' }]] }],
          },
        }],
        pages: [],
      },
    ],
  };
}

const replied = (r: Awaited<ReturnType<OrbitalServerRuntime['processOrbitalEvent']>>) =>
  r.emittedEvents.find((e) => e.event === 'REPLIED');

describe('cross-orbital relay marks a delivered emit dispatched', () => {
  it('the delivered emit carries dispatched: true and the listener ran once', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await rt.register(schema([{ event: 'REPLIED', source: { kind: 'any' }, triggers: 'REPLIED' }]));
    const r = await rt.processOrbitalEvent('GeneratorOrbital', { event: 'ASK', targetTrait: 'Generator' });
    expect(r.success).toBe(true);
    expect(replied(r)?.source?.dispatched).toBe(true);
    expect((r.clientEffectsByTrait ?? []).filter((e) => e.traitName === 'Workspace')).toHaveLength(1);
  });

  it('control: an emit no other orbital listens for stays unmarked', async () => {
    const rt = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await rt.register(schema([]));
    const r = await rt.processOrbitalEvent('GeneratorOrbital', { event: 'ASK', targetTrait: 'Generator' });
    expect(r.success).toBe(true);
    expect(replied(r)).toBeDefined();
    expect(replied(r)?.source?.dispatched).toBeUndefined();
  });
});
