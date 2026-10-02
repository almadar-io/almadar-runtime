/**
 * LOLO §7: a client-only trait (here: bound to a `[runtime]` entity, no
 * server effect) never takes a server round trip for its own state. When its
 * emit reaches an off-page listener, the leg continues at that listener; the
 * events the server answers with run on the client. Live messages that land
 * while the call is running stay in the trait's state when the answer arrives.
 */
import { describe, it, expect } from 'vitest';
import type { EventPayload, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, collectListenerTargets, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

function schema(emit: Record<string, string>): OrbitalSchema {
  return {
    name: 'ClientOnlyAuthorityApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'PageOrbital',
        entity: { name: 'ChatView', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'entries', type: 'array', default: [] }, { name: 'working', type: 'boolean', default: false }] },
        traits: [
          {
            name: 'Chat',
            scope: 'instance',
            linkedEntity: 'ChatView',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'ASK', name: 'Ask' }, { key: 'STEP', name: 'Step' }, { key: 'REPLIED', name: 'Replied' }],
              transitions: [
                { from: 'idle', to: 'idle', event: 'ASK', effects: [['set', '@entity.entries', ['array/append', '@entity.entries', 'user']], ['set', '@entity.working', true], ['emit', 'SEND']] },
                { from: 'idle', to: 'idle', event: 'STEP', effects: [['set', '@entity.entries', ['array/append', '@entity.entries', 'step']]] },
                { from: 'idle', to: 'idle', event: 'REPLIED', effects: [['set', '@entity.entries', ['array/append', '@entity.entries', 'reply']], ['set', '@entity.working', false]] },
              ],
            },
            emits: [{ event: 'SEND', scope: 'external' }],
            listens: [
              { event: 'STEP', triggers: 'STEP', source: { kind: 'orbital', orbital: 'AgentOrbital', trait: 'Loop' } },
              { event: 'REPLIED', triggers: 'REPLIED', source: { kind: 'orbital', orbital: 'AgentOrbital', trait: 'Loop' } },
            ],
          },
        ],
        pages: [],
      },
      {
        name: 'AgentOrbital',
        entity: { name: 'Run', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Loop',
            scope: 'instance',
            linkedEntity: 'Run',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'CONVERSE', name: 'Converse' }, { key: 'STEP', name: 'Step' }, { key: 'REPLIED', name: 'Replied' }, { key: 'FAILED', name: 'Failed' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'CONVERSE', effects: [['call-service', 'llm', 'call-tools', {}, { emit }]] }],
            },
            emits: [{ event: 'STEP', scope: 'external' }, { event: 'REPLIED', scope: 'external' }],
            listens: [{ event: 'SEND', triggers: 'CONVERSE', source: { kind: 'orbital', orbital: 'PageOrbital', trait: 'Chat' } }],
          },
        ],
        pages: [],
      },
    ],
  };
}

async function ask(emit: Record<string, string>) {
  const s = schema(emit);
  const runtime = new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    effectHandlers: {
      callService: async (_service, _action, _params, context): Promise<EventPayload> => {
        context?.host?.message({ text: 'reading' });
        await new Promise((r) => setTimeout(r, 5));
        return { reply: 'done' };
      },
    },
  });
  await runtime.register(s);
  const fullTraitIndex = buildTraitIndex(s.orbitals);
  const traitIndex = buildTraitIndex(s.orbitals.filter((o) => o.name === 'PageOrbital'));
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const posted: OrbitalEventRequest[] = [];
  const transport = createInProcessTransport(async (o: string, r: OrbitalEventRequest): Promise<OrbitalEventResponse> => {
    posted.push(r);
    return runtime.processOrbitalEvent(o, r);
  });
  const kernel = createClientKernel({ orbitalName: 'PageOrbital', traitIndex, fullTraitIndex, store, carriesCircuitState: false, transport });
  const progress: Array<Promise<unknown>> = [];
  runtime.setLiveBroadcastSink((item) => {
    if (item.target !== 'origin' || item.originClientId !== 'tab-1') return;
    for (const t of collectListenerTargets(traitIndex, item.source, item.event, item.payload)) {
      progress.push(kernel.dispatchProgress({ event: t.triggers, ...(t.payload !== undefined ? { payload: t.payload } : {}), targetTrait: t.listenerTrait, clientId: 'tab-1' }));
    }
  });
  await kernel.dispatch({ event: 'INIT', targetTrait: 'Chat', clientId: 'tab-1' });
  await kernel.dispatch({ event: 'ASK', targetTrait: 'Chat', clientId: 'tab-1' });
  await Promise.all(progress);
  const frame = store.frames.get(traitIndex.byName.get('Chat')?.frameKey ?? 'Chat');
  return { frame, posted: posted.filter((r) => r.event !== 'INIT') };
}

describe('client-only trait authority (LOLO §7)', () => {
  it('a live step that lands while the call runs stays when the answer arrives', async () => {
    const { frame } = await ask({ onMessage: 'STEP', success: 'REPLIED', failure: 'FAILED' });
    expect(frame?.entries).toEqual(['user', 'step', 'reply']);
    expect(frame?.working).toBe(false);
  });

  it('control: without live messages the answer still lands once', async () => {
    const { frame } = await ask({ success: 'REPLIED', failure: 'FAILED' });
    expect(frame?.entries).toEqual(['user', 'reply']);
    expect(frame?.working).toBe(false);
  });

  it('the leg continues at the off-page listener, never re-running the client-only seed on the server', async () => {
    const { posted } = await ask({ success: 'REPLIED', failure: 'FAILED' });
    expect(posted.map((r) => [r.event, r.targetTrait])).toEqual([['CONVERSE', 'Loop']]);
    expect(posted[0]?.delivery?.event).toBe('SEND');
  });
});
