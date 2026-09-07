import { describe, it, expect } from 'vitest';
import { ReferenceResolver, resolveSchema } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type {
  OrbitalDefinition,
  OrbitalSchema,
  OrbitalRefObject,
  Orbital,
  Trait,
  TraitRef,
  Entity,
  EntityField,
  DeclaredTraitConfig,
  Page,
  TraitId,
  EntityId,
  EventId,
  OrbitalId,
  PageId,
} from '@almadar/core';

/** Narrow a resolved `EntityField` to its `relation` variant — throws on any
 *  other field type so a wrong lookup fails loudly instead of reading `undefined`. */
function relationOf(field: EntityField): { entity: string; entityId?: string } {
  if (field.type !== 'relation') {
    throw new Error(`expected a relation field, got type "${field.type}" (name: ${field.name ?? '<unnamed>'})`);
  }
  return field.relation;
}

// W3-J: `orbital X = Alias.orbitals.Y { … }` (docs/Almadar_Orbital_Import.md
// §4) must flatten completely — every trait/entity/page the upstream
// `NoteOrbital` fixture below owns is unconditionally prefixed by the local
// orbital name, ids are freshly derived (never reused, never minted), and
// `@trait.`/`@entity.`/listens/navigate tokens are rewritten to match.

const NOTE_ORBITAL_ID = 'orb_SOURCE00000000000000001' as OrbitalId;

// Carries a relation field to the aux entity (`tagId` -> `NoteTag`) AND a
// SELF-relation (`parentId` -> `Note`) — gap (A) coverage: both must resolve
// to the renamed local names, not the upstream ones. Also carries: a relation
// OUTSIDE the materialized closure (`ownerId` -> `User`, never renamed, never
// given an `entityId`) plus a relation nested under `items` (`relatedTags`,
// array) and under `properties` (`meta.mainTag`, object) — gap (F) coverage:
// `relation.entityId` must track every renamed `.entity`, recursing through
// both nesting forms, and stay `undefined` for the out-of-closure target.
function noteEntity(): Entity {
  return {
    id: 'ent_SOURCE_NOTE0000000000001' as EntityId,
    name: 'Note',
    persistence: 'runtime',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'title', type: 'string' },
      { name: 'tagId', type: 'relation', relation: { entity: 'NoteTag', cardinality: 'one' } },
      { name: 'parentId', type: 'relation', relation: { entity: 'Note', cardinality: 'one' } },
      { name: 'ownerId', type: 'relation', relation: { entity: 'User', cardinality: 'one' } },
      {
        name: 'relatedTags',
        type: 'array',
        items: { type: 'relation', relation: { entity: 'NoteTag', cardinality: 'one' } },
      },
      {
        name: 'meta',
        type: 'object',
        properties: {
          mainTag: { type: 'relation', relation: { entity: 'NoteTag', cardinality: 'one' } },
        },
      },
    ],
  };
}

// Carries its own relation BACK to the primary entity — an auxiliary
// entity's relation targets must resolve inside the materialized closure
// too, not just the primary's.
function noteTagEntity(): Entity {
  return {
    id: 'ent_SOURCE_NOTETAG000000001' as EntityId,
    name: 'NoteTag',
    persistence: 'runtime',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'noteId', type: 'relation', relation: { entity: 'Note', cardinality: 'one' } },
    ],
  };
}

// Embeds `@trait.NoteDetailRouter` + `@trait.NoteToOmit`; reads `@entity.title`
// in its guard (fields-rename coverage); listens to a same-orbital TRAIT
// source. `sourceEntityDefinition` is a COPY of the atom's own entity
// (stamped when this trait was originally inlined from an atom bound to
// `Note`) — gap (B) coverage: it must be renamed through the SAME map as
// `linkedEntity` so `sourceEntityDefinition.name === linkedEntity` still
// holds post-import (else the compiler's rebindability check sees a
// spurious rebind).
function noteListTrait(): Trait {
  return {
    id: 'trt_SOURCE_NOTELIST0000001' as TraitId,
    name: 'NoteList',
    linkedEntity: 'Note',
    scope: 'instance',
    sourceEntityDefinition: noteEntity(),
    listens: [{ event: 'NOTE_SELECTED', triggers: 'REFRESH', source: { kind: 'trait', trait: 'NoteDetailRouter' } }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'REFRESH', name: 'Refresh' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          guard: ['=', '@entity.title', ''],
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.NoteDetailRouter', '@trait.NoteToOmit'] }]],
        },
        { from: 'idle', to: 'idle', event: 'REFRESH', effects: [] },
      ],
    },
  };
}

// Exercises all three `(navigate)` arities plus the `str/concat` literal-prefix
// form; also emits `NOTE_OPENED` for the events-rename test.
function noteDetailRouterTrait(): Trait {
  return {
    id: 'trt_SOURCE_NOTEDETAIL000001' as TraitId,
    name: 'NoteDetailRouter',
    scope: 'instance',
    emits: [{ event: 'NOTE_OPENED', scope: 'external' }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [
        { key: 'SELECT', name: 'Select' },
        { key: 'SELECT_WITH_PARAMS', name: 'Select With Params' },
        { key: 'SELECT_WITH_CRUMB', name: 'Select With Crumb' },
        { key: 'SELECT_CONCAT', name: 'Select Concat' },
      ],
      transitions: [
        { from: 'idle', to: 'idle', event: 'SELECT', effects: [['navigate', '/things']] },
        {
          from: 'idle',
          to: 'idle',
          event: 'SELECT_WITH_PARAMS',
          effects: [['navigate', '/things/:id', { id: '@payload.id' }]],
        },
        {
          from: 'idle',
          to: 'idle',
          event: 'SELECT_WITH_CRUMB',
          effects: [['navigate', '/things/:id', { id: '@payload.id' }, { crumb: '@payload.title' }]],
        },
        {
          from: 'idle',
          to: 'idle',
          event: 'SELECT_CONCAT',
          effects: [['navigate', ['str/concat', '/things/', '@payload.id']]],
        },
      ],
    },
  };
}

function noteToOmitTrait(): Trait {
  return {
    id: 'trt_SOURCE_NOTEOMIT0000001' as TraitId,
    name: 'NoteToOmit',
    scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

// Forwards the orbital-declared `pageSize` knob via `@config.pageSize`.
function noteBrowseListTrait(): Trait {
  return {
    id: 'trt_SOURCE_NOTEBROWSE000001' as TraitId,
    name: 'NoteBrowseList',
    scope: 'instance',
    config: { pageSize: { type: 'number', default: '@config.pageSize' } },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

// Listens through the 3-part `Orbital.Trait.EVENT` (ListenSource kind "orbital") form.
function noteNotifierTrait(): Trait {
  return {
    id: 'trt_SOURCE_NOTENOTIFY000001' as TraitId,
    name: 'NoteNotifier',
    scope: 'instance',
    listens: [{ event: 'PING', triggers: 'NOTIFY', source: { kind: 'orbital', orbital: 'NoteOrbital', trait: 'NoteList' } }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'NOTIFY', name: 'Notify' }],
      transitions: [],
    },
  };
}

// Config-held page paths (gap D): an `AppLayout`-style `navItems[].href`
// carries a bare upstream path OUTSIDE any `(navigate)` s-expression. Only
// an EXACT match against an upstream page path may be rewritten — the
// second item's `label` merely CONTAINS `/things` and must survive
// untouched (no prefix/substring matching).
function noteAppLayoutTrait(): Trait {
  return {
    id: 'trt_SOURCE_NOTEAPPLAYOUT1' as TraitId,
    name: 'NoteAppLayout',
    scope: 'instance',
    config: {
      navItems: {
        type: 'array',
        default: [
          { href: '/things', label: 'Things' },
          { href: '/things/:id', label: 'See /things for details' },
        ],
      },
    },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

function notePages(): Page[] {
  return [
    {
      id: 'pag_SOURCE_THINGS0000000001' as PageId,
      name: 'ThingsPage',
      path: '/things',
      primaryEntity: 'Note',
      traits: [{ ref: 'NoteList' }],
    },
    {
      id: 'pag_SOURCE_THINGSDETAIL0001' as PageId,
      name: 'ThingsDetailPage',
      path: '/things/:id',
      primaryEntity: 'Note',
      traits: [{ ref: 'NoteDetailRouter' }],
    },
  ];
}

function upstreamOrbital(): Orbital {
  return {
    id: NOTE_ORBITAL_ID,
    name: 'NoteOrbital',
    entity: noteEntity(),
    auxiliaryEntities: [noteTagEntity()],
    config: { pageSize: { type: 'number', default: 25, label: 'Page size' } },
    traits: [
      noteListTrait(),
      noteDetailRouterTrait(),
      noteToOmitTrait(),
      noteBrowseListTrait(),
      noteNotifierTrait(),
      noteAppLayoutTrait(),
    ],
    pages: notePages(),
  };
}

function makeLoader(): SchemaLoader {
  const orbital = upstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './notes.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './notes.orb', importPath },
      };
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

function consumerOrbital(
  localName: string,
  ref: Partial<OrbitalRefObject> = {},
  opts: { id?: OrbitalId } = {},
): OrbitalDefinition {
  return {
    name: localName,
    ...(opts.id ? { id: opts.id } : {}),
    uses: [{ from: './notes.orb', as: 'Notes' }],
    // Placeholder — the Rust design lowers a reference-form orbital's
    // `entity` to `EntityRef::Reference("<Alias>.orbitals.<Y>.entity")`;
    // `materializeOrbitalRef` never reads it when `.reference` is set.
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: 'Notes.orbitals.NoteOrbital', ...ref },
  };
}

function findTrait(orbital: OrbitalDefinition, name: string): Trait {
  const found = (orbital.traits as Trait[]).find((t) => t.name === name);
  if (!found) throw new Error(`trait "${name}" not materialized (have: ${(orbital.traits as Trait[]).map((t) => t.name).join(', ')})`);
  return found;
}

describe('ReferenceResolver — orbital import materialization (W3-J)', () => {
  it('unconditionally prefixes every trait + the primary entity with zero collisions', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const [orbital] = result.data;
    expect(orbital.name).toBe('NotesA');
    expect(orbital.reference).toBeUndefined();
    expect((orbital.entity as Entity).name).toBe('NotesANote');
    const traitNames = (orbital.traits as Trait[]).map((t) => t.name).sort();
    expect(traitNames).toEqual(
      [
        'NotesANoteAppLayout',
        'NotesANoteBrowseList',
        'NotesANoteDetailRouter',
        'NotesANoteList',
        'NotesANoteNotifier',
        'NotesANoteToOmit',
      ].sort(),
    );
    expect((orbital.auxiliaryEntities as Entity[])[0].name).toBe('NotesANoteTag');
  });

  it('rewrites `@trait.` embeds to the prefixed names', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const list = findTrait(result.data[0], 'NotesANoteList');
    const effects = list.stateMachine!.transitions[0].effects as unknown[];
    const renderUi = effects[0] as unknown[];
    const config = renderUi[2] as { children: string[] };
    expect(config.children).toEqual(['@trait.NotesANoteDetailRouter', '@trait.NotesANoteToOmit']);
  });

  it('rewrites `@entity.<field>` field tokens per `fields {}`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA', { fields: { title: 'subject' } })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const list = findTrait(result.data[0], 'NotesANoteList');
    expect(list.stateMachine!.transitions[0].guard).toEqual(['=', '@entity.subject', '']);
    const entity = result.data[0].entity as Entity;
    expect(entity.fields.map((f) => f.name)).toContain('subject');
    expect(entity.fields.map((f) => f.name)).not.toContain('title');
  });

  it('rewrites a TRAIT-sourced listen to the local name', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const list = findTrait(result.data[0], 'NotesANoteList');
    expect(list.listens![0].source).toEqual(
      expect.objectContaining({ kind: 'trait', trait: 'NotesANoteDetailRouter' }),
    );
  });

  it('rewrites an ORBITAL-sourced listen (`Orbital.Trait.EVENT`) to the local orbital + trait name', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const notifier = findTrait(result.data[0], 'NotesANoteNotifier');
    expect(notifier.listens![0].source).toEqual(
      expect.objectContaining({ kind: 'orbital', orbital: 'NotesA', trait: 'NotesANoteList' }),
    );
  });

  it('rewrites page paths + `(navigate)` literals in all three arities and the str/concat form', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerOrbital('NotesA', { pages: { '/things': '/local-things', '/things/:id': '/local-things/:id' } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pages = result.data[0].pages as Page[];
    expect(pages.map((p) => p.path).sort()).toEqual(['/local-things', '/local-things/:id']);

    const router = findTrait(result.data[0], 'NotesANoteDetailRouter');
    const transitions = router.stateMachine!.transitions;
    const byEvent = (e: string) => transitions.find((t) => t.event === e)!.effects![0] as unknown[];
    expect(byEvent('SELECT')).toEqual(['navigate', '/local-things']);
    expect(byEvent('SELECT_WITH_PARAMS')).toEqual(['navigate', '/local-things/:id', { id: '@payload.id' }]);
    expect(byEvent('SELECT_WITH_CRUMB')).toEqual([
      'navigate',
      '/local-things/:id',
      { id: '@payload.id' },
      { crumb: '@payload.title' },
    ]);
    expect(byEvent('SELECT_CONCAT')).toEqual(['navigate', ['str/concat', '/local-things/', '@payload.id']]);
  });

  it('is deterministic: the same schema resolved twice yields identical ids', async () => {
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const first = await new ReferenceResolver({ basePath: '.', loader: makeLoader() }).resolveOrbitalImports(schema);
    const second = await new ReferenceResolver({ basePath: '.', loader: makeLoader() }).resolveOrbitalImports(schema);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;

    const firstList = findTrait(first.data[0], 'NotesANoteList');
    const secondList = findTrait(second.data[0], 'NotesANoteList');
    expect(firstList.id).toBeDefined();
    expect(firstList.id).toBe(secondList.id);
    expect((first.data[0].entity as Entity).id).toBe((second.data[0].entity as Entity).id);
    expect(first.data[0].id).toBe(second.data[0].id);
  });

  it('two imports of the same upstream are pairwise disjoint in names AND ids', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA'), consumerOrbital('NotesB')],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [a, b] = result.data;
    const aNames = new Set((a.traits as Trait[]).map((t) => t.name));
    const bNames = new Set((b.traits as Trait[]).map((t) => t.name));
    for (const name of aNames) expect(bNames.has(name)).toBe(false);

    const aList = findTrait(a, 'NotesANoteList');
    const bList = findTrait(b, 'NotesBNoteList');
    expect(aList.id).not.toBe(bList.id);
    expect((a.entity as Entity).id).not.toBe((b.entity as Entity).id);
    expect(a.id).not.toBe(b.id);
  });

  it('omitting a trait a surviving trait still embeds is an error (ORB_O_OMIT_EMBEDDED_TRAIT)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA', { omit: ['NoteToOmit'] })],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_OMIT_EMBEDDED_TRAIT/);
    expect(result.errors.join('\n')).toContain('NoteToOmit');
  });

  it('overriding an undeclared config knob is an error (ORB_O_CONFIG_UNKNOWN_KEY)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA', { config: { bogusKnob: { type: 'string', default: 'x' } } })],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_CONFIG_UNKNOWN_KEY/);
    expect(result.errors.join('\n')).toContain('bogusKnob');
  });

  it('a config override wins over the upstream default and reaches the forwarding trait', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA', { config: { pageSize: { type: 'number', default: 99 } } })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data[0].config).toEqual({ pageSize: { type: 'number', default: 99, label: 'Page size' } });
    const browse = findTrait(result.data[0], 'NotesANoteBrowseList');
    expect(browse.config!.pageSize.default).toBe(99);
  });

  it('an `events {}` rename applies to the materialized trait set', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA', { events: { NOTE_OPENED: 'THING_OPENED' } })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const router = findTrait(result.data[0], 'NotesANoteDetailRouter');
    const routerEmitNames = router.emits?.map((e) => e.event) ?? [];
    expect(routerEmitNames).toContain('THING_OPENED');
    expect(routerEmitNames).not.toContain('NOTE_OPENED');
  });

  it('(A) renames relation targets on the primary entity, the aux entity, and a self-relation', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const primary = result.data[0].entity as Entity;
    const tagField = primary.fields.find((f) => f.name === 'tagId')!;
    expect(relationOf(tagField).entity).toBe('NotesANoteTag');
    const parentField = primary.fields.find((f) => f.name === 'parentId')!;
    expect(relationOf(parentField).entity).toBe('NotesANote');

    const aux = (result.data[0].auxiliaryEntities as Entity[])[0];
    const noteIdField = aux.fields.find((f) => f.name === 'noteId')!;
    expect(relationOf(noteIdField).entity).toBe('NotesANote');
  });

  it('(B) renames a trait\'s `sourceEntityDefinition` copy so it still matches the renamed `linkedEntity`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const list = findTrait(result.data[0], 'NotesANoteList');
    expect(list.linkedEntity).toBe('NotesANote');
    const src = list.sourceEntityDefinition!;
    expect(src.name).toBe('NotesANote');
    expect(src.name).toBe(list.linkedEntity);
    const tagField = src.fields.find((f) => f.name === 'tagId')!;
    expect(relationOf(tagField).entity).toBe('NotesANoteTag');
    const parentField = src.fields.find((f) => f.name === 'parentId')!;
    expect(relationOf(parentField).entity).toBe('NotesANote');
  });

  it('(C) keeps the local orbital\'s own id when it has one; derives one only when it has none', async () => {
    const LOCAL_ID = 'orb_LOCAL0000000000000000A' as OrbitalId;
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA', {}, { id: LOCAL_ID }), consumerOrbital('NotesB')],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [withId, withoutId] = result.data;
    expect(withId.id).toBe(LOCAL_ID);
    expect(withoutId.id).toBeDefined();
    expect(withoutId.id).not.toBe(LOCAL_ID);
    expect(withoutId.id).not.toBe(NOTE_ORBITAL_ID);
  });

  it('(D) rewrites a config-default string that EXACTLY matches an upstream page path; leaves a containing string alone', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerOrbital('NotesA', { pages: { '/things': '/local-things', '/things/:id': '/local-things/:id' } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const layout = findTrait(result.data[0], 'NotesANoteAppLayout');
    const navItems = layout.config!.navItems.default as { href: string; label: string }[];
    expect(navItems[0].href).toBe('/local-things');
    expect(navItems[0].label).toBe('Things');
    expect(navItems[1].href).toBe('/local-things/:id');
    // Contains `/things` but is not an EXACT match of any upstream page path
    // — must survive untouched (no prefix/substring matching).
    expect(navItems[1].label).toBe('See /things for details');
  });

  it('(E) unconditionally prefixes every materialized page NAME, same rule as traits/entities', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pages = result.data[0].pages as Page[];
    expect(pages.map((p) => p.name)).toEqual(['NotesAThingsPage', 'NotesAThingsDetailPage']);
    // fresh, pairwise-disjoint-from-upstream ids too — same derivation as
    // trait/entity ids (never `mintId`).
    for (const p of pages) {
      expect(p.id).toBeDefined();
      expect(p.id).not.toBe('pag_SOURCE_THINGS0000000001');
      expect(p.id).not.toBe('pag_SOURCE_THINGSDETAIL0001');
    }
  });

  it('(E) two imports of the same upstream have disjoint materialized page names', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA'), consumerOrbital('NotesB')],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [a, b] = result.data;
    const aPages = (a.pages as Page[]).map((p) => p.name);
    const bPages = (b.pages as Page[]).map((p) => p.name);
    expect(aPages).toEqual(['NotesAThingsPage', 'NotesAThingsDetailPage']);
    expect(bPages).toEqual(['NotesBThingsPage', 'NotesBThingsDetailPage']);
    for (const name of aPages) expect(bPages).not.toContain(name);

    const aIds = (a.pages as Page[]).map((p) => p.id);
    const bIds = (b.pages as Page[]).map((p) => p.id);
    for (const id of aIds) expect(bIds).not.toContain(id);
  });

  it('(F) resets `relation.entityId` to the renamed target\'s materialized id on the primary entity, the aux entity, and `sourceEntityDefinition` — including nested `items`/`properties`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerOrbital('NotesA')] };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const primary = result.data[0].entity as Entity;
    const aux = (result.data[0].auxiliaryEntities as Entity[])[0];
    const primaryId = primary.id;
    const auxId = aux.id;
    expect(primary.name).toBe('NotesANote');
    expect(aux.name).toBe('NotesANoteTag');

    const assertClosureRelationsFixed = (entity: Entity) => {
      const tagField = relationOf(entity.fields.find((f) => f.name === 'tagId')!);
      expect(tagField.entity).toBe('NotesANoteTag');
      expect(tagField.entityId).toBe(auxId);

      const parentField = relationOf(entity.fields.find((f) => f.name === 'parentId')!);
      expect(parentField.entity).toBe('NotesANote');
      expect(parentField.entityId).toBe(primaryId);

      // Out-of-closure target: name untouched, `entityId` stays undefined —
      // `User` is not part of this materialized closure.
      const ownerField = relationOf(entity.fields.find((f) => f.name === 'ownerId')!);
      expect(ownerField.entity).toBe('User');
      expect(ownerField.entityId).toBeUndefined();

      // Nested under `items` (array element schema).
      const relatedTagsField = entity.fields.find((f) => f.name === 'relatedTags')!;
      if (relatedTagsField.type !== 'array' || !relatedTagsField.items) {
        throw new Error('expected relatedTags to be an array field with an items schema');
      }
      const relatedTagsItem = relationOf(relatedTagsField.items);
      expect(relatedTagsItem.entity).toBe('NotesANoteTag');
      expect(relatedTagsItem.entityId).toBe(auxId);

      // Nested under `properties` (object field schema).
      const metaField = entity.fields.find((f) => f.name === 'meta')!;
      const mainTagField = metaField.properties?.mainTag;
      if (!mainTagField) throw new Error('expected meta.properties.mainTag');
      const mainTag = relationOf(mainTagField);
      expect(mainTag.entity).toBe('NotesANoteTag');
      expect(mainTag.entityId).toBe(auxId);
    };

    assertClosureRelationsFixed(primary);

    const auxNoteIdField = relationOf(aux.fields.find((f) => f.name === 'noteId')!);
    expect(auxNoteIdField.entity).toBe('NotesANote');
    expect(auxNoteIdField.entityId).toBe(primaryId);

    const list = findTrait(result.data[0], 'NotesANoteList');
    assertClosureRelationsFixed(list.sourceEntityDefinition!);
  });

  it('resolveSchema flattens the reference form end-to-end — no orbital keeps `.reference`', async () => {
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerOrbital('NotesA'), consumerOrbital('NotesB')],
    };

    const result = await resolveSchema(schema, { basePath: '.', loader: makeLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    for (const resolved of result.data) {
      expect(resolved.original.reference).toBeUndefined();
    }
    expect(resolved0Traits(result.data)).toContain('NotesANoteList');
  });
});

function resolved0Traits(data: { original: OrbitalDefinition }[]): string[] {
  return (data[0].original.traits as Trait[]).map((t) => t.name);
}

// `resolvePageRefObject` honors every `PageRefObject` override (ledger (c)),
// mirroring the compiler's `apply_overrides_to_page`
// (`orbital-rust/crates/orbital-compiler/src/phases/inline/page.rs:21-93`):
// `path` (pre-existing), `linkedEntity` (rebind `primaryEntity` + every
// page-trait POINTER whose own `linkedEntity` named the old entity — `Page.
// traits` is `PageTraitRef[]`, a name pointer into the orbital's own
// `traits {}`, never an inline body, so there is nothing here for
// `renameEntitiesInTrait` to walk), and `traits` (full replacement).
describe('ReferenceResolver — resolvePageRefObject honors `linkedEntity` + `traits` (ledger (c))', () => {
  function pagesOrbital(): Orbital {
    return {
      name: 'Pages',
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [
        {
          name: 'ItemPage',
          path: '/items',
          primaryEntity: 'Item',
          traits: [
            { ref: 'ItemList', linkedEntity: 'Item' },
            { ref: 'ItemSidebar', linkedEntity: 'Other' },
          ],
        },
      ],
    };
  }

  function makePagesLoader(): SchemaLoader {
    const pageOrbital = pagesOrbital();
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital() {
        return { success: true, data: { orbital: pageOrbital, sourcePath: './pages.orb', importPath: 'Pages' } };
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

  it('honors `linkedEntity`: rebinds `primaryEntity` and every page-trait pointer that named the old entity', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makePagesLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Consumer',
      uses: [{ from: './pages.orb', as: 'Pages' }],
      entity: { name: 'ConsumerEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [
        {
          ref: 'Pages.pages.ItemPage',
          path: '/renamed-items',
          linkedEntity: 'RenamedItem',
        },
      ],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const [resolvedPage] = result.data.pages;
    expect(resolvedPage.page.path).toBe('/renamed-items');
    expect(resolvedPage.page.primaryEntity).toBe('RenamedItem');
    expect(resolvedPage.page.traits?.[0]?.linkedEntity).toBe('RenamedItem');
    // A pointer naming a DIFFERENT entity is untouched — the rebind is
    // surgical, not a blanket overwrite of every pointer's `linkedEntity`.
    expect(resolvedPage.page.traits?.[1]?.linkedEntity).toBe('Other');
  });

  it('honors `traits`: replaces the page\'s trait-pointer list entirely, coercing every `TraitRef` shape to a `PageTraitRef`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makePagesLoader() });
    const orbital: OrbitalDefinition = {
      name: 'Consumer',
      uses: [{ from: './pages.orb', as: 'Pages' }],
      entity: { name: 'ConsumerEntity', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [
        {
          ref: 'Pages.pages.ItemPage',
          traits: [
            'BareNameTrait',
            { ref: 'RenamedItemList', linkedEntity: 'RenamedItem', config: { limit: 10 } },
          ],
        },
      ],
    };

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const [resolvedPage] = result.data.pages;
    expect(resolvedPage.page.traits).toEqual([
      { ref: 'BareNameTrait' },
      { ref: 'RenamedItemList', linkedEntity: 'RenamedItem', config: { limit: 10 } },
    ]);
  });
});

// Regression for the import-materialization "embedder rung skipped" bug:
// `materializeOrbitalRef` used to call `resolveForwardedSiblingConfig(next,
// undefined, foldedConfig, this.schemaConfig)` for every cloned trait —
// `parent` always `undefined` — so a forwarded `@config.<knob>` default only
// ever fell through to the orbital/schema rungs, never to the trait that
// actually EMBEDS it in the same materialized set (mirrors std-browse's
// `MasterListView.config.itemClickEvent` forwarding from its embedder
// `BrowseItemBrowse`'s literal `VIEW` default).
//
// `EmbedParent` embeds `@trait.EmbedChild` and declares `itemClickEvent`
// default `"VIEW"`; `EmbedChild` forwards `@config.itemClickEvent` both as
// its own config default AND (std-browse-shaped) as an `emits` definer-knob
// entry / a `stateMachine.events` catalog entry with the same key — the
// compiled `.orb` registry (`ui-data-list.orb`) carries all three forms for
// `DataListRender`'s real `itemClickEvent` knob.
const EMBED_ORBITAL_ID = 'orb_SOURCE_EMBED0000000001' as OrbitalId;

function embedParentTrait(): Trait {
  return {
    id: 'trt_SOURCE_EMBEDPARENT001' as TraitId,
    name: 'EmbedParent',
    scope: 'instance',
    config: { itemClickEvent: { type: 'event', default: 'VIEW' } },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.EmbedChild'] }]],
        },
      ],
    },
  };
}

function embedChildTrait(): Trait {
  return {
    id: 'trt_SOURCE_EMBEDCHILD0001' as TraitId,
    name: 'EmbedChild',
    scope: 'instance',
    config: { itemClickEvent: { type: 'event', default: '@config.itemClickEvent' } },
    emits: [{ event: '@config.itemClickEvent', definerKnob: 'itemClickEvent', scope: 'external' }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: '@config.itemClickEvent', name: 'Item Click Event' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
    },
  };
}

// Orbital-level `config { itemClickEvent }` deliberately holds a DIFFERENT
// value than the embedder's — proves embedder precedence over the orbital
// rung for the same knob, not just "some rung resolved it".
function embedUpstreamOrbital(): Orbital {
  return {
    id: EMBED_ORBITAL_ID,
    name: 'EmbedOrbital',
    entity: {
      id: 'ent_SOURCE_EMBEDITEM0001' as EntityId,
      name: 'EmbedItem',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    config: { itemClickEvent: { type: 'event', default: 'ORBITAL_DEFAULT' } },
    traits: [embedParentTrait(), embedChildTrait()],
    pages: [],
  };
}

function makeEmbedLoader(): SchemaLoader {
  const orbital = embedUpstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './embed.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './embed.orb', importPath },
      };
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

function embedConsumerOrbital(localName: string): OrbitalDefinition {
  return {
    name: localName,
    uses: [{ from: './embed.orb', as: 'Embed' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: 'Embed.orbitals.EmbedOrbital' },
  };
}

describe('ReferenceResolver — orbital import materialization: embedder-rung forwarding (regression)', () => {
  it('a forwarded sibling config default resolves from the trait that embeds it, and reaches the emits catalog after the full resolveSchema', async () => {
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [embedConsumerOrbital('NoteBrowse')],
    };

    const result = await resolveSchema(schema, { basePath: '.', loader: makeEmbedLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const resolvedChild = result.data[0].traits.find((rt) => rt.trait.name === 'NoteBrowseEmbedChild');
    expect(resolvedChild).toBeDefined();
    // The embedder-rung fix: NoteBrowseEmbedChild's own declared default
    // resolves from NoteBrowseEmbedParent (its embedder within the SAME
    // materialized set), not the orbital-level 'ORBITAL_DEFAULT'.
    expect(resolvedChild!.trait.config!.itemClickEvent.default).toBe('VIEW');
    // Once the config default is a literal, the existing per-orbital
    // `resolve()` second pass (Case 1 `resolveConfigRefEmitNames`, called
    // with no call-site config so it reads the trait's OWN now-literal
    // declared default) already resolves the `emits` definer-knob entry —
    // no additional call is needed inside `materializeOrbitalRef`.
    expect(resolvedChild!.trait.emits?.[0]?.event).toBe('VIEW');
    // Ledger (j): `resolveConfigRefEmitNames` now mirrors the rewrite onto
    // `stateMachine.events[*].key` too (L1 lowering unions emit keys into
    // the events registry, so the raw `@config.` token appeared there as
    // well) — the raw forward no longer survives in the catalog.
    expect(resolvedChild!.trait.stateMachine!.events.find((e) => e.key === '@config.itemClickEvent')).toBeUndefined();
    expect(resolvedChild!.trait.stateMachine!.events.find((e) => e.key === 'VIEW')).toBeDefined();
  });

  it('precedence: the embedder value wins over an orbital-level `config {}` value for the same knob', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeEmbedLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [embedConsumerOrbital('NoteBrowse')],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const child = findTrait(result.data[0], 'NoteBrowseEmbedChild');
    // Not 'ORBITAL_DEFAULT' — the embedder rung is tried before the orbital
    // rung inside resolveForwardedSiblingConfigFrom.
    expect(child.config!.itemClickEvent.default).toBe('VIEW');
  });

  it('two imports of the same upstream each resolve their own embedder-forwarded copy (no cross-talk)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeEmbedLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [embedConsumerOrbital('NoteBrowseA'), embedConsumerOrbital('NoteBrowseB')],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const childA = findTrait(result.data[0], 'NoteBrowseAEmbedChild');
    const childB = findTrait(result.data[1], 'NoteBrowseBEmbedChild');
    expect(childA.config!.itemClickEvent.default).toBe('VIEW');
    expect(childB.config!.itemClickEvent.default).toBe('VIEW');
  });
});

// Ledger (n)-JS, materializer half: the direct-embedder loop
// (`embeddersOf.get(trait.name)`) only ever tries ONE rung per embedder — a
// knob still `@config.`-shaped after it may be declared by a GRANDPARENT
// embedder instead. `EmbedGrandparent` declares `itemClickEvent`;
// `EmbedParent2` (no config at all) embeds `EmbedChild2`, which forwards the
// knob; `EmbedGrandparent` embeds `EmbedParent2`. `transitiveEmbedderChain`
// walks past the knob-less direct embedder to reach the grandparent.
const EMBED_CHAIN_ORBITAL_ID = 'orb_SOURCE_EMBEDCHAIN0001' as OrbitalId;

function embedGrandparentTrait(): Trait {
  return {
    id: 'trt_SOURCE_EMBEDGRANDP01' as TraitId,
    name: 'EmbedGrandparent',
    scope: 'instance',
    config: { itemClickEvent: { type: 'event', default: 'GP_VALUE' } },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.EmbedParent2'] }]],
        },
      ],
    },
  };
}

function embedParent2Trait(): Trait {
  return {
    id: 'trt_SOURCE_EMBEDPARENT02' as TraitId,
    name: 'EmbedParent2',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.EmbedChild2'] }]],
        },
      ],
    },
  };
}

function embedChild2Trait(): Trait {
  return {
    id: 'trt_SOURCE_EMBEDCHILD002' as TraitId,
    name: 'EmbedChild2',
    scope: 'instance',
    config: { itemClickEvent: { type: 'event', default: '@config.itemClickEvent' } },
    emits: [{ event: '@config.itemClickEvent', definerKnob: 'itemClickEvent', scope: 'external' }],
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: '@config.itemClickEvent', name: 'Item Click Event' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
    },
  };
}

function embedChainUpstreamOrbital(): Orbital {
  return {
    id: EMBED_CHAIN_ORBITAL_ID,
    name: 'EmbedChainOrbital',
    entity: {
      id: 'ent_SOURCE_EMBEDCHAINIT01' as EntityId,
      name: 'EmbedChainItem',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    config: { itemClickEvent: { type: 'event', default: 'ORBITAL_DEFAULT' } },
    traits: [embedGrandparentTrait(), embedParent2Trait(), embedChild2Trait()],
    pages: [],
  };
}

function makeEmbedChainLoader(): SchemaLoader {
  const orbital = embedChainUpstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './embed-chain.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './embed-chain.orb', importPath },
      };
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

function embedChainConsumerOrbital(localName: string): OrbitalDefinition {
  return {
    name: localName,
    uses: [{ from: './embed-chain.orb', as: 'EmbedChain' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: 'EmbedChain.orbitals.EmbedChainOrbital' },
  };
}

describe('ReferenceResolver — orbital import materialization: multi-hop embedder chain (ledger (n)-JS)', () => {
  it('walks past a knob-less direct embedder to a grandparent that declares the knob', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeEmbedChainLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [embedChainConsumerOrbital('Chain')],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const child = findTrait(result.data[0], 'ChainEmbedChild2');
    // Not 'ORBITAL_DEFAULT' — the grandparent rung is tried before the
    // orbital rung, even though the DIRECT embedder declares nothing.
    expect(child.config!.itemClickEvent.default).toBe('GP_VALUE');
  });

  it('terminates instead of hanging on a circular `@trait.` embed ring', async () => {
    const ringOrbitalId = 'orb_SOURCE_EMBEDRING00001' as OrbitalId;
    const ringA: Trait = {
      id: 'trt_SOURCE_EMBEDRINGA001' as TraitId,
      name: 'RingA',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [
          {
            from: 'idle',
            to: 'idle',
            event: 'INIT',
            effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.RingB'] }]],
          },
        ],
      },
    };
    const ringB: Trait = {
      id: 'trt_SOURCE_EMBEDRINGB001' as TraitId,
      name: 'RingB',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [
          {
            from: 'idle',
            to: 'idle',
            event: 'INIT',
            effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.RingC'] }]],
          },
        ],
      },
    };
    const ringC: Trait = {
      id: 'trt_SOURCE_EMBEDRINGC001' as TraitId,
      name: 'RingC',
      scope: 'instance',
      config: { itemClickEvent: { type: 'event', default: '@config.itemClickEvent' } },
      emits: [{ event: '@config.itemClickEvent', definerKnob: 'itemClickEvent', scope: 'external' }],
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [
          {
            from: 'idle',
            to: 'idle',
            event: 'INIT',
            // Closes the ring: RingC embeds RingA, which already embeds RingB,
            // which already embeds RingC.
            effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.RingA'] }]],
          },
        ],
      },
    };
    const ringOrbital: Orbital = {
      id: ringOrbitalId,
      name: 'RingOrbital',
      entity: {
        id: 'ent_SOURCE_EMBEDRINGITEM1' as EntityId,
        name: 'RingItem',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      config: { itemClickEvent: { type: 'event', default: 'RING_ORBITAL_DEFAULT' } },
      traits: [ringA, ringB, ringC],
      pages: [],
    };
    const loader: SchemaLoader = {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital(importPath: string) {
        if (importPath !== './ring.orb') {
          return { success: false, error: `unexpected import path: ${importPath}` };
        }
        return {
          success: true,
          data: { orbital: ringOrbital, orbitals: [ringOrbital], sourcePath: './ring.orb', importPath },
        };
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
    const resolver = new ReferenceResolver({ basePath: '.', loader });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        {
          name: 'Chain',
          uses: [{ from: './ring.orb', as: 'Ring' }],
          entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
          traits: [],
          pages: [],
          reference: { ref: 'Ring.orbitals.RingOrbital' },
        },
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    // No hang, no throw — the walk's `seenNames` guard stops at the ring's
    // closing edge. None of the three traits declares the knob a concrete
    // value, so it falls all the way through to the orbital rung.
    expect(result.success).toBe(true);
    if (!result.success) return;
    const child = findTrait(result.data[0], 'ChainRingC');
    expect(child.config!.itemClickEvent.default).toBe('RING_ORBITAL_DEFAULT');
  });
});

// Ledger (b): `materializeOrbitalRef` must resolve an upstream trait's
// `@config.<knob>` schema rung against the IMPORTED behavior's OWN loaded
// app-level config (`imported.schemaConfig`), never the CONSUMER's
// (`this.schemaConfig`) — same-named app knobs at each level must not leak
// into each other. `uses … { config }` overrides the imported schema's own
// knob before it becomes that rung.
describe('ReferenceResolver — orbital import: imported schema config rung, not the consumer\'s (ledger (b))', () => {
  const UPSTREAM_SCHEMA_CONFIG = { appName: { type: 'string' as const, default: 'Up' } };

  function appNameOrbital(): Orbital {
    return {
      id: 'orb_SOURCE_APPNAME000001' as OrbitalId,
      name: 'AppNameOrbital',
      entity: {
        id: 'ent_SOURCE_APPNAMEITEM01' as EntityId,
        name: 'Item',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      traits: [
        {
          id: 'trt_SOURCE_APPLABEL00001' as TraitId,
          name: 'AppLabel',
          scope: 'instance',
          config: { label: { type: 'string', default: '@config.appName' } },
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [{ key: 'INIT', name: 'Init' }],
            transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
          },
        },
      ],
      pages: [],
    };
  }

  function makeAppNameLoader(): SchemaLoader {
    const orbital = appNameOrbital();
    return {
      async load(): Promise<LoadResult<LoadedSchema>> {
        return { success: false, error: 'not used' };
      },
      async loadOrbital() {
        return {
          success: true,
          data: {
            orbital,
            orbitals: [orbital],
            sourcePath: './app-name.orb',
            importPath: 'AppName',
            schemaConfig: UPSTREAM_SCHEMA_CONFIG,
          },
        };
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

  function appNameConsumerOrbital(use: { config?: DeclaredTraitConfig }): OrbitalDefinition {
    return {
      name: 'Chain',
      uses: [{ from: './app-name.orb', as: 'AppName', ...use }],
      entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [],
      pages: [],
      reference: { ref: 'AppName.orbitals.AppNameOrbital' },
    };
  }

  it("resolves the forward to the upstream's own schema config, not the consumer's same-named app knob", async () => {
    const resolver = new ReferenceResolver({
      basePath: '.',
      loader: makeAppNameLoader(),
      // The CONSUMER's own app-level config, declaring the SAME knob name
      // with a DIFFERENT value — must not leak into the import.
      schemaConfig: { appName: { type: 'string', default: 'Down' } },
    });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [appNameConsumerOrbital({})],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const label = findTrait(result.data[0], 'ChainAppLabel');
    expect(label.config!.label.default).toBe('Up');
  });

  it('folds `uses … { config }` onto the imported schema config before it becomes the rung', async () => {
    const resolver = new ReferenceResolver({
      basePath: '.',
      loader: makeAppNameLoader(),
      schemaConfig: { appName: { type: 'string', default: 'Down' } },
    });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [appNameConsumerOrbital({ config: { appName: { type: 'string', default: 'Over' } } })],
    };

    const result = await resolver.resolveOrbitalImports(schema);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const label = findTrait(result.data[0], 'ChainAppLabel');
    expect(label.config!.label.default).toBe('Over');
  });
});

// ============================================================================
// Stage B: roles {} / entities {} / mounts {} / siblings (B2-J)
// ============================================================================

const TEAM_ORBITAL_ID = 'orb_SOURCE_TEAM0000000001' as OrbitalId;
const MEMBER_ORBITAL_ID = 'orb_SOURCE_MEMBER00000001' as OrbitalId;
const WIDGET_ORBITAL_ID = 'orb_SOURCE_WIDGET0000000001' as OrbitalId;
const CONSUMER_PERSON_ID = 'ent_CONSUMER_PERSON0000001' as EntityId;

// The upstream roster — a DIFFERENT orbital of the same "Org" alias than the
// one being imported (`identityEntitiesOf`/`entities {}`'s "out-of-orbital"
// universe must span every orbital of the alias, not just the import site).
function memberEntity(): Entity {
  return {
    id: 'ent_SOURCE_MEMBER0000000001' as EntityId,
    name: 'Member',
    persistence: 'runtime',
    identity: true,
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'role', type: 'string', values: ['approver', 'employee'] },
    ],
  };
}

function memberOrbital(): Orbital {
  return {
    id: MEMBER_ORBITAL_ID,
    name: 'MemberOrbital',
    entity: memberEntity(),
    traits: [],
    pages: [],
  };
}

// Carries an out-of-orbital relation (`leadId` -> `Member`) AND a role
// literal in its own `read_policy`.
function teamEntity(): Entity {
  return {
    id: 'ent_SOURCE_TEAM0000000001' as EntityId,
    name: 'Team',
    persistence: 'runtime',
    read_policy: ['=', '@user.role', 'employee'],
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'leadId', type: 'relation', relation: { entity: 'Member', cardinality: 'one' } },
    ],
  };
}

// Guard: `=` with a LIST target (`approver` -> two targets) — rewrites to
// `array/includes`. Effects: `fetch Member` (position-1 op) + a
// `render-ui`/`data-grid` `entity: "Member"` prop — both out-of-orbital
// entity-slot surfaces `entities {}` must retarget.
function teamApproverGateTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMAPPROVER01' as TraitId,
    name: 'TeamApproverGate',
    linkedEntity: 'Team',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          guard: ['=', '@user.role', 'approver'],
          effects: [
            ['fetch', 'Member'],
            ['render-ui', 'main', { type: 'data-grid', entity: 'Member' }],
          ],
        },
      ],
    },
  };
}

// Guard: `=` with a SINGLE target (`employee` -> one target) — literal swap.
function teamEmployeeGateTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMEMPLOYEE01' as TraitId,
    name: 'TeamEmployeeGate',
    linkedEntity: 'Team',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', guard: ['=', '@user.role', 'employee'], effects: [] },
      ],
    },
  };
}

// Guard: `!=` with a LIST target — rewrites to `(not (array/includes …))`.
function teamApproverNegGateTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMAPPROVERNEG1' as TraitId,
    name: 'TeamApproverNegGate',
    linkedEntity: 'Team',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', guard: ['!=', '@user.role', 'approver'], effects: [] },
      ],
    },
  };
}

// An existing `array/includes` haystack: `approver` (2 targets) + `employee`
// (1 target) + `guest` (unmapped, passes through) — expanded + deduped.
function teamHaystackGateTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMHAYSTACK001' as TraitId,
    name: 'TeamHaystackGate',
    linkedEntity: 'Team',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          guard: ['array/includes', ['approver', 'employee', 'guest'], '@user.role'],
          effects: [],
        },
      ],
    },
  };
}

// A DYNAMIC per-step haystack (std-step-flow's role guard idiom:
// `(object/get (array/nth @config.steps i) allowedRoles)`) — not a literal
// role list, so `rewriteRoleLiteralsInValue` must leave it byte-identical
// (the false positive this fixture guards was Rust's `check_comparison`
// flagging "object/get"/"allowedRoles" as bogus role literals on 8 corpus
// organisms; the JS rewrite twin had the worse bug of actively DROPPING the
// nested `array/nth` call while doing so).
function teamDynamicHaystackGateTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMDYNHAYSTAC1' as TraitId,
    name: 'TeamDynamicHaystackGate',
    linkedEntity: 'Team',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          guard: [
            'array/includes',
            ['object/get', ['array/nth', '@config.steps', '@entity.currentStepIndex'], 'allowedRoles'],
            '@user.role',
          ],
          effects: [],
        },
      ],
    },
  };
}

// A `["list", …]` array-construction haystack (the config-array-override
// disambiguation wrap `mark_literal_list_in_place`/`markLiteralListInPlace`
// applies) — the TAIL expands through `roles`, "list" itself is never
// mapped, and the wrap survives on the output so the evaluator still reads
// the result as inert data.
function teamListCallHaystackGateTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMLISTHAYSTAC1' as TraitId,
    name: 'TeamListCallHaystackGate',
    linkedEntity: 'Team',
    scope: 'instance',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          guard: ['array/includes', ['list', 'approver', 'guest'], '@user.role'],
          effects: [],
        },
      ],
    },
  };
}

// A SECONDARY `entityRefIds` entry named "Person" — the SAME name the
// CONSUMER roster's own identity entity carries, but a DIFFERENT
// (atom-foreign) id, unrelated to the `entities { Member: Person }` rename
// this orbital import actually declares. Reproduces std-wiki's
// `WikiAttachmentList = PageAtom.traits.WikiAttachmentList -> WikiAttachment`
// shape at the JS orbital-import path: no rename touches "Person" (so
// `entitySubs` never carries it), yet the id is genuinely foreign and must
// still be joined by NAME against the consumer roster.
function teamPersonNameCollisionTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMPERSONCOLL01' as TraitId,
    name: 'TeamPersonNameCollision',
    linkedEntity: 'Team',
    scope: 'instance',
    entityRefIds: { Person: 'ent_ATOM_LOCAL_PERSON0000001' as EntityId },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

// `sourceEntityDefinition` copy carries its OWN role-literal `read_policy` —
// must be rewritten too, same as the primary entity's.
function teamWidgetTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMWIDGET0001' as TraitId,
    name: 'TeamWidget',
    linkedEntity: 'Team',
    scope: 'instance',
    sourceEntityDefinition: { ...teamEntity(), read_policy: ['=', '@user.role', 'approver'] },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

// Bound DIRECTLY to the out-of-orbital `Member` entity via `linkedEntity` —
// the "trait linkedEntity" referenced-entity surface (distinct from a page's
// trait-ref `linkedEntity` override).
function teamRosterWidgetTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMROSTERW0001' as TraitId,
    name: 'TeamRosterWidget',
    linkedEntity: 'Member',
    scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

// Forwards the orbital-declared `navItems` knob — its default (an array of
// `{href,label}`) becomes a LITERAL only once the forward resolves; the
// page-path rewrite must run AFTER that (planning find i).
function teamAppLayoutTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMAPPLAYOUT01' as TraitId,
    name: 'TeamAppLayout',
    scope: 'instance',
    config: { navItems: { type: 'array', default: '@config.navItems' } },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

// Forwards `reminderChannel` — omitting this trait leaves the knob with no
// forwarder anywhere in the kept set (planning find iii).
function teamReminderTrait(): Trait {
  return {
    id: 'trt_SOURCE_TEAMREMINDER01' as TraitId,
    name: 'TeamReminder',
    scope: 'instance',
    config: { reminderChannel: { type: 'string', default: '@config.reminderChannel' } },
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

function teamPages(): Page[] {
  return [
    {
      id: 'pag_SOURCE_TEAMHOME0000001' as PageId,
      name: 'TeamHomePage',
      path: '/teams',
      primaryEntity: 'Team',
      traits: [
        { ref: 'TeamApproverGate' },
        { ref: 'TeamEmployeeGate' },
        { ref: 'TeamApproverNegGate' },
        { ref: 'TeamHaystackGate' },
        { ref: 'TeamDynamicHaystackGate' },
        { ref: 'TeamListCallHaystackGate' },
        { ref: 'TeamPersonNameCollision' },
        { ref: 'TeamWidget' },
      ],
    },
    {
      id: 'pag_SOURCE_TEAMROSTER0001' as PageId,
      name: 'TeamRosterPage',
      path: '/teams/roster',
      primaryEntity: 'Member',
      traits: [{ ref: 'TeamRosterWidget' }],
    },
  ];
}

function teamOrbital(): Orbital {
  return {
    id: TEAM_ORBITAL_ID,
    name: 'TeamOrbital',
    entity: teamEntity(),
    config: {
      navItems: { type: 'array', default: [{ href: '/teams', label: 'Teams' }] },
      reminderChannel: { type: 'string', default: 'email' },
    },
    traits: [
      teamApproverGateTrait(),
      teamEmployeeGateTrait(),
      teamApproverNegGateTrait(),
      teamHaystackGateTrait(),
      teamDynamicHaystackGateTrait(),
      teamListCallHaystackGateTrait(),
      teamPersonNameCollisionTrait(),
      teamWidgetTrait(),
      teamRosterWidgetTrait(),
      teamAppLayoutTrait(),
      teamReminderTrait(),
    ],
    pages: teamPages(),
  };
}

function widgetBadgeTrait(): Trait {
  return {
    id: 'trt_SOURCE_WIDGETBADGE001' as TraitId,
    name: 'WidgetBadge',
    scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
  };
}

function widgetOrbital(): Orbital {
  return {
    id: WIDGET_ORBITAL_ID,
    name: 'WidgetOrbital',
    entity: { name: 'Widget', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [widgetBadgeTrait()],
    pages: [],
  };
}

function makeOrgLoader(): SchemaLoader {
  const team = teamOrbital();
  const member = memberOrbital();
  const widget = widgetOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './org.orb') {
        return {
          success: true,
          data: { orbital: team, orbitals: [team, member], sourcePath: './org.orb', importPath },
        };
      }
      if (importPath === './widgets.orb') {
        return {
          success: true,
          data: { orbital: widget, orbitals: [widget], sourcePath: './widgets.orb', importPath },
        };
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

// The consumer's own `[identity]` roster — declared inline elsewhere in the
// SAME schema, independent of the "Org" import. Also the `entities {}`
// retarget's TARGET entity (`Member: Person`).
function consumerRosterOrbital(): OrbitalDefinition {
  return {
    name: 'Roster',
    uses: [],
    entity: {
      id: CONSUMER_PERSON_ID,
      name: 'Person',
      persistence: 'persistent',
      identity: true,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'role', type: 'string', values: ['owner', 'project_manager', 'team_member'] },
      ],
    },
    traits: [],
    pages: [],
  };
}

function orgConsumerOrbital(
  localName: string,
  ref: Partial<OrbitalRefObject> = {},
  siblingTraits: TraitRef[] = [],
): OrbitalDefinition {
  return {
    name: localName,
    uses: [
      { from: './org.orb', as: 'Org' },
      { from: './widgets.orb', as: 'Widgets' },
    ],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: siblingTraits,
    pages: [],
    reference: { ref: 'Org.orbitals.TeamOrbital', ...ref },
  };
}

const TEAM_ROLES = { approver: ['owner', 'project_manager'], employee: ['team_member'] };

function findTeamTrait(orbital: OrbitalDefinition, name: string): Trait {
  const found = (orbital.traits as Trait[]).find((t) => t.name === name);
  if (!found) {
    throw new Error(`trait "${name}" not materialized (have: ${(orbital.traits as Trait[]).map((t) => t.name).join(', ')})`);
  }
  return found;
}

describe('ReferenceResolver — orbital import Stage B: roles {}', () => {
  it('list target rewrites an `=` comparison to `array/includes`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gate = findTeamTrait(result.data[1], 'TeamsTeamApproverGate');
    const guard = gate.stateMachine!.transitions[0].guard;
    expect(guard).toEqual(['array/includes', ['owner', 'project_manager'], '@user.role']);
  });

  it('single target swaps the literal in place, operator untouched', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gate = findTeamTrait(result.data[1], 'TeamsTeamEmployeeGate');
    const guard = gate.stateMachine!.transitions[0].guard;
    expect(guard).toEqual(['=', '@user.role', 'team_member']);
  });

  it('`!=` with a list target wraps the array/includes rewrite in `not`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gate = findTeamTrait(result.data[1], 'TeamsTeamApproverNegGate');
    const guard = gate.stateMachine!.transitions[0].guard;
    expect(guard).toEqual(['not', ['array/includes', ['owner', 'project_manager'], '@user.role']]);
  });

  it('expands every mapped literal in an existing `array/includes` haystack, deduped, first-seen order; an unmapped literal passes through', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gate = findTeamTrait(result.data[1], 'TeamsTeamHaystackGate');
    const guard = gate.stateMachine!.transitions[0].guard;
    expect(guard).toEqual(['array/includes', ['owner', 'project_manager', 'team_member', 'guest'], '@user.role']);
  });

  it('a dynamic object/get haystack is left byte-identical, not corrupted', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gate = findTeamTrait(result.data[1], 'TeamsTeamDynamicHaystackGate');
    const guard = gate.stateMachine!.transitions[0].guard;
    expect(guard).toEqual([
      'array/includes',
      ['object/get', ['array/nth', '@config.steps', '@entity.currentStepIndex'], 'allowedRoles'],
      '@user.role',
    ]);
  });

  it('a `list`-call haystack expands only the tail through `roles`, keeping the wrap', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gate = findTeamTrait(result.data[1], 'TeamsTeamListCallHaystackGate');
    const guard = gate.stateMachine!.transitions[0].guard;
    expect(guard).toEqual(['array/includes', ['list', 'owner', 'project_manager', 'guest'], '@user.role']);
  });

  it('rewrites a role literal on both `sourceEntityDefinition` and the primary entity\'s own `read_policy`', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const widget = findTeamTrait(result.data[1], 'TeamsTeamWidget');
    expect(widget.sourceEntityDefinition!.read_policy).toEqual(['array/includes', ['owner', 'project_manager'], '@user.role']);

    const primary = result.data[1].entity as Entity;
    expect(primary.read_policy).toEqual(['=', '@user.role', 'team_member']);
  });

  it('an upstream literal not in any role field\'s vocabulary is ORB_O_ROLE_UNKNOWN_UPSTREAM', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: { boss: ['owner'] } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ROLE_UNKNOWN_UPSTREAM/);
    expect(result.errors.join('\n')).toContain('boss');
  });

  it('a target not a member of the consumer roster is ORB_O_ROLE_TARGET_NOT_MEMBER', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: { approver: ['ceo'] } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ROLE_TARGET_NOT_MEMBER/);
    expect(result.errors.join('\n')).toContain('ceo');
  });
});

// Coordinator addendum (2026-09-06): `materializeOrbitalRef`'s
// `consumerRoleVocab` used to be one flat `Set` unioning EVERY vocabulary
// field of the consumer roster, so `roles { approver: [owner, active] }`
// passed `ORB_O_ROLE_TARGET_NOT_MEMBER` whenever `active` happened to be a
// STATUS value on some OTHER field, not a role. Fixed to check per field:
// for each upstream `literal`, only the upstream field(s) whose vocabulary
// actually contains it, and each `target` must be a member of the CONSUMER
// identity entity's SAME-NAMED field's own declared values (Rust B4-R4
// twin, `consumer_role_vocabulary` / `orbital_ref_config.rs`).
describe('ReferenceResolver — orbital import Stage B: roles {} is per-field, not a union', () => {
  function statusFieldRosterOrbital(): OrbitalDefinition {
    return {
      name: 'Roster',
      uses: [],
      entity: {
        id: CONSUMER_PERSON_ID,
        name: 'Person',
        persistence: 'persistent',
        identity: true,
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'role', type: 'string', values: ['owner', 'project_manager', 'team_member'] },
          // A DIFFERENT field whose vocabulary coincidentally shares the
          // literal `active` with no role meaning at all — the exact PF
          // shape (`Person.status` including `active`, a STATUS value, not
          // a role).
          { name: 'status', type: 'string', values: ['active', 'suspended'] },
        ],
      },
      traits: [],
      pages: [],
    };
  }

  it('a single-form target that is only a value of a DIFFERENT consumer field (not `role`) is still ORB_O_ROLE_TARGET_NOT_MEMBER', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        statusFieldRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: { approver: ['active'], employee: ['team_member'] } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ROLE_TARGET_NOT_MEMBER/);
    expect(result.errors.join('\n')).toContain('active');
    // Names the field it checked against, not a union — the message must
    // point at `role` (the upstream field `approver` came from), never at
    // `status` (the field that actually happens to declare `active`).
    expect(result.errors.join('\n')).toContain('"role"');
  });

  it('a list target with ONE status-value member (`[owner, active]`) is still ORB_O_ROLE_TARGET_NOT_MEMBER — the whole list is not vouched for by one valid member', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        statusFieldRosterOrbital(),
        orgConsumerOrbital('Teams', {
          entities: { Member: 'Person' },
          roles: { approver: ['owner', 'active'], employee: ['team_member'] },
        }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ROLE_TARGET_NOT_MEMBER/);
    expect(result.errors.join('\n')).toContain('active');
  });

  it('the same roles block resolves cleanly once every target is a real `role` value', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        statusFieldRosterOrbital(),
        orgConsumerOrbital('Teams', {
          entities: { Member: 'Person' },
          roles: { approver: ['owner', 'project_manager'], employee: ['team_member'] },
        }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
  });
});

describe('ReferenceResolver — orbital import Stage B: entities {}', () => {
  it('retargets a relation target, a `fetch` effect, a render-ui `entity` prop, and a page `primaryEntity`; re-points ids', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const teams = result.data[1];
    const primary = teams.entity as Entity;
    const leadField = relationOf(primary.fields.find((f) => f.name === 'leadId')!);
    expect(leadField.entity).toBe('Person');
    expect(leadField.entityId).toBe(CONSUMER_PERSON_ID);

    const gate = findTeamTrait(teams, 'TeamsTeamApproverGate');
    const fetchEffect = gate.stateMachine!.transitions[0].effects![0] as unknown[];
    expect(fetchEffect).toEqual(['fetch', 'Person']);
    const renderUi = gate.stateMachine!.transitions[0].effects![1] as unknown[];
    expect((renderUi[2] as { entity: string }).entity).toBe('Person');

    const rosterPage = (teams.pages as Page[]).find((p) => p.name === 'TeamsTeamRosterPage')!;
    expect(rosterPage.primaryEntity).toBe('Person');

    const rosterWidget = findTeamTrait(teams, 'TeamsTeamRosterWidget');
    expect(rosterWidget.linkedEntity).toBe('Person');
  });

  it('a same-named secondary entityRefIds entry with NO rename still joins the consumer roster BY NAME, not the atom-foreign id', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const collision = findTeamTrait(result.data[1], 'TeamsTeamPersonNameCollision');
    expect(collision.entityRefIds).toEqual({ Person: CONSUMER_PERSON_ID });
  });

  it('a referenced out-of-orbital entity with no `entities {}` key is ORB_O_ENTITY_UNMAPPED', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { roles: TEAM_ROLES })],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ENTITY_UNMAPPED/);
    expect(result.errors.join('\n')).toContain('Member');
  });

  it('an `entities {}` key naming no out-of-orbital entity is ORB_O_ENTITY_UNKNOWN_KEY', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Nobody: 'Person' }, roles: TEAM_ROLES }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ENTITY_UNKNOWN_KEY/);
    expect(result.errors.join('\n')).toContain('Nobody');
  });

  it('an `entities {}` target the consumer does not declare is ORB_O_ENTITY_TARGET_UNKNOWN', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Nobody' }, roles: TEAM_ROLES }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ENTITY_TARGET_UNKNOWN/);
    expect(result.errors.join('\n')).toContain('Nobody');
  });
});

describe('ReferenceResolver — orbital import Stage B: pages {} / mounts {} unknown path', () => {
  it('a `pages {}` key naming no upstream page path is ORB_O_PAGE_UNKNOWN_PATH', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES, pages: { '/nope': '/x' } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_PAGE_UNKNOWN_PATH/);
    expect(result.errors.join('\n')).toContain('/nope');
  });

  it('a `mounts {}` key naming no upstream page path is ORB_O_PAGE_UNKNOWN_PATH', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', {
          entities: { Member: 'Person' },
          roles: TEAM_ROLES,
          mounts: { '/nope': ['TeamWidgetBadge'] },
        }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_PAGE_UNKNOWN_PATH/);
    expect(result.errors.join('\n')).toContain('/nope');
  });
});

describe('ReferenceResolver — orbital import Stage B: config-held page paths rewrite AFTER the forward', () => {
  it('a forwarded `navItems` knob\'s href is remapped once the forward resolves it to a literal', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES, pages: { '/teams': '/org-teams' } }),
      ],
    };

    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const layout = findTeamTrait(result.data[1], 'TeamsTeamAppLayout');
    const navItems = layout.config!.navItems.default as { href: string; label: string }[];
    expect(navItems[0].href).toBe('/org-teams');
  });
});

describe('ReferenceResolver — orbital import Stage B: dead-knob drop after omit', () => {
  it('a knob with a live forwarder survives; omitting its only forwarder drops it (no dead knob)', async () => {
    const withForwarder = await new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() }).resolveOrbitalImports({
      name: 'S',
      orbitals: [consumerRosterOrbital(), orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES })],
    });
    expect(withForwarder.success).toBe(true);
    if (!withForwarder.success) return;
    expect(withForwarder.data[1].config).toHaveProperty('reminderChannel');

    const withoutForwarder = await new ReferenceResolver({ basePath: '.', loader: makeOrgLoader() }).resolveOrbitalImports({
      name: 'S',
      orbitals: [
        consumerRosterOrbital(),
        orgConsumerOrbital('Teams', { entities: { Member: 'Person' }, roles: TEAM_ROLES, omit: ['TeamReminder'] }),
      ],
    });
    expect(withoutForwarder.success).toBe(true);
    if (!withoutForwarder.success) return;
    expect(withoutForwarder.data[1].config).not.toHaveProperty('reminderChannel');
    // The rest of the declared config survives untouched.
    expect(withoutForwarder.data[1].config).toHaveProperty('navItems');
  });
});

describe('ReferenceResolver — orbital import Stage B: siblings + mounts', () => {
  it('appends a sibling trait un-prefixed, mounts it on the remapped page, and resolves its `Alias.traits.X` ref against the consumer\'s `uses`', async () => {
    const consumer = orgConsumerOrbital(
      'Teams',
      {
        entities: { Member: 'Person' },
        roles: TEAM_ROLES,
        pages: { '/teams': '/org-teams' },
        mounts: { '/teams': ['TeamWidgetBadge'] },
      },
      [{ ref: 'Widgets.traits.WidgetBadge', name: 'TeamWidgetBadge' }],
    );
    const schema: OrbitalSchema = { name: 'S', orbitals: [consumerRosterOrbital(), consumer] };

    // Sibling resolution rides the ordinary per-orbital `resolve()` pass —
    // exercise the full `resolveSchema` pipeline, not just the flatten step.
    const result = await resolveSchema(schema, { basePath: '.', loader: makeOrgLoader() });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const teams = result.data.find((r) => r.original.name === 'Teams')!;
    const sibling = teams.traits.find((rt) => rt.trait.name === 'TeamWidgetBadge');
    expect(sibling).toBeDefined();
    // Un-prefixed — never touched by the `TeamsTeam...` prefix rule.
    expect(sibling!.trait.name).toBe('TeamWidgetBadge');

    const rosterPage = teams.pages.find((rp) => rp.page.path === '/org-teams')!;
    expect((rosterPage.page.traits ?? []).some((tr) => tr.ref === 'TeamWidgetBadge')).toBe(true);
  });
});

// G1 (`docs/Almadar_Compiler_Gaps.md` §82): cross-import listen sources.
// One upstream file, TWO orbitals of the SAME alias — `AlphaOrbital`'s
// `AlphaCreate` trait, and `BetaOrbital`'s `BetaListener` trait, which
// listens on `AlphaOrbital.AlphaCreate.CREATED` via the 3-part
// `Orbital.Trait.EVENT` form (mirrors `std-realtime-chat`'s `ChannelCreate`
// listening on `ChatMessageOrbital.ChatRoom.CREATE_CHANNEL`). A consumer
// that imports BOTH orbitals must re-point that source at whichever LOCAL
// name each import was given, regardless of declaration order.
function alphaOrbital(): Orbital {
  return {
    id: 'orb_SOURCE_ALPHA00000000001' as OrbitalId,
    name: 'AlphaOrbital',
    entity: {
      id: 'ent_SOURCE_ALPHATHING000001' as EntityId,
      name: 'AlphaThing',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [
      {
        id: 'trt_SOURCE_ALPHACREATE00001' as TraitId,
        name: 'AlphaCreate',
        linkedEntity: 'AlphaThing',
        scope: 'instance',
        emits: [{ event: 'CREATED', scope: 'external' }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'CREATE', name: 'Create' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'CREATE', effects: [['emit', 'CREATED']] }],
        },
      },
    ],
    pages: [],
  };
}

function betaOrbital(): Orbital {
  return {
    id: 'orb_SOURCE_BETA000000000001' as OrbitalId,
    name: 'BetaOrbital',
    entity: {
      id: 'ent_SOURCE_BETATHING0000001' as EntityId,
      name: 'BetaThing',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [
      {
        id: 'trt_SOURCE_BETALISTENER0001' as TraitId,
        name: 'BetaListener',
        linkedEntity: 'BetaThing',
        scope: 'instance',
        listens: [
          {
            event: 'SEEN',
            triggers: 'REFRESH',
            source: { kind: 'orbital', orbital: 'AlphaOrbital', trait: 'AlphaCreate' },
          },
        ],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'REFRESH', name: 'Refresh' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'REFRESH', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

function makeG1Loader(): SchemaLoader {
  const alpha = alphaOrbital();
  const beta = betaOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './g1-upstream.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital: alpha, orbitals: [alpha, beta], sourcePath: './g1-upstream.orb', importPath },
      };
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

function g1ConsumerOrbital(localName: string, upstreamOrbitalName: 'AlphaOrbital' | 'BetaOrbital'): OrbitalDefinition {
  return {
    name: localName,
    uses: [{ from: './g1-upstream.orb', as: 'Up' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: `Up.orbitals.${upstreamOrbitalName}` },
  };
}

function assertBetaListenerResolvesToLocalAlpha(orbitals: readonly OrbitalDefinition[]): void {
  const beta = orbitals.find((o) => o.name === 'LocalBeta');
  expect(beta).toBeDefined();
  const listener = findTrait(beta!, 'LocalBetaBetaListener');
  const source = listener.listens?.[0]?.source;
  expect(source).toBeDefined();
  if (source?.kind !== 'orbital') throw new Error(`expected an orbital-kind source, got ${source?.kind}`);
  expect(source.orbital).toBe('LocalAlpha');
  expect(source.trait).toBe('LocalAlphaAlphaCreate');
  expect(source.traitId).toBeDefined();
}

describe('ReferenceResolver — orbital import G1: cross-import listen sources', () => {
  it('re-points a listen source naming a SIBLING import of the same alias (target declared first)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG1Loader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [g1ConsumerOrbital('LocalAlpha', 'AlphaOrbital'), g1ConsumerOrbital('LocalBeta', 'BetaOrbital')],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    assertBetaListenerResolvesToLocalAlpha(result.data);
  });

  it('is order-independent: resolves the same way when the listener import is declared FIRST', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG1Loader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [g1ConsumerOrbital('LocalBeta', 'BetaOrbital'), g1ConsumerOrbital('LocalAlpha', 'AlphaOrbital')],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    assertBetaListenerResolvesToLocalAlpha(result.data);
  });
});

// G2 (`docs/Almadar_Compiler_Gaps.md` §82): `entity <Name>` does not rewrite
// `entity`-typed config knob VALUES. Mirrors `std-hr-portal.lolo`'s real
// shape: `WidgetSync`'s `targetEntity : entity` knob's literal default names
// the SAME orbital's OWN primary entity ("Widget", exactly like
// `TimeOffCalendarSync.config.targetEntity` defaulting to `TimeOff`,
// `TimeOffOrbital`'s own primary). `entity Gadget` on the reference clones
// the primary as `GadgetOrbitalWidget` — the config VALUE must follow.
function g2UpstreamOrbital(): Orbital {
  return {
    id: 'orb_SOURCE_SYNCORBITAL000001' as OrbitalId,
    name: 'SyncOrbital',
    entity: {
      id: 'ent_SOURCE_WIDGET00000000001' as EntityId,
      name: 'Widget',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [
      {
        id: 'trt_SOURCE_WIDGETSYNC000001' as TraitId,
        name: 'WidgetSync',
        linkedEntity: 'Widget',
        scope: 'instance',
        config: { targetEntity: { type: 'entity', default: 'Widget' } } satisfies DeclaredTraitConfig,
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'SYNC', name: 'Sync' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'SYNC', effects: [['fetch', '@config.targetEntity']] }],
        },
      },
    ],
    pages: [],
  };
}

function makeG2Loader(): SchemaLoader {
  const orbital = g2UpstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './g2-upstream.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './g2-upstream.orb', importPath },
      };
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

describe('ReferenceResolver — orbital import G2: entity-typed config knob values', () => {
  it('rewrites an `entity`-typed config knob default through the SAME entity rename `entity <Name>` applies everywhere else', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG2Loader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        {
          name: 'GadgetOrbital',
          uses: [{ from: './g2-upstream.orb', as: 'Up' }],
          entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
          traits: [],
          pages: [],
          reference: { ref: 'Up.orbitals.SyncOrbital', entity: 'Gadget' },
        },
      ],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [orbital] = result.data;
    expect((orbital.entity as Entity).name).toBe('Gadget');
    const primaryId = (orbital.entity as Entity).id;

    const sync = findTrait(orbital, 'GadgetOrbitalWidgetSync');
    const targetEntity = sync.config?.targetEntity;
    expect(targetEntity?.default).toBe('Gadget');
    expect(targetEntity?.refId).toBe(primaryId);
  });
});

// ============================================================================
// G3 (`docs/Almadar_Compiler_Gaps.md` §82): `fields {}` reaches every
// structurally-recognized field-reference position, not just `@entity.<f>`.
// ============================================================================

function g3UpstreamOrbital(): Orbital {
  return {
    id: 'orb_SOURCE_DEALORBITAL00001' as OrbitalId,
    name: 'DealOrbital',
    entity: {
      id: 'ent_SOURCE_DEAL00000000001' as EntityId,
      name: 'Deal',
      persistence: 'runtime',
      read_policy: ['=', ['object/get', '@entity', 'title'], '@user.id'],
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string' },
        { name: 'amount', type: 'number' },
      ],
    },
    traits: [
      {
        id: 'trt_SOURCE_DEALBOARD000001' as TraitId,
        name: 'DealBoard',
        linkedEntity: 'Deal',
        scope: 'instance',
        config: {
          formFields: { type: '[string]', default: ['title', 'amount'] },
          searchField: { type: 'string', default: 'title' },
          cardTitleBinding: { type: 'string', default: '@item.title' },
        } satisfies DeclaredTraitConfig,
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Initialize' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT' }],
        },
      },
    ],
    pages: [],
  };
}

function makeG3Loader(): SchemaLoader {
  const orbital = g3UpstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './g3-upstream.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './g3-upstream.orb', importPath },
      };
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

describe('ReferenceResolver — orbital import G3: fields {} reaches bare config defaults, @item, and object/get', () => {
  it('rewrites formFields (bare [string]), searchField (bare string), cardTitleBinding (@item.<f>), and the entity read_policy (object/get @entity <f>)', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG3Loader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        {
          name: 'LeadOrbital',
          uses: [{ from: './g3-upstream.orb', as: 'Up' }],
          entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
          traits: [],
          pages: [],
          reference: {
            ref: 'Up.orbitals.DealOrbital',
            entity: 'Lead',
            fields: { title: 'company', amount: 'value' },
          },
        },
      ],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [orbital] = result.data;
    const entity = orbital.entity as Entity;
    expect(entity.name).toBe('Lead');
    expect(entity.fields.some((f) => f.name === 'company')).toBe(true);
    expect(entity.read_policy).toEqual(['=', ['object/get', '@entity', 'company'], '@user.id']);

    const board = findTrait(orbital, 'LeadOrbitalDealBoard');
    expect(board.config?.formFields?.default).toEqual(['company', 'value']);
    expect(board.config?.searchField?.default).toBe('company');
    expect(board.config?.cardTitleBinding?.default).toBe('@item.company');
  });
});

// ============================================================================
// G5 (`docs/Almadar_Compiler_Gaps.md` §82): `events {}` reaches a SOURCED
// listen's source-side `event` key when the source trait is within this
// same import.
// ============================================================================

function g5UpstreamOrbital(): Orbital {
  return {
    id: 'orb_SOURCE_DOCORBITAL000001' as OrbitalId,
    name: 'DocOrbital',
    entity: {
      id: 'ent_SOURCE_DOCUMENT0000001' as EntityId,
      name: 'Document',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [
      {
        id: 'trt_SOURCE_INBOX000000001' as TraitId,
        name: 'Inbox',
        linkedEntity: 'Document',
        scope: 'instance',
        emits: [{ event: 'APPROVE' }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Initialize' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT' }],
        },
      },
      {
        id: 'trt_SOURCE_DECISION00001' as TraitId,
        name: 'Decision',
        linkedEntity: 'Document',
        scope: 'instance',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'APPROVE', name: 'Approve' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'APPROVE' }],
        },
        listens: [
          {
            event: 'APPROVE',
            triggers: 'APPROVE',
            source: { kind: 'trait', trait: 'Inbox' },
          },
        ],
      },
    ],
    pages: [],
  };
}

function makeG5Loader(): SchemaLoader {
  const orbital = g5UpstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './g5-upstream.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './g5-upstream.orb', importPath },
      };
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

describe('ReferenceResolver — orbital import G5: events {} reaches a sourced listen within the same import', () => {
  it('renames Inbox\'s own emit AND Decision\'s sourced-listen event key, not just the local trigger', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG5Loader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        {
          name: 'AssetLibraryOrbital',
          uses: [{ from: './g5-upstream.orb', as: 'Up' }],
          entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
          traits: [],
          pages: [],
          reference: {
            ref: 'Up.orbitals.DocOrbital',
            events: { APPROVE: 'ASSET_REVIEW_APPROVE' },
          },
        },
      ],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [orbital] = result.data;

    const inbox = findTrait(orbital, 'AssetLibraryOrbitalInbox');
    expect(inbox.emits?.[0]).toMatchObject({ event: 'ASSET_REVIEW_APPROVE' });

    const decision = findTrait(orbital, 'AssetLibraryOrbitalDecision');
    const listen = decision.listens?.[0];
    expect(listen?.event).toBe('ASSET_REVIEW_APPROVE');
    expect(listen?.triggers).toBe('ASSET_REVIEW_APPROVE');
  });
});

// G5 id reconciliation: `events {}` renames the event KEY, but the
// declaration's id keeps naming its PRE-rename key in `schema.ledger`
// (copied in wholesale from the upstream file at load time) unless
// `reconcileOrbitalRefEventIdRenames` (`resolveOrbitalImports`'s own
// post-flatten pass) re-derives it — the JS mirror of the compiled path's
// `reconcileOrbitalRefEventIdRenames` (`orbital-rust/.../inline/mod.rs`).
function g5UpstreamOrbitalWithEventId(): Orbital {
  const orbital = g5UpstreamOrbital();
  return {
    ...orbital,
    traits: orbital.traits.map((tr) => {
      const trait = tr as Trait;
      if (trait.name !== 'Decision') return tr;
      return {
        ...trait,
        stateMachine: {
          ...trait.stateMachine!,
          events: [{ key: 'APPROVE', name: 'Approve', id: 'evt_G5APPROVEEVT0000000001' as EventId }],
          transitions: [
            { from: 'idle', to: 'idle', event: 'APPROVE', eventId: 'evt_G5APPROVEEVT0000000001' as EventId },
          ],
        },
        listens: [
          {
            event: 'APPROVE',
            eventId: 'evt_G5APPROVEEVT0000000001' as EventId,
            triggers: 'APPROVE',
            triggersId: 'evt_G5APPROVEEVT0000000001' as EventId,
            source: { kind: 'trait' as const, trait: 'Inbox' },
          },
        ],
      };
    }),
  };
}

function makeG5LedgerLoader(): SchemaLoader {
  const orbital = g5UpstreamOrbitalWithEventId();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './g5-upstream.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './g5-upstream.orb', importPath },
      };
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

describe('ReferenceResolver — orbital import G5: events {} re-derives the shared event id', () => {
  it('renames the ledger entry in place (sole owner) instead of orphaning it', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG5LedgerLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      ledger: {
        schemaVersion: 1,
        entries: {
          evt_G5APPROVEEVT0000000001: {
            id: 'evt_G5APPROVEEVT0000000001',
            kind: 'event',
            bakedName: 'APPROVE',
            curName: 'APPROVE',
            renames: [],
            owner: 'workspace',
            parent: 'trt_SOURCE_DECISION00001' as TraitId,
          },
        },
      },
      orbitals: [
        {
          name: 'AssetLibraryOrbital',
          uses: [{ from: './g5-upstream.orb', as: 'Up' }],
          entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
          traits: [],
          pages: [],
          reference: {
            ref: 'Up.orbitals.DocOrbital',
            events: { APPROVE: 'ASSET_REVIEW_APPROVE' },
          },
        },
      ],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [orbital] = result.data;
    const decision = findTrait(orbital, 'AssetLibraryOrbitalDecision');

    // Sole owner in this whole schema — the id itself must NOT change (only
    // the ledger's curName does); minting a fresh id here would orphan the
    // original row with nothing left to explain it.
    const finalId = decision.listens?.[0]?.eventId;
    expect(finalId).toBe('evt_G5APPROVEEVT0000000001');
    expect(decision.stateMachine?.events?.[0]?.id).toBe(finalId);
    expect(decision.stateMachine?.transitions?.[0]?.eventId).toBe(finalId);
    expect(decision.listens?.[0]?.triggersId).toBe(finalId);

    const entry = schema.ledger?.entries[finalId!];
    expect(entry?.curName).toBe('ASSET_REVIEW_APPROVE');
    expect(entry?.renames).toContainEqual(
      expect.objectContaining({ from: 'APPROVE', to: 'ASSET_REVIEW_APPROVE' }),
    );
  });
});

// G3 follow-up (`docs/Almadar_Compiler_Gaps.md` §82): a `fields {}` rename
// must also reach a config-forward's DESTINATION, not just its declaring
// trait — a JSX-hoisted inline render's `columns: @config.columns` forward
// resolves to its embedder's declared literal AFTER this trait's own field
// rewrite already ran, in the SAME per-trait loop iteration.
function g3HoistUpstreamOrbital(): Orbital {
  return {
    id: 'orb_G3HOISTORBITALID00000000' as OrbitalId,
    name: 'TimeEntryPanelOrbital',
    entity: {
      id: 'ent_G3HOISTENTITYID000000000' as EntityId,
      name: 'TimeEntry',
      persistence: 'runtime',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'hourlyRate', type: 'number' },
      ],
    },
    traits: [
      {
        id: 'trt_G3HOISTPANELID00000000' as TraitId,
        name: 'TimeEntryPanel',
        linkedEntity: 'TimeEntry',
        scope: 'instance',
        config: {
          columns: {
            type: '[ColumnSpec]',
            default: [{ field: 'hourlyRate', key: 'hourlyRate', header: 'Rate' }],
          },
        },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Initialize' }],
          transitions: [
            {
              from: 'idle',
              to: 'idle',
              event: 'INIT',
              effects: [['render-ui', 'main', '@trait.InlineTableViewRender']],
            },
          ],
        },
      },
      {
        id: 'trt_G3HOISTRENDERID0000000' as TraitId,
        name: 'InlineTableViewRender',
        linkedEntity: 'TimeEntry',
        scope: 'instance',
        config: {
          columns: { type: 'unknown', default: '@config.columns' },
        },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Initialize' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT' }],
        },
      },
    ],
    pages: [],
  };
}

function makeG3HoistLoader(): SchemaLoader {
  const orbital = g3HoistUpstreamOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath !== './g3-hoist-upstream.orb') {
        return { success: false, error: `unexpected import path: ${importPath}` };
      }
      return {
        success: true,
        data: { orbital, orbitals: [orbital], sourcePath: './g3-hoist-upstream.orb', importPath },
      };
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

describe('ReferenceResolver — orbital import G3: fields {} reaches a hoisted render\'s forwarded columns', () => {
  it('rewrites the forwarded columns[].field/key, not just the declaring trait\'s own default', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeG3HoistLoader() });
    const schema: OrbitalSchema = {
      name: 'S',
      orbitals: [
        {
          name: 'TimeEntryOrbital',
          uses: [{ from: './g3-hoist-upstream.orb', as: 'Up' }],
          entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
          traits: [],
          pages: [],
          reference: {
            ref: 'Up.orbitals.TimeEntryPanelOrbital',
            entity: 'TimeEntry',
            fields: { hourlyRate: 'billRate' },
          },
        },
      ],
    };
    const result = await resolver.resolveOrbitalImports(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [orbital] = result.data;

    const render = findTrait(orbital, 'TimeEntryOrbitalInlineTableViewRender');
    const columns = render.config?.columns?.default as Array<{ field?: string; key?: string }> | undefined;
    expect(columns?.[0]?.field).toBe('billRate');
    expect(columns?.[0]?.key).toBe('billRate');
  });
});
