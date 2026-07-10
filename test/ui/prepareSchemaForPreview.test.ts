import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { prepareSchemaForPreview, buildMockData, adjustSchemaForMockData } from '../../src/ui/prepareSchemaForPreview';

const baseSchema: OrbitalSchema = {
  name: 'PreviewTestApp',
  orbitals: [
    {
      name: 'ListOrbital',
      entity: {
        name: 'Item',
        fields: [
          { name: 'id', type: 'string' },
          { name: 'title', type: 'string' },
          { name: 'count', type: 'number' },
          { name: 'done', type: 'boolean' },
        ],
      },
      traits: [
        {
          name: 'ItemList',
          scope: 'collection',
          linkedEntity: 'Item',
          stateMachine: {
            states: [
              { name: 'loading', isInitial: true },
              { name: 'browsing' },
            ],
            transitions: [
              { event: 'INIT', from: 'browsing', to: 'loading' },
            ],
          },
        },
      ],
      pages: [{ name: 'ListPage', path: '/list' }],
    },
  ],
};

describe('@almadar/runtime/ui prepareSchemaForPreview', () => {
  it('buildMockData generates 10 rows per entity', () => {
    const data = buildMockData(baseSchema);
    expect(data.Item).toHaveLength(10);
    expect(data.Item[0]).toHaveProperty('id');
    expect(data.Item[0]).toHaveProperty('title');
    expect(typeof data.Item[0].title).toBe('string');
    expect(typeof data.Item[0].count).toBe('number');
    expect(typeof data.Item[0].done).toBe('boolean');
  });

  it('adjustSchemaForMockData flips INIT state when data exists', () => {
    const data = buildMockData(baseSchema);
    const adjusted = adjustSchemaForMockData(baseSchema, data);
    const trait = adjusted.orbitals[0].traits[0];
    expect(trait.stateMachine?.states.find((s) => s.name === 'browsing')?.isInitial).toBe(true);
    expect(trait.stateMachine?.states.find((s) => s.name === 'loading')?.isInitial).toBe(false);
  });

  it('prepareSchemaForPreview returns schema + mockData', () => {
    const { schema, mockData } = prepareSchemaForPreview(baseSchema);
    expect(mockData.Item).toHaveLength(10);
    const trait = schema.orbitals[0].traits[0];
    expect(trait.stateMachine?.states.find((s) => s.name === 'browsing')?.isInitial).toBe(true);
  });

  it('prepareSchemaForPreview accepts a JSON string', () => {
    const { mockData } = prepareSchemaForPreview(JSON.stringify(baseSchema));
    expect(mockData.Item).toHaveLength(10);
  });
});
