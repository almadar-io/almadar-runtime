// A running call-service's live messages (`emit: { onMessage }`) reach only
// the requesting client, while the call is still running, as the call site's
// declared event stamped as the calling trait — never in-band.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime, type LiveBroadcastItem } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { OrbitalSchema, UserContext } from '@almadar/core';

const ALICE: UserContext = { id: 'alice', role: 'member' };

function schema(emit: Record<string, string>): OrbitalSchema {
  return {
    name: 'live-message-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'AssistantOrbital',
        pages: [],
        entity: { name: 'Turn', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
        traits: [
          {
            name: 'Assistant',
            scope: 'instance',
            linkedEntity: 'Turn',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'thinking' }],
              events: [
                { key: 'ASK', name: 'Ask' },
                { key: 'STEP', name: 'Step', payloadSchema: [{ name: 'activity', type: 'object', required: true }] },
                { key: 'ANSWERED', name: 'Answered' },
                { key: 'FAILED', name: 'Failed' },
              ],
              transitions: [
                { from: 'idle', to: 'thinking', event: 'ASK', effects: [['call-service', 'llm', 'call-tools', {}, { emit }]] },
                { from: 'thinking', to: 'idle', event: 'ANSWERED' },
                { from: 'thinking', to: 'idle', event: 'FAILED' },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function setup(emit: Record<string, string>) {
  const items: LiveBroadcastItem[] = [];
  let itemsBeforeReturn = -1;
  const runtime = new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    effectHandlers: {
      callService: async (_service, _action, _params, context) => {
        context?.host?.message({ activity: { type: 'tool_call', tool: 'read__Task', args: {}, timestamp: 1 } });
        context?.host?.message({ activity: { type: 'tool_result', tool: 'read__Task', result: { rows: [] }, success: true, timestamp: 2 } });
        itemsBeforeReturn = items.length;
        return { reply: 'done' };
      },
    },
  });
  runtime.setLiveBroadcastSink((item) => items.push(item));
  await runtime.register(schema(emit));
  const res = await runtime.processOrbitalEvent('AssistantOrbital', { event: 'ASK', targetTrait: 'Assistant', user: ALICE, clientId: 'tab-1' });
  return { res, items, itemsBeforeReturn: () => itemsBeforeReturn };
}

// The page that asks lives in another orbital: the call runs on a
// cross-orbital relay hop, which must still know the requesting tab.
function crossOrbitalSchema(): OrbitalSchema {
  const base = schema({ onMessage: 'STEP', success: 'ANSWERED', failure: 'FAILED' });
  const assistant = base.orbitals[0];
  return {
    ...base,
    orbitals: [
      {
        name: 'PageOrbital',
        pages: [],
        entity: { name: 'PageView', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
        traits: [
          {
            name: 'Page',
            scope: 'instance',
            linkedEntity: 'PageView',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'SUBMIT', name: 'Submit' }, { key: 'SEND', name: 'Send' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'SUBMIT', effects: [['emit', 'SEND', {}]] }],
            },
          },
        ],
      },
      {
        ...assistant,
        traits: assistant.traits.map((t) =>
          typeof t === 'object' && 'stateMachine' in t
            ? { ...t, listens: [{ event: 'SEND', source: { kind: 'any' as const }, triggers: 'ASK' }] }
            : t),
      },
    ],
  };
}

describe('call-service live messages', () => {
  it('a cross-orbital relay hop runs as the requesting viewer, not the default user', async () => {
    const principals: Array<string | undefined> = [];
    const runtime = new OrbitalServerRuntime({
      persistence: new InMemoryPersistence(),
      debug: false,
      defaultUser: { id: 'default', role: 'member' },
      effectHandlers: {
        callService: async (_service, _action, _params, context) => {
          principals.push(context?.principal);
          return { reply: 'done' };
        },
      },
    });
    await runtime.register(crossOrbitalSchema());
    await runtime.processOrbitalEvent('PageOrbital', { event: 'SUBMIT', targetTrait: 'Page', user: ALICE, clientId: 'tab-1' });
    expect(principals).toEqual(['alice']);
  });

  it('a call reached through a cross-orbital relay hop still delivers to the requesting tab', async () => {
    const items: LiveBroadcastItem[] = [];
    const runtime = new OrbitalServerRuntime({
      persistence: new InMemoryPersistence(),
      debug: false,
      effectHandlers: {
        callService: async (_service, _action, _params, context) => {
          context?.host?.message({ activity: { type: 'message', role: 'assistant', content: 'working', timestamp: 1 } });
          return { reply: 'done' };
        },
      },
    });
    runtime.setLiveBroadcastSink((item) => items.push(item));
    await runtime.register(crossOrbitalSchema());
    const res = await runtime.processOrbitalEvent('PageOrbital', { event: 'SUBMIT', targetTrait: 'Page', user: ALICE, clientId: 'tab-1' });
    expect(res.success).toBe(true);
    expect(items.map((i) => [i.event, i.target, i.originClientId, i.source.orbital])).toEqual([
      ['STEP', 'origin', 'tab-1', 'AssistantOrbital'],
    ]);
  });


  it('delivers each message to the origin, in order, before the call returns', async () => {
    const { res, items, itemsBeforeReturn } = await setup({ onMessage: 'STEP', success: 'ANSWERED', failure: 'FAILED' });
    expect(res.success).toBe(true);
    expect(itemsBeforeReturn()).toBe(2);
    expect(items.map((i) => [i.event, i.target, i.originClientId, i.source.trait, i.source.orbital])).toEqual([
      ['STEP', 'origin', 'tab-1', 'Assistant', 'AssistantOrbital'],
      ['STEP', 'origin', 'tab-1', 'Assistant', 'AssistantOrbital'],
    ]);
    expect(items.map((i) => i.payload?.activity)).toEqual([
      { type: 'tool_call', tool: 'read__Task', args: {}, timestamp: 1 },
      { type: 'tool_result', tool: 'read__Task', result: { rows: [] }, success: true, timestamp: 2 },
    ]);
  });

  it('never runs in-band: the response carries the success emit, not the messages', async () => {
    const { res } = await setup({ onMessage: 'STEP', success: 'ANSWERED', failure: 'FAILED' });
    const events = res.emittedEvents.map((e) => e.event);
    expect(events).toContain('ANSWERED');
    expect(events).not.toContain('STEP');
  });

  it('control: without onMessage the messages go nowhere', async () => {
    const { res, items } = await setup({ success: 'ANSWERED', failure: 'FAILED' });
    expect(res.success).toBe(true);
    expect(items).toEqual([]);
  });
});
