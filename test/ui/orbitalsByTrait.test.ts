import { describe, it, expect } from 'vitest';
import { buildOrbitalsByTrait } from '../../src/ui/orbitalsByTrait';

describe('@almadar/runtime/ui buildOrbitalsByTrait', () => {
  const schema = {
    orbitals: [
      {
        name: 'InterviewScheduleOrbital',
        traits: [
          { ref: 'AppShell.traits.AppLayout', name: 'InterviewScheduleAppLayout' },
          { name: 'InterviewScheduleList' },
        ],
        pages: [{ path: '/interviews' }],
      },
      {
        name: 'JobOpeningOrbital',
        traits: [{ name: 'JobOpeningCatalog' }],
        pages: [{ path: '/jobs' }],
      },
    ],
  };

  it('maps source-declared traits to their orbital', () => {
    const map = buildOrbitalsByTrait(schema);
    expect(map.InterviewScheduleAppLayout).toBe('InterviewScheduleOrbital');
    expect(map.InterviewScheduleList).toBe('InterviewScheduleOrbital');
    expect(map.JobOpeningCatalog).toBe('JobOpeningOrbital');
  });

  it('backfills an auto-pulled sibling from the resolved page → its orbital', () => {
    const resolvedPages = [
      { path: '/interviews', traitNames: ['InterviewScheduleAppLayout', 'InterviewScheduleList', 'InterviewWeek'] },
    ];
    const map = buildOrbitalsByTrait(schema, resolvedPages);
    expect(map.InterviewWeek).toBe('InterviewScheduleOrbital');
  });

  it('lets source-declared mappings win over the IR backfill', () => {
    const resolvedPages = [
      { path: '/interviews', traitNames: ['JobOpeningCatalog'] },
    ];
    const map = buildOrbitalsByTrait(schema, resolvedPages);
    expect(map.JobOpeningCatalog).toBe('JobOpeningOrbital');
  });

  it('returns an empty map for a schema with no orbitals', () => {
    expect(buildOrbitalsByTrait(undefined)).toEqual({});
    expect(buildOrbitalsByTrait({ orbitals: [] })).toEqual({});
  });
});
