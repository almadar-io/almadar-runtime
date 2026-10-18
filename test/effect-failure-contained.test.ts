/**
 * A failing effect stops only its own transition (G-UI-097): the dispatch
 * still succeeds, every other trait settles and paints, and the failure is a
 * per-trait `effect-failed` rejection carrying the error.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';

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

const mount = { event: 'INIT', mount: [{ trait: 'Header', event: 'INIT' as const }, { trait: 'Broken', event: 'INIT' as const }] };

describe('a failing effect stops only its own transition', () => {
  it('the stateful server path answers success with the other trait settled', async () => {
    const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false });
    await runtime.register(schema(throwing));
    const r = await runtime.processOrbitalEvent('PageOrbital', mount);
    expect(r.success).toBe(true);
    expect(r.states['Header']).toBe('shown');
    expect(r.rejections).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'effect-failed', trait: 'Broken' })]));
  });
});
