/**
 * `persist batch` through the effect stage reports what it wrote — `{ operations, completedCount,
 * totalCount }` — so two batches saved in one cascade are two distinct deliveries (identical summaries
 * would read as a cycle and the second would be dropped).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { openBrowserHost, type BrowserHost } from '../src/evaluation/browser-store-transport';

const program: OrbitalSchema = {
  name: 'Batches',
  orbitals: [{
    name: 'Batches',
    entity: { name: 'Row', persistence: 'persistent', collection: 'rows', local: true, fields: [{ name: 'id', type: 'string' }, { name: 'n', type: 'number' }] },
    traits: [{
      name: 'Saver', linkedEntity: 'Row', category: 'interaction', scope: 'collection',
      stateMachine: {
        states: [{ name: 'first', isInitial: true }, { name: 'second' }, { name: 'done' }],
        events: [{ key: 'GO', name: 'GO' }, { key: 'SAVED', name: 'SAVED' }],
        transitions: [
          { from: 'first', to: 'second', event: 'GO', effects: [['persist', 'batch', [['create', 'Row', { n: 1 }]], { emit: { success: 'SAVED' } }]] },
          { from: 'second', to: 'done', event: 'SAVED', effects: [['persist', 'batch', [['create', 'Row', { n: 2 }]], { emit: { success: 'SAVED' } }]] },
          { from: 'done', to: 'done', event: 'SAVED', effects: [] },
        ],
      },
    }],
    pages: [],
  }],
};

const hosts: BrowserHost[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.close()));

describe('openBrowserHost: persist batch', () => {
  it('reports what it wrote, so a second batch in the same cascade is delivered too', async () => {
    const host = await openBrowserHost({ databaseName: `batches-${Math.random()}`, schema: program, callService: async () => ({}) });
    hosts.push(host);
    await host.send('Batches', { event: 'INIT', targetTrait: 'Saver', payload: {} });
    const res = await host.send('Batches', { event: 'GO', payload: {} });
    const saved = res.emittedEvents.filter((e) => e.event === 'SAVED').map((e) => e.payload);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ completedCount: 1, totalCount: 1 });
    expect(saved[0]).toHaveProperty('operations');
    expect(res.states).toEqual({ Saver: 'done' });
  });
});
