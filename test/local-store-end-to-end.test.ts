/**
 * A browser-stored entity end to end, with no server: seeded written-out rows
 * come back from a `fetch` run in-process, and a `persist` survives into the
 * browser store.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition, OrbitalEntity } from '@almadar/core';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { seedBrowserStore } from '../src/entities/seedBrowserStore';
import { KERNEL_DIR, testKernel, TEST_LANGUAGE } from './helpers/kernel-module.js';
import { localStorePersistence, openLocalKernel } from '../src/evaluation/local-store-transport.js';
import type { KernelModule } from '../src/kernel/wire.js';
import { readLanguageBundle } from '@almadar/core/language-data';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const invoice: OrbitalEntity = {
  name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true,
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'amount', type: 'number' }],
  instances: [{ id: 'INV-1', amount: 4200 }, { id: 'INV-2', amount: 980 }],
};

const orbital: OrbitalDefinition = {
  name: 'Books',
  entity: invoice,
  traits: [{
    name: 'InvoiceList', linkedEntity: 'Invoice', category: 'interaction', scope: 'collection',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'LOAD', name: 'LOAD' }, { key: 'ADD', name: 'ADD' }, { key: 'LOADED', name: 'LOADED' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'LOAD', effects: [['fetch', 'Invoice', { emit: { success: 'LOADED' } }]] },
        { from: 'idle', to: 'idle', event: 'ADD', effects: [['persist', 'create', 'Invoice', { id: 'INV-3', amount: 15 }]] },
        { from: 'idle', to: 'idle', event: 'LOADED', effects: [] },
      ],
    },
  }],
  pages: [],
};

async function host() {
  const persistence = await IndexedDbPersistence.open({ databaseName: `e2e-${Math.random()}`, entityTypes: ['Invoice'] });
  await seedBrowserStore(persistence, [invoice]);
  return { persistence, transport: createLocalStoreTransport({ kernelEngine: testKernel().then((kernel) => openLocalKernel({ kernel, language: TEST_LANGUAGE, schema: { name: 'e2e', orbitals: [orbital] }, persistence: localStorePersistence({ name: 'e2e', orbitals: [orbital] }, persistence) })) }) };
}

describe.skipIf(KERNEL_DIR === undefined)('browser-stored entity end to end', () => {
  it('a fetch returns the written-out rows from the browser store', async () => {
    const { transport } = await host();
    const response = await transport.send('Books', { event: 'LOAD', targetTrait: 'InvoiceList' });
    expect(response.success).toBe(true);
    const rows = JSON.stringify(response);
    expect(rows).toContain('INV-1');
    expect(rows).toContain('INV-2');
    expect(response.emittedEvents.map((e) => e.event)).toContain('LOADED');
  });

  it('a persist writes into the browser store', async () => {
    const { transport, persistence } = await host();
    await transport.send('Books', { event: 'ADD', targetTrait: 'InvoiceList' });
    expect(await persistence.getById('Invoice', 'INV-3')).toMatchObject({ amount: 15 });
    expect((await persistence.changes()).at(-1)).toMatchObject({ op: 'create', id: 'INV-3' });
  });
});

/** A client-build kernel instance of its own: nothing has installed language data into it. */
async function freshBrowserKernel(): Promise<KernelModule> {
  const dir = KERNEL_DIR ?? '';
  const glue: KernelModule & { initSync(input: { module: Uint8Array }): object } = await import(`${pathToFileURL(join(dir, 'pkg-client/orbital_wasm.js')).href}?fresh=${Math.random()}`);
  glue.initSync({ module: readFileSync(join(dir, 'pkg-client/orbital_wasm_bg.wasm')) });
  return glue;
}

const person: OrbitalEntity = {
  name: 'Person', persistence: 'persistent', collection: 'people', local: true,
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'name', type: 'string' }],
  instances: [{ id: 'p-1', name: 'Maja' }],
};

const task: OrbitalEntity = {
  name: 'Task', persistence: 'persistent', collection: 'tasks', local: true,
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'title', type: 'string' }, { name: 'owner', type: 'relation', relation: { entity: 'Person' } }],
  instances: [{ id: 't-1', title: 'Write the brief', owner: 'p-1' }],
};

const board: OrbitalDefinition = {
  name: 'Board',
  entity: task,
  auxiliaryEntities: [person],
  traits: [{
    name: 'TaskGrid', linkedEntity: 'Task', category: 'interaction', scope: 'collection',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'INIT' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', effects: [['fetch', 'Task'], ['render-ui', 'main', { type: 'data-grid', entity: 'Task', fields: ['title', 'owner'] }]] },
      ],
    },
  }],
  pages: [],
};

async function boardHost(language: string) {
  const schema = { name: 'board', orbitals: [board] };
  const persistence = await IndexedDbPersistence.open({ databaseName: `board-${Math.random()}`, entityTypes: ['Task', 'Person'] });
  await seedBrowserStore(persistence, [task, person]);
  const kernelEngine = freshBrowserKernel().then((kernel) => openLocalKernel({ kernel, language, schema, persistence: localStorePersistence(schema, persistence) }));
  return createLocalStoreTransport({ kernelEngine });
}

describe.skipIf(KERNEL_DIR === undefined)('a browser kernel opened over a local store', () => {
  it('runs a screen whose pattern lists a relation field, with the language the host hands it', async () => {
    const response = await (await boardHost(JSON.stringify(readLanguageBundle(process.cwd())))).send('Board', { event: 'INIT', targetTrait: 'TaskGrid' });
    expect(response.success).toBe(true);
    expect(JSON.stringify(response.clientEffects)).toContain('"relationsData":{"owner":[{"value":"p-1","label":"Maja"}]}');
  });

  it('control: a bundle that is not the language is refused with its code, not a trap', async () => {
    await expect((await boardHost('{}')).send('Board', { event: 'INIT', targetTrait: 'TaskGrid' })).rejects.toThrow(/ORB_LANGUAGE_DATA_INVALID/);
  });
});
