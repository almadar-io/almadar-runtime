/**
 * The browser store of a program's `[persistent: x, local]` entities, opened and
 * seeded once, and the in-process transport its legs run through. The runtime
 * host (`useBrowserStore`) and compiled static clients both open it here.
 */
import type { OrbitalDefinition, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, RuntimeValue } from '@almadar/core';
import { externalInputsOf, orbitalInlineEntities, parseOrbitalSchema, readableEntitiesOf, storesRowsInBrowser } from '@almadar/core';
import { entityAccessPolicies } from '@almadar/core/mock';
import { applyRowAccess } from '../entities/entityAccess.js';
import type { ServerEffectStageDeps } from '../effects/effect-stage.js';
import { dispatchDeclaredInput } from './declared-input-dispatch.js';
import { IndexedDbPersistence } from '../entities/IndexedDbPersistence.js';
import { InMemoryPersistence } from '../entities/PersistenceAdapter.js';
import type { EffectHandlers } from '../types.js';
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

export interface BrowserHostOptions {
  databaseName: string;
  schema: OrbitalSchema;
  /** Answers every `call-service` of the program (the host's browser integrations). */
  callService: EffectHandlers['callService'];
  factory?: IDBFactory;
  locale?: string;
}

/** A declared input the host ran, with its result; no view asked for it. */
export type InputDispatchListener = (orbital: string, request: OrbitalEventRequest, response: OrbitalEventResponse) => void;

export interface BrowserHost extends EventTransport {
  /** Hear every declared input the host runs (e.g. a watched page element), to show it in open views. */
  onInputDispatched(listener: InputDispatchListener): () => void;
}

/**
 * Host a whole program in a browser context with no server (an extension's service worker): its
 * browser-stored entities in IndexedDB, any other rows in memory, and every `call-service` answered
 * by `callService`. The host holds the circuit state itself.
 */
export async function openBrowserHost(options: BrowserHostOptions): Promise<BrowserHost> {
  const persistence =
    (await openBrowserStore(options.databaseName, options.schema.orbitals, options.factory, options.locale)) ?? new InMemoryPersistence();
  const traitIndex = buildTraitIndex(options.schema.orbitals);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  const { schema } = options;
  let transport: EventTransport | undefined;
  const listeners = new Set<InputDispatchListener>();

  // The host holds one circuit, so it runs one request at a time: a request that arrives while another
  // runs (a page reporting elements in a burst) waits its turn, as the client kernel's queue does.
  let queue: Promise<void> = Promise.resolve();
  let running: { done: boolean } | undefined;
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(async () => {
      const request = { done: false };
      running = request;
      try {
        return await work();
      } finally {
        request.done = true;
        running = undefined;
      }
    });
    queue = turn.then(() => undefined, () => undefined);
    return turn;
  };

  const servicePorts: ServerEffectStageDeps['servicePorts'] = (caller, user, message) => {
    // A dispatch made while the lending request still runs is part of that request (a tool loop);
    // one made after it finished (a watch reporting later) is a new request and takes its turn.
    const lentBy = running;
    return {
      caller,
      inputs: () => externalInputsOf(schema),
      readableEntities: () => readableEntitiesOf(schema),
      dispatchInput: (orbital, request) => {
        const host = transport;
        if (!host) return Promise.reject(new Error('openBrowserHost: the host is not open yet'));
        const send = (o: string, r: OrbitalEventRequest) => (lentBy !== undefined && !lentBy.done ? host.send(o, r) : serially(() => host.send(o, r)));
        return dispatchDeclaredInput(schema, orbital, { ...request, ...(user !== undefined ? { user } : {}) }, async (o, r) => {
          const response = await send(o, r);
          for (const listener of listeners) listener(o, r, response);
          return response;
        });
      },
      read: async (entity) => applyRowAccess(await persistence.list(entity), entityAccessPolicies(schema, entity)?.read, undefined, { user }),
      message,
    };
  };
  const local = createLocalStoreTransport({ traitIndex, persistence, store, schema, callService: options.callService, servicePorts });
  transport = local;
  return {
    ...local,
    send: (orbitalName, request) => serially(() => local.send(orbitalName, request)),
    onInputDispatched(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
