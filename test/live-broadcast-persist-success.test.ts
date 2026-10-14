// The live-broadcast sink hears a `persist` effect's `emit.success` envelope, aimed at the other connected clients
// (`target: 'peers'`), and nothing else: a plain `emit` and a failure envelope are not broadcast.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime, type LiveBroadcastItem } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

const schema: OrbitalSchema = {
  name: 'live-peers',
  version: '1.0.0',
  orbitals: [{
    name: 'NotesOrbital',
    pages: [],
    entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string', primaryKey: true }, { name: 'title', type: 'string' }] },
    traits: [{
      name: 'Notes',
      scope: 'instance',
      linkedEntity: 'Note',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'SAVE', name: 'Save' }, { key: 'PING', name: 'Ping' }],
        transitions: [
          { from: 'idle', to: 'idle', event: 'SAVE', effects: [['persist', 'create', 'Note', { title: 'first' }, { emit: { success: 'SAVED', failure: 'SAVE_FAILED' } }], ['emit', 'PLAIN', {}]] },
          { from: 'idle', to: 'idle', event: 'PING', effects: [['emit', 'PLAIN', {}]] },
        ],
      },
      emits: [{ event: 'PLAIN', scope: 'internal' }],
    }],
  }],
};

async function setup(persistence = new InMemoryPersistence()) {
  const items: LiveBroadcastItem[] = [];
  const runtime = new OrbitalServerRuntime({ persistence, debug: false });
  runtime.setLiveBroadcastSink((item) => items.push(item));
  await runtime.register(schema);
  return { runtime, items };
}

describe('live broadcast of a persist success', () => {
  it('fans the success envelope out to the peers of the requesting client, and only it', async () => {
    const { runtime, items } = await setup();
    const res = await runtime.processOrbitalEvent('NotesOrbital', { event: 'SAVE', targetTrait: 'Notes', clientId: 'tab-1' });
    expect(res.success).toBe(true);
    expect(items.map((i) => [i.event, i.target, i.originClientId, i.source.trait])).toEqual([['SAVED', 'peers', 'tab-1', 'Notes']]);
    expect(items[0]?.payload).toMatchObject({ title: 'first' });
  });

  it('control: a plain emit is not broadcast', async () => {
    const { runtime, items } = await setup();
    await runtime.processOrbitalEvent('NotesOrbital', { event: 'PING', targetTrait: 'Notes', clientId: 'tab-1' });
    expect(items).toEqual([]);
  });

  it('control: a refused persist broadcasts no success', async () => {
    const persistence = new InMemoryPersistence();
    persistence.create = async () => { throw new Error('disk full'); };
    const { runtime, items } = await setup(persistence);
    await runtime.processOrbitalEvent('NotesOrbital', { event: 'SAVE', targetTrait: 'Notes', clientId: 'tab-1' });
    expect(items.map((i) => i.event)).toEqual([]);
  });
});
