/**
 * The one dispatcher for inbound deliveries (EXEC-INBOUND-1). A host carries `{name, headers,
 * rawBody}` from `/api/hooks/<name>`; this decides whether the name is served, delivers the
 * handler event with the declared payload, and answers with the handler's own emit of its
 * `answers` event. Twin of `RuntimeKernel::deliver_inbound` (`orbital-core` `kernel/inbound.rs`).
 */
import { dispatchFailed, findInbound, inboundAnswerOf, inboundPayload, unknownHook } from '@almadar/core';
import type { InboundAnswer, InboundDelivery, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';

export async function dispatchInbound(
  schema: OrbitalSchema | null | undefined,
  name: string,
  delivery: InboundDelivery,
  send: (orbitalName: string, request: OrbitalEventRequest) => Promise<OrbitalEventResponse>,
  credential: (name: string) => Promise<string | null | undefined> = async () => undefined,
): Promise<InboundAnswer> {
  const route = schema ? findInbound(schema, name) : undefined;
  if (route === undefined) return unknownHook(name);
  try {
    const held = route.verifies !== undefined ? await credential(route.verifies.credential) : undefined;
    const response = await send(route.orbital, {
      event: route.event,
      payload: inboundPayload(route, delivery, held),
      targetTrait: route.trait,
    });
    return inboundAnswerOf(route, response.emittedEvents, response.error);
  } catch (error) {
    return dispatchFailed(error instanceof Error ? error.message : String(error));
  }
}
