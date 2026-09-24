// Declared `@read` on the live interpreter fetch path; twin of orbital-server/tests/read_access.rs.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { EntityRow, EventPayload, OrbitalEventResponse, OrbitalSchema, SExpr, UserContext } from '@almadar/core';

const OWNER_ONLY: SExpr = ['=', ['object/get', '@entity', 'ownerId'], '@user.id'];
const ADMIN_OR_OWNER: SExpr = ['or', ['=', '@user.role', 'admin'], OWNER_ONLY];
const OPEN_ONLY: SExpr = ['=', ['object/get', '@entity', 'status'], 'open'];
const BOB_ONLY: SExpr = ['=', ['object/get', '@entity', 'ownerId'], 'bob'];

const ROWS = [
  { id: 'a1', ownerId: 'alice', status: 'open' },
  { id: 'a2', ownerId: 'alice', status: 'closed' },
  { id: 'b1', ownerId: 'bob', status: 'open' },
];

type Access = { policy?: SExpr; waiver?: string };

function notesSchema(access: Access): OrbitalSchema {
  return {
    name: 'read-access-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Notes',
        pages: [],
        entity: {
          name: 'Note',
          persistence: 'persistent',
          ...(access.policy ? { read_policy: access.policy } : {}),
          ...(access.waiver ? { access_waivers: { read: access.waiver } } : {}),
          fields: [
            { name: 'id', type: 'string', primaryKey: true },
            { name: 'ownerId', type: 'string' },
            { name: 'status', type: 'string', default: 'open' },
          ],
        },
        traits: [
          {
            name: 'NoteBrowse',
            scope: 'instance',
            linkedEntity: 'Note',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'LIST', name: 'LIST' },
                { key: 'LIST_OPEN', name: 'LIST_OPEN' },
                { key: 'LIST_BOBS', name: 'LIST_BOBS' },
                { key: 'PAGE', name: 'PAGE' },
                { key: 'OPEN', name: 'OPEN' },
              ],
              transitions: [
                { from: 'idle', to: 'idle', event: 'LIST', effects: [['fetch', 'Note', { emit: { success: 'NOTES_LOADED', failure: 'NOTES_FAILED' } }]] },
                {
                  from: 'idle', to: 'idle', event: 'LIST_OPEN',
                  effects: [['fetch', 'Note', { filter: OPEN_ONLY, emit: { success: 'NOTES_LOADED', failure: 'NOTES_FAILED' } }]],
                },
                {
                  from: 'idle', to: 'idle', event: 'LIST_BOBS',
                  effects: [['fetch', 'Note', { filter: BOB_ONLY, emit: { success: 'NOTES_LOADED', failure: 'NOTES_FAILED' } }]],
                },
                {
                  from: 'idle', to: 'idle', event: 'PAGE',
                  effects: [['fetch', 'Note', { limit: '@payload.limit', offset: '@payload.offset', emit: { success: 'NOTES_LOADED', failure: 'NOTES_FAILED' } }]],
                },
                {
                  from: 'idle', to: 'idle', event: 'OPEN',
                  effects: [['fetch', 'Note', { id: '@payload.id', emit: { success: 'NOTES_LOADED', failure: 'NOTES_FAILED' } }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function setup(access: Access, rows: ReadonlyArray<EntityRow> = ROWS) {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(notesSchema(access));
  for (const row of rows) await runtime.persistence.create('Note', { ...row });
  return runtime;
}

// Rows ride the fetch's `emit.success` payload — the JS path never fills `response.data` (G-RUNTIME-033).
function loaded(response: OrbitalEventResponse): { ids: string[]; total: unknown; failed: boolean } {
  const event = response.emittedEvents.find((e) => e.event === 'NOTES_LOADED');
  const failed = response.emittedEvents.some((e) => e.event === 'NOTES_FAILED');
  expect(Boolean(event) !== failed).toBe(true);
  const data = event?.payload?.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return {
    ids: rows.map((row) => String((row as EntityRow).id)).sort(),
    total: event?.payload?.totalCount,
    failed,
  };
}

async function dispatch(
  runtime: OrbitalServerRuntime,
  event: string,
  user: UserContext | undefined,
  payload: EventPayload = {},
) {
  const response = await runtime.processOrbitalEvent('Notes', { event, payload, ...(user ? { user } : {}) });
  expect(response.success).toBe(true);
  return loaded(response);
}

const ALICE: UserContext = { id: 'alice', role: 'member' };

describe('OrbitalServerRuntime fetch — declared @read policy', () => {
  it('scopes a collection fetch to the viewer\'s rows', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    expect((await dispatch(runtime, 'LIST', ALICE)).ids).toEqual(['a1', 'a2']);
  });

  it('gives an anonymous viewer nothing under an owner policy', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    expect((await dispatch(runtime, 'LIST', undefined)).ids).toEqual([]);
  });

  it('fails a fetch-by-id of a row the viewer may not read as not found', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    expect((await dispatch(runtime, 'OPEN', ALICE, { id: 'b1' })).failed).toBe(true);
  });

  it('serves a fetch-by-id of a row the viewer may read', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    expect(await dispatch(runtime, 'OPEN', ALICE, { id: 'a1' })).toEqual({ ids: ['a1'], total: 1, failed: false });
  });

  it('fails a fetch-by-id of a missing row exactly like a refused one', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    const missing = await dispatch(runtime, 'OPEN', ALICE, { id: 'zz' });
    const refused = await dispatch(runtime, 'OPEN', ALICE, { id: 'b1' });
    expect(missing).toEqual(refused);
    expect(missing.failed).toBe(true);
  });

  it('narrows further with a call-site filter', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    expect((await dispatch(runtime, 'LIST_OPEN', ALICE)).ids).toEqual(['a1']);
  });

  it('never lets a call-site filter widen past the policy', async () => {
    const runtime = await setup({ policy: OWNER_ONLY });
    expect((await dispatch(runtime, 'LIST_BOBS', ALICE)).ids).toEqual([]);
  });

  it('paginates the visible set and counts only visible rows', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, ownerId: i % 2 === 0 ? 'alice' : 'bob', status: 'open' }));
    const runtime = await setup({ policy: OWNER_ONLY }, rows);
    const page = await dispatch(runtime, 'PAGE', ALICE, { limit: 2, offset: 1 });
    expect(page.ids).toHaveLength(2);
    expect(page.ids.every((id) => ['r0', 'r2', 'r4'].includes(id))).toBe(true);
    expect(page.total).toBe(3);
    expect((await dispatch(runtime, 'PAGE', ALICE, { limit: 5, offset: 3 })).ids).toEqual([]);
  });

  it('treats no @read and no waiver as ALLOW-ALL', async () => {
    const runtime = await setup({});
    expect((await dispatch(runtime, 'LIST', ALICE)).ids).toEqual(['a1', 'a2', 'b1']);
  });

  it('treats a `@read none` waiver exactly like no policy', async () => {
    const runtime = await setup({ waiver: 'shared review surface' });
    expect((await dispatch(runtime, 'LIST', ALICE)).ids).toEqual(['a1', 'a2', 'b1']);
  });

  it('admits both kinds of viewer under a role-or-owner policy', async () => {
    const runtime = await setup({ policy: ADMIN_OR_OWNER });
    expect((await dispatch(runtime, 'LIST', { id: 'carol', role: 'admin' })).ids).toEqual(['a1', 'a2', 'b1']);
    expect((await dispatch(runtime, 'LIST', { id: 'bob', role: 'member' })).ids).toEqual(['b1']);
  });
});
