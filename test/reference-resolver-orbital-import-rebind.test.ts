/**
 * project-friday imports std-realtime-chat's whole ChatMessageOrbital. Its
 * `ChannelRail = Browse.traits.BrowseItemBrowse -> ChannelMember` must keep that
 * rebind through the import: the Rust resolver emits `fetch ChannelMember`, the
 * JS resolver emitted the atom's own `fetch BrowseItem` — so on the JS-resolved
 * (in-process preview) path project-friday's chat rail listed nothing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { resolveSchema } from '../src/entities/resolver/reference-resolver.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BEHAVIORS_ROOT = join(REPO_ROOT, 'packages/almadar-behaviors');
const PF = join(BEHAVIORS_ROOT, 'behaviors/registry/project-friday/organisms/project-friday.orb');

function fetchedEntities(transitions: ReadonlyArray<{ effects?: unknown[] }>): string[] {
  const out = new Set<string>();
  for (const tr of transitions) {
    for (const e of tr.effects ?? []) {
      if (Array.isArray(e) && e[0] === 'fetch' && typeof e[1] === 'string') out.add(e[1]);
    }
  }
  return [...out];
}

describe.skipIf(!existsSync(PF))('whole-orbital import keeps the imported traits\' rebinds', () => {
  it('project-friday ChatMessageOrbital rail and thread fetch their rebound entities', async () => {
    const input = JSON.parse(readFileSync(PF, 'utf-8')) as OrbitalSchema;
    const result = await resolveSchema(input, {
      basePath: BEHAVIORS_ROOT,
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const chat = result.data.find((o) => o.name === 'ChatMessageOrbital');
    const byName = new Map((chat?.traits ?? []).map((rt) => [rt.trait.name, rt.trait]));
    const rail = byName.get('ChatMessageOrbitalChannelRail');
    const thread = byName.get('ChatMessageOrbitalChatThread');
    expect(fetchedEntities(rail?.stateMachine?.transitions ?? [])).toEqual(['ChannelMember']);
    expect(fetchedEntities(thread?.stateMachine?.transitions ?? [])).toEqual(['ChatMessage']);
  }, 180_000);
});
