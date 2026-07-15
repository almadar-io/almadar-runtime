import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { OrbitalDefinition, EntityId, Trait } from '@almadar/core';

// W5-4b: a config knob typed `entity`/`trait`/`event` holds a reference NAME
// (`targetEntity: "Task"`); the stamp records the referenced node's stable id
// on the field's `refId`. When the entity DECLARATION is renamed (Task ->
// WorkItem) but the config field's `default` keeps the OLD name, the reader
// resolves via `refId` against the id->node index and rewrites `default` to
// the current name — the config-value sibling of the entity-token resolver.

function makeOrbital(trait: Trait): OrbitalDefinition {
  return {
    name: 'Shop',
    // The entity was renamed Task -> WorkItem; its stable id is unchanged.
    entity: {
      id: 'ent_x' as EntityId,
      name: 'WorkItem',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [trait],
    pages: [],
  };
}

function traitWithConfigRef(refId?: EntityId): Trait {
  return {
    name: 'TaskAssign',
    scope: 'instance',
    stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
    config: {
      targetEntity: {
        type: 'entity',
        default: 'Task',
        ...(refId ? { refId } : {}),
      },
    },
  } as Trait;
}

describe('ReferenceResolver — id-primary config-reference resolution', () => {
  it('resolves a stale entity-typed config default to the renamed declaration via refId', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', skipExternalLoading: true });
    const orbital = makeOrbital(traitWithConfigRef('ent_x' as EntityId));

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.traits[0].trait;
      expect(t.config?.targetEntity.default).toBe('WorkItem');
    }
  });

  it('leaves the config default untouched when no refId is present', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', skipExternalLoading: true });
    const orbital = makeOrbital(traitWithConfigRef(undefined));

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.traits[0].trait;
      expect(t.config?.targetEntity.default).toBe('Task');
    }
  });

  it('resolves an event-typed config default to the event current key via refId', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', skipExternalLoading: true });
    // The event was renamed OLD_SUBMIT -> SUBMIT_FORM; its stable id is unchanged.
    const trait: Trait = {
      name: 'FormControl',
      scope: 'instance',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'SUBMIT_FORM', id: 'evt_1', name: 'Submit form' }],
        transitions: [],
      },
      config: {
        pressEvent: {
          type: 'event',
          default: 'OLD_SUBMIT',
          refId: 'evt_1',
        },
      },
    } as Trait;
    const orbital = makeOrbital(trait);

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.traits[0].trait;
      expect(t.config?.pressEvent.default).toBe('SUBMIT_FORM');
    }
  });

  it('leaves the config default untouched when the field type is not a reference type', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', skipExternalLoading: true });
    const trait: Trait = {
      name: 'TaskAssign',
      scope: 'instance',
      stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [] },
      config: {
        targetEntity: {
          type: 'string',
          default: 'Task',
          refId: 'ent_x' as EntityId,
        },
      },
    } as Trait;
    const orbital = makeOrbital(trait);

    const result = await resolver.resolve(orbital);

    expect(result.success).toBe(true);
    if (result.success) {
      const t = result.data.traits[0].trait;
      expect(t.config?.targetEntity.default).toBe('Task');
    }
  });
});
