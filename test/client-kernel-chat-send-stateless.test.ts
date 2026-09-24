/**
 * std-realtime-chat "sending does nothing" on the stateless topology, at the
 * client kernel (no React): the page mounts, the rail's first load auto-opens
 * a conversation (server-run `CONVERSATION_OPENED -> ChatComposer.SELECT_CHANNEL`),
 * so the local composer's frame must hold `activeChannel` when SEND's guard runs.
 */
import { getTraitName } from '@almadar/core';
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityRow, OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import {
  buildTraitIndex,
  createClientKernel,
  createIndexStageRunner,
  createInProcessTransport,
  createMemoryCircuitStore,
  evaluateOrbitalEvent,
  StateMachineManager,
  type IndexedTrait,
  type TraitIndex,
} from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CHAT_ORBS = [
  join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/app/organisms/std-realtime-chat.orb'),
  join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/project-friday/organisms/project-friday.orb'),
].filter((p) => existsSync(p));

async function resolve(orbPath: string): Promise<OrbitalSchema> {
  const raw = JSON.parse(readFileSync(orbPath, 'utf-8')) as OrbitalSchema;
  const resolved = await preprocessSchema(raw, {
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
    allowOutsideBasePath: true,
  });
  if (!resolved.success) throw new Error(resolved.errors.join('; '));
  return resolved.data.schema;
}

function restrict(full: TraitIndex, names: ReadonlySet<string>): TraitIndex {
  const byName = new Map<string, IndexedTrait>();
  for (const [name, entry] of full.byName) if (names.has(name)) byName.set(name, entry);
  return { byName, allEntities: full.allEntities, orbitals: full.orbitals };
}

describe.each(CHAT_ORBS)('stateless chat kernel (%s)', (orbPath) => {
  it('SEND after the auto-open persists the draft into the opened conversation', async () => {
    const s = await resolve(orbPath);
    const persistence = new MockPersistenceAdapter({ ownerId: 'viewer-1', ownerFields: ['ChannelMember.member'] });
    // The hosted store's mock seed (viewer-owned memberships).
    const seeder = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
    await seeder.register(s);
    const user = seeder.getDefaultUser();
    const full = buildTraitIndex(s.orbitals);
    const chat = s.orbitals.find((o) => o.name === 'ChatMessageOrbital');
    const page = chat?.pages?.find((p) => typeof p === 'object' && p.path === '/chat');
    const pageTraits = typeof page === 'object' ? (page.traits ?? []).map((t) => (typeof t === 'object' && 'ref' in t ? t.ref : getTraitName(t))) : [];
    expect(pageTraits.length).toBeGreaterThan(0);
    const traitIndex = restrict(full, new Set(pageTraits));
    const composer = pageTraits.find((t) => t.endsWith('ChatComposer')) ?? 'ChatComposer';

    const transport = createInProcessTransport(async (_orbital, request) => {
      const manager = new StateMachineManager([...full.byName.values()].map((e) => e.traitDef));
      const frames = new Map<string, EntityRow>();
      return evaluateOrbitalEvent(
        { traitIndex: full, manager, persistence, frames, runtimeRowSentinel: true, ...(user !== undefined ? { user } : {}), runEffects: createIndexStageRunner({ traitIndex: full, persistence, frames, manager, schema: s }) },
        request,
      );
    }, { carriesCircuitState: true });
    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({ orbitalName: 'ChatMessageOrbital', traitIndex, fullTraitIndex: full, store, carriesCircuitState: true, transport });

    for (const t of pageTraits) await kernel.dispatch({ event: 'INIT', targetTrait: t });
    const composerFrame = (): EntityRow | undefined => store.frames.get(traitIndex.byName.get(composer)?.frameKey ?? composer);
    const opened = composerFrame()?.['activeChannel'];
    expect(typeof opened === 'string' && opened !== '').toBe(true);

    await kernel.dispatch({ event: 'DRAFT_CHANGED', targetTrait: composer, payload: { value: 'typed and sent' } });
    await kernel.dispatch({ event: 'SEND', targetTrait: composer });
    const stored = (await persistence.list('ChatMessage')).filter((r) => r['content'] === 'typed and sent');
    expect(stored.map((r) => r['channel'])).toEqual([opened]);

    // The saved message is not the composer's row: the conversation stays
    // open and a second message sends too.
    expect(composerFrame()?.['activeChannel']).toBe(opened);
    await kernel.dispatch({ event: 'DRAFT_CHANGED', targetTrait: composer, payload: { value: 'second message' } });
    await kernel.dispatch({ event: 'SEND', targetTrait: composer });
    const second = (await persistence.list('ChatMessage')).filter((r) => r['content'] === 'second message');
    expect(second.map((r) => r['channel'])).toEqual([opened]);
  }, 120_000);
});
