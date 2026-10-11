/**
 * G-RUNTIME-073: a trait that is not client-only (a `[runtime]` view that also calls a server
 * service) reads browser-stored rows; the browser store hands the read's `success` back unconsumed,
 * and the client must continue it so the next arm's server call is sent.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalId, OrbitalSchema } from '@almadar/core';
import type { EventTransport } from '../src/server/EventTransport.js';
import { buildTraitIndex, createMemoryCircuitStore, createResidenceTransport, dispatchWithServerLeg, openBrowserStoreTransport, postServerLeg, type ClientRoleOpts } from '../src/index.js';

function schema(): OrbitalSchema {
  return {
    name: 'optimistic-browser-read',
    version: '1.0.0',
    orbitals: [{
      name: 'Feed',
      id: 'orb_feed' as OrbitalId,
      pages: [],
      entity: { name: 'FeedView', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      auxiliaryEntities: [{
        name: 'Choice', persistence: 'persistent', collection: 'choices', local: true,
        fields: [{ name: 'id', type: 'string' }],
        instances: [{ id: 'c1' }],
      }],
      traits: [{
        name: 'FeedBody',
        linkedEntity: 'FeedView',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'loading', isInitial: true }, { name: 'ready' }],
          events: [],
          transitions: [
            { from: 'loading', to: 'loading', event: 'LOAD', effects: [['fetch', 'Choice', { emit: { success: 'CHOICES_LOADED' } }]] },
            { from: 'loading', to: 'loading', event: 'CHOICES_LOADED', effects: [['call-service', 'knowledge', 'listPaths', {}, { emit: { success: 'PATHS_LOADED' } }]] },
            { from: 'loading', to: 'ready', event: 'PATHS_LOADED', effects: [] },
          ],
        },
      }],
    }],
  };
}

function remoteServer(response: (request: OrbitalEventRequest) => OrbitalEventResponse): EventTransport & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async register() { return { success: true, carriesCircuitState: false }; },
    async unregister() {},
    async send(_orbital: string, request: OrbitalEventRequest) {
      sent.push(request.event);
      return response(request);
    },
  };
}

async function load(remote: EventTransport): Promise<ClientRoleOpts> {
  const traitIndex = buildTraitIndex(schema().orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const opts: ClientRoleOpts = { orbitalName: 'Feed', traitIndex, store, carriesCircuitState: true };
  const local = await openBrowserStoreTransport({ databaseName: `optimistic-${Math.random()}`, schema: schema(), clientRelays: true });
  const transport = createResidenceTransport({ local, remote, traitIndex });
  const dispatch = await dispatchWithServerLeg(opts, { event: 'LOAD', targetTrait: 'FeedBody' });
  expect(dispatch.mode).toBe('runtimeOptimistic');
  await postServerLeg(transport, 'Feed', dispatch, store, opts);
  return opts;
}

describe('a non-client-only trait reading browser-stored rows', () => {
  it('continues the read\'s success into the server call', async () => {
    const remote = remoteServer(() => ({
      success: true, transitioned: true, states: { FeedBody: 'ready' },
      emittedEvents: [{ event: 'PATHS_LOADED', payload: {}, source: { orbital: 'Feed', trait: 'FeedBody', dispatched: true } }],
    }));
    const opts = await load(remote);
    expect(remote.sent).toEqual(['CHOICES_LOADED']);
    expect(opts.store.manager.getState('FeedBody')?.currentState).toBe('ready');
  });

  it('control: an own emit the server already ran is not run again', async () => {
    const remote = remoteServer(() => ({
      success: true, transitioned: true, states: { FeedBody: 'loading' },
      emittedEvents: [{ event: 'CHOICES_LOADED', payload: {}, source: { orbital: 'Feed', trait: 'FeedBody', dispatched: true } }],
    }));
    await load(remote);
    expect(remote.sent).toEqual(['CHOICES_LOADED']);
  });
});
