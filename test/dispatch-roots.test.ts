// Runtime Spec Clauses 3.3 + 5.5: the dispatch roots and the commit point on the real OrbitalServerRuntime.
// Twin of orbital-core `tests/dispatch_roots.rs`.
import { describe, it, expect } from 'vitest';
import type { OrbitalEventResponse, OrbitalSchema, SExpr, Trait, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const fromSrc = { kind: 'trait' as const, trait: 'Src' };
const once: SExpr = ['not', ['array/includes', ['array/map', '@prevEvents', ['fn', 'e', ['object/get', '@e', 'event']]], 'X']];

function listener(name: string, ack: string, guard?: SExpr): Trait {
  return {
    name,
    scope: 'instance' as const,
    emits: [{ event: ack }],
    listens: [{ event: 'X', triggers: 'GOT', source: fromSrc, ...(guard !== undefined ? { guard } : {}) }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'GOT', name: 'GOT' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'GOT', effects: [['emit', ack, { n: '@payload.n' }]] }],
    },
  };
}

const provAck: TypedEffect[] = [['emit', 'ACK_PROV', {
  srcTrait: '@event.source.trait', srcEvent: '@event.event', srcN: '@event.payload.n',
  from: '@fromState', to: '@toState', state: '@state', seen: ['array/len', '@prevEvents'],
}]];

function schema(): OrbitalSchema {
  return {
    name: 'dispatch-roots-app',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [
        {
          name: 'Src', scope: 'instance', emits: [{ event: 'X' }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }], events: [{ key: 'GO', name: 'GO' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'GO',
              effects: [['emit', 'X', { n: 1 }], ['emit', 'X', { n: 2 }], ['emit', 'X', { n: 3 }]] }],
          },
        },
        listener('Once', 'ACK_ONCE', once),
        listener('Twin', 'ACK_TWIN', once),
        listener('All', 'ACK_ALL'),
        {
          name: 'Prov', scope: 'instance', emits: [{ event: 'ACK_PROV' }],
          listens: [{ event: 'X', triggers: 'GOT', source: fromSrc }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'seen' }], events: [{ key: 'GOT', name: 'GOT' }],
            transitions: [
              { from: 'idle', to: 'seen', event: 'GOT',
                guard: ['and', ['=', '@fromState', 'idle'], ['=', '@toState', 'seen'], ['=', '@state', 'idle']], effects: provAck },
              { from: 'seen', to: 'seen', event: 'GOT', effects: provAck },
            ],
          },
        },
        {
          name: 'Reenter', scope: 'instance', emits: [{ event: 'ACK_R' }],
          listens: [{ event: 'X', triggers: 'STEP', source: fromSrc }],
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'processing' }], events: [{ key: 'STEP', name: 'STEP' }],
            transitions: [
              { from: 'idle', to: 'processing', event: 'STEP', guard: ['not', ['array/includes', '@prevStates', 'processing']],
                effects: [['emit', 'ACK_R', { to: '@toState' }]] },
              { from: 'processing', to: 'idle', event: 'STEP', effects: [['emit', 'ACK_R', { to: '@toState' }]] },
            ],
          },
        },
      ],
    }],
  };
}

async function dispatchGo(runtime?: OrbitalServerRuntime): Promise<OrbitalEventResponse> {
  const rt = runtime ?? new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  if (runtime === undefined) await rt.register(schema());
  return rt.processOrbitalEvent('Main', { event: 'GO', targetTrait: 'Src' });
}

const payloads = (r: OrbitalEventResponse, event: string) =>
  r.emittedEvents.filter((e) => e.event === event).map((e) => e.payload ?? {});

describe('dispatch roots on the runtime path', () => {
  it('"once" in a listen `when` admits only the first of three deliveries; the unguarded control gets all three', async () => {
    const r = await dispatchGo();
    expect(payloads(r, 'ACK_ONCE')).toEqual([{ n: 1 }]);
    expect(payloads(r, 'ACK_ALL')).toHaveLength(3);
  });

  it('each listener keeps its own log: a twin with the same guard also gets its first delivery', async () => {
    expect(payloads(await dispatchGo(), 'ACK_TWIN')).toEqual([{ n: 1 }]);
  });

  it('@event is the source emit; guards read pre-commit, effects post-commit; the log grows per delivery', async () => {
    expect(payloads(await dispatchGo(), 'ACK_PROV')).toEqual([
      { srcTrait: 'Src', srcEvent: 'X', srcN: 1, from: 'idle', to: 'seen', state: 'seen', seen: 0 },
      { srcTrait: 'Src', srcEvent: 'X', srcN: 2, from: 'seen', to: 'seen', state: 'seen', seen: 1 },
      { srcTrait: 'Src', srcEvent: 'X', srcN: 3, from: 'seen', to: 'seen', state: 'seen', seen: 2 },
    ]);
  });

  it('@prevStates blocks re-entry into a state the trait already left this dispatch', async () => {
    expect(payloads(await dispatchGo(), 'ACK_R')).toEqual([{ to: 'processing' }, { to: 'idle' }]);
  });

  it('the memory dies with the dispatch: the next dispatch starts with an empty log', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema());
    expect(payloads(await dispatchGo(rt), 'ACK_ONCE')).toEqual([{ n: 1 }]);
    expect(payloads(await dispatchGo(rt), 'ACK_ONCE')).toEqual([{ n: 1 }]);
  });
});

function crossOrbital(): OrbitalSchema {
  const responder = (name: string, ack: string, guard?: SExpr): Trait => ({
    name,
    scope: 'instance' as const,
    emits: [{ event: ack, scope: 'external' as const }],
    listens: [{ event: 'ASK', triggers: 'HEARD', source: { kind: 'any' as const }, ...(guard !== undefined ? { guard } : {}) }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }], events: [{ key: 'HEARD', name: 'HEARD' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'HEARD', effects: [
        ['set', '@entity.srcOrbital', '@event.source.orbital'],
        ['set', '@entity.srcTrait', '@event.source.trait'],
        ['set', '@entity.ev', '@event.event'],
        ['set', '@entity.q', '@event.payload.q'],
        ['set', '@entity.seen', ['array/len', '@prevEvents']],
      ] }],
    },
  });
  return {
    name: 'cross-orbital-roots',
    version: '1.0.0',
    orbitals: [
      {
        name: 'AskOrbital', pages: [],
        entity: { name: 'Question', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
        traits: [{
          name: 'Asker', scope: 'instance', emits: [{ event: 'ASK', scope: 'external' }],
          stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [{ key: 'GO', name: 'GO' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'GO', effects: [['emit', 'ASK', { q: 7 }]] }] },
        }],
      },
      {
        name: 'AnswerOrbital', pages: [],
        entity: { name: 'Answer', persistence: 'runtime', fields: [
          { name: 'id', type: 'string', required: true }, { name: 'srcOrbital', type: 'string' }, { name: 'srcTrait', type: 'string' },
          { name: 'ev', type: 'string' }, { name: 'q', type: 'number' }, { name: 'seen', type: 'number' },
        ] },
        traits: [
          responder('Answerer', 'ECHO'),
          responder('FromAsker', 'ECHO_ASKER', ['=', '@event.source.trait', 'Asker']),
          responder('FromNobody', 'ECHO_NOBODY', ['=', '@event.source.trait', 'Nobody']),
        ],
      },
    ],
  };
}

describe('dispatch roots across the stateful cross-orbital relay', () => {
  it('a relayed delivery sees the originating emit as @event, with a fresh log', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(crossOrbital());
    const r = await rt.processOrbitalEvent('AskOrbital', { event: 'GO', targetTrait: 'Asker' });
    const echo = { srcOrbital: 'AskOrbital', srcTrait: 'Asker', ev: 'ASK', q: 7, seen: 0 };
    expect(r.entityByTrait?.['Answerer']).toMatchObject(echo);
    expect(r.entityByTrait?.['FromAsker']).toMatchObject(echo);
    expect(r.entityByTrait?.['FromNobody']?.['srcTrait']).toBeUndefined();
  });
});

describe('a request continuing a client-begun dispatch', () => {
  it('reads @event and the log from the request', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema());
    const r = await rt.processOrbitalEvent('Main', {
      event: 'GOT',
      targetTrait: 'Prov',
      payload: { n: 5 },
      delivery: { event: 'X', payload: { n: 5 }, source: { orbital: 'Main', trait: 'Src' } },
      dispatchLog: { prevEvents: [{ event: 'X', payload: { n: 4 }, source: { trait: 'Src' } }], prevStates: [] },
    });
    expect(payloads(r, 'ACK_PROV')).toEqual([
      { srcTrait: 'Src', srcEvent: 'X', srcN: 5, from: 'idle', to: 'seen', state: 'seen', seen: 1 },
    ]);
  });

  it('without them the request is a direct dispatch', async () => {
    const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
    await rt.register(schema());
    const r = await rt.processOrbitalEvent('Main', { event: 'GOT', targetTrait: 'Prov', payload: { n: 5 } });
    expect(payloads(r, 'ACK_PROV')).toMatchObject([{ srcEvent: 'GOT', srcN: 5, seen: 0 }]);
    expect(payloads(r, 'ACK_PROV')[0]?.['srcTrait']).toBeUndefined();
  });
});
