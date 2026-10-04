/**
 * An in-process transport over a local store: the full server effect stage
 * (fetch/persist, access policies, the persist envelope) evaluated in the
 * client against `persistence`. The offline preview and the browser-stored
 * side of a residence-routed host both use it.
 */
import type { OrbitalEventRequest, OrbitalSchema, UserContext } from '@almadar/core';
import type { EffectHandlers } from '../types.js';
import type { ServerEffectStageDeps } from '../effects/effect-stage.js';
import type { PersistenceAdapter } from '../entities/PersistenceAdapter.js';
import { createInProcessTransport, type EventTransport } from '../server/EventTransport.js';
import type { TraitIndex } from '../traits/trait-index.js';
import type { CircuitStore } from './circuit-store.js';
import { createIndexStageRunner } from './stage-runner.js';
import { evaluateOrbitalEvent, type EvaluateOrbitalEventDeps } from './evaluateOrbitalEvent.js';

export interface LocalStoreTransportOptions {
  traitIndex: TraitIndex;
  persistence: PersistenceAdapter;
  store: Pick<CircuitStore, 'frames' | 'manager'>;
  /** The resolved schema, so declared access policies apply in-process. */
  schema?: OrbitalSchema | null;
  callService?: EffectHandlers['callService'];
  /** The running app lent to `call-service` providers as the caller. */
  servicePorts?: ServerEffectStageDeps['servicePorts'];
  user?: UserContext;
  guardMode?: EvaluateOrbitalEventDeps['guardMode'];
  strictBindings?: EvaluateOrbitalEventDeps['strictBindings'];
  contextExtensions?: EvaluateOrbitalEventDeps['contextExtensions'];
  debug?: boolean;
  logContext?: EvaluateOrbitalEventDeps['logContext'];
  /** The requesting client relays every emit itself (a compiled client). */
  clientRelays?: boolean;
}

export function createLocalStoreTransport(options: LocalStoreTransportOptions): EventTransport {
  const { traitIndex, persistence, store } = options;
  return createInProcessTransport(
    async (_orbitalName: string, request: OrbitalEventRequest) => {
      const runEffects = createIndexStageRunner({
        traitIndex,
        persistence,
        frames: store.frames,
        manager: store.manager,
        ...(options.schema !== undefined ? { schema: options.schema } : {}),
        ...(options.callService !== undefined ? { extraEffectHandlers: { callService: options.callService } } : {}),
        ...(options.servicePorts !== undefined ? { servicePorts: options.servicePorts } : {}),
        ...(options.debug !== undefined ? { debug: options.debug } : {}),
      });
      return evaluateOrbitalEvent(
        {
          traitIndex,
          manager: store.manager,
          persistence,
          frames: store.frames,
          runEffects,
          ...(options.user !== undefined ? { user: options.user } : {}),
          ...(options.guardMode !== undefined ? { guardMode: options.guardMode } : {}),
          ...(options.strictBindings !== undefined ? { strictBindings: options.strictBindings } : {}),
          ...(options.contextExtensions !== undefined ? { contextExtensions: options.contextExtensions } : {}),
          ...(options.debug !== undefined ? { debug: options.debug } : {}),
          ...(options.logContext !== undefined ? { logContext: options.logContext } : {}),
          ...(options.clientRelays !== undefined ? { clientRelays: options.clientRelays } : {}),
        },
        request,
      );
    },
    { carriesCircuitState: false },
  );
}
