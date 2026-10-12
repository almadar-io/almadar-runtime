/**
 * A client tick whose effects write browser-stored data (drift D-1): the client kernel runs the tick
 * locally and posts ONE `runTick` leg, which the browser store runs as the data authority. Twin of
 * orbital-core `tests/tick_browser_leg.rs`.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalEventRequest, OrbitalSchema, TraitTick } from '@almadar/core';
import { InMemoryPersistence } from '@almadar/db/mock';
import {
  buildTraitIndex,
  createClientKernel,
  createLocalStoreTransport,
  createMemoryCircuitStore,
  createResidenceTransport,
} from '../src/index.js';
import type { EventTransport } from '../src/server/EventTransport.js';

function schema(tick: TraitTick): OrbitalSchema {
  return {
    name: 'demo',
    version: '1.0.0',
    orbitals: [{
      name: 'Editing',
      pages: [],
      entity: { name: 'Draft', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'text', type: 'string', default: 'unsaved' }] },
      auxiliaryEntities: [{ name: 'Note', persistence: 'persistent', collection: 'notes', local: true,
        fields: [{ name: 'id', type: 'string' }, { name: 'text', type: 'string' }] }],
      traits: [{
        name: 'Editor', linkedEntity: 'Draft', scope: 'instance',
        stateMachine: { states: [{ name: 'editing', isInitial: true }], events: [], transitions: [] },
        ticks: [tick],
      }],
    }],
  };
}

const tickRequest = (tick: string): OrbitalEventRequest => ({
  event: `$TICK_${tick}`,
  runTick: { trait: 'Editor', tick },
  targetTrait: 'Editor',
  tick,
});

async function fire(tick: TraitTick) {
  const s = schema(tick);
  const traitIndex = buildTraitIndex(s.orbitals);
  const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
  const browser = new InMemoryPersistence();
  const local = createLocalStoreTransport({ traitIndex, store, persistence: browser, clientRelays: true });
  const posted: OrbitalEventRequest[] = [];
  const residence = createResidenceTransport({ local, traitIndex });
  const spy: EventTransport = { ...residence, send: (orbital, request) => { posted.push(request); return residence.send(orbital, request); } };
  const kernel = createClientKernel({ orbitalName: 'Editing', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false, transport: spy });
  const outcome = await kernel.dispatch(tickRequest(tick.name));
  await outcome.tickSettled;
  return { browser, posted, store };
}

describe('a client tick writing browser-stored data', () => {
  it('posts one runTick leg and the row lands in the browser store', async () => {
    const { browser, posted } = await fire({ name: 'autosave', interval: 1000, effects: [['persist', 'create', 'Note', { id: 'N-1', text: '@entity.text' }]] });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ event: '$TICK_autosave', runTick: { trait: 'Editor', tick: 'autosave' }, targetTrait: 'Editor' });
    expect(await browser.getById('Note', 'N-1')).toMatchObject({ text: 'unsaved' });
  });

  it('control: a tick with only frame writes posts nothing and writes the frame locally', async () => {
    const { browser, posted, store } = await fire({ name: 'mark', interval: 1000, effects: [['set', '@entity.text', 'marked']] });
    expect(posted).toEqual([]);
    expect(await browser.list('Note')).toEqual([]);
    expect(JSON.stringify([...store.frames.values()])).toContain('marked');
  });

  it('edge: a tick whose guard blocks posts nothing', async () => {
    const { browser, posted } = await fire({ name: 'autosave', interval: 1000, guard: ['=', '@state', 'gone'], effects: [['persist', 'create', 'Note', { id: 'N-1' }]] });
    expect(posted).toEqual([]);
    expect(await browser.getById('Note', 'N-1')).toBeNull();
  });
});
