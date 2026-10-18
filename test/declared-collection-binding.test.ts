// A program's declared `[persistent: tbl]` collections reach the store when the program registers (EXEC-STORE-1):
// the store keys an entity's rows by its collection, and by the entity name when none is declared.
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import type { OrbitalSchema } from '@almadar/core';

class RecordingPersistence extends InMemoryPersistence {
  readonly bound: Array<[string, string]> = [];
  bindCollection(entityType: string, collection: string): void {
    this.bound.push([entityType, collection]);
  }
}

const fields = [{ name: 'id', type: 'string' as const, primaryKey: true }];

const schema: OrbitalSchema = {
  name: 'collections',
  version: '1.0.0',
  orbitals: [
    {
      name: 'TicketsOrbital',
      pages: [],
      entity: { name: 'Ticket', persistence: 'persistent', collection: 'tickets', fields },
      auxiliaryEntities: [
        { name: 'Bug', persistence: 'persistent', collection: 'bugs', fields },
        { name: 'Invoice', persistence: 'persistent', collection: 'invoices', local: true, fields },
        { name: 'Scratch', persistence: 'runtime', collection: 'scratch', fields },
      ],
      traits: [],
    },
    {
      name: 'NotesOrbital',
      pages: [],
      entity: { name: 'Note', persistence: 'persistent', fields },
      traits: [],
    },
  ],
};

describe('binding declared collections on register', () => {
  it('binds each server-stored entity that declares a collection, primary and auxiliary', async () => {
    const persistence = new RecordingPersistence();
    await new OrbitalServerRuntime({ persistence, debug: false }).register(schema);
    expect(persistence.bound.sort()).toEqual([['Bug', 'bugs'], ['Ticket', 'tickets']]);
  });

  it('control: a bare persistent entity, a browser-stored one and a runtime one are not bound', async () => {
    const persistence = new RecordingPersistence();
    await new OrbitalServerRuntime({ persistence, debug: false }).register(schema);
    const names = persistence.bound.map(([entity]) => entity);
    expect(names).not.toContain('Note');
    expect(names).not.toContain('Invoice');
    expect(names).not.toContain('Scratch');
  });

  it('edge: a store without bindCollection registers the same program', async () => {
    await expect(new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false }).register(schema)).resolves.not.toThrow();
  });
});
