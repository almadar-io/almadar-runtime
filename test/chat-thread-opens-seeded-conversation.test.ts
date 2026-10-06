/**
 * std-realtime-chat, server side of the owner's report ("mocks not appearing",
 * "changing channels does nothing", "sending does nothing"): the rail's first
 * load auto-opens the viewer's most recent conversation and the thread lists
 * its messages; picking another conversation opens it; a sent message is
 * persisted into the open conversation and the thread lists it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalEventResponse, OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { MockPersistenceAdapter } from '@almadar/db/mock';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { IO_ROOT, STD_ROOT } from './helpers/behavior-packages.js';

const CHAT_ORBS = [
  join(IO_ROOT, 'behaviors/registry/app/organisms/std-realtime-chat.orb'),
  // project-friday imports the whole ChatMessageOrbital (OnlineUser -> Person).
  join(IO_ROOT, 'behaviors/registry/project-friday/organisms/project-friday.orb'),
];

async function chatRuntime(orbPath: string) {
  const raw = JSON.parse(readFileSync(orbPath, 'utf-8')) as OrbitalSchema;
  const resolved = await preprocessSchema(raw, {
    basePath: IO_ROOT,
    stdLibPath: STD_ROOT,
    allowOutsideBasePath: true,
  });
  if (!resolved.success) throw new Error(resolved.errors.join('; '));
  const persistence = new MockPersistenceAdapter({ ownerId: 'viewer-1', ownerFields: ['ChannelMember.member'] });
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
  await runtime.register(resolved.data.schema);
  // A whole-orbital import (`reference`) prefixes the imported traits with the orbital name.
  const imported = raw.orbitals.some((o) => o.name === 'ChatMessageOrbital' && 'reference' in o && o.reference !== undefined);
  const trait = (name: string): string => (imported ? `ChatMessageOrbital${name}` : name);
  // The host names no viewer, so the runtime presents the app's first declared persona.
  const viewer = runtime.getDefaultUser()?.id ?? '';
  return { runtime, persistence, trait, viewer };
}

function threadContents(response: OrbitalEventResponse, threadTrait: string): unknown[] {
  const loaded = response.emittedEvents.filter((e) => e.event === 'BrowseItemLoaded' && e.source?.trait === threadTrait).at(-1);
  const rows = loaded?.payload?.['data'];
  return Array.isArray(rows) ? rows.map((r) => (r !== null && typeof r === 'object' && !Array.isArray(r) ? r['content'] : undefined)) : [];
}

async function viewerMemberships(persistence: MockPersistenceAdapter, viewer: string) {
  return (await persistence.list('ChannelMember'))
    .filter((m) => m['member'] === viewer)
    .sort((a, b) => String(b['lastMessageAt'] ?? '').localeCompare(String(a['lastMessageAt'] ?? '')));
}

describe.each(CHAT_ORBS)('chat server circuit (%s)', (orbPath) => {
  it('the auto-opened conversation\'s thread lists its messages', async () => {
    const { runtime, persistence, trait, viewer } = await chatRuntime(orbPath);
    const channel = (await viewerMemberships(persistence, viewer))[0]?.['channel'];
    expect(typeof channel).toBe('string');
    await persistence.create('ChatMessage', { channel, content: 'hello from seed', sender: viewer, senderName: 'Viewer', timestamp: '2026-09-24T00:00:00.000Z' });

    const response = await runtime.processOrbitalEvent('ChatMessageOrbital', { event: 'INIT', targetTrait: trait('ChannelRail') });
    const opened = response.emittedEvents.find((e) => e.event === 'CONVERSATION_OPENED');
    expect(opened?.payload?.['channel']).toBe(channel);
    expect(threadContents(response, trait('ChatThread'))).toContain('hello from seed');
  }, 120_000);

  it('picking another conversation opens it (thread lists ITS messages)', async () => {
    const { runtime, persistence, trait, viewer } = await chatRuntime(orbPath);
    const memberships = await viewerMemberships(persistence, viewer);
    expect(memberships.length).toBeGreaterThan(1);
    await runtime.processOrbitalEvent('ChatMessageOrbital', { event: 'INIT', targetTrait: trait('ChannelRail') });
    const other = memberships[memberships.length - 1];
    await persistence.create('ChatMessage', { channel: other['channel'], content: 'in the other room', sender: viewer, senderName: 'Viewer', timestamp: '2026-09-24T00:00:00.000Z' });
    // A rail row click reaches the composer through
    // `ChannelRail.VIEW -> SELECT_CHANNEL with { channel: ?row.channel }`.
    const response = await runtime.processOrbitalEvent('ChatMessageOrbital', {
      event: 'SELECT_CHANNEL', targetTrait: trait('ChatComposer'), payload: { channel: other['channel'] },
    });
    expect(threadContents(response, trait('ChatThread'))).toContain('in the other room');
  }, 120_000);

  it('sending a message persists it into the open conversation and the thread lists it', async () => {
    const { runtime, persistence, trait } = await chatRuntime(orbPath);
    const init = await runtime.processOrbitalEvent('ChatMessageOrbital', { event: 'INIT', targetTrait: trait('ChannelRail') });
    const channel = init.emittedEvents.find((e) => e.event === 'CONVERSATION_OPENED')?.payload?.['channel'];
    expect(typeof channel).toBe('string');
    await runtime.processOrbitalEvent('ChatMessageOrbital', { event: 'DRAFT_CHANGED', targetTrait: trait('ChatComposer'), payload: { value: 'sent from the composer' } });
    const sent = await runtime.processOrbitalEvent('ChatMessageOrbital', { event: 'SEND', targetTrait: trait('ChatComposer') });
    expect(sent.transitioned).toBe(true);
    const stored = (await persistence.list('ChatMessage')).filter((r) => r['content'] === 'sent from the composer');
    expect(stored.map((r) => r['channel'])).toEqual([channel]);
    expect(threadContents(sent, trait('ChatThread'))).toContain('sent from the composer');
  }, 120_000);
});
