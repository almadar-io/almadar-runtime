/**
 * The one dispatcher for declared external inputs. The server runtime and the in-process host (a
 * browser extension's worker) both route outside-client inputs through it, so an undeclared input is
 * refused identically everywhere and a declared one is an ordinary event addressed to its trait.
 */
import { findExternalInput } from '@almadar/core';
import type { ExternalInputRequest, OrbitalEventRequest, OrbitalEventResponse, OrbitalSchema } from '@almadar/core';

export async function dispatchDeclaredInput(
  schema: OrbitalSchema | null | undefined,
  orbitalName: string,
  request: ExternalInputRequest,
  send: (orbitalName: string, request: OrbitalEventRequest) => Promise<OrbitalEventResponse>,
): Promise<OrbitalEventResponse> {
  const declared = schema ? findExternalInput(schema, orbitalName, request.targetTrait, request.event) : undefined;
  if (!declared) {
    return {
      success: false,
      transitioned: false,
      states: {},
      emittedEvents: [],
      error: `'${request.event}' is not an external input of ${orbitalName}.${request.targetTrait}`,
      rejections: [{ code: 'not-an-external-input', trait: request.targetTrait, event: request.event }],
    };
  }
  return send(orbitalName, {
    event: request.event,
    payload: request.payload ?? {},
    targetTrait: request.targetTrait,
    ...(request.user !== undefined ? { user: request.user } : {}),
    ...(request.entityId !== undefined ? { entityId: request.entityId } : {}),
  });
}
