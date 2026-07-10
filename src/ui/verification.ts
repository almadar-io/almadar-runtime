/**
 * Renderer-agnostic `window.__orbitalVerification` bridge.
 *
 * The single observation point Playwright-based verifiers
 * (`runtime-verify`, `orbital-verify`, `@almadar-io/verify`) use to read
 * state out of a live app and drive events into it. The wire types live
 * in `@almadar/core` (see `types/verification.ts`); this module owns only
 * the minimal exposure plumbing so any UI library — React, Web
 * Components, or a future renderer — can populate the same contract
 * without duplicating it.
 *
 * Framework-specific state (transition traces, reducer snapshots, bridge
 * health) is left empty by default; a renderer that tracks them can
 * override the readers after {@link ensureVerificationApi} runs. The two
 * bindings every renderer must provide are {@link bindEventBus} (so
 * automation can `sendEvent`) and {@link bindTraitStateGetter} (so
 * automation can `getTraitState`).
 *
 * @packageDocumentation
 */

import type {
  BridgeHealth,
  BusEvent,
  EventLogEntry,
  EventPayload,
  OrbitalVerificationAPI,
  TraitStateSnapshot,
  TransitionTrace,
  VerificationCheck,
  VerificationSnapshot,
  VerificationSummary,
} from '@almadar/core';
import { createLogger } from '@almadar/logger';

const log = createLogger('almadar:runtime:verify');

/** Cap on the rolling event log so long runs do not grow unbounded. */
const MAX_EVENT_LOG = 200;

declare global {
  interface Window {
    __orbitalVerification?: OrbitalVerificationAPI;
  }
}

const EMPTY_SUMMARY: VerificationSummary = {
  totalChecks: 0,
  passed: 0,
  failed: 0,
  warnings: 0,
  pending: 0,
};

function emptySnapshot(): VerificationSnapshot {
  return {
    checks: [],
    transitions: [],
    bridge: null,
    summary: EMPTY_SUMMARY,
    traits: [],
  };
}

/**
 * Minimal structural surface a renderer's event bus must satisfy to be
 * driven by automation. Matches the runtime `EventBus` (`emit` +
 * optional `onAny`) without forcing a concrete class, so any UI
 * library's bus — including `@almadar/runtime`'s own — plugs in.
 */
export interface VerificationBus {
  emit: (type: string, payload?: EventPayload) => void;
  onAny?: (listener: (event: BusEvent) => void) => () => void;
}

/**
 * Ensure `window.__orbitalVerification` exists with the required
 * readers, then return it. Returns `undefined` outside a DOM (SSR /
 * tests without a window). Idempotent: an existing object is returned
 * untouched so a renderer that already registered readers keeps them.
 */
export function ensureVerificationApi(): OrbitalVerificationAPI | undefined {
  if (typeof window === 'undefined') return undefined;

  if (!window.__orbitalVerification) {
    window.__orbitalVerification = {
      getSnapshot: emptySnapshot,
      getChecks: (): VerificationCheck[] => [],
      getTransitions: (): TransitionTrace[] => [],
      getBridge: (): BridgeHealth | null => null,
      getSummary: (): VerificationSummary => EMPTY_SUMMARY,
      waitForTransition: (): Promise<TransitionTrace | null> =>
        Promise.resolve(null),
      getTraitSnapshots: (): TraitStateSnapshot[] => [],
    };
  }
  return window.__orbitalVerification;
}

/** Read the current bridge, if any. SSR-safe. */
export function getOrbitalVerification(): OrbitalVerificationAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.__orbitalVerification;
}

/**
 * Bind the renderer's event bus so automation can send events and read
 * a rolling emission log.
 *
 * `sendEvent(event, payload, traitScope)` mirrors the React bridge:
 * when `traitScope` is provided the event is emitted on the qualified
 * key `UI:${traitScope}.${event}` (matching codegen-emitted
 * subscription keys); otherwise the legacy bare form `UI:${event}` is
 * used. An already-`UI:`-prefixed event is emitted verbatim.
 */
export function bindEventBus(eventBus: VerificationBus): void {
  const api = ensureVerificationApi();
  if (!api) return;

  api.sendEvent = (event: string, payload?: EventPayload, traitScope?: string): void => {
    const prefixed = event.startsWith('UI:')
      ? event
      : traitScope
        ? `UI:${traitScope}.${event}`
        : `UI:${event}`;
    log.debug('sendEvent', {
      event: prefixed,
      traitScope,
      payloadKeys: payload ? Object.keys(payload) : [],
    });
    eventBus.emit(prefixed, payload);
  };

  const eventLog: EventLogEntry[] = [];
  api.eventLog = eventLog;
  api.clearEventLog = (): void => {
    eventLog.length = 0;
  };

  if (eventBus.onAny) {
    const verificationEventLogger = (event: BusEvent): void => {
      if (eventLog.length < MAX_EVENT_LOG) {
        eventLog.push({
          type: event.type,
          payload: event.payload,
          timestamp: Date.now(),
        });
      }
    };
    // Preserve the listener name through minification so per-listener
    // diagnostics can identify this subscriber by source-level name.
    Object.defineProperty(verificationEventLogger, 'name', {
      value: 'runtime-verify:eventLog',
    });
    eventBus.onAny(verificationEventLogger);
  }
}

/**
 * Bind a trait-state getter so automation can query a trait's current
 * state machine state by name.
 */
export function bindTraitStateGetter(
  getter: (traitName: string) => string | undefined,
): void {
  const api = ensureVerificationApi();
  if (!api) return;
  api.getTraitState = getter;
}
