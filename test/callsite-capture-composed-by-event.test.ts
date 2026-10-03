/**
 * The server capture pass repaints only the children the firing transition composes —
 * std-executive-dashboard's INIT renders an empty stack, and its win-rate stat was
 * repainted under INIT's empty payload: `(array/filter @callsitePayload.data …)` on null,
 * a TypeMismatch under the strict array rule. Twin of `@almadar/ui`'s
 * test/callsite-child-deferred-mount.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime, type ClientRenderUITuple } from '../src/server/OrbitalServerRuntime.js';
import type { ClientEffectTuple, OrbitalSchema, RuntimeValue, Trait } from '@almadar/core';

function statFrame(effects: Array<{ traitName: string; effect: ClientEffectTuple }> | undefined): Record<string, RuntimeValue> | undefined {
  const entries = effects?.filter((e) => e.traitName === 'Won') ?? [];
  const last = entries.at(-1);
  return last ? ((last.effect as ClientRenderUITuple)[2] as Record<string, RuntimeValue> | undefined) : undefined;
}

function schema(): OrbitalSchema {
  const content: Trait = {
    name: 'Content', scope: 'instance', linkedEntity: 'Deal',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }], events: [],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Panel'] }]] }],
    },
  };
  const panel: Trait = {
    name: 'Panel', scope: 'instance', linkedEntity: 'Deal',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'DEALS_LOADED', name: 'Deals loaded' }, { key: 'TICK', name: 'Tick' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'stack', children: [] }]] },
        { from: 'idle', to: 'idle', event: 'DEALS_LOADED', effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Won'] }]] },
        { from: 'idle', to: 'idle', event: 'TICK', effects: [['render-ui', 'modal', { type: 'typography', content: 'tick' }]] },
      ],
    },
  };
  const won: Trait = {
    name: 'Won', scope: 'instance', linkedEntity: 'Deal',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', {
        type: 'stat-display', label: 'Won',
        value: ['array/len', ['array/filter', '@callsitePayload.data', ['fn', 'd', ['=', '@d.status', 'won']]]],
      }]] }],
    },
  };
  return {
    name: 'DealsApp',
    schemaVersion: 4,
    orbitals: [{
      name: 'DealOrbital',
      entity: { name: 'Deal', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'status', type: 'string' }] },
      traits: [content, panel, won],
      pages: [],
    }],
  };
}

describe('the server repaints only the children a transition composes', () => {
  it('the parent\'s INIT composes no child: it succeeds and paints no stat', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema());
    const res = await runtime.processOrbitalEvent('DealOrbital', { event: 'INIT', targetTrait: 'Panel' });
    expect(res.success).toBe(true);
    expect(statFrame(res.clientEffectsByTrait)).toBeUndefined();
  });

  it('DEALS_LOADED composes it under its payload: 2 of 3 won', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema());
    const res = await runtime.processOrbitalEvent('DealOrbital', {
      event: 'DEALS_LOADED', targetTrait: 'Panel',
      payload: { data: [{ status: 'won' }, { status: 'lost' }, { status: 'won' }] },
    });
    expect(res.success).toBe(true);
    expect(statFrame(res.clientEffectsByTrait)?.value).toBe(2);
  });

  it('nested: Content\'s INIT repaints Panel, whose INIT composes no stat — the walk stops there', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema());
    const res = await runtime.processOrbitalEvent('DealOrbital', { event: 'INIT', targetTrait: 'Content' });
    expect(res.success).toBe(true);
    expect(statFrame(res.clientEffectsByTrait)).toBeUndefined();
  });

  it('control: a parent event that composes nothing leaves the stat unrepainted', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(schema());
    await runtime.processOrbitalEvent('DealOrbital', { event: 'DEALS_LOADED', targetTrait: 'Panel', payload: { data: [{ status: 'won' }] } });
    const res = await runtime.processOrbitalEvent('DealOrbital', { event: 'TICK', targetTrait: 'Panel' });
    expect(res.success).toBe(true);
    expect(statFrame(res.clientEffectsByTrait)).toBeUndefined();
  });
});
