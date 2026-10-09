// A trait embeds another through its own config (`children: [@trait.Inner]`, the shape
// composition writes) as well as through its render effects; both bind the embedded trait.
import { describe, it, expect } from 'vitest';
import type { ResolvedTrait } from '@almadar/core';
import { collectTraitRefsFromResolvedTrait } from '../src/ui/embedded-traits.js';

function trait(config: ResolvedTrait['config'], effects: ResolvedTrait['transitions'][number]['effects'] = []): ResolvedTrait {
  return {
    name: 'Outer',
    source: 'inline',
    states: [{ name: 'idle', isInitial: true, isFinal: false }],
    events: [],
    transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects }],
    guards: [],
    ticks: [],
    listens: [],
    dataEntities: [],
    ...(config !== undefined ? { config } : {}),
  };
}

describe('collectTraitRefsFromResolvedTrait', () => {
  it('finds a trait embedded through the config', () => {
    const refs = collectTraitRefsFromResolvedTrait(trait({ children: { type: '[node]', default: ['@trait.Inner'] } }));
    expect([...refs]).toEqual(['Inner']);
  });

  it('still finds a trait embedded through a render effect', () => {
    const refs = collectTraitRefsFromResolvedTrait(trait(undefined, [['render-ui', 'main', { type: 'stack', children: ['@trait.Body'] }]]));
    expect([...refs]).toEqual(['Body']);
  });

  it('control: a config with no trait reference embeds nothing', () => {
    expect([...collectTraitRefsFromResolvedTrait(trait({ title: { type: 'string', default: 'Shop' } }))]).toEqual([]);
  });
});
