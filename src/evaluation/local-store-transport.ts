/**
 * An in-process transport over a local store: the full server effect stage
 * (fetch/persist, access policies, the persist envelope) evaluated in the
 * client against `persistence`. The offline preview and the browser-stored
 * side of a residence-routed host both use it.
 */
import type { MessageCatalogs, OrbitalEventRequest, OrbitalSchema, UserContext } from '@almadar/core';
import type { EffectHandlers } from '../types.js';
import type { ServerEffectStageDeps } from '../effects/effect-stage.js';
import type { PersistenceAdapter } from '@almadar/core';
import { createInProcessTransport, type EventTransport } from '../server/EventTransport.js';
import type { TraitIndex } from '../traits/trait-index.js';
import { InFlightCalls } from '../effects/in-flight-calls.js';
import { browserLegCallService } from '../effects/defaultCallService.js';
import type { CircuitStore } from './circuit-store.js';
import { createIndexStageRunner } from './stage-runner.js';
import { evaluateOrbitalEvent, type EvaluateOrbitalEventDeps } from './evaluateOrbitalEvent.js';

export interface LocalStoreTransportOptions {
  traitIndex: TraitIndex;
  persistence: PersistenceAdapter;
  store: Pick<CircuitStore, 'frames' | 'manager'>;
  /** The resolved schema, so declared access policies apply in-process. */
  schema?: OrbitalSchema | null;
  /** Answers every `call-service`; absent, a browser-only service is answered by the browser integrations and any other by the default provider. */
  callService?: EffectHandlers['callService'];
  /** The running app lent to `call-service` providers as the caller. */
  servicePorts?: ServerEffectStageDeps['servicePorts'];
  /** Releases the host's request queue while a `call-service` awaits its provider. */
  outsideEventQueue?: ServerEffectStageDeps['outsideEventQueue'];
  /** What the `http` effect runs on (the browser's request driver); absent, an `http` effect fails as unavailable. */
  http?: ServerEffectStageDeps['http'];
  user?: UserContext;
  strictBindings?: EvaluateOrbitalEventDeps['strictBindings'];
  contextExtensions?: EvaluateOrbitalEventDeps['contextExtensions'];
  debug?: boolean;
  logContext?: EvaluateOrbitalEventDeps['logContext'];
  /** The requesting client relays every emit itself (a compiled client). */
  clientRelays?: boolean;
  /** The program's message catalogs, so `i18n/t` resolves for the request's locale. */
  messages?: MessageCatalogs;
}

export function createLocalStoreTransport(options: LocalStoreTransportOptions): EventTransport {
  const { traitIndex, persistence, store } = options;
  const inFlightCalls = new InFlightCalls();
  return createInProcessTransport(
    async (_orbitalName: string, request: OrbitalEventRequest) => {
      const runEffects = createIndexStageRunner({
        traitIndex,
        persistence,
        frames: store.frames,
        manager: store.manager,
        ...(options.schema !== undefined ? { schema: options.schema } : {}),
        extraEffectHandlers: { callService: options.callService ?? browserLegCallService },
        ...(options.servicePorts !== undefined ? { servicePorts: options.servicePorts } : {}),
        ...(options.outsideEventQueue !== undefined ? { outsideEventQueue: options.outsideEventQueue } : {}),
        ...(options.http !== undefined ? { http: options.http } : {}),
        inFlightCalls,
        ...(options.debug !== undefined ? { debug: options.debug } : {}),
        ...(options.messages !== undefined ? { messages: options.messages } : {}),
      });
      return evaluateOrbitalEvent(
        {
          traitIndex,
          manager: store.manager,
          persistence,
          frames: store.frames,
          runEffects,
          ...(options.user !== undefined ? { user: options.user } : {}),
          ...(options.strictBindings !== undefined ? { strictBindings: options.strictBindings } : {}),
          ...(options.contextExtensions !== undefined ? { contextExtensions: options.contextExtensions } : {}),
          ...(options.debug !== undefined ? { debug: options.debug } : {}),
          ...(options.logContext !== undefined ? { logContext: options.logContext } : {}),
          ...(options.clientRelays !== undefined ? { clientRelays: options.clientRelays } : {}),
          ...(request.locale !== undefined ? { locale: request.locale } : {}),
        },
        request,
      );
    },
    { carriesCircuitState: false },
  );
}
