/**
 * The browser leg of a browser-only service. A local store (the in-process client leg) has no node
 * integrations: `@almadar/integrations/runtime` is an empty module there (package.json `browser`
 * map), so the default call-service provider died with "e is not a constructor". A browser-only
 * service is answered by the browser dispatcher (`@almadar/integrations/browser`) instead.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrbitalDefinition } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { buildTraitIndex } from '../src/traits/trait-index';
import { createMemoryCircuitStore } from '../src/evaluation/circuit-store';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';

vi.mock('@almadar/integrations/runtime', () => ({}));

const orbital = (service: string, action: string, params: Record<string, string>): OrbitalDefinition => ({
  name: 'Site',
  entity: { name: 'Visit', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
  traits: [{
    name: 'Report', linkedEntity: 'Visit', category: 'interaction', scope: 'instance',
    stateMachine: {
      states: [{ name: 'active', isInitial: true }],
      events: [{ key: 'GO', name: 'GO' }, { key: 'DONE', name: 'DONE' }, { key: 'FAILED', name: 'FAILED' }],
      transitions: [
        { from: 'active', to: 'active', event: 'GO', effects: [['call-service', service, action, params, { emit: { success: 'DONE', failure: 'FAILED' } }]] },
        { from: 'active', to: 'active', event: 'DONE', effects: [] },
        { from: 'active', to: 'active', event: 'FAILED', effects: [] },
      ],
    },
  }],
  pages: [],
});

async function emitted(def: OrbitalDefinition) {
  const traitIndex = buildTraitIndex([def]);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  const transport = createLocalStoreTransport({ traitIndex, persistence: new InMemoryPersistence(), store });
  const response = await transport.send('Site', { event: 'GO', targetTrait: 'Report' });
  return response.emittedEvents.map((e) => ({ event: e.event, payload: e.payload }));
}

describe('a local store answering a call to a browser-only service', () => {
  it('analytics resolves through the browser dispatcher: nothing sent without an endpoint', async () => {
    const events = await emitted(orbital('analytics', 'pageview', { endpoint: '', path: '/', domain: '' }));
    expect(events.map((e) => e.event)).toContain('DONE');
    expect(events.find((e) => e.event === 'DONE')?.payload).toMatchObject({ sent: false });
    expect(events.map((e) => e.event)).not.toContain('FAILED');
  });

  it('a browser-only service with no web-hosted implementation fails by name, not as a constructor error', async () => {
    const events = await emitted(orbital('page', 'watch', { url: 'https://example.com' }));
    const failed = events.find((e) => e.event === 'FAILED');
    expect(String(JSON.stringify(failed?.payload))).toContain("Service 'page' is not wired in this browser host");
  });

  it('control: a node service still goes to the node provider', async () => {
    const events = await emitted(orbital('email', 'send', { to: 'a@example.com', subject: 's', body: 'b' }));
    const failed = events.find((e) => e.event === 'FAILED');
    expect(String(JSON.stringify(failed?.payload))).not.toContain('browser host');
  });
});
