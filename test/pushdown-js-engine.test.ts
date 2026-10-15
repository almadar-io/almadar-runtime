/**
 * The JS engine against capable and plain adapters (docs/Almadar_Embedded_Kernel_Speed_Design.md 3.5, 4, 7.3 step 3):
 * a capable adapter gets one `queryPage` per collection fetch and one `writeWhere` per persist (create, update, delete)
 * or `writeBatch` per persist batch; a plain adapter gets today's calls plus the logged `*.pushdown-fallback` notice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CountingPersistence, type PersistenceMethod } from '@almadar/db';
import { InMemoryPersistence } from '@almadar/db/mock';
import { configureLogOutput, getLogOutput } from '@almadar/logger';
import {
  QueryDeclinedError,
  WriteDeclinedError,
  type EntityRow,
  type OrbitalEventResponse,
  type OrbitalSchema,
  type PersistenceAdapter,
  type RowQuery,
  type RowQueryPage,
  type RowWriteOp,
  type RowWriteOutcome,
  type SExpr,
  type StructuredLogEntry,
  type UserContext,
} from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { createServerEffectHandlers } from '../src/effects/ServerEffectHandlers.js';

const OWNER: SExpr = ['=', ['object/get', '@entity', 'owner'], '@user.id'];
const emit = { emit: { success: 'LOADED', failure: 'FAILED' } };

function schema(extra: { readPolicy?: SExpr; updatePolicy?: SExpr } = {}): OrbitalSchema {
  return {
    name: 'pushdown',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: {
        name: 'Note',
        persistence: 'persistent',
        collection: 'notes',
        ...(extra.readPolicy ? { read_policy: extra.readPolicy } : {}),
        ...(extra.updatePolicy ? { update_policy: extra.updatePolicy, delete_policy: extra.updatePolicy } : {}),
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'title', type: 'string' },
          { name: 'rank', type: 'number' },
          { name: 'status', type: 'string' },
          { name: 'owner', type: 'string' },
        ],
      },
      traits: [{
        name: 'Notes',
        scope: 'instance',
        linkedEntity: 'Note',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: ['LIST', 'LIST_UNORDERED', 'LIST_OPEN', 'LIST_WEIRD', 'LIST_RANK', 'UPDATE', 'DELETE', 'CREATE', 'CREATE_TAKEN', 'CREATE_NOID', 'UPSERT', 'UPSERT_GUARDED', 'BATCH', 'BATCH_CREATE', 'BATCH_CREATE_TAKEN', 'RUN_CREATE', 'BATCH_FAIL', 'BATCH_COMP', 'BATCH_UPD', 'RUN', 'RUN_FAIL', 'RUN_REFUSED', 'LOADED', 'FAILED'].map((e) => ({ key: e, name: e })),
          transitions: [
            { from: 'idle', to: 'idle', event: 'LIST', effects: [['fetch', 'Note', { orderBy: 'rank:desc', limit: 3, ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_UNORDERED', effects: [['fetch', 'Note', emit]] },
            { from: 'idle', to: 'idle', event: 'LIST_OPEN', effects: [['fetch', 'Note', { filter: ['=', ['object/get', '@entity', 'status'], 'open'], orderBy: 'rank:desc', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_WEIRD', effects: [['fetch', 'Note', { filter: ['>', ['str/len', ['object/get', '@entity', 'title']], 3], orderBy: 'id', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_RANK', effects: [['fetch', 'Note', { filter: ['>', ['object/get', '@entity', 'rank'], 1], orderBy: 'id', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'UPDATE', effects: [['persist', 'update', 'Note', { id: '@payload.id', title: 'changed' }, emit]] },
            { from: 'idle', to: 'idle', event: 'DELETE', effects: [['persist', 'delete', 'Note', '@payload.id', emit]] },
            { from: 'idle', to: 'idle', event: 'CREATE', effects: [['persist', 'create', 'Note', { id: 'fresh', title: 'f', owner: 'alice' }, emit]] },
            { from: 'idle', to: 'idle', event: 'CREATE_TAKEN', effects: [['persist', 'create', 'Note', { id: 'n1', title: 'again', owner: 'alice' }, emit]] },
            { from: 'idle', to: 'idle', event: 'CREATE_NOID', effects: [['persist', 'create', 'Note', { title: 'minted', owner: 'alice' }, emit]] },
            { from: 'idle', to: 'idle', event: 'UPSERT', effects: [['persist', 'upsert', 'Note', { id: '@payload.id', title: 'swapped' }, emit]] },
            { from: 'idle', to: 'idle', event: 'UPSERT_GUARDED', effects: [['persist', 'upsert', 'Note', { id: '@payload.id', title: 'swapped', owner: '@user.id' }, emit]] },
            {
              from: 'idle', to: 'idle', event: 'BATCH',
              effects: [['persist', 'batch', [['update', 'Note', 'n1', { title: 'b' }], ['update', 'Note', 'n2', { title: 'b' }]], emit]],
            },
            {
              from: 'idle', to: 'idle', event: 'BATCH_CREATE',
              effects: [['persist', 'batch', [['create', 'Note', { id: 'b1', title: 'b' }], ['create', 'Note', { id: 'b2', title: 'c' }]], emit]],
            },
            {
              from: 'idle', to: 'idle', event: 'BATCH_CREATE_TAKEN',
              effects: [['persist', 'batch', [['create', 'Note', { id: 'b1', title: 'b' }], ['create', 'Note', { id: 'n1', title: 'again' }]], emit]],
            },
            {
              from: 'idle', to: 'idle', event: 'BATCH_UPD',
              effects: [['persist', 'batch', [['delete', 'Note', 'n4'], ['update', 'Note', 'n1', { title: 'changed' }]], emit]],
            },
            {
              from: 'idle', to: 'idle', event: 'BATCH_FAIL',
              effects: [['persist', 'batch', [['create', 'Note', { id: 'b1', title: 'b' }], ['update', 'Note', 'ghost', { title: 'x' }]], emit]],
            },
            {
              from: 'idle', to: 'idle', event: 'BATCH_COMP',
              effects: [['persist', 'batch', [['delete', 'Note', 'n4'], ['update', 'Note', 'n1', { title: 'changed', extra: 'x' }], ['update', 'Note', 'n2', { title: 'z' }], ['update', 'Note', 'ghost', { title: 'x' }]], emit]],
            },
            {
              from: 'idle', to: 'idle', event: 'RUN_CREATE',
              effects: [
                ['persist', 'create', 'Note', { id: 'r1', title: 'r' }, emit],
                ['persist', 'update', 'Note', { id: 'n1', title: 'run' }, emit],
                ['persist', 'delete', 'Note', 'n4', emit],
              ],
            },
            {
              from: 'idle', to: 'idle', event: 'RUN',
              effects: [
                ['persist', 'update', 'Note', { id: 'n2', title: 'r' }, emit],
                ['persist', 'update', 'Note', { id: 'n1', title: 'run' }, emit],
                ['persist', 'delete', 'Note', 'n4', emit],
              ],
            },
            {
              from: 'idle', to: 'idle', event: 'RUN_FAIL',
              effects: [
                ['persist', 'update', 'Note', { id: 'n1', title: 'run' }, emit],
                ['persist', 'update', 'Note', { id: 'ghost', title: 'x' }, emit],
                ['persist', 'update', 'Note', { id: 'n3', title: 'late' }, emit],
              ],
            },
            {
              from: 'idle', to: 'idle', event: 'RUN_REFUSED',
              effects: [
                ['persist', 'update', 'Note', { id: 'n1', title: 'run' }, emit],
                ['persist', 'update', 'Note', { id: 'x1', title: 'run' }, emit],
                ['persist', 'update', 'Note', { id: 'n2', title: 'run' }, emit],
              ],
            },
            { from: 'idle', to: 'idle', event: 'LOADED' },
            { from: 'idle', to: 'idle', event: 'FAILED' },
          ],
        },
      }],
    }],
  };
}

const ROWS: EntityRow[] = [
  { id: 'n3', title: 'three', rank: 1, status: 'open', owner: 'alice' },
  { id: 'n1', title: 'one', rank: 1, status: 'open', owner: 'alice' },
  { id: 'n2', title: 'two', rank: 5, status: 'open', owner: 'alice' },
  { id: 'n4', title: 'four', rank: 1, status: 'closed', owner: 'alice' },
  { id: 'x1', title: 'bobs', rank: 9, status: 'open', owner: 'bob' },
];

/** An adapter with no optional members: what a store without push-down looks like. */
function plain(inner: PersistenceAdapter): PersistenceAdapter {
  return {
    create: (t, d) => inner.create(t, d),
    update: (t, id, d) => inner.update(t, id, d),
    delete: (t, id) => inner.delete(t, id),
    getById: (t, id) => inner.getById(t, id),
    list: (t) => inner.list(t),
  };
}

async function build(wrap: (inner: InMemoryPersistence) => PersistenceAdapter, s: OrbitalSchema) {
  const memory = new InMemoryPersistence();
  for (const row of ROWS) await memory.create('Note', { ...row });
  const counting = new CountingPersistence(wrap(memory));
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: counting, debug: false });
  await runtime.register(s);
  counting.reset();
  return { runtime, counting, memory };
}

const calls = (c: CountingPersistence, methods: PersistenceMethod[]): number[] => methods.map((m) => c.counts().byMethod[m] ?? 0);
const capable = (m: InMemoryPersistence): PersistenceAdapter => m;
const ALICE: UserContext = { id: 'alice', role: 'member' };
const BOB: UserContext = { id: 'bob', role: 'member' };

async function fire(runtime: OrbitalServerRuntime, event: string, payload: Record<string, string> = {}, user?: UserContext): Promise<OrbitalEventResponse> {
  const response = await runtime.processOrbitalEvent('Main', { event, targetTrait: 'Notes', payload, ...(user ? { user } : {}) });
  expect(response.success).toBe(true);
  return response;
}

function loaded(response: OrbitalEventResponse): { ids: string[]; total: number; failed: boolean } {
  const event = response.emittedEvents.find((e) => e.event === 'LOADED');
  const failed = response.emittedEvents.some((e) => e.event === 'FAILED');
  const data = event?.payload?.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return { ids: rows.map((r) => String((r as EntityRow).id)), total: Number(event?.payload?.totalCount), failed };
}

let entries: StructuredLogEntry[] = [];
let previous = getLogOutput();
beforeEach(() => {
  entries = [];
  previous = getLogOutput();
  configureLogOutput({ format: 'json', sink: (e) => entries.push(e) });
});
afterEach(() => configureLogOutput({ format: previous.format, context: previous.context, ...(previous.sink ? { sink: previous.sink } : {}) }));
const notices = (message: string): StructuredLogEntry[] => entries.filter((e) => e.message === message);

describe('fetch', () => {
  it('a capable adapter answers a collection fetch with one queryPage and no list', async () => {
    const { runtime, counting } = await build(capable, schema());
    const page = loaded(await fire(runtime, 'LIST'));
    expect(page).toEqual({ ids: ['x1', 'n2', 'n1'], total: 5, failed: false });
    expect(calls(counting, ['queryPage', 'list', 'getById'])).toEqual([1, 0, 0]);
    expect(notices('kernel.fetch.pushdown-fallback')).toEqual([]);
  });

  it('an unordered fetch is pushed down too: one queryPage, in the default createdAt-then-id order (EXEC-FETCH-1)', async () => {
    const { runtime, counting } = await build(capable, schema());
    const page = loaded(await fire(runtime, 'LIST_UNORDERED'));
    expect(page.ids).toEqual(['n1', 'n2', 'n3', 'n4', 'x1']);
    expect(calls(counting, ['queryPage', 'list'])).toEqual([1, 0]);
    expect(notices('kernel.fetch.pushdown-fallback')).toEqual([]);
  });

  it('ties on the order key break by id ascending, on a capable and on a plain adapter', async () => {
    const a = await build(capable, schema());
    const b = await build(plain, schema());
    expect(loaded(await fire(a.runtime, 'LIST')).ids).toEqual(['x1', 'n2', 'n1']);
    expect(loaded(await fire(b.runtime, 'LIST')).ids).toEqual(['x1', 'n2', 'n1']);
  });

  it('pushes the @read policy and the call-site filter together', async () => {
    const { runtime, counting } = await build(capable, schema({ readPolicy: OWNER }));
    const page = loaded(await fire(runtime, 'LIST_OPEN', {}, ALICE));
    expect(page).toEqual({ ids: ['n2', 'n1', 'n3'], total: 3, failed: false });
    expect(calls(counting, ['queryPage'])).toEqual([1]);
  });

  it('a plain adapter gets today\'s list and the logged notice', async () => {
    const { runtime, counting } = await build(plain, schema());
    const page = loaded(await fire(runtime, 'LIST'));
    expect(page).toEqual({ ids: ['x1', 'n2', 'n1'], total: 5, failed: false });
    expect(calls(counting, ['queryPage', 'list'])).toEqual([0, 1]);
    const [notice] = notices('kernel.fetch.pushdown-fallback');
    expect(notice.severity).toBe('WARNING');
    expect(notice.data).toMatchObject({ entity: 'Note', reason: 'no-query-capability' });
  });

  it('the notice is logged once per entity and reason, not once per fetch', async () => {
    const { runtime } = await build(plain, schema());
    await fire(runtime, 'LIST');
    await fire(runtime, 'LIST');
    expect(notices('kernel.fetch.pushdown-fallback')).toHaveLength(1);
  });

  it('a filter outside the expressible set keeps the interpreter and logs not-expressible', async () => {
    const { runtime, counting } = await build(capable, schema());
    const page = loaded(await fire(runtime, 'LIST_WEIRD'));
    expect(page.ids.sort()).toEqual(['n3', 'n4', 'x1']);
    expect(calls(counting, ['queryPage', 'list'])).toEqual([0, 1]);
    expect(notices('kernel.fetch.pushdown-fallback')[0].data).toMatchObject({ reason: 'not-expressible' });
  });

  it('an ordering comparison on a field the entity does not declare required stays interpreted', async () => {
    const { runtime, counting } = await build(capable, schema());
    expect(loaded(await fire(runtime, 'LIST_RANK')).ids).toEqual(['n2', 'x1']);
    expect(calls(counting, ['queryPage', 'list'])).toEqual([0, 1]);
    expect(notices('kernel.fetch.pushdown-fallback')[0].data).toMatchObject({ reason: 'null-semantics' });
  });

  it('a QueryDeclinedError falls back to the list path with the notice naming the reason', async () => {
    const declining = (m: InMemoryPersistence): PersistenceAdapter => ({
      create: (t, d) => m.create(t, d), update: (t, id, d) => m.update(t, id, d), delete: (t, id) => m.delete(t, id),
      getById: (t, id) => m.getById(t, id), list: (t) => m.list(t),
      queryCapabilities: (t) => m.queryCapabilities(t),
      queryPage: async () => { throw new QueryDeclinedError('order-field'); },
    });
    const { runtime, counting } = await build(declining, schema());
    const page = loaded(await fire(runtime, 'LIST'));
    expect(page).toEqual({ ids: ['x1', 'n2', 'n1'], total: 5, failed: false });
    expect(calls(counting, ['queryPage', 'list'])).toEqual([1, 1]);
    expect(notices('kernel.fetch.pushdown-fallback')[0].data).toMatchObject({ reason: 'host-declined', detail: 'order-field' });
  });

  it('re-checks the read policy on the returned rows: a store that ignores the policy fails the fetch', async () => {
    const ignoring = (m: InMemoryPersistence): PersistenceAdapter => ({
      create: (t, d) => m.create(t, d), update: (t, id, d) => m.update(t, id, d), delete: (t, id) => m.delete(t, id),
      getById: (t, id) => m.getById(t, id), list: (t) => m.list(t),
      queryCapabilities: (t) => m.queryCapabilities(t),
      queryPage: (t, q: RowQuery): Promise<RowQueryPage> => m.queryPage(t, { ...q, policy: undefined }),
    });
    const { runtime } = await build(ignoring, schema({ readPolicy: OWNER }));
    expect(loaded(await fire(runtime, 'LIST', {}, ALICE)).failed).toBe(true);
  });
});

describe('persist', () => {
  it('update on a capable adapter is one writeWhere', async () => {
    const { runtime, counting, memory } = await build(capable, schema());
    const response = await fire(runtime, 'UPDATE', { id: 'n1' });
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
    expect((await memory.getById('Note', 'n1'))?.title).toBe('changed');
    expect(calls(counting, ['writeWhere', 'update', 'getById', 'list'])).toEqual([1, 0, 0, 0]);
  });

  it('update of a missing row is not-found and writes nothing', async () => {
    const { runtime, memory } = await build(capable, schema());
    const response = await fire(runtime, 'UPDATE', { id: 'zz' });
    const result = response.effectResults?.find((r) => r.effect === 'persist');
    expect([result?.success, result?.code]).toEqual([false, 'not-found']);
    expect(await memory.getById('Note', 'zz')).toBeNull();
  });

  it('the @update policy rides the write as a guard: the owner writes, another viewer is refused', async () => {
    const { runtime, counting, memory } = await build(capable, schema({ updatePolicy: OWNER }));
    const own = (await fire(runtime, 'UPDATE', { id: 'n1' }, ALICE)).effectResults?.find((r) => r.effect === 'persist');
    expect(own?.success).toBe(true);
    const other = (await fire(runtime, 'UPDATE', { id: 'n2' }, BOB)).effectResults?.find((r) => r.effect === 'persist');
    expect([other?.success, other?.denied]).toEqual([false, true]);
    expect((await memory.getById('Note', 'n2'))?.title).toBe('two');
    expect(calls(counting, ['writeWhere', 'getById', 'update'])).toEqual([2, 0, 0]);
  });

  it('a store that ignores the guard is caught by the pre-image echo check', async () => {
    const ignoring = (m: InMemoryPersistence): PersistenceAdapter => ({
      create: (t, d) => m.create(t, d), update: (t, id, d) => m.update(t, id, d), delete: (t, id) => m.delete(t, id),
      getById: (t, id) => m.getById(t, id), list: (t) => m.list(t),
      writeCapabilities: (t) => m.writeCapabilities(t),
      writeWhere: (op: RowWriteOp): Promise<RowWriteOutcome> => m.writeWhere(op.kind === 'update' || op.kind === 'delete' ? { ...op, guard: undefined } : op).then((o) => (o.kind === 'updated' ? { ...o, before: o.row } : o)),
    });
    const { runtime } = await build(ignoring, schema({ updatePolicy: OWNER }));
    const result = (await fire(runtime, 'UPDATE', { id: 'n2' }, BOB)).effectResults?.find((r) => r.effect === 'persist');
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Note');
  });

  it('a create naming its id on a capable adapter is one writeWhere and returns the row', async () => {
    const { runtime, counting } = await build(capable, schema());
    const response = await fire(runtime, 'CREATE');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.data).toMatchObject({ id: 'fresh', title: 'f' });
    expect(calls(counting, ['writeWhere', 'create', 'getById'])).toEqual([1, 0, 0]);
    expect(notices('kernel.write.pushdown-fallback')).toEqual([]);
  });

  it('a create on a taken id fails duplicate-id and leaves the row, on a capable and on a plain adapter (EXEC-STEP-8)', async () => {
    for (const wrap of [capable, plain]) {
      const { runtime, memory } = await build(wrap, schema());
      const response = await fire(runtime, 'CREATE_TAKEN');
      const persist = response.effectResults?.find((r) => r.effect === 'persist');
      expect([persist?.success, persist?.code]).toEqual([false, 'duplicate-id']);
      expect(response.emittedEvents.some((e) => e.event === 'FAILED')).toBe(true);
      expect((await memory.getById('Note', 'n1'))?.title).toBe('one');
    }
  });

  it('control: a create naming no id keeps the store create, which mints one, and logs why', async () => {
    const { runtime, counting } = await build(capable, schema());
    const response = await fire(runtime, 'CREATE_NOID');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
    expect(calls(counting, ['writeWhere', 'create'])).toEqual([0, 1]);
    expect(notices('kernel.write.pushdown-fallback')[0].data).toMatchObject({ entity: 'Note', reason: 'create-mints-id' });
  });

  it('an upsert replaces the whole row in one writeWhere, and creates a free id; a plain adapter reaches the same rows', async () => {
    for (const wrap of [capable, plain]) {
      const { runtime, counting, memory } = await build(wrap, schema());
      const replaced = await fire(runtime, 'UPSERT', { id: 'n1' });
      expect(replaced.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
      const row = await memory.getById('Note', 'n1');
      expect([row?.title, row?.rank, row?.owner]).toEqual(['swapped', undefined, undefined]);
      await fire(runtime, 'UPSERT', { id: 'brand-new' });
      expect((await memory.getById('Note', 'brand-new'))?.title).toBe('swapped');
      if (wrap === capable) expect(calls(counting, ['writeWhere', 'create', 'update'])).toEqual([2, 0, 0]);
    }
  });

  it('an upsert over a row the @update directive refuses is denied and changes nothing; the viewer\'s own row is replaced', async () => {
    for (const wrap of [capable, plain]) {
      const { runtime, memory } = await build(wrap, schema({ updatePolicy: OWNER }));
      const denied = (await fire(runtime, 'UPSERT_GUARDED', { id: 'x1' }, ALICE)).effectResults?.find((r) => r.effect === 'persist');
      expect([denied?.success, denied?.denied]).toEqual([false, true]);
      expect((await memory.getById('Note', 'x1'))?.title).toBe('bobs');
      const own = (await fire(runtime, 'UPSERT_GUARDED', { id: 'n2' }, ALICE)).effectResults?.find((r) => r.effect === 'persist');
      expect(own?.success).toBe(true);
      expect((await memory.getById('Note', 'n2'))?.title).toBe('swapped');
    }
  });

  it('delete with no on-delete rules to enforce is one writeWhere', async () => {
    const { runtime, counting, memory } = await build(capable, schema());
    const response = await fire(runtime, 'DELETE', { id: 'n4' });
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
    expect(await memory.getById('Note', 'n4')).toBeNull();
    expect(calls(counting, ['writeWhere', 'delete', 'getById'])).toEqual([1, 0, 0]);
  });

  it('a plain adapter gets today\'s calls and the logged write notice', async () => {
    const { runtime, counting, memory } = await build(plain, schema());
    await fire(runtime, 'UPDATE', { id: 'n1' });
    expect((await memory.getById('Note', 'n1'))?.title).toBe('changed');
    expect(calls(counting, ['update', 'getById', 'writeWhere'])).toEqual([1, 2, 0]);
    expect(notices('kernel.write.pushdown-fallback')[0].data).toMatchObject({ entity: 'Note', reason: 'no-write-capability' });
  });

  it('persist batch on a capable adapter is one writeBatch', async () => {
    const { runtime, counting } = await build(capable, schema());
    const response = await fire(runtime, 'BATCH');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
    expect(calls(counting, ['writeBatch', 'update'])).toEqual([1, 0]);
  });

  it('a batch of creates naming their ids is one writeBatch', async () => {
    const { runtime, counting, memory } = await build(capable, schema());
    const response = await fire(runtime, 'BATCH_CREATE');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
    expect(calls(counting, ['writeBatch', 'create'])).toEqual([1, 0]);
    expect((await memory.getById('Note', 'b2'))?.title).toBe('c');
    expect(notices('kernel.write.pushdown-fallback')).toEqual([]);
  });

  it('a batch create on a taken id fails the whole batch and writes nothing, pushed or per-op', async () => {
    for (const wrap of [capable, plain]) {
      const { runtime, memory } = await build(wrap, schema());
      const response = await fire(runtime, 'BATCH_CREATE_TAKEN');
      const persist = response.effectResults?.find((r) => r.effect === 'persist');
      expect(persist?.success).toBe(false);
      expect(persist?.error).toContain('already exists');
      expect(await memory.getById('Note', 'b1')).toBeNull();
      expect((await memory.getById('Note', 'n1'))?.title).toBe('one');
    }
  });

  it('persist batch is atomic: a failing op leaves none of the earlier ops written', async () => {
    const { runtime, memory } = await build(capable, schema());
    const response = await fire(runtime, 'BATCH_FAIL');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(false);
    expect(await memory.getById('Note', 'b1')).toBeNull();
  });

  it('persist batch on a plain adapter is today\'s per-op calls and the notice', async () => {
    const { runtime, counting } = await build(plain, schema());
    await fire(runtime, 'BATCH');
    expect(calls(counting, ['update', 'writeBatch'])).toEqual([2, 0]);
    expect(notices('kernel.write.pushdown-fallback')[0].data).toMatchObject({ reason: 'no-write-capability' });
  });

  it('a WriteDeclinedError from writeBatch falls back to the per-op path with the notice naming the reason', async () => {
    const declining = (m: InMemoryPersistence): PersistenceAdapter => ({
      create: (t, d) => m.create(t, d), update: (t, id, d) => m.update(t, id, d), delete: (t, id) => m.delete(t, id),
      getById: (t, id) => m.getById(t, id), list: (t) => m.list(t),
      writeCapabilities: (t) => m.writeCapabilities(t),
      writeWhere: (op) => m.writeWhere(op),
      writeBatch: async () => { throw new WriteDeclinedError('atomic-batch'); },
    });
    const { runtime, counting, memory } = await build(declining, schema());
    const response = await fire(runtime, 'BATCH_UPD');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(true);
    expect(calls(counting, ['writeBatch'])).toEqual([1]);
    expect(await memory.getById('Note', 'n4')).toBeNull();
    expect((await memory.getById('Note', 'n1'))?.title).toBe('changed');
    expect(notices('kernel.write.pushdown-fallback').some((n) => (n.data as { reason?: string; detail?: string }).reason === 'host-declined' && (n.data as { detail?: string }).detail === 'atomic-batch')).toBe(true);
  });

  it('a batch failing on a store without transactions restores every applied op and logs the compensation', async () => {
    const { runtime, memory } = await build(plain, schema());
    const before = await memory.list('Note');
    const snapshot = before.map((r) => ({ ...r }));
    const response = await fire(runtime, 'BATCH_COMP');
    expect(response.effectResults?.find((r) => r.effect === 'persist')?.success).toBe(false);
    const after = await memory.list('Note');
    expect(after.map((r) => ({ ...r })).sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(snapshot.sort((a, b) => String(a.id).localeCompare(String(b.id))));
    expect(notices('kernel.write.batch-compensated')[0].data).toMatchObject({ applied: 3, restored: 3 });
  });

  it('a batch failing on a capable store is atomic and needs no compensation', async () => {
    const { runtime, memory } = await build(capable, schema());
    await fire(runtime, 'BATCH_COMP');
    expect(await memory.getById('Note', 'n4')).not.toBeNull();
    expect((await memory.getById('Note', 'n1'))?.title).toBe('one');
    expect(notices('kernel.write.batch-compensated')).toEqual([]);
  });
});

describe('a run of plain persists in one transition', () => {
  it('goes as one stop-mode writeBatch on a store that declares stopRuns', async () => {
    const { runtime, counting, memory } = await build(capable, schema());
    const response = await fire(runtime, 'RUN');
    const persists = response.effectResults?.filter((r) => r.effect === 'persist') ?? [];
    expect(persists.map((r) => [r.action, r.success])).toEqual([['update', true], ['update', true], ['delete', true]]);
    expect(response.emittedEvents.filter((e) => e.event === 'LOADED')).toHaveLength(3);
    expect(calls(counting, ['writeBatch', 'writeWhere', 'create', 'update', 'delete'])).toEqual([1, 0, 0, 0, 0]);
    expect((await memory.getById('Note', 'n1'))?.title).toBe('run');
    expect(await memory.getById('Note', 'n4')).toBeNull();
    expect((await memory.getById('Note', 'n2'))?.title).toBe('r');
  });

  it('a run holding a create goes as one writeBatch with the rest', async () => {
    const { runtime, counting, memory } = await build(capable, schema());
    await fire(runtime, 'RUN_CREATE');
    expect(calls(counting, ['writeBatch', 'writeWhere', 'create'])).toEqual([1, 0, 0]);
    expect((await memory.getById('Note', 'n1'))?.title).toBe('run');
    expect(await memory.getById('Note', 'r1')).not.toBeNull();
    expect(notices('kernel.write.pushdown-fallback')).toEqual([]);
  });

  it('a handled failure does not stop the transition: the ops after it go out as a new run', async () => {
    const { runtime, memory, counting } = await build(capable, schema());
    const response = await fire(runtime, 'RUN_FAIL');
    const persists = response.effectResults?.filter((r) => r.effect === 'persist') ?? [];
    expect(persists.map((r) => [r.action, r.success, r.code])).toEqual([['update', true, undefined], ['update', false, 'not-found'], ['update', true, undefined]]);
    expect(response.emittedEvents.some((e) => e.event === 'FAILED')).toBe(true);
    expect((await memory.getById('Note', 'n1'))?.title).toBe('run');
    expect((await memory.getById('Note', 'n3'))?.title).toBe('late');
    expect(calls(counting, ['writeBatch', 'update', 'create'])).toEqual([2, 0, 0]);
  });

  it('a refused op in the middle gives the same results as the plain-store control', async () => {
    const results = async (wrap: (m: InMemoryPersistence) => PersistenceAdapter) => {
      const { runtime, memory } = await build(wrap, schema({ updatePolicy: OWNER }));
      const response = await fire(runtime, 'RUN_REFUSED', {}, ALICE);
      const persists = (response.effectResults?.filter((r) => r.effect === 'persist') ?? []).map((r) => [r.action, r.success, r.code, r.denied]);
      const titles = (await memory.list('Note')).map((r) => [r.id, r.title]).sort();
      return { persists, titles, events: response.emittedEvents.map((e) => e.event) };
    };
    const pushed = await results(capable);
    const control = await results(plain);
    expect(pushed).toEqual(control);
    expect(pushed.persists.map((p) => p[1])).toEqual([true, false, true]);
    expect(pushed.titles.filter(([id]) => id === 'n1' || id === 'n2').map(([, t]) => t)).toEqual(['run', 'run']);
  });

  it('control: a store without the capability gets one call per effect', async () => {
    const { runtime, counting, memory } = await build(plain, schema());
    await fire(runtime, 'RUN');
    expect(calls(counting, ['writeBatch', 'create', 'update', 'delete'])).toEqual([0, 0, 2, 1]);
    expect((await memory.getById('Note', 'n1'))?.title).toBe('run');
    expect((await memory.getById('Note', 'n2'))?.title).toBe('r');
  });
});

describe('ServerEffectHandlers persist batch', () => {
  const ops = [['update', 'Note', 'n1', { title: 'b' }], ['update', 'Note', 'ghost', { title: 'x' }]];
  it('is one atomic writeBatch on a store that declares it', async () => {
    const memory = new InMemoryPersistence();
    await memory.create('Note', { id: 'n1', title: 'one' });
    const counting = new CountingPersistence(memory);
    const handlers = createServerEffectHandlers({ persistence: counting, eventBus: { emit: () => undefined }, entityType: 'Note', effectResults: [] });
    await handlers.persist?.('batch', '', { operations: ops });
    expect(calls(counting, ['writeBatch', 'update'])).toEqual([1, 0]);
    expect((await memory.getById('Note', 'n1'))?.title).toBe('one');
  });
  it('a plain store is compensated after a failure', async () => {
    const memory = new InMemoryPersistence();
    await memory.create('Note', { id: 'n1', title: 'one' });
    const handlers = createServerEffectHandlers({ persistence: plain(memory), eventBus: { emit: () => undefined }, entityType: 'Note', effectResults: [] });
    await handlers.persist?.('batch', '', { operations: ops });
    expect((await memory.getById('Note', 'n1'))?.title).toBe('one');
    expect(notices('kernel.write.batch-compensated')).toHaveLength(1);
  });
});
