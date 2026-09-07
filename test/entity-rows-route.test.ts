/**
 * `GET /:orbital/entities/:entityType` — C1-V12: full mock-store row set
 * for verification tooling, bypassing whatever subset the browser's own
 * rendered snapshot happens to show. Read-only; app CRUD still goes
 * exclusively through `/:orbital/events`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

const schema: OrbitalSchema = {
  name: 'entity-rows-test-app',
  version: '1.0.0',
  orbitals: [
    {
      name: 'Notes',
      pages: [],
      entity: {
        name: 'Note',
        persistence: 'runtime',
        fields: [
          { name: 'id', type: 'string' },
          { name: 'title', type: 'string' },
        ],
      },
      traits: [
        {
          name: 'noteList',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'browsing', isInitial: true }],
            events: [],
            transitions: [],
          },
        },
      ],
    },
  ],
};

describe('GET /:orbital/entities/:entityType', () => {
  let server: http.Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it('returns the FULL mock-store row set, not a browser-visible subset', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(schema);
    // register() auto-seeds one default row; explicitly create more on top
    // of it — more rows than any page-limited browser view would render.
    // The whole point of this route is that it ignores that limit entirely.
    // The mock store assigns its own ids (`nextId`), so capture the ones
    // `create` actually returns rather than assuming the input `id` sticks.
    const { id: n1 } = await runtime.persistence.create('Note', { title: 'Root' });
    const { id: n2 } = await runtime.persistence.create('Note', { title: 'Child of n1' });
    const { id: n3 } = await runtime.persistence.create('Note', { title: 'Grandchild' });

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server!.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/orbitals/Notes/entities/Note`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      entityType: string;
      rows: Array<{ id: string; title: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.entityType).toBe('Note');
    // Auto-seeded row (1) + the three explicitly created above.
    expect(body.rows.length).toBe(4);
    expect(body.rows.map((r) => r.id)).toEqual(expect.arrayContaining([n1, n2, n3]));
  });

  it('404s on an unregistered orbital', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(schema);

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server!.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/orbitals/DoesNotExist/entities/Note`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('empty array for an entity type with no store yet', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(schema);

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server!.address() as { port: number }).port;

    // 'Ghost' was never registered/seeded on this orbital — the store is
    // simply empty, not an error (the orbital itself IS registered, which
    // is the only existence check this route makes).
    const res = await fetch(`http://localhost:${port}/api/orbitals/Notes/entities/Ghost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; rows: unknown[] };
    expect(body.success).toBe(true);
    expect(body.rows).toEqual([]);
  });
});
