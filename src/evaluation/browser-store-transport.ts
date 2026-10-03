/**
 * The browser store of a program's `[persistent: x, local]` entities, opened and
 * seeded once, and the in-process transport its legs run through. The runtime
 * host (`useBrowserStore`) and compiled static clients both open it here.
 */
import type { OrbitalDefinition, OrbitalSchema, RuntimeValue } from '@almadar/core';
import { orbitalInlineEntities, parseOrbitalSchema, storesRowsInBrowser } from '@almadar/core';
import { IndexedDbPersistence } from '../entities/IndexedDbPersistence.js';
import { seedBrowserStore } from '../entities/seedBrowserStore.js';
import type { EventTransport } from '../server/EventTransport.js';
import { buildTraitIndex } from '../traits/trait-index.js';
import { createMemoryCircuitStore } from './circuit-store.js';
import { createLocalStoreTransport } from './local-store-transport.js';

/** One browser database per app and viewer locale, so a visitor's records stay in one language. */
export function browserStoreName(appName: string, locale: string | undefined): string {
  return locale !== undefined ? `almadar:${appName}:${locale}` : `almadar:${appName}`;
}

/** Open and seed the store; `null` when no entity is browser-stored. */
export async function openBrowserStore(
  databaseName: string,
  orbitals: readonly OrbitalDefinition[],
  factory?: IDBFactory,
  locale?: string,
): Promise<IndexedDbPersistence | null> {
  const entities = orbitals.flatMap(orbitalInlineEntities).filter(storesRowsInBrowser);
  if (entities.length === 0) return null;
  const store = await IndexedDbPersistence.open({
    databaseName,
    entityTypes: entities.map((e) => e.name),
    ...(factory !== undefined ? { factory } : {}),
  });
  await seedBrowserStore(store, entities, locale);
  return store;
}

export interface BrowserStoreTransportOptions {
  databaseName: string;
  schema: OrbitalSchema;
  factory?: IDBFactory;
  /** The requesting client relays every emit itself (a compiled client). */
  clientRelays?: boolean;
  /** The viewer's locale: picks the entity's rows for it when the store is first seeded. */
  locale?: string;
}

export async function openBrowserStoreTransport(options: BrowserStoreTransportOptions): Promise<EventTransport> {
  const persistence = await openBrowserStore(options.databaseName, options.schema.orbitals, options.factory, options.locale);
  if (persistence === null) {
    throw new Error(`openBrowserStoreTransport: schema "${options.schema.name}" declares no browser-stored entity`);
  }
  const traitIndex = buildTraitIndex(options.schema.orbitals);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  return createLocalStoreTransport({
    traitIndex,
    persistence,
    store,
    schema: options.schema,
    ...(options.clientRelays !== undefined ? { clientRelays: options.clientRelays } : {}),
  });
}

/**
 * A compiled client's bundled `browserSchema.json`, parsed by this runtime's own
 * core (the client's core may predate the browser-storage fields). A compiled
 * client relays every emit itself, as it does a compiled server's reply.
 */
export function openBundledBrowserStore(bundled: RuntimeValue, locale?: string): Promise<EventTransport> {
  const schema = parseOrbitalSchema(bundled);
  return openBrowserStoreTransport({
    databaseName: browserStoreName(schema.name, locale),
    schema,
    clientRelays: true,
    ...(locale !== undefined ? { locale } : {}),
  });
}
