/**
 * Authored `instances` seed rows that carry `createdAt`/`updatedAt` (absent or blank = now, authored kept).
 * Rust twin: `orbital-core` `instance_rows` (`runtime/seed.rs`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { seedBrowserStore } from '../src/entities/seedBrowserStore.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const NOW = '2026-10-13T08:30:00.000Z';

const schema: OrbitalSchema = {
  name: 'seeded',
  orbitals: [{
    name: 'Items',
    pages: [],
    entity: {
      name: 'Item',
      persistence: 'persistent',
      fields: [{ name: 'id', type: 'string' }, { name: 'kind', type: 'string' }],
      instances: [
        { id: 'a', kind: 'x' },
        { id: 'b', kind: 'y', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z' },
      ],
    },
    traits: [{
      name: 'Page',
      scope: 'instance',
      linkedEntity: 'Item',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
    }],
  }],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe('authored instances are seeded with timestamps', () => {
  it('stamps an instance that has none with now', async () => {
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ persistence, debug: false });
    await runtime.register(schema);
    expect(await persistence.getById('Item', 'a')).toEqual({ id: 'a', kind: 'x', createdAt: NOW, updatedAt: NOW });
  });

  it('control: keeps the timestamps an instance authors', async () => {
    const persistence = new InMemoryPersistence();
    const runtime = new OrbitalServerRuntime({ persistence, debug: false });
    await runtime.register(schema);
    expect(await persistence.getById('Item', 'b')).toEqual({
      id: 'b',
      kind: 'y',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2021-01-01T00:00:00.000Z',
    });
  });
});

describe('a browser-stored entity is seeded with timestamps', () => {
  const local = { name: 'Note', local: true, persistence: 'persistent' as const, fields: [{ name: 'id', type: 'string' as const }], instances: [{ id: 'n' }] };

  it('stamps the written-out rows with now', async () => {
    const store = new InMemoryPersistence();
    await seedBrowserStore(store, [local]);
    expect(await store.getById('Note', 'n')).toEqual({ id: 'n', createdAt: NOW, updatedAt: NOW });
  });

  it('control: a store that already has rows is not seeded again', async () => {
    const store = new InMemoryPersistence();
    await store.create('Note', { id: 'kept' });
    await seedBrowserStore(store, [local]);
    expect(await store.getById('Note', 'n')).toBeNull();
  });
});
