/**
 * An in-process transport over a local store: every request runs on the kernel opened over that store
 * (`openLocalKernel`), and this host answers its I/O. The offline preview and the browser-stored side of a
 * residence-routed host both use it.
 */
import type { BrowserTabPort, MessageCatalogs, OnDeviceModelPorts, OrbitalEventRequest, OrbitalSchema, PersistenceAdapter, UserContext } from '@almadar/core';
import { applyRowAccess, inlineTraitRefs, orbitalInlineEntities, readableEntitiesOf, storesRowsInBrowser, externalInputsOf } from '@almadar/core';
import { entityAccessPolicies } from '@almadar/core/mock';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { EffectHandlers } from '../types.js';
import { KernelEngine, evaluateOnKernel } from '../kernel/engine.js';
import type { KernelHostPorts } from '../kernel/host.js';
import type { HttpPorts } from '../kernel/http-exchange.js';
import type { KernelModule } from '../kernel/wire.js';
import { createInProcessTransport, type EventTransport } from '../server/EventTransport.js';
import { InFlightCalls } from '../effects/in-flight-calls.js';
import { defaultCallService } from '../effects/defaultCallService.js';
import { routeByEntity } from './routed-persistence.js';
import { buildTraitIndex } from '../traits/trait-index.js';

export interface LocalKernelOptions {
  /** The initialised `@almadar/kernel` module. */
  kernel: KernelModule;
  /** The language bundle as JSON (`LanguageBundle`), installed into `kernel` before it opens: a browser has no `node_modules` to read it from. */
  language: string;
  schema: OrbitalSchema;
  /** Every row the kernel reads and writes (`localStorePersistence` over a browser store). */
  persistence: PersistenceAdapter;
  /** Answers every `call-service`; absent, the default provider. */
  callService?: EffectHandlers['callService'];
  /** The running app lent to `call-service` providers; absent, a provider reads the rows its viewer may read and dispatches no input. */
  servicePorts?: KernelHostPorts['servicePorts'];
  /** Where a follow-on call's outcome is dispatched; absent, nowhere. */
  deferCallOutcome?: KernelHostPorts['deferCallOutcome'];
  http?: HttpPorts;
  onDevice?: OnDeviceModelPorts;
  tabs?: BrowserTabPort;
  /** The program's message catalogs, so `i18n/t` resolves for the request's locale. */
  messages?: MessageCatalogs;
}

/** A local store's rows as the kernel holds them: browser-stored entities in `store`, every other entity in memory. */
export function localStorePersistence(schema: OrbitalSchema, store: PersistenceAdapter): PersistenceAdapter {
  const browserStored = new Set(schema.orbitals.flatMap(orbitalInlineEntities).filter(storesRowsInBrowser).map((entity) => entity.name));
  return routeByEntity(browserStored, store, new InMemoryPersistence());
}

/** A kernel over a local store, answering its I/O with `persistence` and the given ports. */
export function openLocalKernel(options: LocalKernelOptions): KernelEngine {
  const { schema, persistence } = options;
  options.kernel.installLanguage(options.language);
  const callService = options.callService ?? defaultCallService;
  const engine = KernelEngine.open(options.kernel, { ...schema, orbitals: inlineTraitRefs(schema.orbitals) }, {
    persistence,
    callService: (service, action, params, context) => callService(service, action, params, context),
    programEffect: () => undefined,
    inFlightCalls: new InFlightCalls(),
    servicePorts: options.servicePorts ?? ((caller, user, message) => ({
      caller,
      message,
      inputs: () => externalInputsOf(schema),
      readableEntities: () => readableEntitiesOf(schema),
      dispatchInput: () => Promise.reject(new Error('a local store host takes no input dispatch')),
      read: async (entity) => applyRowAccess(await persistence.list(entity), entityAccessPolicies(schema, entity)?.read, undefined, { user }, entity),
    })),
    deliverLive: () => undefined,
    deferCallOutcome: options.deferCallOutcome ?? (() => undefined),
    ...(options.http !== undefined ? { http: options.http } : {}),
    ...(options.onDevice !== undefined ? { onDevice: options.onDevice } : {}),
    ...(options.tabs !== undefined ? { tabs: options.tabs } : {}),
  });
  if (options.messages !== undefined) engine.setMessages(Object.keys(options.messages), options.messages);
  // One client is served, and the ticks it asks for (`runTick`) are of traits it mounted.
  engine.setTickMount([...buildTraitIndex(schema.orbitals).byName.keys()]);
  return engine;
}

export interface LocalStoreTransportOptions {
  /** The kernel the requests run on (`openLocalKernel`), or its promise while the kernel module loads. */
  kernelEngine: KernelEngine | Promise<KernelEngine>;
  user?: UserContext;
  /** Releases the host's request queue while a `call-service` awaits its provider. */
  outsideEventQueue?: <T>(work: () => Promise<T>) => Promise<T>;
}

export function createLocalStoreTransport(options: LocalStoreTransportOptions): EventTransport {
  return createInProcessTransport(
    async (orbital: string, request: OrbitalEventRequest) => evaluateOnKernel(
      {
        engine: await options.kernelEngine,
        orbital,
        ...(options.outsideEventQueue !== undefined ? { outsideEventQueue: options.outsideEventQueue } : {}),
      },
      request,
      options.user,
      request.locale,
    ),
    { carriesCircuitState: false },
  );
}
