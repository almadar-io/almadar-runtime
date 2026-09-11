/**
 * `OrbitalServerRuntime` persist — `@intrinsic` frame-field stripping.
 *
 * `@intrinsic` entity fields (`std-realtime-chat`'s `ChatMessage.draft`,
 * `ChannelMember.openChannel`, …) are trait-owned view state the interpreter
 * already keeps in `traitFieldStates` (`sharedFieldKey`) and NEVER a
 * persisted column — full stop, for every write shape, not only a bare
 * `(persist update E @entity)`: an explicit `{...}` literal that happens to
 * name an intrinsic field is stripped identically. The strip is
 * deterministic on the entity's declared schema, never on how `data` was
 * constructed. Uses a `[persistent, shared]` `Message` entity with one
 * `@intrinsic` field (`draft`) — mirrors a chat composer's unsent-draft
 * scratch state riding the same entity as the sent messages.
 *
 * Also pins existing (correct) behaviour: an `@update` policy is evaluated
 * against the FETCHED existing row, never the write payload/frame — so a
 * client can't grant itself a mutation by `(set)`-ing the very field the
 * policy checks just before persisting.
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/PersistenceAdapter.js';
import type { OrbitalSchema, EventPayload } from '@almadar/core';

function chatSchema(): OrbitalSchema {
  return {
    name: 'intrinsic-frame-strip-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'Chat',
        pages: [],
        entity: {
          name: 'Message',
          persistence: 'persistent',
          shared: true,
          // `@update` — `@entity` binds the EXISTING row before mutation.
          update_policy: ['=', ['object/get', '@entity', 'ownerId'], '@user.id'],
          fields: [
            { name: 'id', type: 'string', primaryKey: true },
            { name: 'text', type: 'string', default: '' },
            { name: 'ownerId', type: 'string' },
            { name: 'draft', type: 'string', intrinsic: true, default: '' },
          ],
        },
        traits: [
          {
            name: 'Composer',
            scope: 'instance',
            linkedEntity: 'Message',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [
                { key: 'SET_DRAFT', name: 'SET_DRAFT' },
                { key: 'SAVE', name: 'SAVE' },
                { key: 'SAVE_EXPLICIT', name: 'SAVE_EXPLICIT' },
                { key: 'CHECK_DRAFT', name: 'CHECK_DRAFT' },
                { key: 'HIJACK_ATTEMPT', name: 'HIJACK_ATTEMPT' },
              ],
              transitions: [
                {
                  from: 'idle', to: 'idle', event: 'SET_DRAFT',
                  effects: [['set', '@entity.draft', '@payload.value']],
                },
                {
                  from: 'idle', to: 'idle', event: 'SAVE',
                  effects: [['persist', 'update', 'Message', '@entity']],
                },
                {
                  from: 'idle', to: 'idle', event: 'SAVE_EXPLICIT',
                  effects: [['persist', 'update', 'Message', { id: '@entity.id', draft: '@payload.value', text: 'explicit-text' }]],
                },
                {
                  from: 'idle', to: 'idle', event: 'CHECK_DRAFT',
                  effects: [['emit', 'DRAFT_VALUE', { draft: '@entity.draft' }]],
                },
                {
                  from: 'idle', to: 'idle', event: 'HIJACK_ATTEMPT',
                  effects: [
                    ['set', '@entity.ownerId', '@payload.claimedOwner'],
                    ['persist', 'update', 'Message', '@entity'],
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function setup() {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
  await runtime.register(chatSchema());
  const { id } = await runtime.persistence.create('Message', { text: 'hi', ownerId: 'alice' });
  return { runtime, id };
}

describe('OrbitalServerRuntime persist — @intrinsic frame strip', () => {
  it('strips a bare @entity intrinsic field before it reaches the store', async () => {
    const { runtime, id } = await setup();
    await runtime.processOrbitalEvent('Chat', {
      event: 'SET_DRAFT',
      entityId: id,
      payload: { value: 'unsaved draft' },
    });

    const result = await runtime.processOrbitalEvent('Chat', {
      event: 'SAVE',
      entityId: id,
      user: { id: 'alice' },
    });
    const persistEffect = result.effectResults?.find((e) => e.effect === 'persist');
    expect(persistEffect?.success).toBe(true);

    const stored = await runtime.persistence.getById('Message', id);
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty('draft');
    // Domain data untouched by the strip.
    expect(stored?.text).toBe('hi');
  });

  it('keeps the intrinsic value live in traitFieldStates after the store write drops it', async () => {
    const { runtime, id } = await setup();
    await runtime.processOrbitalEvent('Chat', {
      event: 'SET_DRAFT',
      entityId: id,
      payload: { value: 'unsaved draft' },
    });
    await runtime.processOrbitalEvent('Chat', { event: 'SAVE', entityId: id, user: { id: 'alice' } });

    const check = await runtime.processOrbitalEvent('Chat', { event: 'CHECK_DRAFT', entityId: id });
    const draftEmit = check.emittedEvents?.find((e) => e.event === 'DRAFT_VALUE');
    expect((draftEmit?.payload as EventPayload | undefined)?.draft).toBe('unsaved draft');
  });

  it('ALSO strips an explicit object literal naming the intrinsic field — @intrinsic is never a persisted column, no matter the write shape', async () => {
    const { runtime, id } = await setup();
    await runtime.processOrbitalEvent('Chat', {
      event: 'SAVE_EXPLICIT',
      entityId: id,
      user: { id: 'alice' },
      payload: { value: 'explicit-value' },
    });

    const stored = await runtime.persistence.getById('Message', id);
    expect(stored).not.toHaveProperty('draft');
    // The other explicit field in the SAME literal is untouched.
    expect(stored?.text).toBe('explicit-text');
  });

  it('pins: @update policy is checked against the fetched existing row, not the write frame', async () => {
    const { runtime, id } = await setup();
    // `bob` tries to grant himself the update by (set)-ing `ownerId` to his
    // own id in the SAME transition, just before the persist effect runs.
    // If the policy read `@entity` (the post-`set` frame) instead of the
    // row actually in the store, this would succeed.
    const result = await runtime.processOrbitalEvent('Chat', {
      event: 'HIJACK_ATTEMPT',
      entityId: id,
      user: { id: 'bob' },
      payload: { claimedOwner: 'bob' },
    });

    const persistEffect = result.effectResults?.find((e) => e.effect === 'persist');
    expect(persistEffect?.success).toBe(false);
    expect(persistEffect?.denied).toBe(true);

    const stored = await runtime.persistence.getById('Message', id);
    expect(stored?.ownerId).toBe('alice');
  });
});
