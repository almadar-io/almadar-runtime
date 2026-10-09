/**
 * Where a dispatch leg runs follows where its data lives: browser-stored data
 * (`[persistent: x, local]`) is served in-process, server data by the server,
 * and a static host (no server) serves every leg in-process.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition, OrbitalEventRequest, OrbitalEventResponse, Trait, TypedEffect } from '@almadar/core';
import type { EventTransport } from '../src/server/EventTransport';
import { buildTraitIndex } from '../src/traits/trait-index';
import { createResidenceTransport } from '../src/evaluation/residence-transport';

const ok: OrbitalEventResponse = { success: true, transitioned: false, states: {}, emittedEvents: [] };

function recorder(): EventTransport & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async register() { return { success: true, carriesCircuitState: false }; },
    async unregister() {},
    async send(_o: string, r: OrbitalEventRequest) { sent.push(r.targetTrait ?? r.event); return ok; },
  };
}

function trait(name: string, linked: string, effects: TypedEffect[]): Trait {
  return { name, linkedEntity: linked, category: 'interaction', scope: 'collection',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [{ key: 'GO', name: 'GO' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'GO', effects }] } };
}

const orbital: OrbitalDefinition = {
  name: 'Books',
  entity: { name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, fields: [{ name: 'id', type: 'string', required: true }] },
  auxiliaryEntities: [{ name: 'Ledger', persistence: 'persistent', collection: 'ledgers', fields: [{ name: 'id', type: 'string', required: true }] }],
  traits: [
    trait('InvoiceList', 'Invoice', [['fetch', 'Invoice', {}]]),
    trait('LedgerList', 'Ledger', [['fetch', 'Ledger', {}]]),
    trait('Banner', 'Invoice', [['render-ui', 'main', { type: 'typography', content: 'hi' }]]),
    {
      name: 'Clock', linkedEntity: 'Invoice', category: 'interaction', scope: 'collection',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [{ key: 'TICK', name: 'TICK' }],
        transitions: [{ from: 'idle', to: 'idle', event: 'TICK', effects: [['emit', 'TICKED', {}]] }] },
    },
    {
      name: 'Books', linkedEntity: 'Invoice', category: 'interaction', scope: 'collection',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [{ key: 'GO', name: 'GO' }, { key: 'SYNC', name: 'SYNC' }],
        transitions: [
          { from: 'idle', to: 'idle', event: 'GO', effects: [['fetch', 'Invoice', {}]] },
          { from: 'idle', to: 'idle', event: 'SYNC', effects: [['fetch', 'Ledger', {}]] },
        ] },
    },
  ],
  pages: [],
};

const traitIndex = buildTraitIndex([orbital]);
const leg = (targetTrait: string): OrbitalEventRequest => ({ event: 'GO', targetTrait });

describe('createResidenceTransport', () => {
  it('a leg over browser-stored data runs in-process', async () => {
    const local = recorder(); const remote = recorder();
    await createResidenceTransport({ local, remote, traitIndex }).send('Books', leg('InvoiceList'));
    expect(local.sent).toEqual(['InvoiceList']);
    expect(remote.sent).toEqual([]);
  });

  it('control: a leg over server data goes to the server', async () => {
    const local = recorder(); const remote = recorder();
    await createResidenceTransport({ local, remote, traitIndex }).send('Books', leg('LedgerList'));
    expect(remote.sent).toEqual(['LedgerList']);
    expect(local.sent).toEqual([]);
  });

  it('control: with a server, a leg touching no data still goes to the server as before', async () => {
    const local = recorder(); const remote = recorder();
    await createResidenceTransport({ local, remote, traitIndex }).send('Books', leg('Banner'));
    expect(remote.sent).toEqual(['Banner']);
  });

  it('a static host (no server) runs every leg in-process', async () => {
    const local = recorder();
    await createResidenceTransport({ local, traitIndex }).send('Books', leg('Banner'));
    expect(local.sent).toEqual(['Banner']);
  });

  it('a static host refuses a leg that needs server data, by name', async () => {
    const local = recorder();
    await expect(createResidenceTransport({ local, traitIndex }).send('Books', leg('LedgerList')))
      .rejects.toThrow(/LedgerList.*server/);
  });

  it('a leg mixing browser-stored and server data is an error', async () => {
    const local = recorder(); const remote = recorder();
    const mixed: OrbitalEventRequest = { event: 'GO', targetTrait: 'InvoiceList', traits: [{ trait: 'LedgerList', from: 'idle' }] };
    await expect(createResidenceTransport({ local, remote, traitIndex }).send('Books', mixed)).rejects.toThrow(/browser-stored.*server/);
  });

  it('routes per event: one trait\'s browser event runs in-process, its server event goes to the server', async () => {
    const local = recorder(); const remote = recorder();
    const transport = createResidenceTransport({ local, remote, traitIndex });
    await transport.send('Books', { event: 'GO', targetTrait: 'Books' });
    await transport.send('Books', { event: 'SYNC', targetTrait: 'Books' });
    expect(local.sent).toEqual(['Books']);
    expect(remote.sent).toEqual(['Books']);
  });

  describe('a cascade leg routes each trait by the event it fired on', () => {
    it('a client-only seed whose cascade writes browser-stored data runs in-process', async () => {
      const local = recorder(); const remote = recorder();
      const cascade: OrbitalEventRequest = { event: 'TICK', targetTrait: 'Clock', sourceTrait: 'Clock',
        traits: [{ trait: 'Clock', from: 'idle', event: 'TICK' }, { trait: 'InvoiceList', from: 'idle', event: 'GO' }] };
      await createResidenceTransport({ local, remote, traitIndex }).send('Books', cascade);
      expect(local.sent).toEqual(['Clock']);
      expect(remote.sent).toEqual([]);
    });

    it('a cascade that reaches server data goes to the server', async () => {
      const local = recorder(); const remote = recorder();
      const cascade: OrbitalEventRequest = { event: 'TICK', targetTrait: 'Clock',
        traits: [{ trait: 'Clock', from: 'idle', event: 'TICK' }, { trait: 'LedgerList', from: 'idle', event: 'GO' }] };
      await createResidenceTransport({ local, remote, traitIndex }).send('Books', cascade);
      expect(remote.sent).toEqual(['Clock']);
      expect(local.sent).toEqual([]);
    });

    it('a cascade reaching both browser-stored and server data is refused', async () => {
      const local = recorder(); const remote = recorder();
      const cascade: OrbitalEventRequest = { event: 'TICK', targetTrait: 'Clock',
        traits: [{ trait: 'InvoiceList', from: 'idle', event: 'GO' }, { trait: 'LedgerList', from: 'idle', event: 'GO' }] };
      await expect(createResidenceTransport({ local, remote, traitIndex }).send('Books', cascade)).rejects.toThrow(/browser-stored.*server/);
    });

    it('control: a trait entry without its event is judged by the request event', async () => {
      const local = recorder(); const remote = recorder();
      const cascade: OrbitalEventRequest = { event: 'TICK', targetTrait: 'Clock', traits: [{ trait: 'InvoiceList', from: 'idle' }] };
      await createResidenceTransport({ local, remote, traitIndex }).send('Books', cascade);
      expect(remote.sent).toEqual(['Clock']);
    });
  });

  describe('a mount batch', () => {
    function mounter(): EventTransport & { mounts: string[][] } {
      const mounts: string[][] = [];
      return {
        mounts,
        async register() { return { success: true, carriesCircuitState: false }; },
        async unregister() {},
        async send(_o: string, r: OrbitalEventRequest): Promise<OrbitalEventResponse> {
          const names = (r.mount ?? []).map((m) => m.trait);
          mounts.push(names);
          return { success: true, transitioned: true, states: Object.fromEntries(names.map((n) => [n, 'idle'])),
            emittedEvents: names.map((n) => ({ event: 'LOADED', source: { orbital: 'Books', trait: n } })),
            clientEffects: names.map((n) => ['render-ui', 'main', { type: 'typography', content: n }] as const) };
        },
      };
    }
    const mount = (...traits: string[]): OrbitalEventRequest => ({ event: 'GO', mount: traits.map((trait) => ({ trait, event: 'INIT' })) });

    it('runs each trait at its own residence: browser-stored mounts in-process, server mounts on the server', async () => {
      const local = mounter(); const remote = mounter();
      const response = await createResidenceTransport({ local, remote, traitIndex }).send('Books', mount('InvoiceList', 'LedgerList'));
      expect(local.mounts).toEqual([['InvoiceList']]);
      expect(remote.mounts).toEqual([['LedgerList']]);
      expect(response.success).toBe(true);
      expect(response.states).toEqual({ InvoiceList: 'idle', LedgerList: 'idle' });
      expect(response.emittedEvents.map((e) => e.source?.trait)).toEqual(['InvoiceList', 'LedgerList']);
      expect(response.clientEffects).toHaveLength(2);
    });

    it('control: a batch of one residence goes out whole, unsplit', async () => {
      const local = mounter(); const remote = mounter();
      await createResidenceTransport({ local, remote, traitIndex }).send('Books', mount('LedgerList', 'Banner'));
      expect(remote.mounts).toEqual([['LedgerList', 'Banner']]);
      expect(local.mounts).toEqual([]);
    });

    it('control: a static host still refuses a mounted trait that needs server data', async () => {
      const local = mounter();
      await expect(createResidenceTransport({ local, traitIndex }).send('Books', mount('InvoiceList', 'LedgerList'))).rejects.toThrow(/LedgerList.*server/);
    });
  });
});
