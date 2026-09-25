// A server-runtime transition observer sees every executed hop, listener deliveries included, so one dispatch fanning several events into one listener is observable per event.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import type { TransitionObserver } from '../src/types.js';

const schema: OrbitalSchema = {
  name: 'observer-fanout',
  version: '1.0.0',
  orbitals: [{
    name: 'Main',
    pages: [],
    entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [
      {
        name: 'Bridge',
        linkedEntity: 'Item',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [],
          transitions: [{
            from: 'idle', to: 'idle', event: 'ENABLED',
            effects: [['emit', 'REGISTER', { id: 'a' }], ['emit', 'REGISTER', { id: 'b' }], ['emit', 'STATUS', { text: 'on' }], ['emit', 'UNHEARD', {}]],
          }],
        },
      },
      {
        name: 'Shell',
        linkedEntity: 'Item',
        scope: 'instance',
        listens: [
          { event: 'REGISTER', source: { kind: 'trait', trait: 'Bridge' }, triggers: 'REGISTER' },
          { event: 'STATUS', source: { kind: 'trait', trait: 'Bridge' }, triggers: 'STATUS' },
        ],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [],
          transitions: [
            { from: 'idle', to: 'idle', event: 'REGISTER' },
            { from: 'idle', to: 'idle', event: 'STATUS' },
          ],
        },
      },
    ],
  }],
};

function recorder(): { observer: TransitionObserver; hops: string[] } {
  const hops: string[] = [];
  return { hops, observer: { onTransition: (t) => { hops.push(`${t.traitName}.${t.event}`); } } };
}

const enable = (rt: OrbitalServerRuntime) => rt.processOrbitalEvent('Main', { event: 'ENABLED', payload: {}, targetTrait: 'Bridge' });

describe('OrbitalServerRuntime.observeTransitions', () => {
  it('reports each listener delivery of one fan-out dispatch, not just the last', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema);
    const { observer, hops } = recorder();
    rt.observeTransitions(observer);
    await enable(rt);
    expect(hops.filter((h) => h.startsWith('Shell.'))).toEqual(['Shell.REGISTER', 'Shell.REGISTER', 'Shell.STATUS']);
    expect(hops).toContain('Bridge.ENABLED');
  });

  it('applies to orbitals registered after it was set', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    const { observer, hops } = recorder();
    rt.observeTransitions(observer);
    await rt.register(schema);
    await enable(rt);
    expect(hops.filter((h) => h.startsWith('Shell.'))).toHaveLength(3);
  });

  it('control: an emitted event no trait listens to produces no listener hop', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema);
    const { observer, hops } = recorder();
    rt.observeTransitions(observer);
    await enable(rt);
    expect(hops.some((h) => h.endsWith('.UNHEARD'))).toBe(false);
  });

  it('control: an unsubscribed observer hears nothing further while another still does', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema);
    const gone = recorder();
    const kept = recorder();
    rt.observeTransitions(gone.observer)();
    rt.observeTransitions(kept.observer);
    await enable(rt);
    expect(gone.hops).toEqual([]);
    expect(kept.hops.filter((h) => h.startsWith('Shell.'))).toHaveLength(3);
  });
});
