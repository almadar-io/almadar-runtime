// The outside-client input channel: only declared external inputs pass, as the given user,
// through the same dispatch a click uses (guards, policies). The app's own event channel is unchanged.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import type { OrbitalSchema, SExpr, UserContext } from '@almadar/core';

const MEMBERS_ONLY: SExpr = ['=', '@user.role', 'member'];

function schema(): OrbitalSchema {
  return {
    name: 'external-input-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'TaskOrbital',
        pages: [],
        entity: {
          name: 'Task',
          persistence: 'persistent',
          create_policy: MEMBERS_ONLY,
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
                { key: 'SAVE', name: 'Save' },
              ],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'DO_CREATE',
                  effects: [['persist', 'create', 'Task', { title: '@payload.title', ownerId: '@user.id' }]],
                },
                {
                  from: 'idle', to: 'idle', event: 'SAVE',
                  effects: [['persist', 'create', 'Task', { title: '@payload.title', ownerId: '@user.id' }]],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const ALICE: UserContext = { id: 'alice', role: 'member' };
const VIEWER: UserContext = { id: 'vic', role: 'viewer' };

async function setup() {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(schema());
  return runtime;
}

describe('OrbitalServerRuntime.dispatchExternalInput', () => {
  it('runs a declared input as the given user', async () => {
    const runtime = await setup();
    const res = await runtime.dispatchExternalInput('TaskOrbital', {
      targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { title: 'Ship notes' }, user: ALICE,
    });
    expect(res.success).toBe(true);
    const rows = await runtime.persistence.list('Task');
    expect(rows.map((r) => [r.title, r.ownerId])).toEqual([['Ship notes', 'alice']]);
  });

  it('applies the entity policy for that user', async () => {
    const runtime = await setup();
    const res = await runtime.dispatchExternalInput('TaskOrbital', {
      targetTrait: 'TaskPersistor', event: 'DO_CREATE', payload: { title: 'Nope' }, user: VIEWER,
    });
    expect(res.effectResults?.some((r) => r.denied === true)).toBe(true);
    expect(await runtime.persistence.list('Task')).toEqual([]);
  });

  it('refuses an event that is not a declared input, with a structured reason', async () => {
    const runtime = await setup();
    const res = await runtime.dispatchExternalInput('TaskOrbital', {
      targetTrait: 'TaskPersistor', event: 'SAVE', payload: { title: 'x' }, user: ALICE,
    });
    expect(res.success).toBe(false);
    expect(res.transitioned).toBe(false);
    expect(res.rejections).toEqual([{ code: 'not-an-external-input', trait: 'TaskPersistor', event: 'SAVE' }]);
    expect(await runtime.persistence.list('Task')).toEqual([]);
  });

  it('refuses an unknown trait or orbital the same way', async () => {
    const runtime = await setup();
    for (const [orbital, trait] of [['TaskOrbital', 'Nope'], ['Nope', 'TaskPersistor']] as const) {
      const res = await runtime.dispatchExternalInput(orbital, { targetTrait: trait, event: 'DO_CREATE', payload: {}, user: ALICE });
      expect(res.rejections?.[0]?.code).toBe('not-an-external-input');
    }
  });

  it('lists the declared inputs', async () => {
    const runtime = await setup();
    expect(runtime.listExternalInputs().map((i) => `${i.orbital}.${i.trait}.${i.event}`)).toEqual([
      'TaskOrbital.TaskPersistor.DO_CREATE',
    ]);
  });

  it('control: the app\'s own event channel still delivers non-input events', async () => {
    const runtime = await setup();
    const res = await runtime.processOrbitalEvent('TaskOrbital', { event: 'SAVE', payload: { title: 'From UI' }, user: ALICE });
    expect(res.success).toBe(true);
    expect((await runtime.persistence.list('Task')).map((r) => r.title)).toEqual(['From UI']);
  });
});
