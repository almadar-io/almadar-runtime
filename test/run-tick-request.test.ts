/**
 * A `runTick` request (drift D-1): a browser-run tick whose effects touch browser-stored data sends
 * its tick to the data authority, which runs the tick from the carried state — gate, effects, and
 * its emits through the same fan-out an event's step uses.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition, OrbitalEntity, OrbitalEventRequest, TraitTick } from '@almadar/core';
import { buildTraitIndex } from '../src/traits/trait-index';
import { createMemoryCircuitStore } from '../src/evaluation/circuit-store';
import { createLocalStoreTransport } from '../src/evaluation/local-store-transport';
import { IndexedDbPersistence } from '@almadar/db/browser';

const draft: OrbitalEntity = {
  name: 'Draft', persistence: 'runtime',
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'text', type: 'string' }],
};
const note: OrbitalEntity = {
  name: 'Note', persistence: 'persistent', collection: 'notes', local: true,
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'text', type: 'string' }],
};

function orbital(tick: TraitTick): OrbitalDefinition {
  return {
    name: 'Editing',
    entity: draft,
    auxiliaryEntities: [note],
    traits: [
      {
        name: 'Editor', linkedEntity: 'Draft', category: 'interaction', scope: 'instance',
        stateMachine: {
          states: [{ name: 'editing', isInitial: true }, { name: 'clean' }, { name: 'locked' }],
          events: [{ key: 'SAVED', name: 'SAVED' }],
          transitions: [{ from: 'editing', to: 'clean', event: 'SAVED', effects: [] }],
        },
        emits: [{ event: 'SAVED', scope: 'external' }],
        ticks: [tick],
      },
      {
        name: 'Status', linkedEntity: 'Draft', category: 'interaction', scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }, { name: 'noted' }],
          events: [{ key: 'NOTED', name: 'NOTED' }],
          transitions: [{ from: 'idle', to: 'noted', event: 'NOTED', effects: [] }],
        },
        listens: [{ event: 'SAVED', triggers: 'NOTED', source: { kind: 'trait', trait: 'Editor' } }],
      },
    ],
    pages: [],
  };
}

const autosave = (overrides: Partial<TraitTick> = {}): TraitTick => ({
  name: 'autosave',
  interval: 1000,
  effects: [['persist', 'create', 'Note', { id: 'N-1', text: '@entity.text' }], ['emit', 'SAVED']],
  ...overrides,
});

async function host(tick: TraitTick) {
  const traitIndex = buildTraitIndex([orbital(tick)]);
  const persistence = await IndexedDbPersistence.open({ databaseName: `run-tick-${Math.random()}`, entityTypes: ['Note', 'Draft'] });
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  return { persistence, transport: createLocalStoreTransport({ traitIndex, persistence, store }) };
}

const leg = (from: string, tick = 'autosave'): OrbitalEventRequest => ({
  event: `$TICK_${tick}`,
  runTick: { trait: 'Editor', tick },
  targetTrait: 'Editor',
  traits: [{ trait: 'Editor', from }],
  entityByTrait: { Editor: { id: 'draft-1', text: 'unsaved' } },
});

describe('runTick request', () => {
  it('runs the tick from the carried state: writes the browser-stored row and fans its emit out', async () => {
    const { transport, persistence } = await host(autosave());
    const response = await transport.send('Editing', leg('editing'));
    expect(response.success).toBe(true);
    expect(await persistence.getById('Note', 'N-1')).toMatchObject({ text: 'unsaved' });
    expect(response.emittedEvents.map((e) => e.event)).toContain('SAVED');
    expect(response.states).toMatchObject({ Editor: 'clean', Status: 'noted' });
  });

  it('control: a tick whose appliesTo excludes the carried state does not run', async () => {
    const { transport, persistence } = await host(autosave({ appliesTo: ['editing'] }));
    const response = await transport.send('Editing', leg('locked'));
    expect(await persistence.getById('Note', 'N-1')).toBeNull();
    expect(response.transitioned).toBe(false);
    expect(response.rejections?.[0]).toMatchObject({ code: 'guard-rejected', trait: 'Editor', event: '$TICK_autosave' });
  });

  it('a false tick guard blocks the tick', async () => {
    const { transport, persistence } = await host(autosave({ guard: ['=', '@state', 'locked'] }));
    const response = await transport.send('Editing', leg('editing'));
    expect(await persistence.getById('Note', 'N-1')).toBeNull();
    expect(response.transitioned).toBe(false);
  });

  it('edge: a throwing tick guard blocks like a false one', async () => {
    const { transport, persistence } = await host(autosave({ guard: ['=', 1] }));
    const response = await transport.send('Editing', leg('editing'));
    expect(response.success).toBe(true);
    expect(await persistence.getById('Note', 'N-1')).toBeNull();
  });

  it('edge: an undeclared tick is refused, nothing runs', async () => {
    const { transport, persistence } = await host(autosave());
    const response = await transport.send('Editing', leg('editing', 'nope'));
    expect(await persistence.getById('Note', 'N-1')).toBeNull();
    expect(response.rejections?.[0]).toMatchObject({ code: 'no-dispatchable-traits', trait: 'Editor', event: '$TICK_nope' });
  });
});
