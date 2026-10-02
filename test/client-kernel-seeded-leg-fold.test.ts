/**
 * A client-only trait's leg is seeded with its pre-dispatch state so the
 * server can re-run the arm; the cascade that follows may move a field the
 * local arm just changed back to its pre-dispatch value (a `working` flag set
 * by ASK and cleared by the reply). The fold must apply the server's final
 * value whenever it differs from what the client shows after its local run —
 * not drop it for matching the pre-dispatch carry.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { buildTraitIndex, createClientKernel, createMemoryCircuitStore, createInProcessTransport } from '../src/index.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

function schema(answers: boolean, storeTouchesServer = true): OrbitalSchema {
  return {
    name: 'SeededFoldApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'ChatOrbital',
        entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }, { name: 'text', type: 'string' }] },
        auxiliaryEntities: [
          { name: 'ChatView', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'working', type: 'boolean', default: false }, { name: 'asked', type: 'number', default: 0 }] },
        ],
        traits: [
          {
            name: 'Chat',
            scope: 'instance',
            linkedEntity: 'ChatView',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'ASK', name: 'Ask' }, { key: 'DONE', name: 'Done' }],
              transitions: [
                { from: 'idle', to: 'idle', event: 'ASK', effects: [['set', '@entity.working', true], ['set', '@entity.asked', ['+', '@entity.asked', 1]], ['emit', 'SEND']] },
                { from: 'idle', to: 'idle', event: 'DONE', effects: [['set', '@entity.working', false]] },
              ],
            },
            emits: [{ event: 'SEND', scope: 'internal' }],
            listens: [{ event: 'DONE', triggers: 'DONE', source: { kind: 'trait', trait: 'Store' } }],
          },
          {
            name: 'Store',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'SEND', name: 'Send' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'SEND', effects: storeTouchesServer ? [['persist', 'create', 'Note', { text: 'hi' }, answers ? { emit: { success: 'DONE' } } : {}]] : (answers ? [['emit', 'DONE']] : []) }],
            },
            emits: answers ? [{ event: 'DONE', scope: 'internal' }] : [],
            listens: [{ event: 'SEND', triggers: 'SEND', source: { kind: 'trait', trait: 'Chat' } }],
          },
        ],
        pages: [],
      },
    ],
  };
}

async function run(answers: boolean, storeTouchesServer = true) {
  const s = schema(answers, storeTouchesServer);
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(s);
  const transport = createInProcessTransport(async (o: string, r: OrbitalEventRequest): Promise<OrbitalEventResponse> => runtime.processOrbitalEvent(o, r));
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const kernel = createClientKernel({ orbitalName: 'ChatOrbital', traitIndex, store, carriesCircuitState: false, transport });
  await kernel.dispatch({ event: 'INIT', targetTrait: 'Chat' });
  await kernel.dispatch({ event: 'ASK', targetTrait: 'Chat' });
  const frameKey = traitIndex.byName.get('Chat')?.frameKey ?? 'Chat';
  return store.frames.get(frameKey);
}

describe('client kernel — seeded leg fold', () => {
  it('a field the cascade moves back to its pre-dispatch value ends at the server value', async () => {
    const frame = await run(true);
    expect(frame?.working).toBe(false);
    expect(frame?.asked).toBe(1);
  });

  it('control: with no cascade back, the local arm\'s value stands', async () => {
    const frame = await run(false);
    expect(frame?.working).toBe(true);
    expect(frame?.asked).toBe(1);
  });

  it('a fully local cascade that replies to the trait that started it reaches that trait', async () => {
    const frame = await run(true, false);
    expect(frame?.working).toBe(false);
  });

  it('control: the started trait does not re-run the event it already handled', async () => {
    const frame = await run(true, false);
    expect(frame?.asked).toBe(1);
  });
});
