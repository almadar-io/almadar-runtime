/**
 * Routes each dispatch leg (one trait event) to where its data lives: a leg over browser-stored
 * entities (`[persistent: x, local]`) runs in-process against the browser store,
 * a leg over server data goes to the server. With no server (a static host),
 * every leg runs in-process. A leg needing both is refused, never split
 * silently (`ORB_X_MIXED_RESIDENCE` rejects it per transition at validate).
 */
import type { OrbitalEventRequest } from '@almadar/core';
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

function legTraits(request: OrbitalEventRequest, orbitalName: string, index: TraitIndex): IndexedTrait[] {
  const named = [
    request.targetTrait,
    request.sourceTrait,
    ...(request.traits ?? []).map((t) => t.trait),
    ...(request.mount ?? []).map((m) => m.trait),
  ].filter((t): t is string => typeof t === 'string');
  const names = named.length > 0 ? new Set(named) : null;
  return [...index.byName.values()].filter((entry) =>
    names ? names.has(entry.traitDef.name) : entry.orbitalName === orbitalName);
}

export function createResidenceTransport(options: ResidenceTransportOptions): EventTransport {
  const { local, remote, traitIndex } = options;
  const browserStored = new Set(traitIndex.allEntities.filter(storesRowsInBrowser).map((e) => e.name));
  const stores = (entityType: string) => browserStored.has(entityType);

  const route = (orbitalName: string, request: OrbitalEventRequest): EventTransport => {
    const traits = legTraits(request, orbitalName, traitIndex);
    const server = traits.filter((e) => touchesServer(e.traitDef, e.irTrait, e.config, stores, request.event)).map((e) => e.traitDef.name);
    const browser = traits.filter((e) => browserLegEvents(e.traitDef, stores, e.config).has(request.event)).map((e) => e.traitDef.name);
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
      return route(orbitalName, request).send(orbitalName, request);
    },
    ...(remote?.subscribe ? { subscribe: remote.subscribe.bind(remote) } : {}),
  };
}
