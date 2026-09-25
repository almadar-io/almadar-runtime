// A persist's declared `emit.success` fires with the stored outcome: the row for create/update, `{ id, deleted }` for delete. Twin of orbital-core `tests/persist_success_emit.rs`.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const arm = (event: string, effects: TypedEffect[]) => ({ from: 'idle', to: 'idle', event, effects });
const emit = { emit: { success: 'SAVED', failure: 'SAVE_FAILED' } };

const schema: OrbitalSchema = {
  name: 'persist-success', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Note', persistence: 'persistent', collection: 'notes', fields: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }] },
    traits: [{
      name: 'Notes', linkedEntity: 'Note', scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }], events: [],
        transitions: [
          arm('CREATE', [['persist', 'create', 'Note', { id: 'n1', title: 'first' }, emit]]),
          arm('UPDATE', [['persist', 'update', 'Note', { id: 'n1', title: 'second' }, emit]]),
          arm('DELETE', [['persist', 'delete', 'Note', 'n1', emit]]),
          arm('SILENT', [['persist', 'create', 'Note', { id: 'n2', title: 'quiet' }]]),
          arm('ANON', [['persist', 'create', 'Note', { title: 'no id' }, emit]]),
        ],
      },
    }],
  }],
};

async function runtime() {
  const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  await rt.register(schema);
  return rt;
}

const send = async (rt: OrbitalServerRuntime, event: string) =>
  (await rt.processOrbitalEvent('Main', { event, payload: {}, targetTrait: 'Notes' })).emittedEvents.map((e) => ({ event: e.event, payload: e.payload }));

describe('persist emit.success', () => {
  it('create fires success with the stored row', async () => {
    const out = await send(await runtime(), 'CREATE');
    expect(out).toEqual([{ event: 'SAVED', payload: expect.objectContaining({ id: 'n1', title: 'first' }) }]);
  });

  it('update fires success with the updated row', async () => {
    const rt = await runtime();
    await send(rt, 'CREATE');
    expect(await send(rt, 'UPDATE')).toEqual([{ event: 'SAVED', payload: expect.objectContaining({ id: 'n1', title: 'second' }) }]);
  });

  it('delete fires success with the deleted id', async () => {
    const rt = await runtime();
    await send(rt, 'CREATE');
    expect(await send(rt, 'DELETE')).toEqual([{ event: 'SAVED', payload: { id: 'n1', deleted: true } }]);
  });

  it('control: a persist that declares no emit fires nothing', async () => {
    expect(await send(await runtime(), 'SILENT')).toEqual([]);
  });

  it('an id-less create mints a distinct id each time', async () => {
    const rt = await runtime();
    const [a] = await send(rt, 'ANON');
    const [b] = await send(rt, 'ANON');
    const ids = [a?.payload?.['id'], b?.payload?.['id']];
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
