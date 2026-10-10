import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/entities/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/entities/loader/schema-loader.js';
import type { Entity, Orbital, OrbitalDefinition, OrbitalSchema, TraitId } from '@almadar/core';

// The JS twin of orbital-compiler's orbital_import_roles_expected_identity.rs: an atom with no
// roster of its own declares its viewer by `expects identity`; the expectation's role values are
// the vocabulary its import's `roles {}` remaps.
const upstream: Orbital = {
  name: 'ProgressOrbital',
  expects: [
    {
      kind: 'identity',
      name: 'Person',
      shape: [
        { name: 'id', type: 'string', required: true },
        { name: 'role', type: 'string', values: ['instructor', 'student', 'admin'] },
      ],
    },
  ],
  entity: {
    name: 'Progress',
    persistence: 'persistent',
    collection: 'progresses',
    read_policy: ['or', ['=', '@user.role', 'admin'], ['=', ['object/get', '@entity', 'studentId'], '@user.id']],
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'studentId', type: 'relation', relation: { entity: 'Person', cardinality: 'one' } },
    ],
  },
  traits: [
    {
      id: 'trt_PROGRESSLIST00000000000001' as TraitId,
      name: 'ProgressList',
      linkedEntity: 'Progress',
      scope: 'instance',
      category: 'interaction',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
    },
  ],
  pages: [{ name: 'ProgressPage', path: '/progress', traits: [{ ref: 'ProgressList' }] }],
};

function loader(): SchemaLoader {
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      return { success: true, data: { orbital: upstream, orbitals: [upstream], sourcePath: './up.orb', importPath } };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

function schemaWith(roles: Record<string, string[]> | undefined): OrbitalSchema {
  const roster: OrbitalDefinition = {
    name: 'MemberOrbital',
    entity: {
      name: 'Member',
      persistence: 'persistent',
      identity: true,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'role', type: 'string', values: ['teacher', 'pupil', 'director'] },
      ],
    },
    traits: [],
    pages: [],
  };
  const grades: OrbitalDefinition = {
    name: 'Grades',
    uses: [{ from: './up.orb', as: 'Up' }],
    entity: { name: 'Placeholder', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [],
    pages: [],
    reference: { ref: 'Up.orbitals.ProgressOrbital', entity: 'Grade', entities: { Person: 'Member' }, ...(roles !== undefined ? { roles } : {}) },
  };
  return { name: 'S', orbitals: [roster, grades] };
}

async function resolved(roles: Record<string, string[]> | undefined) {
  return new ReferenceResolver({ basePath: '.', loader: loader() }).resolveOrbitalImports(schemaWith(roles));
}

describe('ReferenceResolver — roles {} over an expected identity', () => {
  it("remaps an expected identity's role words", async () => {
    const result = await resolved({ admin: ['director'], instructor: ['teacher'], student: ['pupil'] });
    if (!result.success) throw new Error(result.errors.join('\n'));
    const grade = result.data[1]!.entity as Entity;
    expect(JSON.stringify(grade.read_policy)).toContain('director');
    expect(JSON.stringify(grade.read_policy)).not.toContain('"admin"');
    const studentId = grade.fields.find((f) => f.name === 'studentId');
    expect(studentId?.type === 'relation' ? studentId.relation.entity : undefined).toBe('Member');
  });

  it('control: a word the expectation does not declare is still ORB_O_ROLE_UNKNOWN_UPSTREAM', async () => {
    const result = await resolved({ ghost: ['director'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join('\n')).toMatch(/ORB_O_ROLE_UNKNOWN_UPSTREAM/);
  });

  it('control: without a remap the upstream words stay', async () => {
    const result = await resolved(undefined);
    if (!result.success) throw new Error(result.errors.join('\n'));
    expect(JSON.stringify((result.data[1]!.entity as Entity).read_policy)).toContain('"admin"');
  });
});
