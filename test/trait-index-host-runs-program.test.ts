/**
 * A view of a program its host runs entirely (an extension's panel over its worker) keeps no trait
 * client-only: the host runs every trait, so every dispatch is host-first and every host result is
 * shown. Without the option, the usual classification stands.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalDefinition } from '@almadar/core';
import { buildTraitIndex } from '../src/index.js';

const orbitals: OrbitalDefinition[] = [{
  name: 'Feed',
  entity: { name: 'Seen', persistence: 'persistent', collection: 'seen', local: true, fields: [{ name: 'id', type: 'string' }] },
  traits: [
    {
      name: 'List', linkedEntity: 'Seen', category: 'interaction', scope: 'collection',
      stateMachine: {
        states: [{ name: 'ready', isInitial: true }],
        events: [{ key: 'INIT', name: 'INIT' }, { key: 'LOADED', name: 'LOADED' }],
        transitions: [
          { from: 'ready', to: 'ready', event: 'INIT', effects: [['fetch', 'Seen', { emit: { success: 'LOADED' } }]] },
          { from: 'ready', to: 'ready', event: 'LOADED', effects: [['render-ui', 'main', { type: 'typography', content: 'loaded' }]] },
        ],
      },
    },
  ],
  pages: [],
}];

describe('buildTraitIndex hostRunsProgram', () => {
  it('control: a trait over a browser-stored entity with no server effect is client-only by default', () => {
    expect(buildTraitIndex(orbitals).byName.get('List')?.dispatchMode).toBe('hybridClientOnly');
  });

  it('when the host runs the program, the same trait is host-first', () => {
    expect(buildTraitIndex(orbitals, undefined, { hostRunsProgram: true }).byName.get('List')?.dispatchMode).toBe('persistedAwaited');
  });
});
