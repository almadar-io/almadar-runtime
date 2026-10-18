/**
 * The browser store of a program's `[persistent: x, local]` entities, opened and
 * seeded once, and the in-process transport its legs run through. The runtime
 * host (`useBrowserStore`) and compiled static clients both open it here.
 */
import type { BrowserTabPort, MessageCatalogs, OnDeviceModelPorts, OrbitalDefinition, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema, RuntimeValue } from '@almadar/core';
import { applyRowAccess, externalInputsOf, orbitalInlineEntities, parseOrbitalSchema, readableEntitiesOf, storesRowsInBrowser } from '@almadar/core';
import { entityAccessPolicies } from '@almadar/core/mock';
import type { KernelHostPorts } from '../kernel/host.js';
import type { HttpPorts } from '../kernel/http-exchange.js';
import type { KernelModule } from '../kernel/wire.js';
import { dispatchDeclaredInput } from './declared-input-dispatch.js';
import { IndexedDbPersistence } from '@almadar/db/browser';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EffectHandlers } from '../types.js';
import type { DeferredCallOutcome } from '../kernel/host.js';
import { seedBrowserStore } from '../entities/seedBrowserStore.js';
import type { EventTransport } from '../server/EventTransport.js';
import { buildTraitIndex } from '../traits/trait-index.js';
import { createLocalStoreTransport, localStorePersistence, openLocalKernel } from './local-store-transport.js';
import { tickEventKey } from '../traits/state-book.js';
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
  /** The initialised `@almadar/kernel` module the store's legs run on. */
  kernel: KernelModule;
  factory?: IDBFactory;
  /** The viewer's locale: picks the entity's rows for it when the store is first seeded. */
  locale?: string;
  /** Answers the program's calls to browser-only services (the client's web-hosted integrations). */
  callService?: EffectHandlers['callService'];
  /** What a leg's client-site `http` runs on (`createBrowserHttpPorts`). */
  http?: HttpPorts;
  /** The program's message catalogs, so a leg's `i18n/t` resolves for the request's locale. */
  messages?: MessageCatalogs;
}

export async function openBrowserStoreTransport(options: BrowserStoreTransportOptions): Promise<EventTransport> {
  const stored = await openBrowserStore(options.databaseName, options.schema.orbitals, options.factory, options.locale);
  if (stored === null && options.callService === undefined) {
    throw new Error(`openBrowserStoreTransport: schema "${options.schema.name}" declares no browser-stored entity`);
  }
  // Legs that only call browser-only services keep no rows of their own.
  const persistence = localStorePersistence(options.schema, stored ?? new InMemoryPersistence());
  return createLocalStoreTransport({
    kernelEngine: openLocalKernel({
      kernel: options.kernel,
      schema: options.schema,
      persistence,
      ...(options.callService !== undefined ? { callService: options.callService } : {}),
      ...(options.http !== undefined ? { http: options.http } : {}),
      ...(options.messages !== undefined ? { messages: options.messages } : {}),
    }),
  });
}

/**
 * A compiled client's bundled `browserSchema.json`, parsed by this runtime's own core (the client's core may predate
 * the browser-storage fields), served on the kernel like any local host.
 */
export function openBundledBrowserStore(bundled: RuntimeValue, kernel: KernelModule, locale?: string, callService?: EffectHandlers['callService'], messages?: MessageCatalogs, http?: HttpPorts): Promise<EventTransport> {
  const schema = parseOrbitalSchema(bundled);
  return openBrowserStoreTransport({
    databaseName: browserStoreName(schema.name, locale),
    schema,
    kernel,
    ...(locale !== undefined ? { locale } : {}),
    ...(callService !== undefined ? { callService } : {}),
    ...(http !== undefined ? { http } : {}),
    ...(messages !== undefined ? { messages } : {}),
  });
}

export interface BrowserHostOptions {
  databaseName: string;
  schema: OrbitalSchema;
  /** Answers every `call-service` of the program (the host's browser integrations). */
  callService: EffectHandlers['callService'];
  /** What the program's client-site `http` effects run on (`createBrowserHttpPorts`). */
  http?: HttpPorts;
  /** The on-device model and embedder `browser/prompt` and `browser/embed` ask (the host plugs its Prompt API and embedder in here). */
  onDevice?: OnDeviceModelPorts;
  /** The initialised `@almadar/kernel` module the program runs on; this host answers its I/O. */
  kernel: KernelModule;
  /** The browser's tabs for the `browser/tab-*` effects; absent, a tab ask fails `unavailable`. */
  tabs?: BrowserTabPort;
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

/** The host runs the program's ticks (LOLO §11): each firing is one `runTick` request in the host's queue. */
const tickLog = createLogger('almadar:runtime:browser-host:ticks');
const queueLog = createLogger('almadar:runtime:browser-host:queue');

function refuseUnhostedTicks(traitIndex: ReturnType<typeof buildTraitIndex>): void {
  for (const entry of traitIndex.byName.values()) {
    for (const tick of entry.irTrait.ticks ?? []) {
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
  const browserStore = await openBrowserStore(options.databaseName, options.schema.orbitals, options.factory, options.locale);
  const persistence = localStorePersistence(options.schema, browserStore ?? new InMemoryPersistence());
  const traitIndex = buildTraitIndex(options.schema.orbitals);
  refuseUnhostedTicks(traitIndex);
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

  const servicePorts: KernelHostPorts['servicePorts'] = (caller, user, message) => {
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
      read: async (entity) => applyRowAccess(await persistence.list(entity), entityAccessPolicies(schema, entity)?.read, undefined, { user }, entity),
      message,
    };
  };
  let deferred: ((call: DeferredCallOutcome) => void) | undefined;
  const kernelEngine = openLocalKernel({
    kernel: options.kernel,
    schema,
    persistence,
    callService: options.callService,
    servicePorts,
    deferCallOutcome: () => deferred,
    ...(options.http !== undefined ? { http: options.http } : {}),
    ...(options.onDevice !== undefined ? { onDevice: options.onDevice } : {}),
    ...(options.tabs !== undefined ? { tabs: options.tabs } : {}),
  });
  const local = createLocalStoreTransport({ kernelEngine, outsideEventQueue });
  transport = local;
  // A follow-on call's outcome runs as a dispatch of its own, in the background lane, and shows in open views.
  deferred = (call) => {
    const request: OrbitalEventRequest = {
      event: call.event,
      ...(call.payload !== undefined ? { payload: call.payload } : {}),
      targetTrait: call.traitName,
      ...(call.entityId !== undefined ? { entityId: call.entityId } : {}),
      ...(call.originClientId !== undefined ? { clientId: call.originClientId } : {}),
      ...(call.user !== undefined ? { user: call.user } : {}),
      ...(call.locale !== undefined ? { locale: call.locale } : {}),
    };
    void inBackground(async () => {
      const response = await local.send(call.orbital, request);
      for (const listener of listeners) listener(call.orbital, request, response);
    }).catch((error: Error) => {
      queueLog.error('deferred-outcome:failed', { orbital: call.orbital, event: call.event, trait: call.traitName, error: error.message });
    });
  };

  const scheduler = createTickScheduler();
  const tickHandles: TickHandle[] = [];
  for (const entry of traitIndex.byName.values()) {
    for (const tick of entry.irTrait.ticks ?? []) {
      // A firing waits its turn; while one is queued or running, the next is skipped, not piled up.
      let firing = false;
      const fire = () => {
        if (firing) return;
        firing = true;
        // Fired as a `runTick` request, so the tick runs where every transition runs: the gate, its
        // effects, and its emits through the dispatch's own fan-out.
        const request: OrbitalEventRequest = {
          event: tickEventKey(tick.name),
          runTick: { trait: entry.traitDef.name, tick: tick.name },
          targetTrait: entry.traitDef.name,
          tick: tick.name,
        };
        void inBackground(async () => {
          const response = await local.send(entry.orbitalName, request);
          if (response.transitioned) for (const listener of listeners) listener(entry.orbitalName, request, response);
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
