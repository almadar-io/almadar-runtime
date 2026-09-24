/**
 * Two explicit rebinds of one frame (`Authority = Frame.traits.TacticsAuthority`,
 * `Player = Frame.traits.PlayerIntent`): the frame's `PlayerIntent.MOVE -> MOVE`
 * route must follow the call-site rename to `Player`, or the authority never
 * hears the player's intents. Rust twin: `rename_map` in inline/trait.rs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { buildTraitIndex } from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

async function listenSources(file: string, trait: string): Promise<{ sources: string[]; ids: (string | undefined)[]; index: ReturnType<typeof buildTraitIndex> }> {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8')) as OrbitalSchema;
  const resolved = await preprocessSchema(raw, {
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
    allowOutsideBasePath: true,
  });
  if (!resolved.success) throw new Error(resolved.errors.join('; '));
  const index = buildTraitIndex(resolved.data.schema.orbitals);
  const def = index.byName.get(trait)?.irTrait;
  const trait_ = def as { listens?: { source?: { kind: string; trait?: string; traitId?: string } }[] } | undefined;
  const srcs = (trait_?.listens ?? []).map((l) => l.source).filter((s) => s?.kind === 'trait');
  return { sources: srcs.map((s) => s?.trait ?? ''), ids: srcs.map((s) => s?.traitId), index };
}

describe('explicit rebind renames reach sibling listen sources', () => {
  it('std-vector-tactics: Authority listens to Player, by name and id', async () => {
    const { sources, ids, index } = await listenSources('packages/almadar-behaviors/behaviors/registry/game/organisms/std-vector-tactics.orb', 'Authority');
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources)).toEqual(new Set(['Player']));
    const playerId = index.byName.get('Player')?.irTrait.id;
    for (const id of ids) expect(id).toBe(playerId);
  });

  it('control: the frame itself keeps its own PlayerIntent source', async () => {
    const { sources } = await listenSources('packages/almadar-std/behaviors/registry/ui/game/organisms/std-tactics-board-2d.orb', 'TacticsAuthority');
    expect(sources).toContain('PlayerIntent');
  });
});
