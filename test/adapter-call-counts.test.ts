/**
 * Baseline for speed pass 2 (design 4.6): how many `PersistenceAdapter` calls one dispatch makes today, on the JS
 * engine and on the kernel host. The JS engine column is the push-down result (one queryPage per fetch, ordered or not (EXEC-FETCH-1), one writeWhere per persist, one writeBatch per batch); the kernel column is the pushed-down result (writeWhere / writeBatch declared by the adapter's capabilities).
 * The kernel suite needs the built `@almadar/kernel` (ALMADAR_KERNEL_DIR) and is skipped without it.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CountingPersistence, type PersistenceMethod } from '@almadar/db';
import { InMemoryPersistence } from '@almadar/db/mock';
import { isEntityReferenceAny, type OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import type { KernelModule } from '../src/kernel/index.js';
import { KERNEL_DIR, loadKernel } from './helpers/kernel-module.js';

const emit = { emit: { success: 'DONE', failure: 'FAILED' } };

function program(): OrbitalSchema {
  return {
    name: 'counts',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: { name: 'Note', persistence: 'persistent', collection: 'notes', fields: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'title', type: 'string' }] },
      traits: [{
        name: 'Notes',
        scope: 'instance',
        linkedEntity: 'Note',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: ['UPDATE', 'CREATE', 'BATCH', 'FETCH', 'DONE', 'FAILED'].map((e) => ({ key: e, name: e })),
          transitions: [
            { from: 'idle', to: 'idle', event: 'UPDATE', effects: [['persist', 'update', 'Note', { id: 'n1', title: 'changed' }, emit]] },
            { from: 'idle', to: 'idle', event: 'CREATE', effects: [['persist', 'create', 'Note', { id: 'n2', title: 'fresh' }, emit]] },
            {
              from: 'idle',
              to: 'idle',
              event: 'BATCH',
              effects: [['persist', 'batch', [['create', 'Note', { id: 'b1', title: 'b' }], ['create', 'Note', { id: 'b2', title: 'b' }], ['create', 'Note', { id: 'b3', title: 'b' }]], emit]],
            },
            { from: 'idle', to: 'idle', event: 'FETCH', effects: [['fetch', 'Note', emit]] },
            { from: 'idle', to: 'idle', event: 'DONE' },
            { from: 'idle', to: 'idle', event: 'FAILED' },
          ],
        },
      }],
    }],
  };
}

type Verb = 'noop' | 'update' | 'create' | 'batch' | 'fetch';
const event: Record<Verb, string> = { noop: 'DONE', update: 'UPDATE', create: 'CREATE', batch: 'BATCH', fetch: 'FETCH' };

async function callsFor(verb: Verb, engine: { kernel?: KernelModule }): Promise<Record<PersistenceMethod, number>> {
  const memory = new InMemoryPersistence();
  await memory.create('Note', { id: 'n1', title: 'seed' });
  const counting = new CountingPersistence(memory);
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: counting, ...(engine.kernel !== undefined ? { kernel: engine.kernel } : {}) });
  await runtime.register(program());
  counting.reset();
  const response = await runtime.processOrbitalEvent('Main', { event: event[verb], targetTrait: 'Notes' });
  expect(response.success).toBe(true);
  return counting.counts().byMethod;
}

const counts = (create: number, update: number, getById: number, list: number, pushed: Partial<Record<PersistenceMethod, number>> = {}): Record<PersistenceMethod, number> => ({
  create, update, delete: 0, getById, list, countRows: 0, query: 0, listPage: 0, queryPage: 0, queryIds: 0, writeWhere: 0, writeBatch: 0, ...pushed,
});

// Totals include the dispatch's own frame reads (readRow/listRows for the bound entity),
// which the `noop` control isolates; the persist effect's own share is the difference.
const KERNEL = { noop: counts(0, 0, 1, 0), update: counts(0, 0, 2, 0, { writeBatch: 1 }), create: counts(0, 0, 2, 0, { writeBatch: 1 }), batch: counts(0, 0, 2, 0, { writeBatch: 1 }), fetch: counts(0, 0, 1, 0, { queryPage: 1 }) };

describe.skipIf(KERNEL_DIR === undefined)('adapter calls per dispatch, kernel host (push-down)', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });
  it('control: an event with no effects costs only the one frame read', async () => expect(await callsFor('noop', { kernel })).toEqual(KERNEL.noop));
  it('persist update', async () => expect(await callsFor('update', { kernel })).toEqual(KERNEL.update));
  it('persist create', async () => expect(await callsFor('create', { kernel })).toEqual(KERNEL.create));
  it('persist batch of 3', async () => expect(await callsFor('batch', { kernel })).toEqual(KERNEL.batch));
  it('fetch', async () => expect(await callsFor('fetch', { kernel })).toEqual(KERNEL.fetch));
});


// The twin oracle shared with orbital-server's pushdown_counting (native host): the same verb makes the same push-down calls.
const TWIN: Record<string, Partial<Record<PersistenceMethod, number>>> = JSON.parse(readFileSync(new URL('./fixtures/adapter-calls.json', import.meta.url), 'utf8')).verbs;

describe.skipIf(KERNEL_DIR === undefined)('adapter calls per dispatch: the wasm host against the shared twin oracle', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });
  for (const verb of ['update', 'create', 'batch', 'fetch'] as const) {
    it(`${verb}: the push-down calls are the oracle's`, async () => {
      const actual = await callsFor(verb, { kernel });
      for (const [method, want] of Object.entries(TWIN[verb])) expect(actual[method as PersistenceMethod], method).toBe(want);
    });
  }
});

// `[runtime]` rows live in the kernel's memory: a dispatch over a runtime entity makes no adapter call at all (the same
// program makes the two frame reads when the entity is persistent). Twin: orbital-core `server_transitions.rs` `runtime_rows`.
function runtimeProgram(persistence: 'runtime' | 'persistent'): OrbitalSchema {
  const base = program();
  const orbital = base.orbitals[0];
  if (isEntityReferenceAny(orbital.entity)) throw new Error('the counts program has an inline entity');
  return { ...base, orbitals: [{ ...orbital, entity: { ...orbital.entity, persistence } }] };
}

async function totalCalls(persistence: 'runtime' | 'persistent', kernel: KernelModule): Promise<number> {
  const counting = new CountingPersistence(new InMemoryPersistence());
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: counting, kernel });
  await runtime.register(runtimeProgram(persistence));
  counting.reset();
  const response = await runtime.processOrbitalEvent('Main', { event: 'DONE', targetTrait: 'Notes' });
  expect(response.success).toBe(true);
  return Object.values(counting.counts().byMethod).reduce((a, b) => a + b, 0);
}

describe.skipIf(KERNEL_DIR === undefined)('runtime rows live in the kernel (wasm host)', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });
  it('a dispatch over a [runtime] entity makes no adapter call', async () => expect(await totalCalls('runtime', kernel)).toBe(0));
  it('control: the same program over a persistent entity reads its frame from the adapter', async () => expect(await totalCalls('persistent', kernel)).toBeGreaterThan(0));
});

// A persistent entity's frame row is asked of the adapter once per dispatch, however many steps read it. Twin: orbital-core
// `server_transitions.rs` `runtime_rows` (the same oracle file).
describe.skipIf(KERNEL_DIR === undefined)('the frame row of a persistent entity is read once per dispatch (wasm host)', () => {
  let kernel: KernelModule;
  beforeAll(async () => {
    kernel = await loadKernel();
  });

  async function frameReads(persistence: 'persistent' | 'runtime'): Promise<number> {
    const doc: { schema: OrbitalSchema } = JSON.parse(readFileSync(new URL('../../../tools/kernel-bench/fixtures/scenarios/emit-fanout.json', import.meta.url), 'utf8'));
    const orbital = doc.schema.orbitals[0];
    if (isEntityReferenceAny(orbital.entity)) throw new Error('emit-fanout has an inline entity');
    const schema: OrbitalSchema = { ...doc.schema, orbitals: [{ ...orbital, entity: { ...orbital.entity, persistence } }] };
    const counting = new CountingPersistence(new InMemoryPersistence());
    const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: counting, kernel });
    await runtime.register(schema);
    counting.reset();
    const response = await runtime.processOrbitalEvent('Main', { event: 'GO', targetTrait: 'Src' });
    expect(response.success).toBe(true);
    expect(response.states.Sink).toBe('done');
    return counting.counts().byMethod.getById;
  }

  it('emit-fanout go over a persistent entity asks the adapter once', async () => {
    const oracle: { emitFanoutPersistent: { frameReads: number } } = JSON.parse(readFileSync(new URL('./fixtures/adapter-calls.json', import.meta.url), 'utf8'));
    expect(await frameReads('persistent')).toBe(oracle.emitFanoutPersistent.frameReads);
  });

  it('control: the same program over a runtime entity asks it never', async () => expect(await frameReads('runtime')).toBe(0));
});
