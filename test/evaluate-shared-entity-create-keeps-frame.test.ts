/**
 * std-realtime-chat: the first message sent, the second rejected until the
 * page was left and re-entered. ChatMessage is `[shared]` — ONE working
 * instance across its bound traits (the composer's open conversation and
 * draft). The persistor's `persist create` wrote a NEW record, and the step
 * adopted that record's id as the trait's address, so the shared instance
 * itself became "message #N": the next SEND's round-tripped row carried that
 * id, the server read the stored message instead of the working frame, and
 * the `activeChannel && draft` guard failed. A create on a shared entity
 * records a row; it never re-addresses the shared instance. A non-shared
 * trait that mints its own row still adopts it.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalId, OrbitalSchema } from '@almadar/core';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import {
  buildTraitIndex,
  createClientKernel,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  evaluateOrbitalEvent,
  StateMachineManager,
} from '../src/index.js';

function chatSchema(): OrbitalSchema {
  return {
    name: 'shared-create',
    version: '1.0.0',
    orbitals: [{
      name: 'ChatOrbital',
      id: 'orb_chat' as OrbitalId,
      pages: [],
      entity: {
        name: 'Message',
        persistence: 'persistent',
        shared: true,
        fields: [
          { name: 'id', type: 'string' },
          { name: 'content', type: 'string' },
          { name: 'draft', type: 'string', intrinsic: true },
        ],
      },
      traits: [
        {
          name: 'Composer',
          linkedEntity: 'Message',
          scope: 'instance',
          local: true,
          stateMachine: {
            states: [{ name: 'ready', isInitial: true }],
            events: [],
            transitions: [
              { from: 'ready', to: 'ready', event: 'DRAFT', effects: [['set', '@entity.draft', '@payload.value']] },
              {
                from: 'ready', to: 'ready', event: 'SEND', guard: ['!=', ['str/default', '@entity.draft', ''], ''],
                effects: [['emit', 'SAVE', { content: '@entity.draft' }], ['set', '@entity.draft', '']],
              },
            ],
          },
        },
        {
          name: 'Persistor',
          linkedEntity: 'Message',
          scope: 'instance',
          listens: [{ event: 'SAVE', source: { kind: 'trait', trait: 'Composer' }, triggers: 'DO_CREATE' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'DO_CREATE', effects: [['persist', 'create', 'Message', { content: '@payload.content' }]] }],
          },
        },
      ],
    }],
  } as OrbitalSchema;
}

function ownRowSchema(): OrbitalSchema {
  return {
    name: 'own-row-create',
    version: '1.0.0',
    orbitals: [{
      name: 'NoteOrbital',
      id: 'orb_note' as OrbitalId,
      pages: [],
      entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }] },
      traits: [{
        name: 'NoteEditor',
        linkedEntity: 'Note',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [],
          transitions: [{ from: 'idle', to: 'idle', event: 'CREATE', effects: [['persist', 'create', 'Note', { title: 'first' }]] }],
        },
      }],
    }],
  } as OrbitalSchema;
}

async function serverRun(s: OrbitalSchema, persistence: InMemoryPersistence, request: Parameters<typeof evaluateOrbitalEvent>[1]) {
  const traitIndex = buildTraitIndex(s.orbitals);
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const frames = new Map<string, EntityRow>();
  return evaluateOrbitalEvent(
    { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) },
    request,
  );
}

describe('persist create on a [shared] entity', () => {
  it('the created record does not become the shared instance', async () => {
    const persistence = new InMemoryPersistence();
    const response = await serverRun(chatSchema(), persistence, {
      event: 'SEND',
      targetTrait: 'Composer',
      traits: [{ trait: 'Composer', from: 'ready' }],
      entityByTrait: { Composer: { draft: 'hi' } },
    });
    expect((await persistence.list('Message')).map((r) => r['content'])).toEqual(['hi']);
    for (const row of Object.values(response.entityByTrait ?? {})) {
      expect(row['id']).toBeUndefined();
      expect(row['content']).toBeUndefined();
    }
  });

  it('two messages in a row both persist (stateless client kernel)', async () => {
    const s = chatSchema();
    const persistence = new InMemoryPersistence();
    const traitIndex = buildTraitIndex(s.orbitals);
    const kernel = createClientKernel({
      orbitalName: 'ChatOrbital',
      traitIndex,
      store: createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef)),
      carriesCircuitState: true,
      transport: createInProcessTransport((_o, request) => serverRun(s, persistence, request), { carriesCircuitState: true }),
    });
    for (const text of ['first', 'second']) {
      await kernel.dispatch({ event: 'DRAFT', targetTrait: 'Composer', payload: { value: text } });
      await kernel.dispatch({ event: 'SEND', targetTrait: 'Composer' });
    }
    expect((await persistence.list('Message')).map((r) => r['content']).sort()).toEqual(['first', 'second']);
  });

  it('control: a non-shared trait that mints its own row adopts it', async () => {
    const persistence = new InMemoryPersistence();
    const response = await serverRun(ownRowSchema(), persistence, { event: 'CREATE', targetTrait: 'NoteEditor' });
    const [created] = await persistence.list('Note');
    expect(response.entityByTrait?.['NoteEditor']?.['id']).toBe(created?.['id']);
  });
});
