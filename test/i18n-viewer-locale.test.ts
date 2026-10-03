// The viewer's locale rides the event request; the runtime evaluates `i18n/t` with the program's catalogs.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';
import { buildTraitIndex, createMemoryCircuitStore, dispatchWithServerLeg, type ClientRoleOpts } from '../src/index.js';
import type { MessageCatalogs, OrbitalEventResponse, OrbitalSchema, Trait, TypedEffect } from '@almadar/core';

const CATALOGS: MessageCatalogs = {
  en: { 'site:hero.title': 'Hello', 'site:posts.count': '{{n}} posts', 'site:cta': 'Start' },
  ar: { 'site:hero.title': 'مرحبا', 'site:posts.count': '{{n}} منشورات', 'site:cta': 'ابدأ' },
};

const HOME_EFFECTS: TypedEffect[] = [['render-ui', 'main', {
    type: 'stack',
    children: [
      { type: 'typography', content: ['i18n/t', 'site:hero.title'] },
      { type: 'typography', content: ['i18n/t', 'site:posts.count', { n: 3 }] },
      { type: 'button', label: ['i18n/t', 'site:cta'], className: ['if', ['==', ['i18n/t', 'site:cta'], ''], 'hidden', ''] },
      { type: 'typography', content: '@locale' },
    ],
  }]];

function homePage(effects: TypedEffect[] = HOME_EFFECTS, local = false): Trait {
  return {
    name: 'HomePage',
    scope: 'instance',
    linkedEntity: 'HomeView',
    ...(local ? { local: true } : {}),
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'INIT' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects }],
    },
  };
}

function schema(page: Trait = homePage()): OrbitalSchema {
  return {
    name: 'site',
    version: '1.0.0',
    locales: ['en', 'ar'],
    orbitals: [
      {
        name: 'Home',
        pages: [],
        entity: { name: 'HomeView', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
        traits: [page],
      },
    ],
  };
}

async function boot(): Promise<OrbitalServerRuntime> {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
  await runtime.register(schema(), { messages: CATALOGS });
  return runtime;
}

function rendered(response: OrbitalEventResponse): unknown {
  const effect = (response.clientEffects ?? []).find((e) => e[0] === 'render-ui');
  return effect?.[2];
}

describe('i18n/t on the runtime path', () => {
  it('renders the requesting viewer\'s locale, including a computation on a message', async () => {
    const response = await (await boot()).processOrbitalEvent('Home', { event: 'INIT', locale: 'ar' });
    expect(rendered(response)).toEqual({
      type: 'stack',
      children: [
        { type: 'typography', content: 'مرحبا' },
        { type: 'typography', content: '3 منشورات' },
        { type: 'button', label: 'ابدأ', className: '' },
        { type: 'typography', content: 'ar' },
      ],
    });
  });

  it('control: a request without a locale renders the first declared locale', async () => {
    const response = await (await boot()).processOrbitalEvent('Home', { event: 'INIT' });
    expect(JSON.stringify(rendered(response))).toContain('"Hello"');
    expect(JSON.stringify(rendered(response))).toContain('"content":"en"');
  });

  it('edge: a program that declares no locales accepts any viewer locale', async () => {
    const plain = schema(homePage([['render-ui', 'main', { type: 'typography', content: 'Hi' }]]));
    delete plain.locales;
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
    await runtime.register(plain);
    const response = await runtime.processOrbitalEvent('Home', { event: 'INIT', locale: 'en' });
    expect(response.success).toBe(true);
  });

  it('edge: a locale the program does not declare is refused', async () => {
    const response = await (await boot()).processOrbitalEvent('Home', { event: 'INIT', locale: 'fr' });
    expect(response.success).toBe(false);
    expect(response.error).toContain('"fr"');
  });
});

describe('host access to catalogs', () => {
  it('exposes the registered catalogs, and unregisterAll drops them', async () => {
    const runtime = await boot();
    expect(runtime.getMessages().ar?.['site:hero.title']).toBe('مرحبا');
    runtime.unregisterAll();
    expect(runtime.getMessages()).toEqual({});
  });
});

describe('registerFromFile catalogs', () => {
  function writeProgram(withArabic: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-orb-'));
    const orbPath = join(dir, 'site.orb');
    writeFileSync(orbPath, JSON.stringify(schema()));
    writeFileSync(join(dir, 'site.en.json'), JSON.stringify(CATALOGS.en));
    if (withArabic) writeFileSync(join(dir, 'site.ar.json'), JSON.stringify(CATALOGS.ar));
    return orbPath;
  }

  it('loads each declared locale\'s sidecar catalog written by orb resolve', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
    await runtime.registerFromFile(writeProgram(true));
    const response = await runtime.processOrbitalEvent('Home', { event: 'INIT', locale: 'ar' });
    expect(JSON.stringify(rendered(response))).toContain('مرحبا');
  });

  it('edge: a declared locale without its catalog fails registration, naming the file', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
    await expect(runtime.registerFromFile(writeProgram(false))).rejects.toThrow(/site\.ar\.json/);
  });
});

describe('i18n/t on the client role\'s local arm', () => {
  function localSchema(): OrbitalSchema {
    return schema(homePage(HOME_EFFECTS, true));
  }

  function opts(i18n: Pick<ClientRoleOpts, 'locale' | 'messages'>): ClientRoleOpts {
    const s = localSchema();
    const traitIndex = buildTraitIndex(s.orbitals);
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    return { orbitalName: 'Home', traitIndex, store, carriesCircuitState: true, ...i18n };
  }

  it('evaluates with the host\'s locale and catalogs', async () => {
    const dispatch = await dispatchWithServerLeg(opts({ locale: 'ar', messages: CATALOGS }), { event: 'INIT', targetTrait: 'HomePage' });
    expect(JSON.stringify(rendered(dispatch.response))).toContain('مرحبا');
  });

  it('control: without a host locale the local arm reports the missing message', async () => {
    await expect(dispatchWithServerLeg(opts({}), { event: 'INIT', targetTrait: 'HomePage' })).rejects.toThrow('no `unset` message');
  });
});
