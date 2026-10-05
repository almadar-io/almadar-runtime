/**
 * A request cancels a call another request made, then makes its own call under the same key while the
 * first request is still finishing: both requests complete, and the new call's result is delivered.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { EventPayload, OrbitalSchema, ServiceParams } from '@almadar/core';
import { isInlineTrait } from '@almadar/core';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';

const program: OrbitalSchema = {
  name: 'Recall',
  orbitals: [{
    name: 'Recall',
    entity: { name: 'Job', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{
      name: 'Judge', linkedEntity: 'Job', category: 'interaction', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }, { name: 'asking' }, { name: 'done' }],
        events: [{ key: 'ASK', name: 'ASK' }, { key: 'SWITCH', name: 'SWITCH' }, { key: 'ANSWERED', name: 'ANSWERED' }, { key: 'GAVE_UP', name: 'GAVE_UP' }, { key: 'PING', name: 'PING' }],
        transitions: [
          { from: 'idle', to: 'asking', event: 'ASK', effects: [['call-service', 'model', 'ask', { n: 1 }, { key: 'batch', emit: { success: 'ANSWERED', cancelled: 'GAVE_UP' } }]] },
          { from: 'asking', to: 'asking', event: 'SWITCH', effects: [['cancel-call', 'batch'], ['call-service', 'model', 'ask', { n: 2 }, { key: 'batch', emit: { success: 'ANSWERED', cancelled: 'GAVE_UP' } }]] },
          { from: 'asking', to: 'done', event: 'ANSWERED', effects: [] },
          { from: 'asking', to: 'asking', event: 'GAVE_UP', effects: [] },
          { from: 'done', to: 'done', event: 'PING', effects: [] },
        ],
      },
    }],
    pages: [],
  }],
};

const hosts: BrowserHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.close()));

describe('openBrowserHost: cancel a call, then call again under the same key', () => {
  it('the new call answers and the trait reaches done; both requests complete', async () => {
    const calls: number[] = [];
    const callService = (_s: string, _a: string, params?: ServiceParams, context?: { signal?: AbortSignal }) =>
      new Promise<EventPayload | null>((resolve, reject) => {
        calls.push(Number(params?.n));
        const timer = setTimeout(() => resolve({ n: Number(params?.n) }), 60);
        context?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
    const host = await openBrowserHost({ databaseName: `recall-${Math.random()}`, schema: program, callService });
    hosts.push(host);
    await host.send('Recall', { event: 'INIT', targetTrait: 'Judge', payload: {} });
    const ask = host.send('Recall', { event: 'ASK', payload: {} });
    await new Promise((r) => setTimeout(r, 20));
    const switched = host.send('Recall', { event: 'SWITCH', payload: {} });
    const outcome = await Promise.race([Promise.all([ask, switched]).then(() => 'both completed'), new Promise((r) => setTimeout(() => r('stuck'), 2000))]);
    expect(outcome).toBe('both completed');
    expect(calls).toEqual([1, 2]);
    expect((await switched).states).toEqual({ Judge: 'done' });
    const after = await Promise.race([host.send('Recall', { event: 'PING', payload: {} }).then((r) => (r.transitioned ? 'served' : 'not handled')), new Promise((r) => setTimeout(() => r('host stuck'), 1000))]);
    expect(after).toBe('served');
  });

  it('a cancelled call\'s request does not run on after the cancel until it holds the host again', async () => {
    const order: string[] = [];
    const callService = (_s: string, _a: string, params?: ServiceParams, context?: { signal?: AbortSignal }) =>
      new Promise<EventPayload | null>((resolve, reject) => {
        order.push(`call ${Number(params?.n)}`);
        const timer = setTimeout(() => resolve({ n: Number(params?.n) }), 80);
        context?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
    const host = await openBrowserHost({ databaseName: `recall-${Math.random()}`, schema: program, callService });
    hosts.push(host);
    await host.send('Recall', { event: 'INIT', targetTrait: 'Judge', payload: {} });
    const ask = host.send('Recall', { event: 'ASK', payload: {} }).then(() => order.push('ask done'));
    await new Promise((r) => setTimeout(r, 20));
    const switched = host.send('Recall', { event: 'SWITCH', payload: {} }).then(() => order.push('switch done'));
    await Promise.race([Promise.all([ask, switched]), new Promise((r) => setTimeout(r, 2000))]);
    const served = await Promise.race([host.send('Recall', { event: 'PING', payload: {} }).then(() => 'served'), new Promise((r) => setTimeout(() => r('host stuck'), 1000))]);
    expect(served).toBe('served');
    expect(order).toEqual(['call 1', 'call 2', 'ask done', 'switch done']);
  });
});

describe('openBrowserHost: a view request cancels a call a tick started', () => {
  const judge = program.orbitals[0].traits[0];
  if (!isInlineTrait(judge)) throw new Error('fixture: the Judge trait is inline');
  const ticking: OrbitalSchema = {
    ...program,
    name: 'RecallTick',
    orbitals: [{ ...program.orbitals[0], traits: [{ ...judge, ticks: [{ name: 'go', interval: 10, guard: ['=', '@state', 'idle'], effects: [['emit', 'ASK']] }] }] }],
  };

  it('the view request completes, its own call answers, and the host stays servable', async () => {
    const calls: number[] = [];
    const callService = (_s: string, _a: string, params?: ServiceParams, context?: { signal?: AbortSignal }) =>
      new Promise<EventPayload | null>((resolve, reject) => {
        calls.push(Number(params?.n));
        const timer = setTimeout(() => resolve({ n: Number(params?.n) }), 80);
        context?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
    const host = await openBrowserHost({ databaseName: `recall-tick-${Math.random()}`, schema: ticking, callService });
    hosts.push(host);
    await host.send('RecallTick', { event: 'INIT', targetTrait: 'Judge', payload: {} });
    await new Promise((r) => setTimeout(r, 60));
    const switched = await Promise.race([host.send('RecallTick', { event: 'SWITCH', payload: {} }).then((r) => r.states.Judge), new Promise((r) => setTimeout(() => r('stuck'), 2000))]);
    expect(switched).toBe('done');
    const served = await Promise.race([host.send('RecallTick', { event: 'PING', payload: {} }).then(() => 'served'), new Promise((r) => setTimeout(() => r('host stuck'), 1000))]);
    expect(served).toBe('served');
    expect(calls).toEqual([1, 2]);
  });
});
