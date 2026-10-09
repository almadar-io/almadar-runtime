/**
 * Routes each dispatch leg to where its data lives, judging every trait by the
 * event it fired on (`traits[].event` in a cascade): a leg over browser-stored
 * entities (`[persistent: x, local]`) runs in-process against the browser store,
 * a leg over server data goes to the server. With no server (a static host),
 * every leg runs in-process. A leg needing both is refused, never split
 * silently (`ORB_X_MIXED_RESIDENCE` rejects it per transition at validate).
 * A mount batch is not one leg: each seed is its own trait's lifecycle event,
 * so the batch goes to each residence with that residence's seeds.
 */
import type { EntityRow, OrbitalEventRequest, OrbitalEventResponse } from '@almadar/core';
import { storesRowsInBrowser } from '@almadar/core';
import type { EventTransport } from '../server/EventTransport.js';
import { browserLegEvents, touchesServer, type IndexedTrait, type TraitIndex } from '../traits/trait-index.js';

export interface ResidenceTransportOptions {
  /** In-process transport over the browser store. */
  local: EventTransport;
  /** The server; absent on a static host. */
  remote?: EventTransport;
  traitIndex: TraitIndex;
}

interface LegTrait { entry: IndexedTrait; event: string }

/** Each trait the leg reaches, with the event it fired on (a cascade trait's own event, else the request's). */
function legTraits(request: OrbitalEventRequest, orbitalName: string, index: TraitIndex): LegTrait[] {
  const events = new Map<string, string>();
  for (const t of request.traits ?? []) events.set(t.trait, t.event ?? request.event);
  const named = [
    request.targetTrait,
    request.sourceTrait,
    ...(request.traits ?? []).map((t) => t.trait),
    ...(request.mount ?? []).map((m) => m.trait),
  ].filter((t): t is string => typeof t === 'string');
  const names = named.length > 0 ? new Set(named) : null;
  return [...index.byName.values()]
    .filter((entry) => names ? names.has(entry.traitDef.name) : entry.orbitalName === orbitalName)
    .map((entry) => ({ entry, event: events.get(entry.traitDef.name) ?? request.event }));
}

export function createResidenceTransport(options: ResidenceTransportOptions): EventTransport {
  const { local, remote, traitIndex } = options;
  const browserStored = new Set(traitIndex.allEntities.filter(storesRowsInBrowser).map((e) => e.name));
  const stores = (entityType: string) => browserStored.has(entityType);

  const route = (orbitalName: string, request: OrbitalEventRequest): EventTransport => {
    const traits = legTraits(request, orbitalName, traitIndex);
    const server = traits.filter(({ entry: e, event }) => touchesServer(e.traitDef, e.irTrait, e.config, stores, event)).map(({ entry }) => entry.traitDef.name);
    const browser = traits.filter(({ entry: e, event }) => browserLegEvents(e.traitDef, stores, e.config).has(event)).map(({ entry }) => entry.traitDef.name);
    if (server.length > 0 && browser.length > 0) {
      throw new Error(`residence: one dispatch reaches browser-stored data (${browser.join(', ')}) and server data (${server.join(', ')}); split it with an emit and a listen`);
    }
    if (browser.length > 0) return local;
    if (remote) return remote;
    if (server.length > 0) {
      throw new Error(`residence: ${server.join(', ')} needs server data, and this host has no server`);
    }
    return local;
  };

  const mountLegs = (orbitalName: string, request: OrbitalEventRequest): Array<{ transport: EventTransport; request: OrbitalEventRequest }> => {
    const seeds = request.mount ?? [];
    const groups = new Map<EventTransport, string[]>();
    for (const seed of seeds) {
      const transport = route(orbitalName, { ...request, mount: [seed], traits: undefined, targetTrait: undefined, sourceTrait: undefined });
      groups.set(transport, [...(groups.get(transport) ?? []), seed.trait]);
    }
    return [...groups].map(([transport, traits]) => {
      const keep = new Set(traits);
      const entityByTrait = request.entityByTrait === undefined
        ? undefined
        : Object.fromEntries(Object.entries(request.entityByTrait).filter(([trait]) => keep.has(trait)));
      return {
        transport,
        request: {
          ...request,
          mount: seeds.filter((seed) => keep.has(seed.trait)),
          ...(request.traits !== undefined ? { traits: request.traits.filter((t) => keep.has(t.trait)) } : {}),
          ...(entityByTrait !== undefined ? { entityByTrait } : {}),
        },
      };
    });
  };

  return {
    async register(schema) {
      const result = await local.register(schema);
      return remote ? remote.register(schema) : result;
    },
    async unregister() {
      await local.unregister();
      await remote?.unregister();
    },
    async send(orbitalName, request) {
      if ((request.mount?.length ?? 0) > 1) {
        const legs = mountLegs(orbitalName, request);
        if (legs.length > 1) {
          const responses: OrbitalEventResponse[] = [];
          for (const leg of legs) responses.push(await leg.transport.send(orbitalName, leg.request));
          return mergeMountResponses(responses);
        }
      }
      return route(orbitalName, request).send(orbitalName, request);
    },
    ...(remote?.subscribe ? { subscribe: remote.subscribe.bind(remote) } : {}),
  };
}

/** The responses of one mount batch's residence legs, as the one response the batch would return. */
function mergeMountResponses(responses: OrbitalEventResponse[]): OrbitalEventResponse {
  const concat = <T>(pick: (r: OrbitalEventResponse) => T[] | undefined): T[] | undefined => {
    const all = responses.flatMap((r) => pick(r) ?? []);
    return responses.some((r) => pick(r) !== undefined) ? all : undefined;
  };
  const data: Record<string, EntityRow[]> = {};
  for (const r of responses) for (const [entity, rows] of Object.entries(r.data ?? {})) data[entity] = [...(data[entity] ?? []), ...rows];
  const entityByTrait = Object.assign({}, ...responses.map((r) => r.entityByTrait ?? {}));
  const errors = responses.flatMap((r) => (r.error !== undefined ? [r.error] : []));
  const merged: OrbitalEventResponse = {
    success: responses.every((r) => r.success),
    transitioned: responses.some((r) => r.transitioned),
    states: Object.assign({}, ...responses.map((r) => r.states)),
    emittedEvents: responses.flatMap((r) => r.emittedEvents),
  };
  if (responses.some((r) => r.data !== undefined)) merged.data = data;
  if (responses.some((r) => r.entityByTrait !== undefined)) merged.entityByTrait = entityByTrait;
  const clientEffects = concat((r) => r.clientEffects);
  if (clientEffects !== undefined) merged.clientEffects = clientEffects;
  const clientEffectsByTrait = concat((r) => r.clientEffectsByTrait);
  if (clientEffectsByTrait !== undefined) merged.clientEffectsByTrait = clientEffectsByTrait;
  const effectResults = concat((r) => r.effectResults);
  if (effectResults !== undefined) merged.effectResults = effectResults;
  const rejections = concat((r) => r.rejections);
  if (rejections !== undefined) merged.rejections = rejections;
  const cascadeTruncated = concat((r) => r.cascadeTruncated);
  if (cascadeTruncated !== undefined) merged.cascadeTruncated = cascadeTruncated;
  const guardFailed = responses.find((r) => r.guardFailed !== undefined)?.guardFailed;
  if (guardFailed !== undefined) merged.guardFailed = guardFailed;
  if (errors.length > 0) merged.error = errors.join('; ');
  return merged;
}
