/**
 * EXEC-STEP-8 (G-CROSS-198): a `persist create` on a taken id fails `duplicate-id` on every path and store, and an
 * authored `persist upsert` creates the row or replaces it whole. Creates and upserts that name their id push down,
 * alone, in a run and in a batch. Same program on the JS engine and the kernel host.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CountingPersistence, type PersistenceMethod } from '@almadar/db';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import type { KernelModule } from '../src/kernel/index.js';
import { KERNEL_DIR, loadKernel } from './helpers/kernel-module.js';

const emit = { emit: { success: 'DONE', failure: 'FAILED' } };

function program(): OrbitalSchema {
  const transitions = [
    { from: 'idle', to: 'idle', event: 'TAKEN', effects: [['persist', 'create', 'Note', { id: 'n1', title: 'again' }, emit]] },
    { from: 'idle', to: 'idle', event: 'FRESH', effects: [['persist', 'create', 'Note', { id: 'n9', title: 'new' }, emit]] },
    { from: 'idle', to: 'idle', event: 'UPSERT_TAKEN', effects: [['persist', 'upsert', 'Note', { id: 'n1', title: 'swapped' }, emit]] },
    { from: 'idle', to: 'idle', event: 'UPSERT_FRESH', effects: [['persist', 'upsert', 'Note', { id: 'n9', title: 'new' }, emit]] },
    {
      from: 'idle',
      to: 'idle',
      event: 'BATCH_TAKEN',
      effects: [['persist', 'batch', [['update', 'Note', 'n2', { title: 'u' }], ['create', 'Note', { id: 'n1', title: 'again' }]], emit]],
    },
    {
      from: 'idle',
      to: 'idle',
      event: 'BATCH_FRESH',
      effects: [['persist', 'batch', [['update', 'Note', 'n2', { title: 'u' }], ['create', 'Note', { id: 'n9', title: 'new' }]], emit]],
    },
    {
      from: 'idle',
      to: 'idle',
      event: 'RUN_CREATE',
      effects: [['persist', 'update', 'Note', { id: 'n2', title: 'u' }], ['persist', 'create', 'Note', { id: 'n9', title: 'new' }]],
    },
    { from: 'idle', to: 'idle', event: 'DONE' },
    { from: 'idle', to: 'idle', event: 'FAILED' },
  ];
  return {
    name: 'create-semantics',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: {
        name: 'Note',
        persistence: 'persistent',
        collection: 'notes',
        fields: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'title', type: 'string' }, { name: 'tone', type: 'string' }],
      },
      traits: [{
        name: 'Notes',
        scope: 'instance',
        linkedEntity: 'Note',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: ['TAKEN', 'FRESH', 'UPSERT_TAKEN', 'UPSERT_FRESH', 'BATCH_TAKEN', 'BATCH_FRESH', 'RUN_CREATE', 'DONE', 'FAILED'].map((e) => ({ key: e, name: e })),
          transitions,
        },
      }],
    }],
  } as OrbitalSchema;
}

async function run(event: string, kernel?: KernelModule) {
  const memory = new InMemoryPersistence();
  await memory.create('Note', { id: 'n1', title: 'seed', tone: 'warm' });
  await memory.create('Note', { id: 'n2', title: 'seed' });
  const counting = new CountingPersistence(memory);
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: counting, ...(kernel !== undefined ? { kernel } : {}) });
  await runtime.register(program());
  counting.reset();
  const response = await runtime.processOrbitalEvent('Main', { event, targetTrait: 'Notes' });
  expect(response.success).toBe(true);
  const counts: Record<PersistenceMethod, number> = counting.counts().byMethod;
  const persist = response.effectResults?.find((r) => r.effect === 'persist');
  return { rows: await memory.list('Note'), counts, persist, events: response.emittedEvents.map((e) => e.event) };
}

function suite(kernel: () => KernelModule | undefined): void {
  it('a create on a taken id fails duplicate-id, fires the failure event and leaves the row', async () => {
    const { rows, counts, persist, events } = await run('TAKEN', kernel());
    expect([persist?.success, persist?.code]).toEqual([false, 'duplicate-id']);
    expect(events).toContain('FAILED');
    expect(rows.find((r) => r.id === 'n1')).toEqual({ id: 'n1', title: 'seed', tone: 'warm' });
    expect(counts.writeBatch).toBe(1);
    expect(counts.create).toBe(0);
  });
  it('control: a create on a free id is pushed and stored', async () => {
    const { rows, persist, counts } = await run('FRESH', kernel());
    expect(persist?.success).toBe(true);
    expect(rows.find((r) => r.id === 'n9')).toMatchObject({ title: 'new' });
    expect(counts.writeBatch).toBe(1);
    expect(counts.create).toBe(0);
  });
  it('an upsert on a taken id replaces the whole row in one write', async () => {
    const { rows, counts, persist } = await run('UPSERT_TAKEN', kernel());
    expect(persist?.success).toBe(true);
    const row = rows.find((r) => r.id === 'n1');
    expect(row).toMatchObject({ title: 'swapped' });
    expect(row?.tone).toBeUndefined();
    expect(counts.writeBatch).toBe(1);
    expect(counts.update + counts.create).toBe(0);
  });
  it('control: an upsert on a free id creates it', async () => {
    const { rows, persist } = await run('UPSERT_FRESH', kernel());
    expect(persist?.success).toBe(true);
    expect(rows.find((r) => r.id === 'n9')).toMatchObject({ title: 'new' });
  });
  it('a batch with a create on a taken id fails whole and writes nothing', async () => {
    const { rows, counts, persist } = await run('BATCH_TAKEN', kernel());
    expect(persist?.success).toBe(false);
    expect(rows.find((r) => r.id === 'n2')).toMatchObject({ title: 'seed' });
    expect(rows.find((r) => r.id === 'n1')).toMatchObject({ title: 'seed' });
    expect(counts.writeBatch).toBe(1);
    expect(counts.create).toBe(0);
  });
  it('control: a batch with a free create is one writeBatch', async () => {
    const { rows, counts } = await run('BATCH_FRESH', kernel());
    expect(rows.find((r) => r.id === 'n9')).toMatchObject({ title: 'new' });
    expect(rows.find((r) => r.id === 'n2')).toMatchObject({ title: 'u' });
    expect(counts.writeBatch).toBe(1);
    expect(counts.create).toBe(0);
  });
  it('a run holding a create goes as one stop-mode writeBatch', async () => {
    const { rows, counts } = await run('RUN_CREATE', kernel());
    expect(rows.find((r) => r.id === 'n9')).toMatchObject({ title: 'new' });
    expect(counts.writeBatch).toBe(1);
    expect(counts.create).toBe(0);
  });
}

describe.skipIf(KERNEL_DIR === undefined)('create is strict and upsert replaces, kernel host', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });
  suite(() => kernel);
});
