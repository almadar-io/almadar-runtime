/**
 * A `call-service` in a follow-on step (a listener's arm, or the calling trait's own next
 * step) never holds the request that caused it: the request answers with that step's state and
 * screen, and the call's outcome runs later as its own dispatch, handed to the host-dispatch
 * sink for the requesting tab. A request's own call still answers in that request.
 */
import { describe, expect, it } from 'vitest';
import type { OrbitalSchema, Trait, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime, type HostDispatchItem } from '../src/server/OrbitalServerRuntime.js';

const render = (text: string): TypedEffect => ['render-ui', 'main', { type: 'typography', content: text }];
const slowCall: TypedEffect = ['call-service', 'svc', 'work', {}, { emit: { success: 'ANSWERED', failure: 'ANSWER_FAILED' } }];

const starter: Trait = {
  name: 'Starter', scope: 'instance', linkedEntity: 'Job',
  emits: [{ event: 'PING', scope: 'internal' }],
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }, { name: 'started' }],
    events: [{ key: 'SUBMIT', name: 'SUBMIT' }],
    transitions: [{ from: 'idle', to: 'started', event: 'SUBMIT', effects: [['emit', 'PING'], render('started')] }],
  },
};

const helper: Trait = {
  name: 'Helper', scope: 'instance', linkedEntity: 'Job',
  listens: [{ event: 'PING', source: { kind: 'trait', trait: 'Starter' }, triggers: 'ASK' }],
  emits: [{ event: 'ANSWERED', scope: 'internal' }, { event: 'ANSWER_FAILED', scope: 'internal' }],
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }, { name: 'asking' }, { name: 'done' }, { name: 'failed' }],
    events: [{ key: 'ASK', name: 'ASK' }, { key: 'ANSWERED', name: 'ANSWERED' }, { key: 'ANSWER_FAILED', name: 'ANSWER_FAILED' }],
    transitions: [
      { from: 'idle', to: 'asking', event: 'ASK', effects: [slowCall, render('asking')] },
      { from: 'asking', to: 'done', event: 'ANSWERED', effects: [render('done')] },
      { from: 'asking', to: 'failed', event: 'ANSWER_FAILED', effects: [render('failed')] },
    ],
  },
};

const keyedCall: TypedEffect = ['call-service', 'svc', 'work', {}, { key: 'job', emit: { success: 'ANSWERED', failure: 'ANSWER_FAILED', cancelled: 'STOPPED' } }];

const keyed: Trait = {
  name: 'Keyed', scope: 'instance', linkedEntity: 'Job',
  emits: [{ event: 'NEXT', scope: 'internal' }, { event: 'ANSWERED', scope: 'internal' }, { event: 'ANSWER_FAILED', scope: 'internal' }, { event: 'STOPPED', scope: 'internal' }],
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }, { name: 'first' }, { name: 'building' }, { name: 'stopped' }],
    events: [{ key: 'GO', name: 'GO' }, { key: 'NEXT', name: 'NEXT' }, { key: 'STOP', name: 'STOP' }, { key: 'ANSWERED', name: 'ANSWERED' }, { key: 'ANSWER_FAILED', name: 'ANSWER_FAILED' }, { key: 'STOPPED', name: 'STOPPED' }],
    transitions: [
      { from: 'idle', to: 'first', event: 'GO', effects: [['emit', 'NEXT']] },
      { from: 'first', to: 'building', event: 'NEXT', effects: [keyedCall] },
      { from: 'building', to: 'building', event: 'STOP', effects: [['cancel-call', 'job']] },
      { from: 'building', to: 'stopped', event: 'STOPPED', effects: [render('stopped')] },
    ],
  },
};

const chain: Trait = {
  name: 'Chain', scope: 'instance', linkedEntity: 'Job',
  emits: [{ event: 'NEXT', scope: 'internal' }, { event: 'ANSWERED', scope: 'internal' }, { event: 'ANSWER_FAILED', scope: 'internal' }],
  stateMachine: {
    states: [{ name: 'idle', isInitial: true }, { name: 'first' }, { name: 'building' }, { name: 'built' }],
    events: [{ key: 'GO', name: 'GO' }, { key: 'NEXT', name: 'NEXT' }, { key: 'ANSWERED', name: 'ANSWERED' }, { key: 'ANSWER_FAILED', name: 'ANSWER_FAILED' }],
    transitions: [
      { from: 'idle', to: 'first', event: 'GO', effects: [['emit', 'NEXT']] },
      { from: 'first', to: 'building', event: 'NEXT', effects: [slowCall, render('building')] },
      { from: 'building', to: 'built', event: 'ANSWERED', effects: [render('built')] },
    ],
  },
};

const schema = (): OrbitalSchema => ({
  name: 'deferred',
  version: '1.0.0',
  orbitals: [{
    name: 'App',
    pages: [],
    entity: { name: 'Job', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
    traits: [starter, helper, chain, keyed],
  }],
});

function gatedRuntime(outcome: 'resolve' | 'reject' = 'resolve') {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const runtime = new OrbitalServerRuntime({
    mode: 'real',
    debug: false,
    effectHandlers: {
      callService: async () => {
        await gate;
        if (outcome === 'reject') throw new Error('model down');
        return { answer: 42 };
      },
    },
  });
  const dispatched: HostDispatchItem[] = [];
  let notify: () => void = () => {};
  const arrived = new Promise<void>((r) => { notify = r; });
  runtime.setHostDispatchSink((item) => { dispatched.push(item); notify(); });
  return { runtime, release, dispatched, arrived };
}

const rendered = (texts: unknown[] | undefined) => (texts ?? []).flatMap((e) => (Array.isArray(e) && e[0] === 'render-ui' ? [(e[2] as { content?: string }).content] : []));

describe('a call in a follow-on step', () => {
  it('a listener\'s call does not hold the request; its outcome arrives as its own dispatch', async () => {
    const { runtime, release, dispatched, arrived } = gatedRuntime();
    await runtime.register(schema());
    const response = await runtime.processOrbitalEvent('App', { event: 'SUBMIT', targetTrait: 'Starter', clientId: 'tab-1' });
    expect(response.states).toMatchObject({ Starter: 'started', Helper: 'asking' });
    expect(dispatched).toEqual([]);
    release();
    await arrived;
    expect(dispatched[0]).toMatchObject({ orbitalName: 'App', originClientId: 'tab-1', request: { event: 'ANSWERED', targetTrait: 'Helper' } });
    expect(dispatched[0]?.response.states).toMatchObject({ Helper: 'done' });
    expect(rendered(dispatched[0]?.response.clientEffects)).toContain('done');
  });

  it('the calling trait\'s own next step is a follow-on too', async () => {
    const { runtime, release, dispatched, arrived } = gatedRuntime();
    await runtime.register(schema());
    const response = await runtime.processOrbitalEvent('App', { event: 'GO', targetTrait: 'Chain', clientId: 'tab-1' });
    expect(response.states).toMatchObject({ Chain: 'building' });
    expect(rendered(response.clientEffects)).toContain('building');
    release();
    await arrived;
    expect(dispatched[0]?.response.states).toMatchObject({ Chain: 'built' });
  });

  it('control: a request\'s own call still answers in that request', async () => {
    const { runtime, release, dispatched } = gatedRuntime();
    await runtime.register(schema());
    let answered = false;
    const pending = runtime.processOrbitalEvent('App', { event: 'ASK', targetTrait: 'Helper', clientId: 'tab-1' }).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBe(false);
    release();
    const response = await pending;
    expect(response.states).toMatchObject({ Helper: 'done' });
    expect(dispatched).toEqual([]);
  });

  it('edge: a failed follow-on call arrives as its failure event', async () => {
    const { runtime, release, dispatched, arrived } = gatedRuntime('reject');
    await runtime.register(schema());
    await runtime.processOrbitalEvent('App', { event: 'SUBMIT', targetTrait: 'Starter', clientId: 'tab-1' });
    release();
    await arrived;
    expect(dispatched[0]?.request).toMatchObject({ event: 'ANSWER_FAILED', targetTrait: 'Helper' });
    expect(dispatched[0]?.response.states).toMatchObject({ Helper: 'failed' });
  });

  it('edge: a cancelled keyed follow-on call arrives as its cancelled event', async () => {
    const { runtime, dispatched, arrived } = gatedRuntime();
    await runtime.register(schema());
    const response = await runtime.processOrbitalEvent('App', { event: 'GO', targetTrait: 'Keyed', clientId: 'tab-1' });
    expect(response.states).toMatchObject({ Keyed: 'building' });
    await runtime.processOrbitalEvent('App', { event: 'STOP', targetTrait: 'Keyed', clientId: 'tab-1' });
    await arrived;
    expect(dispatched[0]?.request).toMatchObject({ event: 'STOPPED', targetTrait: 'Keyed', payload: { key: 'job' } });
    expect(dispatched[0]?.response.states).toMatchObject({ Keyed: 'stopped' });
  });

  it('control: a host with no host-dispatch sink keeps the call in the request (nowhere to deliver its outcome)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const runtime = new OrbitalServerRuntime({ mode: 'real', debug: false, effectHandlers: { callService: async () => { await gate; return { answer: 1 }; } } });
    await runtime.register(schema());
    let answered = false;
    const pending = runtime.processOrbitalEvent('App', { event: 'SUBMIT', targetTrait: 'Starter', clientId: 'tab-1' }).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBe(false);
    release();
    expect((await pending).states).toMatchObject({ Helper: 'done' });
  });
});

