/**
 * The runtime's own `call-service` provider when the host injects none: the
 * same @almadar/integrations manager compiled apps use, configured from the
 * env on first use. Loaded lazily and server-only (the browser build maps
 * @almadar/integrations away), so a client bundle never pulls provider SDKs.
 */
import type { EventPayload, ServiceParams } from '@almadar/core';
import type { IntegrationCallContext } from '@almadar/integrations';

type ServiceCall = (
  service: string,
  action: string,
  params: ServiceParams | undefined,
  context?: IntegrationCallContext,
) => Promise<EventPayload | null>;

let loaded: Promise<ServiceCall> | null = null;

async function load(): Promise<ServiceCall> {
  const { RuntimeIntegrationManager } = await import('@almadar/integrations/runtime');
  const manager = new RuntimeIntegrationManager();
  manager.configureFromEnv();
  const factory = manager.getFactory();
  return async (service, action, params, context) => {
    const result = await factory.execute(service, action, params ?? {}, context);
    if (!result.success) throw result.error ?? new Error(`${service}.${action} failed`);
    return result.data == null ? null : (result.data as EventPayload);
  };
}

/** Calls `service.action` through @almadar/integrations; throws its error on failure. */
export async function defaultCallService(
  service: string,
  action: string,
  params: ServiceParams | undefined,
  context?: IntegrationCallContext,
): Promise<EventPayload | null> {
  loaded ??= load();
  return (await loaded)(service, action, params, context);
}
