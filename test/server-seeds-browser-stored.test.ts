/**
 * Headless hosts (verify) run a browser-stored entity's rows through the same
 * seed rule as the browser store: `instances`, else `mock` rows when declared,
 * once into an empty store.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEntity, OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import { MockPersistenceAdapter } from '@almadar/db/mock';

function app(entity: OrbitalEntity): OrbitalSchema {
  return { name: 'seed', version: '1.0.0', orbitals: [{ name: 'Books', entity, traits: [], pages: [] }] };
}

const fields: OrbitalEntity['fields'] = [{ name: 'id', type: 'string', required: true }, { name: 'client', type: 'string' }];

async function rows(entity: OrbitalEntity, mode: 'mock' | 'real'): Promise<number> {
  const persistence = mode === 'mock' ? new MockPersistenceAdapter() : new InMemoryPersistence();
  const runtime = new OrbitalServerRuntime({ debug: false, persistence, mode });
  await runtime.register(app(entity));
  return (await persistence.list(entity.name)).length;
}

describe('server runtime seeds browser-stored entities by the browser rule', () => {
  it('a local entity declaring mock is seeded even outside mock mode', async () => {
    expect(await rows({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, seedMock: true, fields }, 'real')).toBeGreaterThan(0);
  });

  it('a local entity with written-out rows gets exactly those rows', async () => {
    expect(await rows({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, fields, instances: [{ id: 'A', client: 'Noor' }] }, 'real')).toBe(1);
  });

  it('a local entity with neither source starts empty, even in mock mode', async () => {
    expect(await rows({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, fields }, 'mock')).toBe(0);
  });

  it('a local entity declaring mock gets mock rows in mock mode', async () => {
    expect(await rows({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, seedMock: true, fields }, 'mock')).toBeGreaterThan(0);
  });

  it('control: a server entity with neither source is mock-seeded in mock mode, as before', async () => {
    expect(await rows({ name: 'Invoice', persistence: 'persistent', collection: 'invoices', fields }, 'mock')).toBeGreaterThan(0);
  });

  it('an auxiliary local entity follows the same rule in mock mode', async () => {
    const persistence = new MockPersistenceAdapter();
    const runtime = new OrbitalServerRuntime({ debug: false, persistence, mode: 'mock' });
    await runtime.register({
      name: 'seed-aux', version: '1.0.0',
      orbitals: [{
        name: 'Books',
        entity: { name: 'Ledger', persistence: 'persistent', collection: 'ledgers', fields },
        auxiliaryEntities: [
          { name: 'Draft', persistence: 'persistent', collection: 'drafts', local: true, fields },
          { name: 'Sample', persistence: 'persistent', collection: 'samples', local: true, seedMock: true, fields },
        ],
        traits: [], pages: [],
      }],
    });
    expect((await persistence.list('Draft')).length).toBe(0);
    expect((await persistence.list('Sample')).length).toBeGreaterThan(0);
  });
});
