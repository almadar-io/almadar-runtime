import { describe, it, expect } from 'vitest';
import { resolveSchema } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Effect, Entity, OrbitalDefinition, OrbitalSchema, StateMachine } from '@almadar/core';
import type { ResolvedOrbital } from '../src/entities/resolver/reference-resolver.js';

// Twin of orbital-compiler's `a_retargeted_shared_entity_carries_the_fields_the_importing_traits_write`:
// an organism whose orbitals share an entity — `OwnerOrbital` owns `Note` (aux, `id` only),
// `UserOrbital`'s trait writes `Note.body` through an atom. Imported orbital by orbital, the
// consumer retargets `Note` onto the owner import's copy; that copy must carry `body`.

const ATOM: OrbitalDefinition = {
  name: 'NoteOrbital',
  entity: { name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }, { name: 'body', type: 'string' }] },
  traits: [
    {
      name: 'NoteKeeper',
      scope: 'instance',
      linkedEntity: 'Note',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'WRITE', name: 'WRITE' }],
        transitions: [{ from: 'idle', to: 'idle', event: 'WRITE', effects: [['set', '@entity.body', 'x']] }],
      },
    },
  ],
  pages: [],
};

const OWNER: OrbitalDefinition = {
  name: 'OwnerOrbital',
  entity: { name: 'Owner', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
  auxiliaryEntities: [{ name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] }],
  traits: [],
  pages: [],
};

const USER: OrbitalDefinition = {
  name: 'UserOrbital',
  uses: [{ from: './atom.orb', as: 'Atom' }],
  entity: { name: 'UserView', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
  traits: [{ ref: 'Atom.traits.NoteKeeper', linkedEntity: 'Note' }],
  pages: [],
};

function loader(): SchemaLoader {
  const files: Record<string, OrbitalDefinition[]> = { './atom.orb': [ATOM], './org.orb': [OWNER, USER] };
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      const orbitals = files[importPath];
      if (!orbitals) return { success: false, error: `unexpected import path: ${importPath}` };
      return { success: true, data: { orbital: orbitals[0]!, orbitals, sourcePath: importPath, importPath } };
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

function importOf(name: string, upstream: string, entity: string, entities?: Record<string, string>): OrbitalDefinition {
  return {
    name,
    uses: [{ from: './org.orb', as: 'Org' }],
    entity: `Org.orbitals.${upstream}.entity`,
    traits: [],
    pages: [],
    reference: { ref: `Org.orbitals.${upstream}`, entity, ...(entities ? { entities } : {}) },
  };
}

async function resolve(userEntities?: Record<string, string>): Promise<ResolvedOrbital[]> {
  const schema: OrbitalSchema = {
    name: 'Consumer',
    orbitals: [importOf('Owner', 'OwnerOrbital', 'Owner'), importOf('User', 'UserOrbital', 'UserView', userEntities)],
  };
  const result = await resolveSchema(schema, { basePath: '.', loader: loader() });
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data;
}

const byName = (resolved: ResolvedOrbital[], name: string): ResolvedOrbital => {
  const found = resolved.find((o) => o.name === name);
  if (!found) throw new Error(`no orbital ${name}`);
  return found;
};

const auxOf = (o: ResolvedOrbital): Entity[] => [
  ...(o.auxiliaryEntities ?? []),
  ...(o.original.auxiliaryEntities ?? []).filter((e): e is Entity => typeof e !== 'string'),
];

const linkedOf = (o: ResolvedOrbital): string[] => o.traits.flatMap((t) => (t.linkedEntity ?? t.trait.linkedEntity) ?? []);

describe('orbital import — a shared entity retargeted across imports', () => {
  it('the retarget target carries the fields the importing traits write', async () => {
    const resolved = await resolve({ Note: 'OwnerNote' });
    expect(linkedOf(byName(resolved, 'User'))).toContain('OwnerNote');
    const note = auxOf(byName(resolved, 'Owner')).find((e) => e.name === 'OwnerNote');
    expect(note?.fields.map((f) => f.name)).toContain('body');
  });

  it('control: without a retarget the import keeps its own copy', async () => {
    const resolved = await resolve();
    expect(linkedOf(byName(resolved, 'User'))).toContain('UserNote');
  });

  it('control: a target no import declares is still refused', async () => {
    await expect(resolve({ Note: 'NoSuchEntity' })).rejects.toThrow(/ORB_O_ENTITY_TARGET_UNKNOWN/);
  });
});

const idField = { name: 'id', type: 'string' as const, required: true };
const idle = (event: string, effects: Effect[]): StateMachine => ({
  states: [{ name: 'idle', isInitial: true }],
  events: [{ key: event, name: event }],
  transitions: [{ from: 'idle', to: 'idle', event, effects }],
});

function filesLoader(files: Record<string, OrbitalDefinition[]>): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      const orbitals = files[importPath];
      if (!orbitals) return { success: false, error: `unexpected import path: ${importPath}` };
      return { success: true, data: { orbital: orbitals[0]!, orbitals, sourcePath: importPath, importPath } };
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

function importFrom(name: string, alias: string, from: string, upstream: string, entity: string, entities?: Record<string, string>): OrbitalDefinition {
  return {
    name,
    uses: [{ from, as: alias }],
    entity: `${alias}.orbitals.${upstream}.entity`,
    traits: [],
    pages: [],
    reference: { ref: `${alias}.orbitals.${upstream}`, entity, ...(entities ? { entities } : {}) },
  };
}

// One file, two orbitals sharing `Product`: `ProductOrbital` owns it, `ShelfOrbital` carries an
// auxiliary copy its trait writes. Twin of orbital-compiler's `a_same_file_siblings_entity_…`.
const SHOP: OrbitalDefinition[] = [
  {
    name: 'ProductOrbital',
    entity: { name: 'Product', persistence: 'runtime', fields: [idField, { name: 'title', type: 'string' }] },
    traits: [],
    pages: [],
  },
  {
    name: 'ShelfOrbital',
    entity: { name: 'Shelf', persistence: 'runtime', fields: [idField] },
    auxiliaryEntities: [{ name: 'Product', persistence: 'runtime', fields: [idField, { name: 'title', type: 'string' }] }],
    traits: [{ name: 'ShelfRows', scope: 'instance', linkedEntity: 'Product', stateMachine: idle('INIT', [['set', '@entity.title', 'x']]) }],
    pages: [],
  },
];

async function resolveShop(shelfEntities?: Record<string, string>): Promise<ResolvedOrbital[]> {
  const schema: OrbitalSchema = {
    name: 'Consumer',
    orbitals: [
      importFrom('ProductOrbital', 'Shop', './shop.orb', 'ProductOrbital', 'Product'),
      importFrom('ShelfOrbital', 'Shop', './shop.orb', 'ShelfOrbital', 'Shelf', shelfEntities),
    ],
  };
  const result = await resolveSchema(schema, { basePath: '.', loader: filesLoader({ './shop.orb': SHOP }) });
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data;
}

describe('orbital import — an entity a same-file sibling owns', () => {
  it('is shared through `entities {}`, not copied into the import', async () => {
    const resolved = await resolveShop({ Product: 'Product' });
    const shelf = byName(resolved, 'ShelfOrbital');
    expect(linkedOf(shelf)).toContain('Product');
    expect(auxOf(shelf).map((e) => e.name)).not.toContain('ShelfOrbitalProduct');
  });

  it('control: unmapped, it is refused as unmapped', async () => {
    await expect(resolveShop()).rejects.toThrow(/ORB_O_ENTITY_UNMAPPED/);
  });
});

// `base.orb`: `PersonOrbital` owns `Person`, `ChatOrbital`'s trait links it. `solution.orb`
// imports both, naming `Person` `Customer` and retargeting the chat onto it.
const BASE: OrbitalDefinition[] = [
  { name: 'PersonOrbital', entity: { name: 'Person', persistence: 'runtime', fields: [idField] }, traits: [], pages: [] },
  {
    name: 'ChatOrbital',
    entity: { name: 'Chat', persistence: 'runtime', fields: [idField] },
    auxiliaryEntities: [{ name: 'Person', persistence: 'runtime', fields: [idField] }],
    traits: [{ name: 'ChatWho', scope: 'instance', linkedEntity: 'Person', stateMachine: idle('INIT', []) }],
    pages: [],
  },
];

async function resolveNested(chatEntities: Record<string, string>): Promise<ResolvedOrbital[]> {
  const solution: OrbitalDefinition[] = [
    importFrom('Account', 'Base', './base.orb', 'PersonOrbital', 'Customer'),
    importFrom('Chat', 'Base', './base.orb', 'ChatOrbital', 'Chat', chatEntities),
  ];
  const schema: OrbitalSchema = {
    name: 'Consumer',
    orbitals: [
      importFrom('Account', 'Sol', './solution.orb', 'Account', 'Customer'),
      importFrom('Chat', 'Sol', './solution.orb', 'Chat', 'Chat', { Customer: 'Customer' }),
    ],
  };
  const result = await resolveSchema(schema, {
    basePath: '.',
    loader: filesLoader({ './base.orb': BASE, './solution.orb': solution }),
  });
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data;
}

describe('orbital import — an imported program\'s own retarget', () => {
  it('resolves against that program\'s own sibling imports', async () => {
    const resolved = await resolveNested({ Person: 'Customer' });
    expect(linkedOf(byName(resolved, 'Chat'))).toContain('Customer');
  });

  it('control: a target naming nothing is still refused', async () => {
    await expect(resolveNested({ Person: 'Nobody' })).rejects.toThrow(/ORB_O_ENTITY_TARGET_UNKNOWN/);
  });
});


// Twin of orbital-compiler's `a_forward_to_an_app_knob_two_imports_deep_resolves_in_its_own_home`:
// `Exp` declares the app knob `welcomeTitle` and its `Welcome` trait forwards `headline` to it;
// `Sol` composes `Exp.traits.Welcome` into its own `View`; the consumer imports `Sol.orbitals.View`.
function expProgram(): { orbitals: OrbitalDefinition[]; config: Record<string, { type: string; default: string }> } {
  return {
    config: { welcomeTitle: { type: 'string', default: 'Your ledger' } },
    orbitals: [{
      name: 'HomeOrbital',
      entity: { name: 'Visit', persistence: 'runtime', fields: [idField] },
      traits: [{
        name: 'Welcome',
        scope: 'instance',
        linkedEntity: 'Visit',
        config: { headline: { type: 'string', default: '@config.welcomeTitle' } },
        stateMachine: idle('INIT', [['render-ui', 'main', { type: 'typography', content: '@config.headline' }]]),
      }],
      pages: [],
    }],
  };
}

async function resolveTwoLevel(solUsesConfig?: Record<string, { type: string; default: string }>, solConfig?: Record<string, { type: string; default: string }>, consumerUsesConfig?: Record<string, { type: string; default: string }>): Promise<ResolvedOrbital[]> {
  const exp = expProgram();
  const sol: OrbitalDefinition[] = [{
    name: 'View',
    uses: [{ from: './exp.orb', as: 'Exp', ...(solUsesConfig ? { config: solUsesConfig } : {}) }],
    entity: { name: 'ViewVisit', persistence: 'runtime', fields: [idField] },
    traits: [{ ref: 'Exp.traits.Welcome' }],
    pages: [],
  }];
  const files: Record<string, { orbitals: OrbitalDefinition[]; config?: Record<string, { type: string; default: string }> }> = {
    './exp.orb': exp,
    './sol.orb': { orbitals: sol, ...(solConfig ? { config: solConfig } : {}) },
  };
  const loader: SchemaLoader = {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      const file = files[importPath];
      if (!file) return { success: false, error: `unexpected import path: ${importPath}` };
      return { success: true, data: { orbital: file.orbitals[0]!, orbitals: file.orbitals, sourcePath: importPath, importPath, ...(file.config ? { schemaConfig: file.config } : {}) } };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {},
    getCacheStats() {
      return { size: 0 };
    },
  };
  const consumer = importFrom('View', 'Sol', './sol.orb', 'View', 'ViewVisit');
  if (consumerUsesConfig) consumer.uses = [{ from: './sol.orb', as: 'Sol', config: consumerUsesConfig }];
  const result = await resolveSchema({ name: 'Consumer', orbitals: [consumer] }, { basePath: '.', loader });
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data;
}

const headline = (resolved: ResolvedOrbital[]): string | undefined => {
  const t = byName(resolved, 'View').traits.find((x) => x.trait.name.endsWith('Welcome'));
  const field = t?.trait.config?.['headline'];
  return field !== undefined && typeof field.default === 'string' ? field.default : undefined;
};

describe('orbital import — a forward to an app knob two imports deep', () => {
  it('resolves in its own home', async () => {
    expect(headline(await resolveTwoLevel())).toBe('Your ledger');
  });

  it('control: a knob the middle program re-exposes stays overridable by its importer', async () => {
    const resolved = await resolveTwoLevel(
      { welcomeTitle: { type: 'unknown', default: '@config.solTitle' } },
      { solTitle: { type: 'string', default: 'Sol default' } },
      { solTitle: { type: 'unknown', default: 'Candles' } },
    );
    expect(headline(resolved)).toBe('Candles');
  });
});

// Twin of orbital-compiler's `a_pulled_sibling_comes_from_the_orbital_that_declares_its_parent`:
// `hr.orb` composes one atom twice — `HomeOrbital` (declared first) rebinds it to `Offboarding`,
// `EmployeeOrbital` to `Employee`; a consumer of `EmployeeList` must pull EmployeeOrbital's `Filter`.
async function resolveComposing(traitName: string): Promise<ResolvedOrbital[]> {
  const itemFields = [idField, { name: 'title', type: 'string' as const }];
  const atom: OrbitalDefinition[] = [{
    name: 'ItemOrbital',
    entity: { name: 'Item', persistence: 'runtime', fields: itemFields },
    traits: [
      { name: 'List', scope: 'instance', linkedEntity: 'Item', stateMachine: idle('INIT', [['render-ui', 'main', { type: 'stack', children: ['@trait.Filter'] }]]) },
      { name: 'Filter', scope: 'instance', linkedEntity: 'Item', stateMachine: idle('INIT', [['set', '@entity.title', 'x']]) },
    ],
    pages: [],
  }];
  const entity = (name: string): Entity => ({ name, persistence: 'runtime', fields: itemFields });
  const hr: OrbitalDefinition[] = [
    { name: 'HomeOrbital', uses: [{ from: './atom.orb', as: 'HomeAtom' }], entity: entity('HomeVisit'), auxiliaryEntities: [entity('Offboarding')], traits: [{ ref: 'HomeAtom.traits.List', name: 'HomeList', linkedEntity: 'Offboarding' }], pages: [] },
    { name: 'EmployeeOrbital', uses: [{ from: './atom.orb', as: 'Atom' }], entity: entity('Employee'), traits: [{ ref: 'Atom.traits.List', name: 'EmployeeList', linkedEntity: 'Employee' }], pages: [] },
  ];
  const consumer: OrbitalDefinition = {
    name: 'PersonOrbital',
    uses: [{ from: './hr.orb', as: 'Hr' }],
    entity: entity('Person'),
    traits: [{ ref: `Hr.traits.${traitName}`, linkedEntity: 'Person' }],
    pages: [],
  };
  const result = await resolveSchema({ name: 'Consumer', orbitals: [consumer] }, { basePath: '.', loader: filesLoader({ './atom.orb': atom, './hr.orb': hr }) });
  if (!result.success) throw new Error(result.errors.join('\n'));
  return result.data;
}

describe('sibling pull — one atom composed by two orbitals of an imported program', () => {
  it('pulls the sibling from the orbital that declares the pulling trait', async () => {
    const person = byName(await resolveComposing('EmployeeList'), 'PersonOrbital');
    expect(linkedOf(person)).not.toContain('Offboarding');
  });

  it('control: composing the first orbital\'s trait still pulls its own sibling', async () => {
    const person = byName(await resolveComposing('HomeList'), 'PersonOrbital');
    expect(person.traits.map((t) => t.trait.name).some((n) => n.endsWith('Filter'))).toBe(true);
  });
});
