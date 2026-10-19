// `POST /api/orbitals/resolve-rows`: a row-set reference resolved for the requesting viewer against the server's
// store. Twin of orbital-server/tests/resolve_rows_route.rs (same schema, rows, references and expected ids).
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { EntityRow, OrbitalSchema, RowQueryPage, RowSetRef, SExpr, UserContext } from '@almadar/core';
import type { VerifiedUser } from '@almadar/auth';
import { stubKernelModule } from './helpers/kernel-module.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import type { KernelModule, KernelServerHandle } from '../src/kernel/index.js';

const OWNER_ONLY: SExpr = ['=', ['object/get', '@entity', 'ownerId'], '@user.id'];
const ROWS: EntityRow[] = [
  { id: 'a1', ownerId: 'alice', status: 'open' },
  { id: 'a2', ownerId: 'alice', status: 'closed' },
  { id: 'b1', ownerId: 'bob', status: 'open' },
];

function schema(policy: boolean): OrbitalSchema {
  return {
    name: 'resolve-app',
    version: '1.0.0',
    orbitals: [{
      name: 'Notes',
      pages: [],
      entity: {
        name: 'Note',
        persistence: 'persistent',
        ...(policy ? { read_policy: OWNER_ONLY } : {}),
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'ownerId', type: 'string' },
          { name: 'status', type: 'string' },
        ],
      },
      traits: [{
        name: 'NoteBrowse',
        scope: 'instance',
        linkedEntity: 'Note',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'LIST', name: 'LIST' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'LIST' }],
        },
      }],
    }],
  };
}

const reference = (ids: string[]): RowSetRef => ({ entityType: 'Note', ids, total: 3, query: {} });
const ALICE: UserContext = { id: 'alice', role: 'member' };
const ids = (page: RowQueryPage): string[] => page.rows.map((r) => String(r.id));

async function setup(policy: boolean) {
  const store = new InMemoryPersistence();
  const runtime = new OrbitalServerRuntime({ persistence: store, debug: false });
  await runtime.register(schema(policy));
  for (const row of ROWS) await store.create('Note', { ...row });
  return { runtime, store };
}

describe('OrbitalServerRuntime.resolveRows (JS engine)', () => {
  it('omits a row the requesting viewer may not read', async () => {
    const { runtime } = await setup(true);
    const page = await runtime.resolveRows(reference(['a1', 'b1', 'a2']), ALICE);
    expect(ids(page)).toEqual(['a1', 'a2']);
    expect(page.total).toBe(2);
  });

  it('control: a policy-free entity resolves every row in the reference order', async () => {
    const { runtime } = await setup(false);
    const page = await runtime.resolveRows(reference(['b1', 'a1', 'a2']), ALICE);
    expect(ids(page)).toEqual(['b1', 'a1', 'a2']);
    expect(page.total).toBe(3);
  });

  it('a row deleted since the fetch is omitted and the total follows the store', async () => {
    const { runtime, store } = await setup(false);
    await store.delete('Note', 'a2');
    const page = await runtime.resolveRows(reference(['a1', 'a2']), ALICE);
    expect(ids(page)).toEqual(['a1']);
    expect(page.total).toBe(2);
  });

  it('a total: none reference is not re-counted: the total is the resolved window', async () => {
    const { runtime } = await setup(false);
    const page = await runtime.resolveRows({ ...reference(['a1']), query: { total: 'none' } }, ALICE);
    expect(page).toEqual({ rows: [{ id: 'a1', ownerId: 'alice', status: 'open' }], total: 1 });
  });

  it('an entity no orbital declares is refused, not answered empty', async () => {
    const { runtime } = await setup(false);
    await expect(runtime.resolveRows({ ...reference(['x']), entityType: 'Ghost' }, ALICE)).rejects.toThrow(/Ghost/);
  });
});

describe('the kernel engine resolves through its resolve flight', () => {
  it('hands the reference and the viewer to the kernel and returns its page', async () => {
    const seen: { ref: string; viewer: string }[] = [];
    class Handle implements KernelServerHandle {
      resolveRows(ref: string, viewer: string): string {
        seen.push({ ref, viewer });
        return JSON.stringify({ status: 'done', rows: [{ id: 'a1' }], total: 7 });
      }
      resumeResolve(): string { throw new Error('unused'); }
      start(): string { throw new Error('unused'); }
      resume(): string { throw new Error('unused'); }
      abandon(): boolean { return true; }
      inFlight(): number { return 0; }
      getState(): string { return ''; }
      setDefaultUser(): void {}
      mount(): void {}
      remount(): void {}
      setTickMount(): void {}
      seedRuntimeMock(): void {}
      setCapabilities(): void {}
      setMessages(): void {}
      setManagedProgram(): void {}
      lastError(): string { return ''; }
      osAllows(): boolean { return false; }
      fork(): KernelServerHandle { throw new Error('unused'); }
      free(): void {}
    }
    const kernel: KernelModule = stubKernelModule(Handle);
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false, kernel });
    await runtime.register(schema(true));
    const page = await runtime.resolveRows(reference(['a1']), ALICE);
    expect(page).toEqual({ rows: [{ id: 'a1' }], total: 7 });
    expect(JSON.parse(seen[0]?.viewer ?? 'null')).toEqual(ALICE);
  });
});

let server: http.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function post(runtime: OrbitalServerRuntime, body: object, verified: VerifiedUser | null): Promise<{ status: number; json: RowQueryPage }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (verified !== null) req.authUser = verified;
    next();
  });
  app.use('/api/orbitals', runtime.router());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server!.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const res = await fetch(`http://localhost:${address.port}/api/orbitals/resolve-rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as RowQueryPage };
}

const aliceToken: VerifiedUser = { uid: 'alice', provider: 'firebase', email: 'alice@example.com', claims: { role: 'member' } };

describe('POST /api/orbitals/resolve-rows', () => {
  it('resolves for the viewer the host verified', async () => {
    const { runtime } = await setup(true);
    const { status, json } = await post(runtime, { ref: reference(['a1', 'b1', 'a2']) }, aliceToken);
    expect(status).toBe(200);
    expect(ids(json)).toEqual(['a1', 'a2']);
    expect(json.total).toBe(2);
  });

  it('control: an anonymous viewer under an owner policy resolves nothing', async () => {
    const { runtime } = await setup(true);
    const { status, json } = await post(runtime, { ref: reference(['a1', 'b1']) }, null);
    expect(status).toBe(200);
    expect(json.rows).toEqual([]);
  });

  it('a malformed reference is a client error', async () => {
    const { runtime } = await setup(true);
    const { status } = await post(runtime, { ref: { entityType: 'Note' } }, aliceToken);
    expect(status).toBe(400);
  });
});
