// Inbound deliveries (EXEC-INBOUND-1), JS twin of `orbital-core` `kernel/inbound.rs` tests: the runtime
// decides whether a hook name is served, delivers the handler event with `{headers, body, rawBody}` and
// answers with the handler's own emit — same fixture, same answers as the Rust kernel.
import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

function schemaOf(inbound: string[]): OrbitalSchema {
  return {
    name: 'calendar-app',
    version: '1.0.0',
    inbound,
    orbitals: [
      {
        name: 'Cal',
        pages: [],
        entity: { name: 'Req', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
        traits: [
          {
            name: 'Push',
            scope: 'instance',
            linkedEntity: 'Req',
            emits: [{ event: 'PUSH_ANSWERED' }, { event: 'CAL_REMOTE_CHANGED' }],
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'PUSH', name: 'Push', listened: true, inbound: { name: 'google-calendar', answers: 'PUSH_ANSWERED', verifies: { header: 'x-goog-channel-token', credential: 'CHANNEL_TOKEN' } } },
              ],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'PUSH',
                  guard: ['=', '@payload.verified', false],
                  effects: [['emit', 'PUSH_ANSWERED', { status: 400, body: '{"error":"bad-token"}' }]],
                },
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'PUSH',
                  guard: ['=', '@payload.headers.x-goog-resource-state', 'sync'],
                  effects: [['emit', 'PUSH_ANSWERED', { status: 200, body: '{"ok":true,"dispatched":false}' }]],
                },
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'PUSH',
                  guard: ['=', '@payload.headers.x-goog-resource-state', 'exists'],
                  effects: [
                    ['emit', 'CAL_REMOTE_CHANGED', { resourceState: '@payload.headers.x-goog-resource-state' }],
                    ['emit', 'PUSH_ANSWERED', { status: 200, body: '{"ok":true,"dispatched":true}' }],
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function runtimeOf(inbound: string[]): Promise<OrbitalServerRuntime> {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(schemaOf(inbound));
  return runtime;
}

const deliver = (runtime: OrbitalServerRuntime, name: string, state: string, token: string) =>
  runtime.deliverInbound(name, { headers: { 'X-Goog-Resource-State': state, 'X-Goog-Channel-Token': token }, rawBody: '' });

function withCredential<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CHANNEL_TOKEN;
  if (value === undefined) delete process.env.CHANNEL_TOKEN;
  else process.env.CHANNEL_TOKEN = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env.CHANNEL_TOKEN;
    else process.env.CHANNEL_TOKEN = previous;
  });
}

describe('deliverInbound', () => {
  it('answers with the handler’s own emit', async () => {
    const runtime = await runtimeOf(['google-calendar']);
    expect(await deliver(runtime, 'google-calendar', 'sync', 't')).toEqual({ status: 200, body: '{"ok":true,"dispatched":false}' });
    expect(await deliver(runtime, 'google-calendar', 'exists', 't')).toEqual({ status: 200, body: '{"ok":true,"dispatched":true}' });
  });

  it('checks the sender against the credential the host holds, and an unset credential is unchecked', async () => {
    const runtime = await runtimeOf(['google-calendar']);
    await withCredential('s3cret', async () => {
      expect(await deliver(runtime, 'google-calendar', 'exists', 's3cret')).toMatchObject({ status: 200 });
      expect(await deliver(runtime, 'google-calendar', 'exists', 'guess')).toEqual({ status: 400, body: '{"error":"bad-token"}' });
    });
    await withCredential(undefined, async () => {
      expect(await deliver(runtime, 'google-calendar', 'exists', 'anything')).toMatchObject({ status: 200 });
    });
  });

  it('control: an undeclared name is a 404 and a delivery no arm takes is unanswered', async () => {
    expect(await deliver(await runtimeOf([]), 'google-calendar', 'sync', 't')).toEqual({
      status: 404,
      body: '{"error":"Unknown hook provider: google-calendar"}',
    });
    const runtime = await runtimeOf(['google-calendar']);
    expect(await deliver(runtime, 'slack', 'sync', 't')).toMatchObject({ status: 404 });
    expect(await deliver(runtime, 'google-calendar', 'not_exists', 't')).toEqual({ status: 500, body: '{"error":"inbound-unanswered"}' });
  });
});

describe('the app’s own event route', () => {
  it('refuses an inbound hook event and still serves any other', async () => {
    const runtime = await runtimeOf(['google-calendar']);
    const refused = runtime.refuseInboundOnly('Cal', { event: 'PUSH', targetTrait: 'Push' });
    expect(refused).toMatchObject({
      success: false,
      transitioned: false,
      rejections: [{ code: 'inbound-only-event', trait: 'Push', event: 'PUSH' }],
    });
    expect(refused?.error).toContain('/api/hooks/');
    expect(runtime.refuseInboundOnly('Cal', { event: 'PUSH' })).toMatchObject({ success: false });
    expect(runtime.refuseInboundOnly('Cal', { event: 'INIT', targetTrait: 'Push' })).toBeUndefined();
    expect(runtime.refuseInboundOnly('Other', { event: 'PUSH' })).toBeUndefined();
  });

  it('answers 403 on the event route for an inbound event and serves any other event', async () => {
    const runtime = await runtimeOf(['google-calendar']);
    const app = express();
    app.use(express.json());
    app.use('/api/orbitals', runtime.router());
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const port = (server.address() as { port: number }).port;
      const post = async (body: object) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/orbitals/Cal/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() };
      };
      const refused = await post({ event: 'PUSH', targetTrait: 'Push', payload: { headers: {}, rawBody: '' } });
      expect(refused.status).toBe(403);
      expect(refused.json).toMatchObject({ success: false, rejections: [{ code: 'inbound-only-event', event: 'PUSH' }] });
      const served = await post({ event: 'INIT', targetTrait: 'Push' });
      expect(served.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
