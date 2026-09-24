// Runtime Spec Clause 2.3: a `[shared]` entity is one frame for every trait bound to it, any other trait keeps a private frame. Twin of orbital-core `tests/trait_frames.rs`.
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, Trait, TypedEffect } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';

const from = (trait: string, event: string, triggers: string) => ({ event, triggers, source: { kind: 'trait' as const, trait } });
const arm = (event: string, effects: TypedEffect[]) => ({ from: 'idle', to: 'idle', event, effects });
const listener = (name: string, linkedEntity: string, listens: Trait['listens'], transitions: ReturnType<typeof arm>[]): Trait => ({
  name, linkedEntity, scope: 'instance', listens,
  stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [], transitions },
});

const schema: OrbitalSchema = {
  name: 'frames', version: '1.0.0',
  orbitals: [{
    name: 'Main', pages: [],
    entity: { name: 'Doc', shared: true, persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'v', type: 'string' }, { name: 'w', type: 'string', default: 'doc-w' }] },
    auxiliaryEntities: [{ name: 'Note', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }, { name: 'v', type: 'string', default: 'none' }] }],
    traits: [
      listener('Starter', 'Doc', [], [arm('GO', [['set', '@entity.v', 'first'], ['set', '@entity.v', 'start'], ['emit', 'PING', { v: '@entity.v' }]])]),
      listener('Reader', 'Doc', [from('Starter', 'PING', 'READ')], [arm('READ', [['emit', 'SEEN', { v: '@entity.v' }]])]),
      listener('OwnB', 'Note', [from('Starter', 'PING', 'WRITE'), from('OwnC', 'OWN_C', 'READ')], [
        arm('WRITE', [['set', '@entity.v', 'b']]),
        arm('READ', [['emit', 'OWN_SEEN', { v: '@entity.v' }]]),
      ]),
      listener('OwnC', 'Note', [from('Starter', 'PING', 'WRITE')], [arm('WRITE', [['set', '@entity.v', 'c'], ['emit', 'OWN_C', {}]])]),
      listener('OwnD', 'Note', [from('OwnC', 'OWN_C', 'READ')], [arm('READ', [['emit', 'D_SEEN', { v: '@entity.v', w: '@entity.w' }]])]),
    ],
  }],
};

async function runtime(): Promise<OrbitalServerRuntime> {
  const rt = new OrbitalServerRuntime({ debug: false, mode: 'mock' });
  await rt.register(schema);
  return rt;
}

async function seen(rt: OrbitalServerRuntime, event: string): Promise<unknown[]> {
  const r = await rt.processOrbitalEvent('Main', { event: 'GO', payload: {}, targetTrait: 'Starter' });
  return r.emittedEvents.filter((e) => e.event === event).map((e) => e.payload?.['v']);
}

describe('trait frames', () => {
  it('a shared write is seen by every trait on the entity', async () => {
    expect(await seen(await runtime(), 'SEEN')).toEqual(['start']);
  });

  it('within one trait the later set wins', async () => {
    expect(await seen(await runtime(), 'PING')).toEqual(['start']);
  });

  it('non-shared traits on one entity keep private frames', async () => {
    expect(await seen(await runtime(), 'OWN_SEEN')).toEqual(['b']);
  });

  it("an unwritten private field reads its declared default, not a sibling's write", async () => {
    expect(await seen(await runtime(), 'D_SEEN')).toEqual(['none']);
  });

  it("the orbital's primary entity defaults never reach a trait bound to another entity", async () => {
    const r = await (await runtime()).processOrbitalEvent('Main', { event: 'GO', payload: {}, targetTrait: 'Starter' });
    expect(r.emittedEvents.find((e) => e.event === 'D_SEEN')?.payload?.['w']).toBeUndefined();
  });

  it('a private frame persists across dispatches', async () => {
    const rt = await runtime();
    await seen(rt, 'OWN_SEEN');
    expect(await seen(rt, 'OWN_SEEN')).toEqual(['b']);
  });
});
