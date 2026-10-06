// `@user` for an authenticated request comes from `resolveViewer` against the program's
// `[identity]` entity: the directory row when one is declared, the token's claims otherwise.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { OrbitalEntity, OrbitalSchema } from '@almadar/core';
import type { VerifiedUser } from '@almadar/auth';
import { InMemoryPersistence } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const task: OrbitalEntity = {
  name: 'Task',
  persistence: 'persistent',
  fields: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'ownerId', type: 'string' },
    { name: 'ownerRole', type: 'string' },
  ],
};

const member: OrbitalEntity = {
  name: 'Member',
  persistence: 'persistent',
  identity: true,
  fields: [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'role', type: 'string' },
  ],
};

function program(withDirectory: boolean): OrbitalSchema {
  return {
    name: 'request-viewer-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'TaskOrbital',
        pages: [],
        entity: task,
        traits: [{
          name: 'TaskPersistor',
          scope: 'instance',
          linkedEntity: 'Task',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'DO_CREATE', name: 'Do create', external: true, payloadSchema: [] }],
            transitions: [{
              from: 'idle', to: 'idle', event: 'DO_CREATE',
              effects: [['persist', 'create', 'Task', { ownerId: '@user.id', ownerRole: '@user.role' }]],
            }],
          },
        }],
      },
      ...(withDirectory ? [{ name: 'MemberOrbital', pages: [], entity: member, traits: [] }] : []),
    ],
  };
}

const alice: VerifiedUser = { uid: 'alice', provider: 'firebase', email: 'alice@example.com', claims: { role: 'admin' } };

let server: http.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function createAs(schema: OrbitalSchema, seed: (store: InMemoryPersistence) => Promise<void>, verified: VerifiedUser | null = alice) {
  const store = new InMemoryPersistence();
  const runtime = new OrbitalServerRuntime({ persistence: store, debug: false, defaultUser: { id: 'host-default', role: 'admin' } });
  await runtime.register(schema);
  await seed(store);
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
  const res = await fetch(`http://localhost:${address.port}/api/orbitals/TaskOrbital/inputs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetTrait: 'TaskPersistor', event: 'DO_CREATE' }),
  });
  expect(res.status).toBe(200);
  const [row] = await store.list('Task');
  return row;
}

describe('request viewer', () => {
  it('[persistent, identity]: @user is the directory row, not the token claim', async () => {
    const row = await createAs(program(true), async (store) => {
      for (const existing of await store.list('Member')) await store.delete('Member', String(existing.id));
      await store.create('Member', { id: 'alice', role: 'editor' });
    });
    expect(row).toMatchObject({ ownerId: 'alice', ownerRole: 'editor' });
  });

  it('[persistent, identity] with no row yet: token fields only, the role claim never leaks', async () => {
    const row = await createAs(program(true), async (store) => {
      for (const existing of await store.list('Member')) await store.delete('Member', String(existing.id));
    });
    expect(row?.ownerId).toBe('alice');
    expect(row?.ownerRole).not.toBe('admin');
  });

  it('no verified user is the anonymous viewer, never the host default', async () => {
    const row = await createAs(program(false), async () => {}, null);
    expect(row).toMatchObject({ ownerId: 'anonymous', ownerRole: 'anonymous' });
  });

  it('no [identity] entity: @user reads the token claims', async () => {
    const row = await createAs(program(false), async () => {});
    expect(row).toMatchObject({ ownerId: 'alice', ownerRole: 'admin' });
  });

  it('a host tool runtime acts as its declared principal, whatever the request carries', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false, principal: { id: 'operator', role: 'owner' } });
    await runtime.register(program(true));
    expect(await runtime.viewerOf(alice)).toEqual({ id: 'operator', role: 'owner' });
    expect(await runtime.viewerOf(undefined)).toEqual({ id: 'operator', role: 'owner' });
  });
});
