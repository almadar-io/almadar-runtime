/**
 * A call-site trait (`trait ChannelRail = Browse.traits.BrowseItemBrowse ->
 * ChannelMember`) is its OWN node: the `.orb` reference carries its id, the
 * Rust resolver keeps it, and every id-scoped `listens` (`ChannelRail.VIEW`,
 * `ChannelRail.BrowseItemLoaded`) is keyed on it. The JS resolver kept the
 * ATOM's id instead, so on the interpreted path every emit from a rebound
 * trait was stamped with std-browse's id and no listener ever matched —
 * std-realtime-chat's rail click, auto-open and thread were all dead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema, TraitRef } from '@almadar/core';
import { resolveSchema } from '../src/entities/resolver/reference-resolver.js';
import { IO_ROOT, STD_ROOT } from './helpers/behavior-packages.js';

const BEHAVIORS_ROOT = IO_ROOT;
const ORGANISMS = [
  join(BEHAVIORS_ROOT, 'behaviors/registry/app/organisms/std-realtime-chat.orb'),
  join(BEHAVIORS_ROOT, 'behaviors/registry/project-friday/organisms/project-friday.orb'),
];

function refIds(schema: OrbitalSchema): Map<string, string> {
  const out = new Map<string, string>();
  for (const orbital of schema.orbitals) {
    if (typeof orbital !== 'object' || !('traits' in orbital) || !orbital.traits) continue;
    for (const t of orbital.traits as TraitRef[]) {
      if (typeof t === 'object' && 'ref' in t && typeof t.name === 'string' && 'id' in t && typeof t.id === 'string') {
        out.set(`${orbital.name}.${t.name}`, t.id);
      }
    }
  }
  return out;
}

describe.each(ORGANISMS)('call-site trait ids survive resolution (%s)', (orbPath) => {
  it('every named reference resolves to a trait carrying the reference\'s own id', async () => {
    const input = JSON.parse(readFileSync(orbPath, 'utf-8')) as OrbitalSchema;
    const expected = refIds(input);
    expect(expected.size).toBeGreaterThan(0);
    const result = await resolveSchema(input, {
      basePath: BEHAVIORS_ROOT,
      stdLibPath: STD_ROOT,
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const mismatches: string[] = [];
    for (const orbital of result.data) {
      for (const rt of orbital.traits) {
        const want = expected.get(`${orbital.name}.${rt.trait.name}`);
        if (want !== undefined && rt.trait.id !== want) mismatches.push(`${orbital.name}.${rt.trait.name}: ${String(rt.trait.id)} != ${want}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});
