/**
 * A failing effect stops only its own transition (G-UI-097): the dispatch
 * still succeeds, every other trait settles and paints, and the failure is a
 * per-trait `effect-failed` rejection carrying the error.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import { buildTraitIndex, createIndexStageRunner, evaluateOrbitalEvent, StateMachineManager, type EvaluateOrbitalEventDeps } from '../src/index.js';

const render = (label: string): TypedEffect => ['render-ui', 'main', { type: 'typography', content: label }];

function schema(brokenEffects: TypedEffect[]): OrbitalSchema {
  return {
    name: 'effect-failure',
    orbitals: [{
      name: 'PageOrbital',
      pages: [],
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        { name: 'Header', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'shown' }], events: [], transitions: [{ from: 'idle', to: 'shown', event: 'INIT', effects: [render('header')] }] } },
        { name: 'Broken', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'ready' }], events: [], transitions: [{ from: 'idle', to: 'ready', event: 'INIT', effects: brokenEffects }] } },
      ],
    }],
  };
}

const throwing: TypedEffect[] = [render('loading'), ['set', '@entity.app', ['behavior/ref', 'Indigo Pioneer']], render('after')];

function deps(s: OrbitalSchema): EvaluateOrbitalEventDeps {
  const traitIndex = buildTraitIndex(s.orbitals);
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, EntityRow>();
  return { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) };
}

const rendered = (r: Awaited<ReturnType<typeof evaluateOrbitalEvent>>, trait: string): string[] =>
  (r.clientEffectsByTrait ?? []).flatMap((e) => {
    if (e.traitName !== trait || e.effect[0] !== 'render-ui') return [];
    const node = e.effect[2];
    return node !== null && typeof node === 'object' && !Array.isArray(node) && 'content' in node && typeof node.content === 'string' ? [node.content] : [];
  });

const mount = { event: 'INIT', mount: [{ trait: 'Header', event: 'INIT' as const }, { trait: 'Broken', event: 'INIT' as const }] };

describe('a failing effect stops only its own transition', () => {
  it('the other trait settles and paints; the failure is an effect-failed rejection', async () => {
    const r = await evaluateOrbitalEvent(deps(schema(throwing)), mount);
    expect(r.success).toBe(true);
    expect(r.states['Header']).toBe('shown');
    expect(rendered(r, 'Header')).toEqual(['header']);
    expect(r.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'effect-failed', trait: 'Broken', event: 'INIT', error: expect.stringMatching(/not a behavior specifier/) }),
    ]));
  });

  it('the failing transition runs no effect after the one that threw', async () => {
    const r = await evaluateOrbitalEvent(deps(schema(throwing)), mount);
    expect(rendered(r, 'Broken')).not.toContain('after');
  });

  it('the stateful server path answers success with the other trait settled', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
    await runtime.register(schema(throwing));
    const r = await runtime.processOrbitalEvent('PageOrbital', mount);
    expect(r.success).toBe(true);
    expect(r.states['Header']).toBe('shown');
    expect(r.rejections).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'effect-failed', trait: 'Broken' })]));
  });

  it('control: with no failing effect there is no effect-failed rejection', async () => {
    const r = await evaluateOrbitalEvent(deps(schema([render('fine')])), mount);
    expect(r.success).toBe(true);
    expect(r.states['Broken']).toBe('ready');
    expect((r.rejections ?? []).filter((x) => x.code === 'effect-failed')).toEqual([]);
  });
});
