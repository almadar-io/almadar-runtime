/**
 * Identity-keyed routing (Almadar Rabit V4, Phase 4 — interpreter path).
 *
 * The runtime routes cross-trait events by NAME today: the bus key is the
 * event name and source filtering compares orbital/trait name strings. A
 * mid-session rename (a ledger `curName` edit that updates a node's own
 * display name but deliberately does NOT rewrite the name strings held by
 * every reference) therefore breaks name routing — the emitter now stamps
 * the new name while the listener still holds the old one.
 *
 * These helpers make routing resolve by ID when the schema carries ids
 * (ledger-backed, V4), and fall back to name while dual-carry. Ids are the
 * stable edge keys: a rename never touches a node's id or any `*Id`
 * reference, so id-routed bindings survive it. Legacy id-free schemas take
 * the name path unchanged — byte-for-byte the previous behavior.
 *
 * @packageDocumentation
 */

import type { OrbitalId, TraitId, EventId } from '@almadar/core';

/**
 * The bus subscription/delivery key for an event. When an `eventId` is
 * present the key is the id (namespaced so it can never collide with a
 * bare event name); otherwise it is the event name (legacy path).
 *
 * The event ENVELOPE keeps the human name as its `type` — only the routing
 * key changes — so observability, the client re-broadcast wire shape, and
 * wildcard listeners are untouched.
 */
export function eventRouteKey(eventName: string, eventId?: EventId | string): string {
  return eventId ? `@evt:${eventId}` : eventName;
}

/** Structured `listens {}` source, carrying V4 dual-carry ids when present. */
export type ListenSourceDescriptor =
  | { kind: 'any' }
  | { kind: 'trait'; trait: string; traitId?: TraitId }
  | { kind: 'orbital'; orbital: string; trait: string; orbitalId?: OrbitalId; traitId?: TraitId };

/**
 * The subset of a bus event's `source` metadata the matcher reads. Kept
 * structural (no index signature) so `BusEventSource` assigns to it cleanly.
 */
export interface RouteSourceMeta {
  orbital?: string;
  orbitalId?: OrbitalId;
  trait?: string;
  traitId?: TraitId;
}

/**
 * Build a source-scope matcher for a `listens {}` entry.
 *
 * ID-first: when the listen source carries the id(s) for its scope, the
 * matcher compares ids ONLY (exact-match, rename-proof). Otherwise it
 * compares names against `listenerOrbital` — the exact legacy predicate.
 * No name-similarity, ever: an id present on one side but absent on the
 * other is a mismatch, never a fuzzy fallback.
 */
export function buildSourceMatcher(
  src: ListenSourceDescriptor,
  listenerOrbital: string,
): (source: RouteSourceMeta | undefined) => boolean {
  if (src.kind === 'any') return () => true;

  if (src.kind === 'trait') {
    if (src.traitId !== undefined) {
      const wantedTraitId = src.traitId;
      return (source) => !!source && source.traitId === wantedTraitId;
    }
    const wantedTrait = src.trait;
    return (source) =>
      !!source && source.orbital === listenerOrbital && source.trait === wantedTrait;
  }

  // src.kind === 'orbital'
  if (src.orbitalId !== undefined && src.traitId !== undefined) {
    const wantedOrbitalId = src.orbitalId;
    const wantedTraitId = src.traitId;
    return (source) =>
      !!source && source.orbitalId === wantedOrbitalId && source.traitId === wantedTraitId;
  }
  const wantedOrbital = src.orbital;
  const wantedTrait = src.trait;
  return (source) =>
    !!source && source.orbital === wantedOrbital && source.trait === wantedTrait;
}
