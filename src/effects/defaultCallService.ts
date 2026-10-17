/**
 * The runtime's own `call-service` provider when the host injects none: the
 * same @almadar/integrations manager compiled apps use, configured from the
 * env on first use. Loaded lazily and server-only (the browser build maps
 * @almadar/integrations away), so a client bundle never pulls provider SDKs.
 */
import type { EventPayload, ServiceParams } from '@almadar/core';
import { mockServiceAnswer } from '@almadar/core/mock';
import { isBrowserOnlyService } from '@almadar/core/patterns';
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

let loadedBrowser: Promise<ServiceCall> | null = null;

async function loadBrowser(): Promise<ServiceCall> {
  const { BROWSER_SERVICES, createBrowserCallService, webBrowserServices } = await import('@almadar/integrations/browser');
  return createBrowserCallService(webBrowserServices(BROWSER_SERVICES));
}

/**
 * The call-service provider of a browser leg (a local store, no server): a browser-only service is
 * answered by the web-hosted browser integrations, since the node integrations
 * (`@almadar/integrations/runtime`) do not exist in a browser; any other service takes the default.
 */
export async function browserLegCallService(
  service: string,
  action: string,
  params: ServiceParams | undefined,
  context?: IntegrationCallContext,
): Promise<EventPayload | null> {
  if (!isBrowserOnlyService(service)) return defaultCallService(service, action, params, context);
  loadedBrowser ??= loadBrowser();
  return (await loadedBrowser)(service, action, params, context);
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
