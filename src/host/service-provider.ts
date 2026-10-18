import type { EventPayload, ServiceParams } from '@almadar/core';
import type { ServiceCallContext } from '../types.js';

/** Why a service call failed, for a provider to name: bad params, no host installed, no signed-in caller, an action it does not have. */
export type ServiceCallErrorCode = 'VALIDATION_ERROR' | 'NOT_CONFIGURED' | 'AUTH_ERROR' | 'UNKNOWN_ACTION';

export class ServiceCallError extends Error {
  constructor(message: string, readonly code: ServiceCallErrorCode) {
    super(message);
    this.name = 'ServiceCallError';
  }
}

/** A host's answerer for the `call-service` calls of one named service: resolves the payload, throws to fail the call. */
export type ServiceProvider = (action: string, params: ServiceParams, context?: ServiceCallContext) => Promise<EventPayload | null>;

const providers = new Map<string, ServiceProvider>();

/** Plug a service's answerer into this process's `call-service`; a later registration of the same name replaces it. */
export function registerServiceProvider(service: string, provider: ServiceProvider): void {
  providers.set(service, provider);
}

/** Testing/reset hook. */
export function unregisterServiceProvider(service: string): void {
  providers.delete(service);
}

/** The names of the services a host has plugged in. */
export function registeredServices(): string[] {
  return [...providers.keys()];
}

/** Calls `service.action` through the registered provider; a service no host plugged in is a named failure. */
export async function callRegisteredService(
  service: string,
  action: string,
  params: ServiceParams | undefined,
  context?: ServiceCallContext,
): Promise<EventPayload | null> {
  const provider = providers.get(service);
  if (provider === undefined) throw new Error(`Unknown integration: ${service}`);
  return provider(action, params ?? {}, context);
}
