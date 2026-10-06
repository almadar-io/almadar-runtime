/**
 * A mount batch (`OrbitalEventRequest.mount`): one request mounts several
 * traits, each running its OWN lifecycle event in list order with the shared
 * payload; the per-trait response maps carry every seed. A seed that cannot
 * handle its event is a per-trait rejection, never a silent skip.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';
import { buildTraitIndex, createIndexStageRunner, evaluateOrbitalEvent, StateMachineManager, type EvaluateOrbitalEventDeps } from '../src/index.js';

function schema(): OrbitalSchema {
  const render = (label: string): TypedEffect => ['render-ui', 'main', { type: 'typography', content: label }];
  return {
    name: 'mount-batch',
    orbitals: [{
      name: 'PageOrbital',
      pages: [],
      entity: { name: 'Item', persistence: 'persistent', fields: [{ name: 'id', type: 'string' }] },
      traits: [
        { name: 'Header', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'shown' }], events: [], transitions: [{ from: 'idle', to: 'shown', event: 'INIT', effects: [render('header')] }] } },
        { name: 'Stats', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'loaded' }], events: [], transitions: [{ from: 'idle', to: 'loaded', event: 'LOAD', effects: [render('stats')] }] } },
        { name: 'Clock', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }, { name: 'ticking' }], events: [], transitions: [{ from: 'idle', to: 'ticking', event: '$MOUNT', effects: [render('clock')] }] } },
        { name: 'Inert', scope: 'instance', stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions: [{ from: 'idle', to: 'idle', event: 'SAVE', effects: [] }] } },
      ],
    }],
  };
}

function deps(): EvaluateOrbitalEventDeps {
  const s = schema();
  const traitIndex = buildTraitIndex(s.orbitals);
  const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
  const persistence = new InMemoryPersistence();
  const frames = new Map<string, EntityRow>();
  return { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema: s }) };
}

const effectEvents = (r: Awaited<ReturnType<typeof evaluateOrbitalEvent>>) =>
  (r.clientEffectsByTrait ?? []).map((e) => `${e.traitName}:${e.event}`);

describe('evaluateOrbitalEvent — mount batch', () => {
  it('runs each seed with its own lifecycle event and merges the per-trait maps', async () => {
    const r = await evaluateOrbitalEvent(deps(), {
      event: 'INIT',
      mount: [{ trait: 'Header', event: 'INIT' }, { trait: 'Stats', event: 'LOAD' }, { trait: 'Clock', event: '$MOUNT' }],
    });
    expect(r.success).toBe(true);
    expect(r.transitioned).toBe(true);
    expect(r.states).toMatchObject({ Header: 'shown', Stats: 'loaded', Clock: 'ticking' });
    expect(effectEvents(r)).toEqual(['Header:INIT', 'Stats:LOAD', 'Clock:$MOUNT']);
  });

  it('a seed that cannot handle its event is a per-trait rejection; the other seeds still run', async () => {
    const r = await evaluateOrbitalEvent(deps(), {
      event: 'INIT',
      mount: [{ trait: 'Inert', event: 'INIT' }, { trait: 'Header', event: 'INIT' }, { trait: 'Nowhere', event: 'INIT' }],
    });
    expect(r.states['Header']).toBe('shown');
    expect(r.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'no-matching-transition', trait: 'Inert', event: 'INIT' }),
      expect.objectContaining({ code: 'no-dispatchable-traits', trait: 'Nowhere', event: 'INIT' }),
    ]));
  });

  it('stateless addressing: each seed dispatches from its declared state', async () => {
    const r = await evaluateOrbitalEvent(deps(), {
      event: 'INIT',
      mount: [{ trait: 'Header', event: 'INIT' }, { trait: 'Stats', event: 'LOAD' }],
      traits: [{ trait: 'Header', from: 'shown' }, { trait: 'Stats', from: 'idle' }],
    });
    expect(r.states['Stats']).toBe('loaded');
    expect(effectEvents(r)).toEqual(['Stats:LOAD']);
    expect(r.rejections).toEqual(expect.arrayContaining([expect.objectContaining({ trait: 'Header', from: 'shown', event: 'INIT' })]));
  });

  it('control: a single targetTrait request is unchanged (only the target runs)', async () => {
    const r = await evaluateOrbitalEvent(deps(), { event: 'INIT', targetTrait: 'Header' });
    expect(r.states).toEqual({ Header: 'shown' });
    expect(effectEvents(r)).toEqual(['Header:INIT']);
  });

  it('the stateful host runs a mount batch from its held states', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema());
    const r = await runtime.processOrbitalEvent('PageOrbital', {
      event: 'INIT', clientId: 'tab-1',
      mount: [{ trait: 'Header', event: 'INIT' }, { trait: 'Stats', event: 'LOAD' }],
    });
    expect(r.states).toMatchObject({ Header: 'shown', Stats: 'loaded' });
    expect(effectEvents(r)).toEqual(['Header:INIT', 'Stats:LOAD']);
  });
});
