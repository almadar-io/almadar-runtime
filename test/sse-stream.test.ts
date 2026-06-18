import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

const minimalSchema: OrbitalSchema = {
  name: 'sse-test-app',
  version: '1.0.0',
  orbitals: [
    {
      name: 'Counter',
      pages: [],
      entity: { name: 'Counter', fields: [{ name: 'count', type: 'number' }] },
      traits: [
        {
          name: 'counting',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'active' }],
            events: [{ key: 'START', name: 'START' }],
            transitions: [{ from: 'idle', to: 'active', event: 'START' }],
          },
        },
      ],
    },
  ],
};

function collectSSE(res: http.IncomingMessage): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const lines: string[] = [];
    res.setEncoding('utf-8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line.startsWith('data: ')) {
          lines.push(line.slice('data: '.length).trim());
        }
      }
    });
    res.on('end', () => resolve(lines));
    res.on('error', reject);
  });
}

describe('POST /:orbital/events?stream=true (Express runtime)', () => {
  let server: http.Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it('non-stream path unchanged: returns JSON OrbitalEventResponse', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(minimalSchema);

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const port = (server!.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/orbitals/Counter/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'START' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { success: boolean; transitioned: boolean };
    expect(body.success).toBe(true);
    expect(body.transitioned).toBe(true);
  });

  it('stream path: content-type text/event-stream, emits data: lines ending with complete', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(minimalSchema);

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const port = (server!.address() as { port: number }).port;

    const lines = await new Promise<string[]>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port,
          path: '/api/orbitals/Counter/events?stream=true',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          collectSSE(res).then(resolve).catch(reject);
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ event: 'START' }));
      req.end();
    });

    expect(lines.length).toBeGreaterThan(0);
    const events = lines
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l) as { type: string });
    const types = events.map((e) => e.type);
    expect(types).toContain('complete');
    const completeEvent = events.find((e) => e.type === 'complete') as
      | { type: string; data: { success: boolean; transitioned: boolean } }
      | undefined;
    expect(completeEvent?.data.success).toBe(true);
    expect(completeEvent?.data.transitioned).toBe(true);
  });

  it('stream path: Accept: text/event-stream header also triggers SSE', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(minimalSchema);

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const port = (server!.address() as { port: number }).port;

    const lines = await new Promise<string[]>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port,
          path: '/api/orbitals/Counter/events',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
        },
        (res) => {
          expect(res.headers['content-type']).toContain('text/event-stream');
          collectSSE(res).then(resolve).catch(reject);
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ event: 'START' }));
      req.end();
    });

    const events = lines
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toContain('complete');
  });
});
