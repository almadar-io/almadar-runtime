/**
 * `@payload` is the payload of the event being processed, and only that (owner ruling 2026-10-12,
 * drift D-2): nothing a trait received earlier carries over, an empty payload reads `{}`, and a
 * tick has no payload. Twin of orbital-core `tests/payload_is_the_events_own.rs`.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import { buildTraitIndex } from '../src/traits/trait-index';
import { createMemoryCircuitStore } from '../src/evaluation/circuit-store';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';

const orbital: OrbitalDefinition = {
  name: 'Main',
  entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
  traits: [{
    name: 'Picker', linkedEntity: 'Item', category: 'interaction', scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'PICK', name: 'PICK' }, { key: 'SHOW', name: 'SHOW' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'PICK', effects: [['set', '@entity.picked', '@payload.row']] },
        { from: 'idle', to: 'idle', event: 'SHOW', effects: [['set', '@entity.shown', '@payload.row'], ['set', '@entity.whole', '@payload']] },
      ],
    },
    ticks: [{ name: 'beat', interval: 1000, effects: [['set', '@entity.ticked', '@payload.row']] }],
  }],
  pages: [],
};

function host() {
  const traitIndex = buildTraitIndex([orbital]);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  return createLocalStoreTransport({ traitIndex, store, persistence: new InMemoryPersistence() });
}

describe('@payload is the event\'s own', () => {
  it('an event reads its own payload', async () => {
    const response = await host().send('Main', { event: 'PICK', targetTrait: 'Picker', payload: { row: 'r1' } });
    expect(response.entityByTrait?.Picker).toMatchObject({ picked: 'r1' });
  });

  it('an earlier event\'s payload does not carry over; an empty payload reads {}', async () => {
    const transport = host();
    await transport.send('Main', { event: 'PICK', targetTrait: 'Picker', payload: { row: 'r1' } });
    const response = await transport.send('Main', { event: 'SHOW', targetTrait: 'Picker', payload: {} });
    expect(response.entityByTrait?.Picker?.shown).not.toBe('r1');
    expect(response.entityByTrait?.Picker?.whole).toEqual({});
  });

  it('a tick has no payload', async () => {
    const transport = host();
    await transport.send('Main', { event: 'PICK', targetTrait: 'Picker', payload: { row: 'r1' } });
    const response = await transport.send('Main', { event: '$TICK_beat', runTick: { trait: 'Picker', tick: 'beat' }, targetTrait: 'Picker' });
    expect(response.entityByTrait?.Picker?.ticked).not.toBe('r1');
  });
});
