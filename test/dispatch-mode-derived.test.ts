/**
 * Dispatch mode derived from the effect row (owner ruling 2026-09-24): a
 * `[runtime]` entity lives in the client, so its traits stay client-only
 * unless their own effects reach the server (registry `runsOn`). Persisted
 * entities await the server; `local` always wins. Rust twin:
 * orbital-core `runtime::dispatch_mode` tests.
 */
import { describe, it, expect } from 'vitest';
import { computeDispatchMode, type Effect, type OrbitalSchema } from '@almadar/core';
import { buildTraitIndex } from '../src/index.js';

describe('computeDispatchMode', () => {
  it('follows the rule table', () => {
    for (const [runtime, server] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      expect(computeDispatchMode(true, runtime, server)).toBe('hybridClientOnly');
    }
    expect(computeDispatchMode(false, true, false)).toBe('hybridClientOnly');
    expect(computeDispatchMode(false, true, true)).toBe('runtimeOptimistic');
    expect(computeDispatchMode(false, false, false)).toBe('persistedAwaited');
    expect(computeDispatchMode(false, false, true)).toBe('persistedAwaited');
  });
});

function modeOf(opts: { runtime: boolean; effects?: Effect[]; tickEffects?: Effect[]; background?: boolean; local?: boolean }): string {
  const schema: OrbitalSchema = {
    name: 'mode-app',
    version: '1.0.0',
    orbitals: [{
      name: 'Main',
      pages: [],
      entity: { name: 'E', persistence: opts.runtime ? 'runtime' : 'persistent', fields: [{ name: 'id', type: 'string' }] },
      traits: [{
        name: 'T',
        linkedEntity: 'E',
        scope: 'instance',
        ...(opts.local ? { local: true } : {}),
        ...(opts.tickEffects ? { ticks: [{ name: 't', interval: 100, runsInBackground: opts.background === true, effects: opts.tickEffects }] } : {}),
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [],
          transitions: [{ from: 'idle', to: 'idle', event: 'GO', effects: opts.effects ?? [] }],
        },
      }],
    }],
  };
  return buildTraitIndex(schema.orbitals).byName.get('T')?.dispatchMode ?? 'missing';
}

describe('trait index dispatch mode', () => {
  it('a [runtime] trait with no server effect is client-only', () => {
    expect(modeOf({ runtime: true, effects: [['set', '@entity.x', 1]] })).toBe('hybridClientOnly');
  });
  it('a nested server effect makes a [runtime] trait optimistic', () => {
    expect(modeOf({ runtime: true, effects: [['when', true, ['fetch', 'Row', {}]]] })).toBe('runtimeOptimistic');
  });
  it('a client tick server effect counts, a background one does not', () => {
    expect(modeOf({ runtime: true, tickEffects: [['fetch', 'Row', {}]] })).toBe('runtimeOptimistic');
    expect(modeOf({ runtime: true, tickEffects: [['fetch', 'Row', {}]], background: true })).toBe('hybridClientOnly');
  });
  it('control: a persisted trait awaits whatever its effects', () => {
    expect(modeOf({ runtime: false, effects: [['set', '@entity.x', 1]] })).toBe('persistedAwaited');
  });
  it('control: local wins', () => {
    expect(modeOf({ runtime: true, effects: [['fetch', 'Row', {}]], local: true })).toBe('hybridClientOnly');
  });
});

describe('a statically dead server effect is no server work', () => {
  // A ui-* wrapper: `INIT -> idle when @config.selfFetch (fetch …)`.
  function wrapperMode(selfFetch: boolean): string {
    const schema: OrbitalSchema = {
      name: 'fold-app',
      version: '1.0.0',
      orbitals: [{
        name: 'Main',
        pages: [],
        entity: { name: 'E', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [{
          name: 'T',
          linkedEntity: 'E',
          scope: 'instance',
          config: { selfFetch: { type: 'boolean', default: selfFetch } },
          stateMachine: {
            states: [{ name: 'idle', isInitial: true }],
            events: [],
            transitions: [{ from: 'idle', to: 'idle', event: 'INIT', guard: '@config.selfFetch', effects: [['fetch', 'Row', {}]] }],
          },
        }],
      }],
    };
    return buildTraitIndex(schema.orbitals).byName.get('T')?.dispatchMode ?? 'missing';
  }
  it('selfFetch: false keeps the wrapper client-only', () => {
    expect(wrapperMode(false)).toBe('hybridClientOnly');
  });
  it('control: selfFetch: true makes it optimistic', () => {
    expect(wrapperMode(true)).toBe('runtimeOptimistic');
  });
});

