/**
 * A host presents the app first as the synthetic viewer and switches to the roster's first
 * persona after registration (playground `applyPendingPersona`). The seed is gated, so the
 * synthetic viewer, which may not create the rows, stamps nothing. The switch must still
 * give the real persona its rows, including an owner column that is not a relation (no
 * fallback owner exists for it).
 */
import { describe, expect, it } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const schema: OrbitalSchema = {
  name: 'Notes',
  version: '1.0.0',
  orbitals: [
    {
      name: 'PersonOrbital',
      entity: {
        name: 'Person', collection: 'people', persistence: 'persistent', identity: true,
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'name', type: 'string', required: true },
          { name: 'role', type: 'string', required: true, values: ['author', 'reader'] },
        ],
      },
      traits: [], pages: [],
    },
    {
      name: 'NoteOrbital',
      entity: {
        name: 'Note', collection: 'notes', persistence: 'persistent',
        read_policy: ['=', '@entity.authorId', '@user.id'],
        create_policy: ['=', '@user.role', 'author'],
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'authorId', type: 'string', required: true },
        ],
      },
      traits: [], pages: [],
    },
  ],
};

async function notesOwnedAfterSwitchTo(personaId: string, role: string): Promise<number> {
  const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
  await runtime.register(schema);
  runtime.setDefaultUser({ id: personaId, name: personaId, email: 'p@example.com', role });
  const notes = await runtime.persistence.list('Note');
  return notes.filter((n) => n['authorId'] === personaId).length;
}

describe('owner cells the synthetic viewer could not take', () => {
  it('go to the roster persona the host switches to', async () => {
    expect(await notesOwnedAfterSwitchTo('Person Id 1', 'author')).toBe(3);
  });

  it('control: a persona the @create policy denies still owns none', async () => {
    expect(await notesOwnedAfterSwitchTo('Person Id 2', 'reader')).toBe(0);
  });
});

describe('the viewer when the host names none', () => {
  it('is the roster\'s first persona, who owns seeded rows from the first seed', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema);
    expect(runtime.getDefaultUser()).toMatchObject({ id: 'Person Id 1', role: 'author' });
    const notes = await runtime.persistence.list('Note');
    expect(notes.filter((n) => n['authorId'] === 'Person Id 1').length).toBe(3);
    expect(await runtime.persistence.getById('Person', 'Person Id 1')).not.toBeNull();
  });

  it('control: a viewer the host names is kept', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, defaultUser: { id: 'Person Id 2', name: 'p2', email: 'p2@example.com', role: 'reader' } });
    await runtime.register(schema);
    expect(runtime.getDefaultUser()?.id).toBe('Person Id 2');
  });

  it('edge: an app with no [identity] roster keeps the synthetic viewer', async () => {
    const noRoster: OrbitalSchema = { ...schema, orbitals: schema.orbitals.filter((o) => o.name !== 'PersonOrbital') };
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(noRoster);
    expect(runtime.getDefaultUser()?.id).toBe('viewer-1');
  });
});
