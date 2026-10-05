/**
 * The browser host is a program's server leg (an extension's worker), so it runs the program's ticks:
 * each firing is its own request in the host's queue, so a view's request is served between firings
 * rather than after a whole loop. This host runs ticks whose effects emit events.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { EventPayload, OrbitalSchema, OrbitalEventRequest, TraitTick } from '@almadar/core';
import { asTraitId, isInlineTrait } from '@almadar/core';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';

const counter = { name: 'Counter', persistence: 'runtime' as const, fields: [{ name: 'id', type: 'string' as const, required: true }, { name: 'n', type: 'number' as const, default: 0 }] };

function program(ticks: TraitTick[]): OrbitalSchema {
  return {
    name: 'Loop',
    orbitals: [{
      name: 'Loop',
      entity: counter,
      traits: [{
        name: 'Stepper', linkedEntity: 'Counter', category: 'interaction', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
          events: [{ key: 'STEP', name: 'STEP' }, { key: 'STEPPED', name: 'STEPPED' }, { key: 'PING', name: 'PING' }, { key: 'FINISH', name: 'FINISH' }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'STEP', effects: [['set', '@entity.n', ['+', '@entity.n', 1]], ['call-service', 'slow', 'work', {}, { emit: { success: 'STEPPED', failure: 'STEPPED' } }]] },
            { from: 'idle', to: 'idle', event: 'STEPPED', effects: [] },
            { from: 'idle', to: 'idle', event: 'PING', effects: [] },
            { from: 'idle', to: 'done', event: 'FINISH', effects: [] },
          ],
        },
        ticks,
      }],
      pages: [],
    }],
  };
}

const slow = async (): Promise<EventPayload> => {
  await new Promise((r) => setTimeout(r, 40));
  return {};
};
const db = () => `ticks-${Math.random()}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hosts: BrowserHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.close()));

describe('openBrowserHost ticks', () => {
  it('fires a tick as its own request and shows its result to listening views', async () => {
    const host = await openBrowserHost({ databaseName: db(), schema: program([{ name: 'finish', interval: 20, guard: ['=', '@state', 'idle'], effects: [['emit', 'FINISH']] }]), callService: slow });
    hosts.push(host);
    const seen: OrbitalEventRequest[] = [];
    host.onInputDispatched((_o, request) => seen.push(request));
    await host.send('Loop', { event: 'INIT', targetTrait: 'Stepper', payload: {} });
    await wait(150);
    expect(seen.map((r) => r.event)).toContain('FINISH');
    expect((await host.send('Loop', { event: 'PING', payload: {} })).transitioned).toBe(false);
  });

  it('a view request is served between firings, not after the whole loop', async () => {
    const host = await openBrowserHost({ databaseName: db(), schema: program([{ name: 'step', interval: 10, guard: ['<', '@entity.n', 20], effects: [['emit', 'STEP']] }]), callService: slow });
    hosts.push(host);
    let steps = 0;
    host.onInputDispatched((_o, request) => { if (request.event === 'STEP') steps++; });
    await host.send('Loop', { event: 'INIT', targetTrait: 'Stepper', payload: {} });
    await wait(60);
    const before = steps;
    const reply = await host.send('Loop', { event: 'PING', payload: {} });
    expect(reply.success).toBe(true);
    expect(steps - before).toBeLessThanOrEqual(2);
    expect(steps).toBeLessThan(20);
  });

  it('a view request waits for at most the background step that is running, never for queued background work', async () => {
    const host = await openBrowserHost({ databaseName: db(), schema: program([{ name: 'step', interval: 5, guard: ['<', '@entity.n', 50], effects: [['emit', 'STEP']] }]), callService: slow });
    hosts.push(host);
    await host.send('Loop', { event: 'INIT', targetTrait: 'Stepper', payload: {} });
    await wait(200);
    const started = Date.now();
    await Promise.all([1, 2, 3].map(() => host.send('Loop', { event: 'PING', payload: {} })));
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('control: a tick whose guard does not hold does not fire', async () => {
    const host = await openBrowserHost({ databaseName: db(), schema: program([{ name: 'finish', interval: 20, guard: ['=', '@state', 'done'], effects: [['emit', 'FINISH']] }]), callService: slow });
    hosts.push(host);
    const seen: string[] = [];
    host.onInputDispatched((_o, request) => seen.push(request.event));
    await host.send('Loop', { event: 'INIT', targetTrait: 'Stepper', payload: {} });
    await wait(120);
    expect(seen).toEqual([]);
  });

  it('edge: a tick with an effect other than emit is refused when the host opens, naming it', async () => {
    await expect(openBrowserHost({ databaseName: db(), schema: program([{ name: 'bump', interval: 20, effects: [['set', '@entity.n', 1]] }]), callService: slow }))
      .rejects.toThrow(/Loop\.Stepper tick 'bump'.*'set'/);
  });

  it('edge: close stops the ticks', async () => {
    const host = await openBrowserHost({ databaseName: db(), schema: program([{ name: 'step', interval: 10, effects: [['emit', 'STEP']] }]), callService: async () => ({}) });
    let steps = 0;
    host.onInputDispatched(() => { steps++; });
    await host.send('Loop', { event: 'INIT', targetTrait: 'Stepper', payload: {} });
    host.close();
    await wait(30);
    const after = steps;
    await wait(80);
    expect(steps).toBe(after);
  });
});

describe('openBrowserHost ticks: listeners', () => {
  const clockProgram: OrbitalSchema = {
    name: 'Clocked',
    orbitals: [{
      name: 'Clocked',
      entity: counter,
      traits: [
        {
          name: 'Clock', linkedEntity: 'Counter', category: 'lifecycle', scope: 'instance',
          stateMachine: { states: [{ name: 'running', isInitial: true }], events: [{ key: 'INIT', name: 'INIT' }], transitions: [{ from: 'running', to: 'running', event: 'INIT', effects: [] }] },
          emits: [{ event: 'TICKED', scope: 'internal' }],
          ticks: [{ name: 'beat', interval: 20, effects: [['emit', 'TICKED']] }],
        },
        {
          name: 'Worker', linkedEntity: 'Counter', category: 'interaction', scope: 'instance',
          stateMachine: {
            states: [{ name: 'waiting', isInitial: true }, { name: 'woken' }],
            events: [{ key: 'WAKE', name: 'WAKE' }],
            transitions: [{ from: 'waiting', to: 'woken', event: 'WAKE', effects: [] }],
          },
          listens: [{ event: 'TICKED', source: { kind: 'trait', trait: 'Clock' }, triggers: 'WAKE' }],
        },
      ],
      pages: [],
    }],
  };

  it('a tick emit reaches the traits that listen for it, as the event they map it to', async () => {
    const host = await openBrowserHost({ databaseName: db(), schema: clockProgram, callService: slow });
    hosts.push(host);
    const delivered: Array<{ event: string; trait?: string }> = [];
    host.onInputDispatched((_o, request) => delivered.push({ event: request.event, ...(request.targetTrait !== undefined ? { trait: request.targetTrait } : {}) }));
    await wait(80);
    expect(delivered).toContainEqual({ event: 'WAKE', trait: 'Worker' });
  });

  it('reaches a listener that names its emitter by id, as compiled programs do', async () => {
    const [clock, worker] = clockProgram.orbitals[0].traits;
    if (!isInlineTrait(clock) || !isInlineTrait(worker)) throw new Error('fixture: Clock and Worker are inline');
    const compiled: OrbitalSchema = {
      ...clockProgram,
      name: 'Compiled',
      orbitals: [{
        ...clockProgram.orbitals[0],
        traits: [
          { ...clock, id: asTraitId('trt_CLOCK') },
          { ...worker, id: asTraitId('trt_WORKER'), listens: [{ event: 'TICKED', source: { kind: 'trait', trait: 'Clock', traitId: asTraitId('trt_CLOCK') }, triggers: 'WAKE' }] },
        ],
      }],
    };
    const host = await openBrowserHost({ databaseName: db(), schema: compiled, callService: slow });
    hosts.push(host);
    const delivered: string[] = [];
    host.onInputDispatched((_o, request) => delivered.push(`${request.event}>${request.targetTrait ?? ''}`));
    await wait(80);
    expect(delivered).toContain('WAKE>Worker');
  });

  it('control: an emit no trait listens for and the ticker does not handle dispatches nothing', async () => {
    const quiet: OrbitalSchema = { ...clockProgram, name: 'Quiet', orbitals: [{ ...clockProgram.orbitals[0], traits: [clockProgram.orbitals[0].traits[0]] }] };
    const host = await openBrowserHost({ databaseName: db(), schema: quiet, callService: slow });
    hosts.push(host);
    const delivered: string[] = [];
    host.onInputDispatched((_o, request) => delivered.push(request.event));
    await wait(80);
    expect(delivered).toEqual([]);
  });
});
