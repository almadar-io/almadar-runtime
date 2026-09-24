// One `now` stamp per dispatch through the live interpreter; Date.now jumps on every call so a second wall-clock read is visible.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { OrbitalEventResponse, OrbitalSchema } from '@almadar/core';

function schema(): OrbitalSchema {
  return {
    name: 'now-stamp-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Clock',
        pages: [],
        entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [
          {
            name: 'Source',
            scope: 'instance',
            linkedEntity: 'Item',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'GO', name: 'GO' }],
              transitions: [{
                from: 'idle', to: 'idle', event: 'GO',
                guard: ['=', ['time/now'], '@now'],
                effects: [
                  ['set', '@entity.viaOperator', ['time/now']],
                  ['set', '@entity.viaBinding', '@now'],
                  ['emit', 'PING', { at: '@now' }],
                ],
              }],
            },
            emits: [{ event: 'PING', scope: 'external' }],
          },
          {
            name: 'Listener',
            scope: 'instance',
            linkedEntity: 'Item',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'PONG', name: 'PONG' }],
              transitions: [{ from: 'idle', to: 'idle', event: 'PONG', effects: [['set', '@entity.heardAt', '@now']] }],
            },
            listens: [{ event: 'PING', triggers: 'PONG', scope: 'external', source: { kind: 'trait', trait: 'Source' } }],
          },
        ],
      },
    ],
  };
}

let clock = 1_000_000;
afterEach(() => vi.restoreAllMocks());

async function go(runtime: OrbitalServerRuntime): Promise<OrbitalEventResponse> {
  return runtime.processOrbitalEvent('Clock', { event: 'GO', targetTrait: 'Source', payload: {} });
}

function stampsOf(response: OrbitalEventResponse) {
  return {
    viaOperator: response.entityByTrait?.Source?.viaOperator,
    viaBinding: response.entityByTrait?.Source?.viaBinding,
    emitted: response.emittedEvents.find((e) => e.event === 'PING')?.payload?.at,
    heardAt: response.entityByTrait?.Listener?.heardAt,
  };
}

describe('one now stamp per dispatch (live interpreter)', () => {
  it('guard, operator, binding, emit payload and cascaded listener all read the same stamp', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
    await runtime.register(schema());
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));

    const response = await go(runtime);
    expect(response.transitioned).toBe(true);
    const s = stampsOf(response);
    expect(typeof s.viaOperator).toBe('number');
    expect(s.viaBinding).toBe(s.viaOperator);
    expect(s.emitted).toBe(s.viaOperator);
    expect(s.heardAt).toBe(s.viaOperator);
  });

  it('a second dispatch gets its own later stamp', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
    await runtime.register(schema());
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));

    const first = stampsOf(await go(runtime)).viaOperator;
    const second = stampsOf(await go(runtime)).viaOperator;
    expect(typeof first).toBe('number');
    expect(second).toBeGreaterThan(first as number);
  });
});
