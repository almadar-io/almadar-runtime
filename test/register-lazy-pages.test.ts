// `uses lazy`: the server runs the whole program (as the compiled server does); only the client loads a lazy page's behavior on visit.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { MessageCatalogs, OrbitalDefinition, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';

function pageOrbital(name: string, path: string, key: string): OrbitalDefinition {
  return {
    name,
    entity: { name: `${name}View`, persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
    traits: [{
      name: `${name}Page`,
      scope: 'instance',
      linkedEntity: `${name}View`,
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'INIT', name: 'INIT' }],
        transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: ['i18n/t', key] }]] }],
      },
    }],
    pages: [{ name: `${name}PageView`, path, traits: [{ ref: `${name}Page` }] }],
  };
}

const SITE: OrbitalSchema = {
  name: 'site',
  version: '1.0.0',
  locales: ['en', 'ar'],
  orbitals: [pageOrbital('Home', '/', 'site:title')],
  lazyPages: [{ path: '/blog/why', orbital: 'BlogWhy', orbRef: 'lazy/BlogWhy.orb' }],
};
const POST: OrbitalSchema = { name: 'post-why', version: '1.0.0', locales: ['en', 'ar'], orbitals: [pageOrbital('BlogWhy', '/blog/why', 'post-why:title')] };
const SITE_CATALOGS: MessageCatalogs = { en: { 'site:title': 'Home' }, ar: { 'site:title': 'الرئيسية' } };
const POST_CATALOGS: MessageCatalogs = { en: { 'post-why:title': 'Why we started' }, ar: { 'post-why:title': 'لماذا بدأنا' } };

interface ProgramOptions { site?: OrbitalSchema; post?: OrbitalSchema | null; postLocales?: readonly string[] }

function writeProgram({ site = SITE, post = POST, postLocales = ['en', 'ar'] }: ProgramOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-orb-'));
  const orbPath = join(dir, 'site.orb');
  writeFileSync(orbPath, JSON.stringify(site));
  for (const locale of site.locales ?? []) writeFileSync(join(dir, `site.${locale}.json`), JSON.stringify(SITE_CATALOGS[locale]));
  mkdirSync(join(dir, 'lazy'));
  if (post !== null) {
    writeFileSync(join(dir, 'lazy', 'BlogWhy.orb'), JSON.stringify(post));
    for (const locale of postLocales) writeFileSync(join(dir, 'lazy', `BlogWhy.${locale}.json`), JSON.stringify(POST_CATALOGS[locale]));
  }
  return orbPath;
}

async function boot(options?: ProgramOptions): Promise<OrbitalServerRuntime> {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
  await runtime.registerFromFile(writeProgram(options));
  return runtime;
}

function rendered(response: OrbitalEventResponse): string {
  return JSON.stringify((response.clientEffects ?? []).find((e) => e[0] === 'render-ui')?.[2]);
}

describe('registerFromFile with lazy pages', () => {
  it('runs a lazy page\'s orbital with its own catalogs', async () => {
    const response = await (await boot()).processOrbitalEvent('BlogWhy', { event: 'INIT', locale: 'ar' });
    expect(response.success).toBe(true);
    expect(rendered(response)).toContain('لماذا بدأنا');
  });

  it('control: the eager orbital still runs with the program\'s catalogs', async () => {
    const response = await (await boot()).processOrbitalEvent('Home', { event: 'INIT', locale: 'ar' });
    expect(rendered(response)).toContain('الرئيسية');
  });

  it('the schema served to clients stays lazy', async () => {
    const served = (await boot()).getResolvedSchema();
    expect(served?.orbitals.map((o) => o.name)).toEqual(['Home']);
    expect(served?.lazyPages).toEqual(SITE.lazyPages);
  });

  it('the host\'s catalogs carry the lazy behaviors\' messages', async () => {
    const messages = (await boot()).getMessages();
    expect(messages.en?.['post-why:title']).toBe('Why we started');
    expect(messages.en?.['site:title']).toBe('Home');
  });

  it('control: a program without lazy pages registers only its own orbitals', async () => {
    const plain: OrbitalSchema = { ...SITE };
    delete plain.lazyPages;
    const runtime = await boot({ site: plain, post: null });
    const response = await runtime.processOrbitalEvent('BlogWhy', { event: 'INIT' });
    expect(response.success).toBe(false);
  });

  it('edge: a missing lazy behavior fails registration, naming the file', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
    await expect(runtime.registerFromFile(writeProgram({ post: null }))).rejects.toThrow(/lazy\/BlogWhy\.orb/);
  });

  it('edge: a lazy behavior without the orbital its page names fails registration', async () => {
    const wrong: OrbitalSchema = { ...POST, orbitals: [pageOrbital('BlogOther', '/blog/why', 'post-why:title')] };
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
    await expect(runtime.registerFromFile(writeProgram({ post: wrong }))).rejects.toThrow(/BlogWhy/);
  });

  it('edge: a lazy behavior missing a declared locale\'s catalog fails registration, naming the file', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence() });
    await expect(runtime.registerFromFile(writeProgram({ postLocales: ['en'] }))).rejects.toThrow(/BlogWhy\.ar\.json/);
  });
});
