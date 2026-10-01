// `persist create`'s success event carries the row the store holds — declared
// field defaults applied, timestamps normalized — exactly as `persist update`'s
// does, never just the submitted fields plus an id.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

function schema(): OrbitalSchema {
  return {
    name: 'posts-app',
    version: '1.0.0',
    orbitals: [{
      name: 'PostOrbital',
      pages: [],
      entity: {
        name: 'Post',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'content', type: 'string', required: true },
          { name: 'voteCount', type: 'number', default: 0 },
        ],
      },
      traits: [{
        name: 'PostWriter',
        linkedEntity: 'Post',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [
            { key: 'WRITE', name: 'Write' },
            { key: 'EDIT', name: 'Edit' },
            { key: 'Written', name: 'Written' },
          ],
          transitions: [
            { from: 'idle', to: 'idle', event: 'WRITE', effects: [['persist', 'create', 'Post', { content: '@payload.content' }, { emit: { success: 'Written' } }]] },
            { from: 'idle', to: 'idle', event: 'EDIT', effects: [['persist', 'update', 'Post', { id: '@payload.id', content: '@payload.content' }, { emit: { success: 'Written' } }]] },
            { from: 'idle', to: 'idle', event: 'Written', effects: [] },
          ],
        },
      }],
    }],
  };
}

async function written(event: 'WRITE' | 'EDIT', payload: Record<string, string>) {
  const persistence = new MockPersistenceAdapter({ defaultSeedCount: 0 });
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
  await runtime.register(schema());
  const seeded = await persistence.create('Post', { content: 'seed' });
  const res = await runtime.processOrbitalEvent('PostOrbital', {
    event, targetTrait: 'PostWriter', payload: { id: seeded.id, ...payload },
  });
  const emitted = res.emittedEvents.find((e) => e.event === 'Written')?.payload;
  const stored = typeof emitted?.['id'] === 'string' ? await persistence.getById('Post', emitted['id']) : null;
  return { emitted, stored };
}

describe('persist success payload is the stored row', () => {
  it('create emits the stored row, defaults included', async () => {
    const { emitted, stored } = await written('WRITE', { content: 'hello' });
    expect(emitted?.['voteCount']).toBe(0);
    expect(emitted).toEqual(stored);
  });

  it('control: update emits the stored row', async () => {
    const { emitted, stored } = await written('EDIT', { content: 'edited' });
    expect(emitted?.['content']).toBe('edited');
    expect(emitted).toEqual(stored);
  });
});
