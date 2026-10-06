// A `persist create` the executor refuses before the store is called (a
// required field missing) must be reported in the response's effectResults as a
// failed persist — not answered as a clean success. An outside client (an agent
// firing a declared input) reads effectResults to know whether its write landed.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

function schema(): OrbitalSchema {
  return {
    name: 'required-app',
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
            { name: 'title', type: 'string', required: true },
            { name: 'projectId', type: 'string', required: true },
          ],
        },
        traits: [
          {
            name: 'TaskPersistor',
            scope: 'instance',
            linkedEntity: 'Task',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'DO_CREATE', name: 'Do create', external: true, payloadSchema: [{ name: 'data', type: 'object', required: true }] }],
              transitions: [
                { from: 'idle', to: 'idle', event: 'DO_CREATE', effects: [['persist', 'create', 'Task', '@payload.data']] },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function create(data: Record<string, string>) {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(schema());
  const res = await runtime.dispatchExternalInput('TaskOrbital', {
    targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { data }, user: { id: 'u1', role: 'member' },
  });
  return { res, rows: await runtime.persistence.list('Task') };
}

describe('persist create refused for a missing required field', () => {
  it('is reported as a failed persist naming the missing fields', async () => {
    const { res, rows } = await create({ title: 'Ship notes' });
    expect(rows).toEqual([]);
    const persists = (res.effectResults ?? []).filter((r) => r.effect === 'persist');
    expect(persists).toHaveLength(1);
    expect(persists[0]).toMatchObject({ effect: 'persist', action: 'create', entityType: 'Task', success: false });
    expect(persists[0].error).toContain('projectId');
  });

  it('control: a complete row persists and is reported once, as a success', async () => {
    const { res, rows } = await create({ title: 'Ship notes', projectId: 'p1' });
    expect(rows).toHaveLength(1);
    const persists = (res.effectResults ?? []).filter((r) => r.effect === 'persist');
    expect(persists).toHaveLength(1);
    expect(persists[0]).toMatchObject({ success: true });
  });
});
