import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

/**
 * Schema with a trait that emits 2 events and renders a UI effect, so we
 * have multiple incremental items to observe before completion.
 */
const emitSchema: OrbitalSchema = {
  name: 'sse-incremental-app',
  version: '1.0.0',
  orbitals: [
    {
      name: 'Notifier',
      pages: [],
      entity: { name: 'Notifier', fields: [{ name: 'status', type: 'string' }] },
      traits: [
        {
          name: 'notifying',
          scope: 'instance',
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
            events: [{ key: 'NOTIFY', name: 'NOTIFY' }],
            transitions: [
              {
                from: 'idle',
                to: 'done',
                event: 'NOTIFY',
                effects: [
                  ['emit', 'FIRST_EVENT', { msg: 'first' }],
                  ['emit', 'SECOND_EVENT', { msg: 'second' }],
                  ['render-ui', 'main', { type: 'text', text: 'hello' }],
                ],
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('SSE incremental streaming (Express runtime)', () => {
  let server: http.Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('onPush fires for each emitted event and client effect before processOrbitalEvent resolves', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(emitSchema);

    const pushOrder: Array<{ type: string; resolvedAfterPush: boolean }> = [];
    let resolved = false;

    const origProcess = runtime.processOrbitalEvent.bind(runtime);
    runtime.processOrbitalEvent = async (orbitalName, request, onPush) => {
      const wrappedOnPush: typeof onPush = onPush
        ? (item) => {
            pushOrder.push({ type: item.type, resolvedAfterPush: resolved });
            onPush(item);
          }
        : undefined;
      const result = await origProcess(orbitalName, request, wrappedOnPush);
      resolved = true;
      return result;
    };

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
          path: '/api/orbitals/Notifier/events?stream=true',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          let buf = '';
          const collected: string[] = [];
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            const parts = buf.split('\n');
            buf = parts.pop() ?? '';
            for (const line of parts) {
              if (line.startsWith('data: ')) {
                collected.push(line.slice('data: '.length).trim());
              }
            }
          });
          res.on('end', () => resolve(collected));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ event: 'NOTIFY' }));
      req.end();
    });

    const events = lines
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l) as { type: string; data: unknown });

    const types = events.map((e) => e.type);

    // Incremental items arrive before 'complete'
    expect(types).toContain('event');
    expect(types).toContain('effect');
    expect(types).toContain('complete');

    const completeIdx = types.indexOf('complete');
    const firstEventIdx = types.indexOf('event');
    const firstEffectIdx = types.indexOf('effect');

    // Events and effects arrive before the terminal complete
    expect(firstEventIdx).toBeLessThan(completeIdx);
    expect(firstEffectIdx).toBeLessThan(completeIdx);

    // Two emitted events (FIRST_EVENT, SECOND_EVENT) + one render-ui effect = 3 incremental items
    const eventItems = types.filter((t) => t === 'event');
    const effectItems = types.filter((t) => t === 'effect');
    expect(eventItems.length).toBe(2);
    expect(effectItems.length).toBe(1);

    // onPush was called before processOrbitalEvent resolved
    expect(pushOrder.length).toBeGreaterThan(0);
    for (const entry of pushOrder) {
      expect(entry.resolvedAfterPush).toBe(false);
    }
  });

  it('non-stream path unchanged after onPush threading', async () => {
    const runtime = new OrbitalServerRuntime();
    await runtime.register(emitSchema);

    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());

    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const port = (server!.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/api/orbitals/Notifier/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'NOTIFY' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      success: boolean;
      transitioned: boolean;
      emittedEvents: unknown[];
      clientEffects: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.transitioned).toBe(true);
    // Both emitted events and client effects are still present in the JSON body
    expect(body.emittedEvents.length).toBe(2);
    expect(body.clientEffects?.length).toBe(1);
  });
});
