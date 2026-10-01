import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, Trait } from '@almadar/core';

// A `listens`-addressed event value (`Trait.EVENT`, `Orbital.Trait.EVENT`)
// follows import renames exactly as a `listens` source does, and a consumer
// addresses an imported trait by local orbital + upstream trait name. Twins of
// `orbital-compiler` `inline/orbital.rs` (`imported_event_values` tests) and
// `tests/imported_trait_addressing.rs`.

function addressConfig(one: string, tool: string): Trait['config'] {
  return {
    one: { type: 'event', default: one },
    tools: {
      type: 'array',
      default: [{ event: tool }],
      items: { type: 'object', properties: { event: { name: 'event', type: 'event' } } },
    },
  };
}

function upstream(one: string, tool: string): Orbital {
  return {
    name: 'ThingOrbital',
    entity: { name: 'Thing', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'ThingPersistor',
        linkedEntity: 'Thing',
        scope: 'instance',
        category: 'lifecycle',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }, { key: 'DO_SAVE', name: 'Do save', external: true }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT' },
            { from: 'idle', to: 'idle', event: 'DO_SAVE', effects: [['emit', 'SAVED', {}]] },
          ],
        },
        emits: [{ event: 'SAVED', scope: 'external' }],
      },
      {
        name: 'ThingTools',
        linkedEntity: 'Thing',
        scope: 'instance',
        category: 'interaction',
        config: addressConfig(one, tool),
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT' }],
        },
      },
    ],
    pages: [],
  } as Orbital;
}

function loaderFor(orbital: Orbital): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      return { success: true, data: { orbital, orbitals: [orbital], sourcePath: './up.orb', importPath } };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {},
    getCacheStats() {
      return { size: 0 };
    },
  };
}

function importOrbital(events?: Record<string, string>, bodyTraits: Trait[] = []): OrbitalDefinition {
  return {
    name: 'Things',
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: bodyTraits,
    pages: [],
    reference: { ref: 'Up.orbitals.ThingOrbital', ...(events ? { events } : {}) },
  } as OrbitalDefinition;
}

function watcher(listenTrait: string, tool: string): OrbitalDefinition {
  return {
    name: 'Watcher',
    entity: { name: 'Note', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'NoteLog',
        linkedEntity: 'Note',
        scope: 'instance',
        category: 'interaction',
        config: addressConfig(tool, tool),
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }, { key: 'LOG', name: 'Log' }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT' },
            { from: 'idle', to: 'idle', event: 'LOG' },
          ],
        },
        listens: [{ event: 'SAVED', triggers: 'LOG', source: { kind: 'orbital', orbital: 'Things', trait: listenTrait } }],
      },
    ],
    pages: [],
  } as OrbitalDefinition;
}

async function resolve(up: Orbital, orbitals: OrbitalDefinition[]): Promise<OrbitalDefinition[]> {
  const resolver = new ReferenceResolver({ basePath: '.', loader: loaderFor(up) });
  const schema: OrbitalSchema = { name: 'S', orbitals };
  const result = await resolver.resolveOrbitalImports(schema);
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data;
}

function trait(orbitals: OrbitalDefinition[], name: string): Trait {
  const found = orbitals.flatMap((o) => o.traits as Trait[]).find((t) => t.name === name);
  if (!found) throw new Error(`trait ${name} missing`);
  return found;
}

function values(t: Trait): [unknown, unknown] {
  const cfg = t.config ?? {};
  const tools = cfg.tools?.default;
  return [cfg.one?.default, Array.isArray(tools) ? (tools[0] as { event?: string }).event : undefined];
}

describe('event-typed values follow import renames', () => {
  it('a trait-addressed value follows the import prefix', async () => {
    const out = await resolve(upstream('ThingPersistor.DO_SAVE', 'ThingPersistor.DO_SAVE'), [importOrbital()]);
    expect(values(trait(out, 'ThingsThingTools'))).toEqual(['ThingsThingPersistor.DO_SAVE', 'ThingsThingPersistor.DO_SAVE']);
  });

  it('an orbital-addressed value naming its own upstream follows the import', async () => {
    const out = await resolve(upstream('ThingOrbital.ThingPersistor.DO_SAVE', 'ThingOrbital.ThingPersistor.DO_SAVE'), [
      importOrbital(),
    ]);
    expect(values(trait(out, 'ThingsThingTools'))).toEqual([
      'Things.ThingsThingPersistor.DO_SAVE',
      'Things.ThingsThingPersistor.DO_SAVE',
    ]);
  });

  it('an addressed value follows an events rename of its trait', async () => {
    const out = await resolve(upstream('ThingPersistor.DO_SAVE', 'ThingOrbital.ThingPersistor.DO_SAVE'), [
      importOrbital({ DO_SAVE: 'SAVE_NOW' }),
    ]);
    expect(values(trait(out, 'ThingsThingTools'))).toEqual([
      'ThingsThingPersistor.SAVE_NOW',
      'Things.ThingsThingPersistor.SAVE_NOW',
    ]);
  });

  it('control: an address into another orbital is left alone', async () => {
    const out = await resolve(upstream('Elsewhere.B.PING', 'Elsewhere.B.PING'), [importOrbital()]);
    expect(values(trait(out, 'ThingsThingTools'))).toEqual(['Elsewhere.B.PING', 'Elsewhere.B.PING']);
  });
});

describe('a consumer addresses an imported trait by local orbital + upstream trait', () => {
  const up = upstream('ThingPersistor.DO_SAVE', 'ThingPersistor.DO_SAVE');

  it('a listen lands on the materialized name', async () => {
    const out = await resolve(up, [importOrbital(), watcher('ThingPersistor', 'Things.ThingPersistor.DO_SAVE')]);
    expect(trait(out, 'NoteLog').listens?.[0].source).toEqual(
      expect.objectContaining({ kind: 'orbital', orbital: 'Things', trait: 'ThingsThingPersistor' }),
    );
  });

  it('an event value lands on the materialized name', async () => {
    const out = await resolve(up, [importOrbital(), watcher('ThingPersistor', 'Things.ThingPersistor.DO_SAVE')]);
    expect(values(trait(out, 'NoteLog'))).toEqual([
      'Things.ThingsThingPersistor.DO_SAVE',
      'Things.ThingsThingPersistor.DO_SAVE',
    ]);
  });

  it('a body trait named like an upstream trait keeps its own name', async () => {
    const body: Trait = {
      name: 'ThingPersistor',
      linkedEntity: 'Thing',
      scope: 'instance',
      category: 'interaction',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
      emits: [{ event: 'SAVED', scope: 'external' }],
    };
    const out = await resolve(up, [importOrbital(undefined, [body]), watcher('ThingPersistor', 'Things.ThingsThingPersistor.DO_SAVE')]);
    expect(trait(out, 'NoteLog').listens?.[0].source).toEqual(
      expect.objectContaining({ kind: 'orbital', orbital: 'Things', trait: 'ThingPersistor' }),
    );
  });

  it('control: the materialized name also resolves', async () => {
    const out = await resolve(up, [importOrbital(), watcher('ThingsThingPersistor', 'Things.ThingsThingPersistor.DO_SAVE')]);
    expect(trait(out, 'NoteLog').listens?.[0].source).toEqual(
      expect.objectContaining({ trait: 'ThingsThingPersistor' }),
    );
  });
});
