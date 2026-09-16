/**
 * `findEntityAmongOrbitals` — find an entity by name among a set of
 * orbitals' own resolved entities. Shared by `OrbitalServerRuntime`'s
 * `findEntityDefByName` (searches its registered orbitals) and the
 * stateless per-request transition path's `compileBehavior` (searches a
 * resolved schema's orbitals) — a trait's `linkedEntity` can name a
 * DIFFERENT orbital's own primary entity than its host orbital's (e.g. a
 * browse-list trait bound to a sibling entity), and both callers need the
 * identical answer. Verified 2026-09-16: before this was shared, the
 * stateless path stubbed an empty-`fields` entity for this exact case
 * (project-friday's ChatMessageOrbital -> ChannelMember), producing
 * correctly-shaped but entirely blank rows.
 */

import { describe, it, expect } from 'vitest';
import { findEntityAmongOrbitals } from '../src/index.js';
import type { Entity } from '@almadar/core';

function entity(name: string, fieldCount: number): Entity {
  return {
    name,
    fields: Array.from({ length: fieldCount }, (_, i) => ({ name: `field${i}`, type: 'string' })),
  };
}

describe('findEntityAmongOrbitals', () => {
  it('finds an entity by name among several orbitals', () => {
    const chatMessage = entity('ChatMessage', 3);
    const channelMember = entity('ChannelMember', 6);
    const found = findEntityAmongOrbitals([chatMessage, channelMember], 'ChannelMember');
    expect(found).toBe(channelMember);
    expect(found?.fields).toHaveLength(6);
  });

  it('returns undefined when no orbital declares that entity name', () => {
    expect(findEntityAmongOrbitals([entity('A', 1)], 'Nonexistent')).toBeUndefined();
  });

  it('skips undefined entries (an orbital that resolved no entity)', () => {
    const target = entity('Target', 2);
    expect(findEntityAmongOrbitals([undefined, target, undefined], 'Target')).toBe(target);
  });

  it('an empty iterable yields undefined', () => {
    expect(findEntityAmongOrbitals([], 'Anything')).toBeUndefined();
  });
});
