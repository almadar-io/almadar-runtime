// The orb website runs OrbitalServerRuntime in the BROWSER, where the package
// `browser` field maps node:async_hooks to an empty module. Every dispatch must
// still run — and keep its queue semantics (a service call releases the event
// queue while it awaits) — with AsyncLocalStorage unavailable. Regression:
// @almadar/runtime 6.100.0 threw "e is not a constructor" on every event.
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:async_hooks', () => ({}));

import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { EventPayload, OrbitalSchema, UserContext } from '@almadar/core';

const ALICE: UserContext = { id: 'alice', role: 'member' };

function schema(): OrbitalSchema {
  return {
    name: 'reentrant-app',
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
                { key: 'DO_CREATE', name: 'Do create', external: true, payloadSchema: [{ name: 'title', type: 'string', required: true }] },
              ],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'DO_CREATE',
                  effects: [['persist', 'create', 'Task', { title: '@payload.title', ownerId: '@user.id' }]],
                },
              ],
            },
          },
          {
            name: 'Assistant',
            scope: 'instance',
            linkedEntity: 'Task',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }, { name: 'thinking' }],
              events: [
                { key: 'ASK', name: 'Ask', payloadSchema: [{ name: 'message', type: 'string', required: true }] },
                { key: 'ANSWERED', name: 'Answered' },
                { key: 'FAILED', name: 'Failed' },
              ],
              transitions: [
                {
                  from: 'idle', to: 'thinking', event: 'ASK',
                  effects: [[
                    'call-service', 'llm', 'call-tools', { message: '@payload.message' },
                    { emit: { success: 'ANSWERED', failure: 'FAILED' } },
                  ]],
                },
                { from: 'thinking', to: 'idle', event: 'ANSWERED' },
                { from: 'thinking', to: 'idle', event: 'FAILED' },
              ],
            },
          },
        ],
      },
    ],
  };
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`deadlocked: no result after ${ms}ms`)), ms)),
  ]);
}

async function setup(nested: (runtime: OrbitalServerRuntime) => Promise<EventPayload>) {
  const holder: { runtime?: OrbitalServerRuntime } = {};
  const runtime = new OrbitalServerRuntime({
    persistence: new InMemoryPersistence(),
    debug: false,
    effectHandlers: {
      callService: async () => {
        if (!holder.runtime) throw new Error('runtime not registered');
        return nested(holder.runtime);
      },
    },
  });
  holder.runtime = runtime;
  await runtime.register(schema());
  return runtime;
}

describe('browser host (no async_hooks): call-service re-entrant dispatch', () => {
  it('an input dispatched mid-call-service completes, and so does the outer transition', async () => {
    const runtime = await setup(async (rt) => {
      const inner = await rt.dispatchExternalInput('TaskOrbital', {
        targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { title: 'Ship notes' }, user: ALICE,
      });
      return { reply: inner.success ? 'created' : 'failed' };
    });
    const res = await withDeadline(
      runtime.processOrbitalEvent('TaskOrbital', {
        event: 'ASK', targetTrait: 'Assistant', payload: { message: 'create a task' }, user: ALICE,
      }),
      5000,
    );
    expect(res.success).toBe(true);
    const rows = await runtime.persistence.list('Task');
    expect(rows.map((r) => [r.title, r.ownerId])).toEqual([['Ship notes', 'alice']]);
    expect(res.emittedEvents.map((e) => e.event)).toContain('ANSWERED');
  });

  it('control: a call-service that does not re-enter completes the same way', async () => {
    const runtime = await setup(async () => ({ reply: 'nothing to do' }));
    const res = await withDeadline(
      runtime.processOrbitalEvent('TaskOrbital', {
        event: 'ASK', targetTrait: 'Assistant', payload: { message: 'hi' }, user: ALICE,
      }),
      5000,
    );
    expect(res.success).toBe(true);
    expect(res.emittedEvents.map((e) => e.event)).toContain('ANSWERED');
  });
});

describe('browser host (no async_hooks): call-service releases the queue while it awaits', () => {
  it('an unrelated dispatch is served while a service call is still in flight', async () => {
    let finishService: () => void = () => undefined;
    const serviceGate = new Promise<void>((resolve) => {
      finishService = resolve;
    });
    const runtime = await setup(async () => {
      await serviceGate;
      return { reply: 'late' };
    });
    const asking = runtime.processOrbitalEvent('TaskOrbital', {
      event: 'ASK', targetTrait: 'Assistant', payload: { message: 'slow' }, user: ALICE,
    });
    const other = await withDeadline(
      runtime.dispatchExternalInput('TaskOrbital', {
        targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { title: 'Meanwhile' }, user: ALICE,
      }),
      5000,
    );
    expect(other.success).toBe(true);
    finishService();
    const asked = await withDeadline(asking, 5000);
    expect(asked.emittedEvents.map((e) => e.event)).toContain('ANSWERED');
  });
});

describe('browser host (no async_hooks): plain lifecycle dispatch', () => {
  it('INIT runs instead of throwing', async () => {
    const runtime = await setup(async () => ({ reply: 'unused' }));
    const res = await withDeadline(
      runtime.processOrbitalEvent('TaskOrbital', { event: 'INIT', user: ALICE }),
      5000,
    );
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
  });
});
