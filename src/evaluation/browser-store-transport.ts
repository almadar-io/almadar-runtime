/**
 * The browser store of a program's `[persistent: x, local]` entities, opened and
 * seeded once, and the in-process transport its legs run through. The runtime
 * host (`useBrowserStore`) and compiled static clients both open it here.
 */
import type { EventPayload, SExpr, OrbitalDefinition, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, RuntimeValue } from '@almadar/core';
import { externalInputsOf, isEventPayloadValue, orbitalInlineEntities, parseOrbitalSchema, readableEntitiesOf, storesRowsInBrowser } from '@almadar/core';
import { entityAccessPolicies } from '@almadar/core/mock';
import { applyRowAccess } from '../entities/entityAccess.js';
import type { ServerEffectStageDeps } from '../effects/effect-stage.js';
import { dispatchDeclaredInput } from './declared-input-dispatch.js';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EffectHandlers } from '../types.js';
import { seedBrowserStore } from '../entities/seedBrowserStore.js';
import type { EventTransport } from '../server/EventTransport.js';
import { buildTraitIndex } from '../traits/trait-index.js';
import { createMemoryCircuitStore } from './circuit-store.js';
import { createLocalStoreTransport } from './local-store-transport.js';
import { collectListenerTargets } from './evaluateOrbitalEvent.js';
import { createContextFromBindings } from './BindingResolver.js';
import { evaluateGuard, executeEffects } from '@almadar/evaluator';
import { createTickScheduler, type TickHandle } from '../time/TickScheduler.js';
import { createLogger } from '@almadar/logger';
import { isValidCronExpression } from '../time/cron.js';
import { parseDurationString } from '../time/duration.js';

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
  /** Hear every declared input and tick firing the host runs (e.g. a watched page element), to show it in open views. */
  onInputDispatched(listener: InputDispatchListener): () => void;
  /** Stop the program's ticks. */
  close(): void;
}

/**
 * The host runs ticks whose effects emit events (LOLO §11): a firing reads the trait's state and
 * entity frame, and each event it emits is dispatched as its own request in the host's queue.
 */
const tickLog = createLogger('almadar:runtime:browser-host:ticks');
const queueLog = createLogger('almadar:runtime:browser-host:queue');

function isPayloadObject(value: RuntimeValue): value is EventPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && isEventPayloadValue(value);
}

function refuseUnhostedTicks(traitIndex: ReturnType<typeof buildTraitIndex>): void {
  for (const entry of traitIndex.byName.values()) {
    for (const tick of entry.irTrait.ticks ?? []) {
      for (const effect of tick.effects) {
        const op = Array.isArray(effect) ? effect[0] : undefined;
        if (op !== 'emit') {
          throw new Error(`openBrowserHost runs ticks that emit events; ${entry.orbitalName}.${entry.traitDef.name} tick '${tick.name}' has a '${String(op)}' effect`);
        }
      }
      if (tick.interval === 'frame') {
        throw new Error(`openBrowserHost has no frame clock; ${entry.orbitalName}.${entry.traitDef.name} tick '${tick.name}' runs every frame`);
      }
    }
  }
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
  refuseUnhostedTicks(traitIndex);
  const store = createMemoryCircuitStore(Array.from(traitIndex.byName.values(), (e) => e.traitDef));
  const { schema } = options;
  let transport: EventTransport | undefined;
  const listeners = new Set<InputDispatchListener>();

  // The host holds one circuit, so it runs one request at a time. A person's requests (from a view)
  // go before queued background work (ticks, a watched page reporting elements); the request that is
  // running is never interrupted.
  // The host's one running slot. The turn that holds it may release it while it awaits something
  // outside the host (`outsideEventQueue`) and takes a new slot, in its own lane, afterwards.
  interface Turn { id: number; lane: Array<(free: () => void) => void>; held: boolean; done: boolean; release: () => void }
  let turns = 0;
  type Lane = Turn['lane'];
  const foreground: Lane = [];
  const background: Lane = [];
  let pumping = false;
  let running: Turn | undefined;
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    for (let grant = foreground.shift() ?? background.shift(); grant !== undefined; grant = foreground.shift() ?? background.shift()) {
      await new Promise<void>(grant);
    }
    pumping = false;
  };
  const take = (turn: Turn): Promise<void> =>
    new Promise<void>((taken) => {
      queueLog.debug('queue:wait', { turn: turn.id, lane: turn.lane === foreground ? 'foreground' : 'background', running: running?.id });
      turn.lane.push((free) => {
        turn.held = true;
        running = turn;
        queueLog.debug('queue:take', { turn: turn.id });
        turn.release = () => {
          queueLog.debug('queue:release', { turn: turn.id });
          turn.held = false;
          if (running === turn) running = undefined;
          free();
        };
        taken();
      });
      void pump();
    });
  const enqueue = async <T>(lane: Lane, work: () => Promise<T>): Promise<T> => {
    const turn: Turn = { id: ++turns, lane, held: false, done: false, release: () => undefined };
    await take(turn);
    try {
      return await work();
    } finally {
      turn.done = true;
      if (turn.held) turn.release();
    }
  };
  const serially = <T>(work: () => Promise<T>): Promise<T> => enqueue(foreground, work);
  const inBackground = <T>(work: () => Promise<T>): Promise<T> => enqueue(background, work);

  // A call-service awaits its provider with the slot released, so a slow service never stalls a view's
  // request and a provider may dispatch into the app; the slot is re-taken, in the turn's own lane, before
  // the transition continues.
  const outsideEventQueue = async <T>(work: () => Promise<T>): Promise<T> => {
    const turn = running;
    queueLog.debug('queue:outside', { turn: turn?.id, held: turn?.held });
    if (turn === undefined || !turn.held) return work();
    turn.release();
    try {
      return await work();
    } finally {
      await take(turn);
    }
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
        const send = (o: string, r: OrbitalEventRequest) => (lentBy !== undefined && lentBy.held && !lentBy.done ? host.send(o, r) : inBackground(() => host.send(o, r)));
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
  const local = createLocalStoreTransport({ traitIndex, persistence, store, schema, callService: options.callService, servicePorts, outsideEventQueue });
  transport = local;

  const scheduler = createTickScheduler();
  const tickHandles: TickHandle[] = [];
  for (const entry of traitIndex.byName.values()) {
    for (const tick of entry.irTrait.ticks ?? []) {
      // A firing waits its turn; while one is queued or running, the next is skipped, not piled up.
      let firing = false;
      const fire = () => {
        if (firing) return;
        firing = true;
        void inBackground(async () => {
          const state = store.manager.getState(entry.traitDef.name)?.currentState ?? '';
          const ctx = createContextFromBindings({ entity: store.frames.get(entry.frameKey) ?? {}, payload: {}, state, now: Date.now() });
          if (entry.config !== undefined) ctx.config = entry.config;
          if (tick.guard !== undefined && !evaluateGuard(tick.guard, ctx)) return;
          const emitted: Array<{ event: string; payload: EventPayload }> = [];
          ctx.emit = (event, payload) => {
            if (payload === undefined || payload === null) emitted.push({ event, payload: {} });
            else if (isPayloadObject(payload)) emitted.push({ event, payload });
            else throw new Error(`${entry.orbitalName}.${entry.traitDef.name} tick '${tick.name}' emitted ${event} with a payload that is not an object`);
          };
          executeEffects(tick.effects as SExpr[], ctx);
          // Delivered as the bus would: to the ticking trait when it handles the event, and to every
          // trait that listens for it from this one, as the event that trait maps it to.
          const source = { orbital: entry.orbitalName, trait: entry.traitDef.name, tick: tick.name, ...(entry.orbitalId !== undefined ? { orbitalId: entry.orbitalId } : {}), ...(entry.traitDef.id !== undefined ? { traitId: entry.traitDef.id } : {}) };
          for (const { event, payload } of emitted) {
            const deliveries: Array<{ orbital: string; request: OrbitalEventRequest }> = [];
            if (entry.traitDef.transitions.some((t) => t.event === event)) {
              deliveries.push({ orbital: entry.orbitalName, request: { event, payload, targetTrait: entry.traitDef.name } });
            }
            for (const target of collectListenerTargets(traitIndex, source, event, payload)) {
              deliveries.push({ orbital: target.entry.orbitalName, request: { event: target.triggers, payload: target.payload ?? {}, targetTrait: target.listenerTrait } });
            }
            for (const { orbital, request } of deliveries) {
              const response = await local.send(orbital, request);
              for (const listener of listeners) listener(orbital, request, response);
            }
          }
        }).catch((error: Error) => {
          tickLog.error('tick:failed', { orbital: entry.orbitalName, trait: entry.traitDef.name, tick: tick.name, error: error.message });
        }).finally(() => {
          firing = false;
        });
      };
      tickHandles.push(
        typeof tick.interval === 'string' && isValidCronExpression(tick.interval)
          ? scheduler.addCron(tick.interval, fire)
          : scheduler.add(typeof tick.interval === 'number' ? tick.interval : parseDurationString(tick.interval), fire),
      );
    }
  }

  return {
    ...local,
    send: (orbitalName, request) => serially(() => local.send(orbitalName, request)),
    onInputDispatched(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const handle of tickHandles) handle.stop();
    },
  };
}
