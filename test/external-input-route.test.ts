// HTTP face of the outside-client input channel: `GET /inputs` lists the declared inputs,
// `POST /:orbital/inputs` dispatches only a declared input, as the AUTHENTICATED user — a
// `user` field in the body is never trusted.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { OrbitalSchema } from '@almadar/core';

const schema: OrbitalSchema = {
  name: 'external-input-route-app',
  version: '1.0.0',
  orbitals: [
    {
      name: 'TaskOrbital',
      pages: [],
      entity: {
        name: 'Task',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'title', type: 'string' },
          { name: 'ownerId', type: 'string' },
        ],
      },
      traits: [
        {
          name: 'TaskPersistor',
          scope: 'instance',
          linkedEntity: 'Task',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [
              { key: 'DO_CREATE', name: 'Do create', external: true, description: 'Create a task', payloadSchema: [{ name: 'title', type: 'string', required: true }] },
              { key: 'SAVE', name: 'Save' },
            ],
            transitions: [
              { from: 'idle', to: 'idle', event: 'DO_CREATE', effects: [['persist', 'create', 'Task', { title: '@payload.title', ownerId: '@user.id' }]] },
              { from: 'idle', to: 'idle', event: 'SAVE', effects: [['persist', 'create', 'Task', { title: '@payload.title' }]] },
            ],
          },
        },
      ],
    },
  ],
};

let server: http.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(authUser?: { uid: string; role: string }) {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(schema);
  const app = express();
  app.use(express.json());
  if (authUser) {
    app.use((req, _res, next) => {
      (req as express.Request & { firebaseUser?: { uid: string; role: string } }).firebaseUser = authUser;
      next();
    });
  }
  app.use('/api/orbitals', runtime.router());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server!.address() as { port: number }).port;
  return { runtime, base: `http://localhost:${port}/api/orbitals` };
}

const post = (url: string, body: object) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('external input routes', () => {
  it('GET /inputs lists the declared inputs', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/inputs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inputs: Array<{ orbital: string; trait: string; event: string; description?: string }> };
    expect(body.inputs).toEqual([
      expect.objectContaining({ orbital: 'TaskOrbital', trait: 'TaskPersistor', event: 'DO_CREATE', description: 'Create a task' }),
    ]);
  });

  it('POST /:orbital/inputs dispatches a declared input as the authenticated user', async () => {
    const { base, runtime } = await serve({ uid: 'alice', role: 'member' });
    const res = await post(`${base}/TaskOrbital/inputs`, { targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { title: 'T1' } });
    expect(res.status).toBe(200);
    expect((await runtime.persistence.list('Task')).map((r) => r.ownerId)).toEqual(['alice']);
  });

  it('refuses an undeclared event with 403 and the structured reason', async () => {
    const { base, runtime } = await serve({ uid: 'alice', role: 'member' });
    const res = await post(`${base}/TaskOrbital/inputs`, { targetTrait: 'TaskPersistor', event: 'SAVE', payload: { title: 'x' } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { rejections?: Array<{ code: string }> };
    expect(body.rejections?.[0]?.code).toBe('not-an-external-input');
    expect(await runtime.persistence.list('Task')).toEqual([]);
  });

  it('never trusts a user named in the body', async () => {
    const { base, runtime } = await serve({ uid: 'alice', role: 'member' });
    await post(`${base}/TaskOrbital/inputs`, {
      targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { title: 'T2' }, user: { id: 'mallory', role: 'admin' },
    });
    expect((await runtime.persistence.list('Task')).map((r) => r.ownerId)).toEqual(['alice']);
  });
});
