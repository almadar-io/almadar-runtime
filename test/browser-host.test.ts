/**
 * `openBrowserHost` hosts a whole program in a browser context with no server (an extension's
 * service worker): browser-stored entities in IndexedDB, everything else in memory, and every
 * `call-service` answered by the provider the host wires in.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { EventPayload, OrbitalSchema, ServiceHostPorts, ServiceParams } from '@almadar/core';
import { openBrowserHost } from '../src/evaluation/browser-store-transport';

function program(entity: OrbitalSchema['orbitals'][number]['entity']): OrbitalSchema {
  return {
    name: 'Feed',
    orbitals: [{
      name: 'Feed',
      entity,
      traits: [{
        name: 'Judge', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'JUDGE', name: 'JUDGE' }, { key: 'JUDGED', name: 'JUDGED' }, { key: 'JUDGE_FAILED', name: 'JUDGE_FAILED' }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'JUDGE', effects: [['call-service', 'llm', 'classify', { text: '@payload.title', categories: ['learn', 'laugh'] }, { emit: { success: 'JUDGED', failure: 'JUDGE_FAILED' } }]] },
            { from: 'idle', to: 'idle', event: 'JUDGED', effects: [] },
            { from: 'idle', to: 'idle', event: 'JUDGE_FAILED', effects: [] },
          ],
        },
      }],
      pages: [],
    }],
  };
}

const runtimeItem = { name: 'Item', persistence: 'runtime' as const, fields: [{ name: 'id', type: 'string' as const, required: true }] };
const db = () => `host-${Math.random()}`;

describe('openBrowserHost', () => {
  it('answers call-service with the wired provider and routes its result to the success event', async () => {
    const calls: Array<{ service: string; action: string; params: ServiceParams | undefined }> = [];
    const callService = async (service: string, action: string, params?: ServiceParams): Promise<EventPayload> => {
      calls.push({ service, action, params });
      return { category: 'learn', confidence: 0.9, reasoning: 'r' };
    };
    const host = await openBrowserHost({ databaseName: db(), schema: program(runtimeItem), callService });
    const res = await host.send('Feed', { event: 'JUDGE', payload: { title: 'Graphs 101' } });
    expect(res.success).toBe(true);
    expect(calls).toEqual([{ service: 'llm', action: 'classify', params: { text: 'Graphs 101', categories: ['learn', 'laugh'] } }]);
    expect(res.emittedEvents.map((e) => e.event)).toContain('JUDGED');
  });

  it('a provider failure takes the failure route', async () => {
    const host = await openBrowserHost({
      databaseName: db(),
      schema: program(runtimeItem),
      callService: async () => {
        throw new Error('MODEL_UNAVAILABLE');
      },
    });
    const res = await host.send('Feed', { event: 'JUDGE', payload: { title: 't' } });
    expect(res.emittedEvents.map((e) => e.event)).toContain('JUDGE_FAILED');
  });

  it('lends the provider the running app as the caller: its declared inputs and a dispatch that fires them', async () => {
    const watcher: OrbitalSchema = {
      name: 'Feed',
      orbitals: [{
        name: 'Feed',
        entity: runtimeItem,
        traits: [{
          name: 'Watch', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'seen' }],
            events: [{ key: 'START', name: 'START' }, { key: 'ITEM_SEEN', name: 'ITEM_SEEN', external: true, payloadSchema: [{ name: 'title', type: 'string' }] }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'START', effects: [['call-service', 'page', 'watch', { match: 'https://example.com/*', selector: '.i', fields: {}, event: 'ITEM_SEEN' }]] },
              { from: 'idle', to: 'seen', event: 'ITEM_SEEN', effects: [] },
            ],
          },
        }],
        pages: [],
      }],
    };
    let lent: ServiceHostPorts | undefined;
    const host = await openBrowserHost({
      databaseName: db(),
      schema: watcher,
      callService: async (_s, _a, _p, context) => {
        lent = context?.host;
        return { watchId: 'w-1' };
      },
    });
    await host.send('Feed', { event: 'START', payload: {} });
    expect(lent?.caller).toEqual({ orbital: 'Feed', trait: 'Watch' });
    expect(lent?.inputs().map((i) => i.event)).toEqual(['ITEM_SEEN']);
    const res = await lent?.dispatchInput('Feed', { targetTrait: 'Watch', event: 'ITEM_SEEN', payload: { title: 'x' } });
    expect(res?.states).toEqual({ Watch: 'seen' });
    const refused = await lent?.dispatchInput('Feed', { targetTrait: 'Watch', event: 'START', payload: {} });
    expect(refused?.rejections?.[0]?.code).toBe('not-an-external-input');
  });

  it('reports each declared input it runs, with the result, so open views can show it', async () => {
    const watcher: OrbitalSchema = {
      name: 'Feed',
      orbitals: [{
        name: 'Feed',
        entity: runtimeItem,
        traits: [{
          name: 'Watch', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'seen' }],
            events: [{ key: 'START', name: 'START' }, { key: 'ITEM_SEEN', name: 'ITEM_SEEN', external: true, payloadSchema: [{ name: 'title', type: 'string' }] }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'START', effects: [['call-service', 'page', 'watch', { match: 'https://example.com/*', selector: '.i', fields: {}, event: 'ITEM_SEEN' }]] },
              { from: 'idle', to: 'seen', event: 'ITEM_SEEN', effects: [['render-ui', 'main', { type: 'typography', content: 'Seen an item' }]] },
            ],
          },
        }],
        pages: [],
      }],
    };
    let lent: ServiceHostPorts | undefined;
    const host = await openBrowserHost({
      databaseName: db(),
      schema: watcher,
      callService: async (_s, _a, _p, context) => {
        lent = context?.host;
        return { watchId: 'w-1' };
      },
    });
    const reported: Array<{ orbital: string; event: string; targetTrait: string | undefined; states: Record<string, string>; rendered: number }> = [];
    const stop = host.onInputDispatched((orbital, request, response) => {
      reported.push({ orbital, event: request.event, targetTrait: request.targetTrait, states: response.states, rendered: response.clientEffects?.length ?? 0 });
    });
    await host.send('Feed', { event: 'START', payload: {} });
    expect(reported).toEqual([]);
    await lent?.dispatchInput('Feed', { targetTrait: 'Watch', event: 'ITEM_SEEN', payload: { title: 'x' } });
    expect(reported).toEqual([{ orbital: 'Feed', event: 'ITEM_SEEN', targetTrait: 'Watch', states: { Watch: 'seen' }, rendered: 1 }]);
    await lent?.dispatchInput('Feed', { targetTrait: 'Watch', event: 'START', payload: {} });
    expect(reported).toHaveLength(1);
    stop();
    await lent?.dispatchInput('Feed', { targetTrait: 'Watch', event: 'ITEM_SEEN', payload: { title: 'y' } });
    expect(reported).toHaveLength(1);
  });

  it('a request that arrives while another awaits its service runs in the meantime, and sees the state the first transition entered', async () => {
    const slow: OrbitalSchema = {
      name: 'Feed',
      orbitals: [{
        name: 'Feed',
        entity: runtimeItem,
        traits: [{
          name: 'Work', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'busy' }],
            events: [{ key: 'GO', name: 'GO' }, { key: 'DONE', name: 'DONE' }],
            transitions: [
              { from: 'idle', to: 'busy', event: 'GO', effects: [['call-service', 'slow', 'run', { label: '@payload.label' }, { emit: { success: 'DONE' } }]] },
              { from: 'busy', to: 'idle', event: 'DONE', effects: [] },
            ],
          },
        }],
        pages: [],
      }],
    };
    const log: string[] = [];
    let running = 0;
    const host = await openBrowserHost({
      databaseName: db(),
      schema: slow,
      callService: async (_s, _a, params) => {
        running += 1;
        log.push(`start ${String(params?.label)} (${running} running)`);
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return {};
      },
    });
    const [a, b] = await Promise.all([host.send('Feed', { event: 'GO', payload: { label: 'a' } }), host.send('Feed', { event: 'GO', payload: { label: 'b' } })]);
    // b runs while a's call is out of the queue, but Work is already `busy`, where GO does nothing.
    expect(log).toEqual(['start a (1 running)']);
    expect(a.states).toEqual({ Work: 'idle' });
    expect(b.transitioned).toBe(false);
  });

  it('control: a service that dispatches an input while its own request runs is not made to wait for itself', async () => {
    const watcher: OrbitalSchema = {
      name: 'Feed',
      orbitals: [{
        name: 'Feed',
        entity: runtimeItem,
        traits: [{
          name: 'Watch', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'seen' }],
            events: [{ key: 'START', name: 'START' }, { key: 'ITEM_SEEN', name: 'ITEM_SEEN', external: true, payloadSchema: [{ name: 'title', type: 'string' }] }],
            transitions: [
              { from: 'idle', to: 'idle', event: 'START', effects: [['call-service', 'tools', 'run', {}]] },
              { from: 'idle', to: 'seen', event: 'ITEM_SEEN', effects: [] },
            ],
          },
        }],
        pages: [],
      }],
    };
    let inner: string | undefined;
    const host = await openBrowserHost({
      databaseName: db(),
      schema: watcher,
      callService: async (_s, _a, _p, context) => {
        const res = await context?.host?.dispatchInput('Feed', { targetTrait: 'Watch', event: 'ITEM_SEEN', payload: { title: 'x' } });
        inner = res?.states.Watch;
        return {};
      },
    });
    const outcome = await Promise.race([host.send('Feed', { event: 'START', payload: {} }).then(() => 'finished'), new Promise((r) => setTimeout(() => r('deadlocked'), 1000))]);
    expect(outcome).toBe('finished');
    expect(inner).toBe('seen');
  });

  it('edge: a program with no browser-stored entity still opens (runtime entities live in memory)', async () => {
    await expect(openBrowserHost({ databaseName: db(), schema: program(runtimeItem), callService: async () => ({}) })).resolves.toBeDefined();
  });

  it('control: a browser-stored entity is still served from IndexedDB', async () => {
    const local = { name: 'Item', persistence: 'persistent' as const, collection: 'items', local: true, fields: [{ name: 'id', type: 'string' as const, required: true }], instances: [{ id: 'I-1' }] };
    const host = await openBrowserHost({ databaseName: db(), schema: program(local), callService: async () => ({}) });
    expect(host).toBeDefined();
  });
});
