/**
 * Server-side relation-option injection — the interpreter's mirror of the
 * compiled path's build-time `relationsData` generation (orbital-rust
 * registry.rs). A render-ui carrying a form-section or detail-panel whose
 * linked entity declares a relation-typed field must ship with
 * `relationsData: { <field>: [{value, label}] }` read from the persistence
 * adapter, label contract `name || title || id`. Without this, every
 * relation select on the runtime path renders EMPTY and detail views show
 * raw foreign ids ("Staff Id 1").
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime, type ClientRenderUITuple } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema, RuntimeValue } from '@almadar/core';

function relationSchema(): OrbitalSchema {
  return {
    name: 'relation-injection-app',
    version: '1.0.0',
    orbitals: [
      {
        name: 'StaffOrbital',
        pages: [],
        entity: {
          name: 'Staff',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
          ],
        },
        traits: [],
      },
      {
        name: 'TaskOrbital',
        pages: [],
        entity: {
          name: 'Task',
          fields: [
            { name: 'id', type: 'string', required: true },
            { name: 'title', type: 'string', required: true },
            {
              name: 'assignee',
              type: 'relation',
              relation: { entity: 'Staff', cardinality: 'one' },
            },
          ],
        },
        traits: [
          {
            name: 'editor',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'OPEN', name: 'OPEN' }],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'OPEN',
                  effects: [
                    [
                      'render-ui',
                      'modal',
                      {
                        type: 'stack',
                        children: [
                          {
                            type: 'form-section',
                            mode: 'edit',
                            fields: ['title', 'assignee'],
                          },
                          {
                            type: 'detail-panel',
                            fields: [{ key: 'title' }, { key: 'assignee' }],
                          },
                        ],
                      },
                    ],
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

interface OptionShape {
  value: string;
  label: string;
}

interface NodeShape {
  type?: string;
  relationsData?: Record<string, OptionShape[]>;
  children?: NodeShape[];
}

function isOptionShape(value: RuntimeValue): value is OptionShape {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { value?: unknown }).value === 'string' &&
    typeof (value as { label?: unknown }).label === 'string'
  );
}

function toRelationsData(value: RuntimeValue): Record<string, OptionShape[]> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, OptionShape[]> = {};
  for (const [key, options] of Object.entries(value as Record<string, RuntimeValue>)) {
    if (Array.isArray(options) && options.every(isOptionShape)) out[key] = options;
  }
  return out;
}

/** Narrow a resolved `PatternConfig` (whose `children`/`relationsData` fields
 *  are typed `unknown` in the pattern registry) to the shape this test
 *  actually asserts against — a real runtime-checked walk, not a cast. */
function toNodeShape(pattern: RuntimeValue): NodeShape {
  if (pattern === null || typeof pattern !== 'object' || Array.isArray(pattern)) return {};
  const obj = pattern as Record<string, RuntimeValue>;
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  const relationsData = toRelationsData(obj.relationsData ?? null);
  const children = Array.isArray(obj.children) ? obj.children.map(toNodeShape) : undefined;
  return { type, relationsData, children };
}

describe('relation-option injection (runtime path)', () => {
  it('attaches relationsData from the persistence adapter to form and detail nodes', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(relationSchema());
    const result = await runtime.processOrbitalEvent('TaskOrbital', { event: 'OPEN' });
    const render = result.clientEffects?.find(
      (e): e is ClientRenderUITuple => Array.isArray(e) && e[0] === 'render-ui',
    );
    expect(render, 'the OPEN transition must ship a render-ui effect').toBeTruthy();

    const node = toNodeShape(render?.[2] ?? null);
    const children = node.children ?? [];
    const formNode = children.find((c) => c.type === 'form-section');
    const detailNode = children.find((c) => c.type === 'detail-panel');

    for (const node of [formNode, detailNode]) {
      expect(node?.relationsData, `${node?.type} must carry relationsData`).toBeTruthy();
      const options = node?.relationsData?.['assignee'] ?? [];
      expect(options.length, 'seeded Staff rows must become options').toBeGreaterThan(0);
      const first = options[0];
      expect(typeof first.value).toBe('string');
      expect(first.value.length).toBeGreaterThan(0);
      expect(typeof first.label).toBe('string');
      expect(first.label.length).toBeGreaterThan(0);
    }
  });

  it('leaves patterns without relation fields untouched', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(relationSchema());
    const result = await runtime.processOrbitalEvent('TaskOrbital', { event: 'OPEN' });
    const render = result.clientEffects?.find(
      (e): e is ClientRenderUITuple => Array.isArray(e) && e[0] === 'render-ui',
    );
    // The wrapping stack itself carries no fields — no relationsData on it.
    expect(toNodeShape(render?.[2] ?? null).relationsData).toBeUndefined();
  });
});
