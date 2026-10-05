/**
 * A transition's state is committed before its effects run (transition, then effects). With the host
 * queue released while a call-service awaits its provider, a request served meanwhile sees the trait in
 * the state the transition entered, not the one it left.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { EventPayload, OrbitalSchema, ServiceParams } from '@almadar/core';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';

const program: OrbitalSchema = {
  name: 'Midcall',
  orbitals: [{
    name: 'Midcall',
    entity: { name: 'Job', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{
      name: 'Runner', linkedEntity: 'Job', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'working' }],
        events: [{ key: 'GO', name: 'GO' }, { key: 'DONE', name: 'DONE' }, { key: 'START_ANOTHER', name: 'START_ANOTHER' }, { key: 'BUSY', name: 'BUSY' }],
        transitions: [
          { from: 'idle', to: 'working', event: 'GO', effects: [['call-service', 'slow', 'work', {}, { emit: { success: 'DONE' } }]] },
          { from: 'working', to: 'idle', event: 'DONE', effects: [] },
          { from: 'idle', to: 'idle', event: 'START_ANOTHER', effects: [] },
          { from: 'working', to: 'working', event: 'BUSY', effects: [] },
        ],
      },
    }],
    pages: [],
  }],
};

const hosts: BrowserHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.close()));

function slow() {
  let finish: (value: EventPayload) => void = () => undefined;
  return {
    finish: (value: EventPayload) => finish(value),
    callService: (_s: string, _a: string, _p?: ServiceParams) => new Promise<EventPayload | null>((resolve) => { finish = resolve; }),
  };
}

describe('openBrowserHost: state while a call is in flight', () => {
  it('a request served during the call sees the state the transition entered', async () => {
    const provider = slow();
    const host = await openBrowserHost({ databaseName: `midcall-${Math.random()}`, schema: program, callService: provider.callService });
    hosts.push(host);
    await host.send('Midcall', { event: 'INIT', targetTrait: 'Runner', payload: {} });
    const go = host.send('Midcall', { event: 'GO', payload: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect((await host.send('Midcall', { event: 'BUSY', payload: {} })).transitioned).toBe(true);
    expect((await host.send('Midcall', { event: 'START_ANOTHER', payload: {} })).transitioned).toBe(false);
    provider.finish({});
    await go;
    expect((await host.send('Midcall', { event: 'START_ANOTHER', payload: {} })).transitioned).toBe(true);
  });
});
