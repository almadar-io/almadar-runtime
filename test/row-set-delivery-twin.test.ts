/**
 * `fetch … { deliver: ids }` on the JS engine and the kernel engine (the kernel config,
 * `vitest.engine-kernel.config.ts`, swaps `OrbitalServerRuntime`): the success event's `data` is a `RowSetMarker`, the
 * response carries the same ref in `dataRefs`, no rows travel, and a `render-ui` prop holding the marker leaves the
 * dispatch as the marker. Rust twin: `orbital-core/tests/row_set_delivery.rs` (same entity, rows, viewer and fetch).
 */
import { describe, expect, it } from 'vitest';
import { CountingPersistence } from '@almadar/db';
import { InMemoryPersistence } from '@almadar/db/mock';
import { isRowSetMarker, type EntityRow, type OrbitalEventResponse, type OrbitalSchema, type PersistenceAdapter, type RowSetRef, type RuntimeValue } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const emit = { emit: { success: 'LISTED', failure: 'LIST_FAILED' } };
const OPEN = ['=', ['object/get', '@entity', 'status'], 'open'];

function schema(): OrbitalSchema {
  return {
    name: 'row-set-delivery',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: {
        name: 'Ticket',
        persistence: 'persistent',
        collection: 'tickets',
        read_policy: ['=', ['object/get', '@entity', 'owner'], '@user.id'],
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'status', type: 'string' },
          { name: 'score', type: 'number' },
          { name: 'owner', type: 'string' },
        ],
      },
      traits: [{
        name: 'Tickets',
        scope: 'instance',
        linkedEntity: 'Ticket',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: ['LIST', 'LIST_NONE', 'LIST_ROWS_NONE', 'LIST_ROWS', 'LIST_BY_ID', 'LIST_INCLUDE', 'LISTED', 'LIST_FAILED'].map((e) => ({ key: e, name: e })),
          transitions: [
            { from: 'idle', to: 'idle', event: 'LIST', effects: [['fetch', 'Ticket', { filter: OPEN, orderBy: 'score:desc', limit: 2, deliver: 'ids', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_NONE', effects: [['fetch', 'Ticket', { filter: OPEN, orderBy: 'score:desc', limit: 2, deliver: 'ids', total: 'none', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_ROWS_NONE', effects: [['fetch', 'Ticket', { filter: OPEN, orderBy: 'score:desc', limit: 2, total: 'none', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_ROWS', effects: [['fetch', 'Ticket', { filter: OPEN, orderBy: 'score:desc', limit: 2, ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_BY_ID', effects: [['fetch', 'Ticket', { id: 't1', deliver: 'ids', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LIST_INCLUDE', effects: [['fetch', 'Ticket', { include: ['owner'], deliver: 'ids', ...emit }]] },
            { from: 'idle', to: 'idle', event: 'LISTED', effects: [['render-ui', 'main', { type: 'data-grid' as const, entity: '@payload.data' }]] },
            { from: 'idle', to: 'idle', event: 'LIST_FAILED' },
          ],
        },
      }],
    }],
  };
}

const ROWS: EntityRow[] = [
  { id: 't1', status: 'open', score: 3, owner: 'u1' },
  { id: 't2', status: 'open', score: 9, owner: 'u1' },
  { id: 't3', status: 'open', score: 5, owner: 'u1' },
  { id: 't4', status: 'closed', score: 1, owner: 'u1' },
  { id: 't5', status: 'open', score: 8, owner: 'u1' },
  { id: 't6', status: 'open', score: 7, owner: 'u2' },
];

const plain = (inner: PersistenceAdapter): PersistenceAdapter => ({
  create: (t, d) => inner.create(t, d),
  update: (t, id, d) => inner.update(t, id, d),
  delete: (t, id) => inner.delete(t, id),
  getById: (t, id) => inner.getById(t, id),
  list: (t) => inner.list(t),
});

async function fire(wrap: (m: InMemoryPersistence) => PersistenceAdapter, event: string) {
  const memory = new InMemoryPersistence();
  for (const row of ROWS) await memory.create('Ticket', { ...row });
  const counting = new CountingPersistence(wrap(memory));
  const runtime = new OrbitalServerRuntime({ mode: 'real', persistence: counting, debug: false });
  await runtime.register(schema());
  counting.reset();
  const response: OrbitalEventResponse = await runtime.processOrbitalEvent('Main', { event, targetTrait: 'Tickets', payload: {}, user: { id: 'u1', role: 'member' } });
  return { response, counting };
}

const listed = (r: OrbitalEventResponse) => r.emittedEvents.find((e) => e.event === 'LISTED')?.payload;

function painted(r: OrbitalEventResponse): Record<string, RuntimeValue> {
  const render = (r.clientEffects ?? []).find((e) => e[0] === 'render-ui');
  expect(render).toBeDefined();
  return (render?.[2] ?? {}) as Record<string, RuntimeValue>;
}

describe.each([
  ['a capable adapter', (m: InMemoryPersistence): PersistenceAdapter => m],
  ['a plain adapter', plain],
])('a deliver: ids fetch on %s', (_name, wrap) => {
  it('hands the success event a marker, paints it whole, and carries the ref in dataRefs with no rows', async () => {
    const { response } = await fire(wrap, 'LIST');
    expect(response.success).toBe(true);
    const payload = listed(response);
    const marker = payload?.data;
    if (marker === undefined || !isRowSetMarker(marker)) throw new Error('the success payload carries no row-set marker');
    const reference: RowSetRef = marker.ref;
    // viewer u1 sees open t1,t2,t3,t5 (t6 is u2's), ordered by score desc, window 2
    expect(reference.entityType).toBe('Ticket');
    expect(reference.ids).toEqual(['t2', 't5']);
    expect(reference.total).toBe(4);
    expect(reference.query.limit).toBe(2);
    expect(payload?.totalCount).toBe(4);
    expect(response.dataRefs?.Ticket).toEqual(reference);
    expect(response.data).toBeUndefined();
    const props = painted(response);
    expect(props.entity).toEqual(marker);
  });

  it('control: the default delivery passes the rows and no ref', async () => {
    const { response } = await fire(wrap, 'LIST_ROWS');
    const data = listed(response)?.data;
    expect(Array.isArray(data)).toBe(true);
    expect((data as EntityRow[]).map((r) => r.id)).toEqual(['t2', 't5']);
    expect(response.dataRefs).toBeUndefined();
  });

  it.each(['LIST_BY_ID', 'LIST_INCLUDE'])('%s: a by-id or include fetch fails instead of widening', async (event) => {
    const { response } = await fire(wrap, event);
    expect(response.dataRefs).toBeUndefined();
    expect(listed(response)).toBeUndefined();
  });
});

describe('what crosses to the store', () => {
  it('a capable adapter answers one queryIds and never lists', async () => {
    const { counting } = await fire((m) => m, 'LIST');
    const byMethod = counting.counts().byMethod;
    expect([byMethod.queryIds ?? 0, byMethod.queryPage ?? 0, byMethod.list ?? 0]).toEqual([1, 0, 0]);
  });

  it('control: a plain adapter is listed once', async () => {
    const { counting } = await fire(plain, 'LIST');
    const byMethod = counting.counts().byMethod;
    expect([byMethod.queryIds ?? 0, byMethod.list ?? 0]).toEqual([0, 1]);
  });
});

/** A capable adapter that records the `total` mode of every query it is handed. */
function spying(asked: Array<'exact' | 'none' | undefined>) {
  return (m: InMemoryPersistence): PersistenceAdapter => ({
    ...plain(m),
    queryCapabilities: (t) => m.queryCapabilities(t),
    queryPage: (t, q) => { asked.push(q.total); return m.queryPage(t, q); },
    queryIds: (t, q) => { asked.push(q.total); return m.queryIds(t, q); },
  });
}

describe('fetch { total: none } (ruled Q12). Rust twin: row_set_delivery.rs total_none_*', () => {
  it('a rows fetch tells the store not to count and the payload carries no totalCount', async () => {
    const asked: Array<'exact' | 'none' | undefined> = [];
    const { response } = await fire(spying(asked), 'LIST_ROWS_NONE');
    expect(asked).toEqual(['none']);
    const payload = listed(response);
    expect((payload?.data as EntityRow[]).map((r) => r.id)).toEqual(['t2', 't5']);
    expect(payload && 'totalCount' in payload).toBe(false);
  });

  it('control: a fetch without total: none asks for the exact total and reports it', async () => {
    const asked: Array<'exact' | 'none' | undefined> = [];
    const { response } = await fire(spying(asked), 'LIST_ROWS');
    expect(asked).toEqual([undefined]);
    expect(listed(response)?.totalCount).toBe(4);
  });

  it('a deliver: ids fetch asks queryIds for no count; the ref carries the window size and the query', async () => {
    const asked: Array<'exact' | 'none' | undefined> = [];
    const { response } = await fire(spying(asked), 'LIST_NONE');
    expect(asked).toEqual(['none']);
    const payload = listed(response);
    expect(payload && 'totalCount' in payload).toBe(false);
    const reference = response.dataRefs?.Ticket;
    expect(reference?.ids).toEqual(['t2', 't5']);
    expect(reference?.total).toBe(2);
    expect(reference?.query.total).toBe('none');
  });
});
