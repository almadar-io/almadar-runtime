/**
 * The runtime's own `call-service` answerer when the host injects none: the services a host plugged in with
 * `registerServiceProvider`. A call to a service nobody plugged in fails by name, so the trait's declared failure event fires.
 */
import type { EventPayload, ServiceParams } from '@almadar/core';
import { mockServiceAnswer } from '@almadar/core/mock';
import { callRegisteredService } from '../host/service-provider.js';
import type { CredentialModeControl } from '../host/credentials/scope.js';
import type { EffectHandlers, ServiceCallContext } from '../types.js';

export function defaultCallService(
  service: string,
  action: string,
  params: ServiceParams | undefined,
  context?: ServiceCallContext,
): Promise<EventPayload | null> {
  return callRegisteredService(service, action, params, context);
}

/**
 * Mock-mode `call-service`: the registry-shaped answer (`@almadar/core` `mockServiceAnswer`), the same one
 * every host's mock mode gives. Pure and browser-safe, so an in-browser mock runtime answers too.
 */
export async function mockCallService(
  service: string,
  action: string,
): Promise<EventPayload | null> {
  const answer = mockServiceAnswer(service, action);
  if (!answer.ok) throw new Error(answer.message);
  return answer.value;
}

/** `call-service` for a host with a mock/real switch: the registry-shaped mock answer in `mock` mode, the registered services in `real`. */
export function callServiceByMode(control: CredentialModeControl): NonNullable<EffectHandlers['callService']> {
  return (service, action, params, context) =>
    control.mode === 'mock' ? mockCallService(service, action) : defaultCallService(service, action, params, context);
}
