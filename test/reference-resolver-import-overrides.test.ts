/**
 * LOLO §8b additions on the interpreted path — the JS twin of orbital-compiler
 * `tests/orbital_import_overrides.rs`: the import's `entity [persistent: tbl]`
 * bracket, `retype {}`, and per-trait `traits { T { … } }` overrides (the §8
 * trait-reference surface, applied to one imported trait). Plus the §8
 * trait-reference `fields {}` / `emitsScope` the JS path used to drop.
 */
import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Entity, EntityPersistence, Orbital, OrbitalDefinition, OrbitalRefObject, OrbitalSchema, Trait } from '@almadar/core';
import { isEntityCall } from '@almadar/core';

function editor(): Trait {
  return {
    name: 'Editor',
    scope: 'instance',
    linkedEntity: 'Note',
    config: { title: { type: 'string', default: 'Edit' } },
    emits: [{ event: 'SAVED' }],
    listens: [{ event: 'RESET', triggers: 'INIT' }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'SAVE', name: 'Save' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: '@entity.body' }]] },
        { from: 'idle', to: 'idle', event: 'SAVE', effects: [['emit', 'SAVED', { body: '@entity.body' }]] },
      ],
    },
  };
}

function viewer(): Trait {
  return {
    name: 'Viewer',
    scope: 'instance',
    linkedEntity: 'Note',
    config: { title: { type: 'string', default: 'View' } },
    emits: [{ event: 'OPENED' }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: '@entity.body' }]] }],
    },
  };
}

function upstream(persistence: EntityPersistence = 'persistent'): Orbital {
  return {
    name: 'NoteOrbital',
    entity: {
      name: 'Note',
      persistence,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'body', type: 'string', default: '', description: 'The note text' },
        { name: 'pinned', type: 'boolean', default: false },
      ],
    },
    traits: [editor(), viewer()],
    pages: [{ name: 'Notes', path: '/notes', traits: [{ ref: 'Editor' }, { ref: 'Viewer' }] }],
  };
}

function loaderFor(up: Orbital): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './notes.orb') {
        return { success: true, data: { orbital: up, orbitals: [up], sourcePath: './notes.orb', importPath } };
      }
      return { success: false, error: `unexpected import path: ${importPath}` };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

function schemaWith(reference: Omit<OrbitalRefObject, 'ref'>): OrbitalSchema {
  return {
    name: 'App',
    orbitals: [
      {
        name: 'Local',
        entity: 'Up.orbitals.NoteOrbital.entity',
        reference: { ref: 'Up.orbitals.NoteOrbital', ...reference },
        traits: [],
        pages: [],
        uses: [{ as: 'Up', from: './notes.orb' }],
      },
    ],
  };
}

async function resolve(reference: Omit<OrbitalRefObject, 'ref'>, up: Orbital = upstream()) {
  return new ReferenceResolver({ basePath: '.', loader: loaderFor(up) }).resolveOrbitalImports(schemaWith(reference));
}

function inlineEntity(o: OrbitalDefinition | undefined): Entity | undefined {
  const e = o?.entity;
  return e !== undefined && typeof e === 'object' && !isEntityCall(e) ? e : undefined;
}

function traitNamed(o: OrbitalDefinition | undefined, name: string): Trait | undefined {
  for (const t of o?.traits ?? []) {
    if (typeof t === 'object' && 'stateMachine' in t && t.name === name) return t;
  }
  return undefined;
}

async function local(reference: Omit<OrbitalRefObject, 'ref'>, up?: Orbital): Promise<OrbitalDefinition | undefined> {
  const result = await resolve(reference, up);
  expect(result.success).toBe(true);
  return result.success ? result.data.find((o) => o.name === 'Local') : undefined;
}

async function errorsOf(reference: Omit<OrbitalRefObject, 'ref'>, up?: Orbital): Promise<string[]> {
  const result = await resolve(reference, up);
  expect(result.success).toBe(false);
  return result.success ? [] : result.errors;
}

describe('§8b entity bracket — persistence, collection, flags', () => {
  it('overrides persistence and collection of a persistent upstream entity, and switches a flag on', async () => {
    const e = inlineEntity(await local({ persistence: 'runtime', collection: 'scratch', local: true }));
    expect(e?.persistence).toBe('runtime');
    expect(e?.collection).toBe('scratch');
    expect(e?.local).toBe(true);
  });

  it('control: without a bracket the entity keeps upstream persistence', async () => {
    const e = inlineEntity(await local({}));
    expect(e?.persistence).toBe('persistent');
    expect(e?.collection).toBeUndefined();
  });

  it('refuses an override on a runtime upstream entity — ORB_O_ENTITY_PERSISTENCE_LOCKED', async () => {
    const errors = await errorsOf({ collection: 'notes' }, upstream('runtime'));
    expect(errors.some((e) => e.includes('ORB_O_ENTITY_PERSISTENCE_LOCKED'))).toBe(true);
  });
});

describe('§8b retype {}', () => {
  it('replaces an existing field, keeping its description', async () => {
    const e = inlineEntity(await local({ retype: [{ name: 'body', type: 'number', default: 0 }] }));
    const body = e?.fields.find((f) => f.name === 'body');
    expect(body?.type).toBe('number');
    expect(body?.description).toBe('The note text');
  });

  it('retypes the post-rename name', async () => {
    const e = inlineEntity(await local({ fields: { body: 'text' }, retype: [{ name: 'text', type: 'number' }] }));
    expect(e?.fields.find((f) => f.name === 'text')?.type).toBe('number');
  });

  it('refuses an unknown field — ORB_O_RETYPE_UNKNOWN_FIELD', async () => {
    const errors = await errorsOf({ retype: [{ name: 'missing', type: 'number' }] });
    expect(errors.some((e) => e.includes('ORB_O_RETYPE_UNKNOWN_FIELD'))).toBe(true);
  });

  it('refuses a field both extended and retyped, and one retyped twice — ORB_O_RETYPE_FIELD_CONFLICT', async () => {
    const both = await errorsOf({ extend: [{ name: 'tag', type: 'string' }], retype: [{ name: 'tag', type: 'number' }] });
    expect(both.some((e) => e.includes('ORB_O_RETYPE_FIELD_CONFLICT'))).toBe(true);
    const twice = await errorsOf({ retype: [{ name: 'body', type: 'number' }, { name: 'body', type: 'boolean' }] });
    expect(twice.some((e) => e.includes('ORB_O_RETYPE_FIELD_CONFLICT'))).toBe(true);
  });

  it('control: extend keeps refusing a collision', async () => {
    const errors = await errorsOf({ extend: [{ name: 'body', type: 'string' }] });
    expect(errors.some((e) => e.includes('ORB_O_EXTEND_FIELD_COLLISION'))).toBe(true);
  });
});

describe('§8b traits { T { … } }', () => {
  it('applies config to the named trait only', async () => {
    const o = await local({ traits: { Editor: { config: { title: { type: 'string', default: 'Write' } } } } });
    expect(traitNamed(o, 'LocalEditor')?.config?.title).toMatchObject({ default: 'Write' });
    expect(traitNamed(o, 'LocalViewer')?.config?.title).toMatchObject({ default: 'View' });
  });

  it('renames events, replaces listens and sets emitsScope on the named trait', async () => {
    const o = await local({
      traits: {
        Editor: {
          events: { SAVE: 'COMMIT' },
          listens: [],
          emitsScope: 'internal',
        },
      },
    });
    const ed = traitNamed(o, 'LocalEditor');
    expect(ed?.stateMachine?.transitions.map((t) => t.event)).toEqual(['INIT', 'COMMIT']);
    expect(ed?.listens).toEqual([]);
    expect(ed?.emits?.map((e) => [e.scope, e.scopeOverridden])).toEqual([['internal', true]]);
    const vw = traitNamed(o, 'LocalViewer');
    expect(vw?.emits?.map((e) => e.scopeOverridden)).toEqual([undefined]);
  });

  it('renames the fields the named trait reads', async () => {
    const o = await local({ traits: { Editor: { fields: { body: 'text' } } } });
    const ed = traitNamed(o, 'LocalEditor');
    expect(JSON.stringify(ed?.stateMachine?.transitions)).toContain('@entity.text');
    expect(JSON.stringify(traitNamed(o, 'LocalViewer')?.stateMachine?.transitions)).toContain('@entity.body');
  });

  it('refuses an unknown trait, an omitted trait and an undeclared knob', async () => {
    expect((await errorsOf({ traits: { Ghost: { config: { title: { type: 'string', default: 'x' } } } } })).some((e) => e.includes('ORB_O_TRAITS_UNKNOWN_TRAIT'))).toBe(true);
    expect((await errorsOf({ omit: ['Viewer'], traits: { Viewer: { config: { title: { type: 'string', default: 'x' } } } } })).some((e) => e.includes('ORB_O_TRAITS_OMITTED_TRAIT'))).toBe(true);
    expect((await errorsOf({ traits: { Editor: { config: { nope: { type: 'unknown', default: 'x' } } } } })).some((e) => e.includes('ORB_O_CONFIG_UNKNOWN_KEY'))).toBe(true);
  });

  it('control: a typed re-declaration of a knob the trait does not declare is accepted', async () => {
    expect((await resolve({ traits: { Editor: { config: { nope: { type: 'string', default: 'x' } } } } })).success).toBe(true);
  });

  it('control: no traits {} leaves both traits as upstream', async () => {
    const o = await local({});
    expect(traitNamed(o, 'LocalEditor')?.config?.title).toMatchObject({ default: 'Edit' });
    expect(traitNamed(o, 'LocalEditor')?.listens).toEqual([{ event: 'RESET', triggers: 'INIT' }]);
  });
});

describe('§8 trait reference — fields {} and emitsScope (JS parity with apply_overrides_to_trait)', () => {
  function consumer(overrides: { fields?: Record<string, string>; emitsScope?: 'internal' | 'external' }): Orbital {
    return {
      name: 'Consumer',
      entity: {
        name: 'Memo',
        persistence: 'persistent',
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'text', type: 'string', default: '' },
          { name: 'body', type: 'string', default: '' },
        ],
      },
      traits: [{ ref: 'Up.traits.Editor', name: 'MemoEditor', linkedEntity: 'Memo', ...overrides }],
      pages: [],
      uses: [{ as: 'Up', from: './notes.orb' }],
    };
  }

  async function resolved(overrides: { fields?: Record<string, string>; emitsScope?: 'internal' | 'external' }): Promise<Trait | undefined> {
    const result = await new ReferenceResolver({ basePath: '.', loader: loaderFor(upstream()) }).resolve(consumer(overrides));
    expect(result.success).toBe(true);
    return result.success ? result.data.traits.find((t) => t.trait.name === 'MemoEditor')?.trait : undefined;
  }

  it('renames the fields the referenced trait reads and scopes its emits', async () => {
    const t = await resolved({ fields: { body: 'text' }, emitsScope: 'internal' });
    expect(JSON.stringify(t?.stateMachine?.transitions)).toContain('@entity.text');
    expect(t?.emits?.map((e) => [e.scope, e.scopeOverridden])).toEqual([['internal', true]]);
  });

  it('control: without them the trait reads and emits as upstream', async () => {
    const t = await resolved({});
    expect(JSON.stringify(t?.stateMachine?.transitions)).toContain('@entity.body');
    expect(t?.emits?.map((e) => e.scopeOverridden)).toEqual([undefined]);
  });
});
