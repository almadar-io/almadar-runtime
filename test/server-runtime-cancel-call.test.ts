// The in-flight call registry is per OrbitalServerRuntime: a `cancel-call` dispatched while a keyed
// call-service is in flight (released from the event queue) aborts it; another runtime's calls are untouched.
import { describe, it, expect } from 'vitest';
import type { EventPayload, OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { ServiceCallContext } from '../src/types.js';

const schema: OrbitalSchema = {
  name: 'cancel-app',
  version: '1.0.0',
  orbitals: [{
    name: 'JobOrbital',
    pages: [],
    entity: { name: 'Job', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
    traits: [{
      name: 'Runner',
      scope: 'instance',
      linkedEntity: 'Job',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'START', name: 'Start' }, { key: 'STOP', name: 'Stop' }, { key: 'DONE', name: 'Done' }, { key: 'CANCELLED', name: 'Cancelled' }],
        transitions: [
          { from: 'idle', to: 'idle', event: 'START', effects: [['call-service', 'work', 'run', {}, { key: 'job', emit: { success: 'DONE', cancelled: 'CANCELLED' } }]] },
          { from: 'idle', to: 'idle', event: 'STOP', effects: [['cancel-call', 'job']] },
          { from: 'idle', to: 'idle', event: 'DONE' },
          { from: 'idle', to: 'idle', event: 'CANCELLED' },
        ],
      },
    }],
  }],
};

function runtimeWith(signals: Array<AbortSignal | undefined>, finishers: Array<(v: EventPayload) => void>) {
  return new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    effectHandlers: {
      callService: (_s, _a, _p, context?: ServiceCallContext) =>
        new Promise<EventPayload | null>((resolve, reject) => {
          signals.push(context?.signal);
          finishers.push(resolve);
          context?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    },
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OrbitalServerRuntime cancel-call', () => {
  it('a STOP dispatched mid-call aborts the call started by START, which routes to cancelled with { key }', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const runtime = runtimeWith(signals, []);
    await runtime.register(schema);
    const start = runtime.processOrbitalEvent('JobOrbital', { event: 'START', targetTrait: 'Runner' });
    await wait(20);
    await runtime.processOrbitalEvent('JobOrbital', { event: 'STOP', targetTrait: 'Runner' });
    const res = await start;
    expect(signals[0]?.aborted).toBe(true);
    expect(res.emittedEvents.map((e) => e.event)).toEqual(['CANCELLED']);
    expect(res.emittedEvents[0].payload).toEqual({ key: 'job' });
  });

  it('control: another runtime instance has its own registry, so its STOP cancels nothing here', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const finishers: Array<(v: EventPayload) => void> = [];
    const runtime = runtimeWith(signals, finishers);
    const other = runtimeWith([], []);
    await runtime.register(schema);
    await other.register(schema);
    const start = runtime.processOrbitalEvent('JobOrbital', { event: 'START', targetTrait: 'Runner' });
    await wait(20);
    await other.processOrbitalEvent('JobOrbital', { event: 'STOP', targetTrait: 'Runner' });
    expect(signals[0]?.aborted).toBe(false);
    finishers[0]({});
    expect((await start).emittedEvents.map((e) => e.event)).toEqual(['DONE']);
  });
});
