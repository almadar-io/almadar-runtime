/**
 * A name-only `trait` listen source hears only the listener's OWN orbital; a
 * listener reaches another orbital by naming it. Rust twin:
 * `orbital-core/tests/listen_source_identity.rs`.
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { buildSourceMatcher } from '../src/events/identity/routing.js';
import type { OrbitalSchema, Trait } from '@almadar/core';

type Source = NonNullable<Trait['listens']>[number]['source'];

const player: Trait = {
  name: 'Play',
  scope: 'instance',
  linkedEntity: 'S',
  stateMachine: {
    states: [{ name: 'on', isInitial: true }],
    events: [{ key: 'UP', name: 'Up' }],
    transitions: [{ from: 'on', to: 'on', event: 'UP', effects: [['emit', 'TURN', {}]] }],
  },
  emits: [{ event: 'TURN', scope: 'external' }],
};

const listener = (source: Source): Trait => ({
  name: 'Mechanic',
  scope: 'instance',
  linkedEntity: 'S',
  stateMachine: {
    states: [{ name: 'on', isInitial: true }],
    events: [{ key: 'STEER', name: 'Steer' }],
    transitions: [{ from: 'on', to: 'on', event: 'STEER', effects: [['emit', 'STEERED', {}]] }],
  },
  emits: [{ event: 'STEERED', scope: 'external' }],
  listens: [{ event: 'TURN', triggers: 'STEER', scope: 'external', source }],
});

const orbital = (name: string, traits: Trait[]): OrbitalSchema['orbitals'][number] => ({
  name,
  entity: { name: 'S', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
  traits,
  pages: [],
});

async function heard(orbitals: OrbitalSchema['orbitals'], seedOrbital: string): Promise<boolean> {
  const runtime = new OrbitalServerRuntime({ debug: false });
  await runtime.register({ name: 'App', orbitals });
  const recorded: string[] = [];
  runtime.getEventBus().onAny((e) => recorded.push(e.type));
  await runtime.processOrbitalEvent(seedOrbital, { event: 'UP' });
  await new Promise((r) => setTimeout(r, 30));
  return recorded.includes('STEERED');
}

describe('a name-only trait listen source is confined to the listener orbital', () => {
  it('hears the named trait of its own orbital', async () => {
    expect(await heard([orbital('A', [player, listener({ kind: 'trait', trait: 'Play' })]), orbital('B', [])], 'A')).toBe(true);
  });

  it('control: does not hear the same-named trait of another orbital', async () => {
    expect(await heard([orbital('A', [listener({ kind: 'trait', trait: 'Play' })]), orbital('B', [player])], 'B')).toBe(false);
  });

  it('an orbital source that names the other orbital hears it', async () => {
    expect(await heard([orbital('A', [listener({ kind: 'orbital', orbital: 'B', trait: 'Play' })]), orbital('B', [player])], 'B')).toBe(true);
  });

  it('control: an orbital source naming a different orbital does not hear it', async () => {
    expect(await heard([orbital('A', [listener({ kind: 'orbital', orbital: 'Other', trait: 'Play' })]), orbital('B', [player])], 'B')).toBe(false);
  });
});

describe('buildSourceMatcher', () => {
  it('a name-only trait source matches only an emitter stamped with the listener orbital', () => {
    const match = buildSourceMatcher({ kind: 'trait', trait: 'Play' }, 'A');
    expect(match({ orbital: 'A', trait: 'Play' })).toBe(true);
    expect(match({ orbital: 'B', trait: 'Play' })).toBe(false);
    expect(match({ trait: 'Play' })).toBe(false);
    expect(match(undefined)).toBe(false);
  });
});
