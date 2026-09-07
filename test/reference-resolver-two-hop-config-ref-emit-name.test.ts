/**
 * Synthetic two-hop `@config.<knob>` emit-name override (C1-J4, item A).
 *
 * `X = Y.traits.Z { config: { <knob>: <value> } }` declared INSIDE an atom's
 * own registry (`std-approval-gate`'s `CloseButton = Button.traits.
 * ButtonRender { config: { action: CLOSE } }`) is itself a `ref`-shaped
 * `TraitRef` entry. When a THIRD orbital references that entry
 * (`Wrapper.traits.CloseButton` below — the sibling-pull path in the real
 * organism reaches the exact same code, see
 * `reference-resolver-config-ref-emit-name-two-hop-parity.test.ts`),
 * `resolveTraitRefString` recurses through `resolveTraitEntry` TWICE: once
 * to find `CloseButton` itself (a ref, folds `config: {action: CLOSE}` and
 * recurses again), and once MORE inside that recursion to find the base
 * `ButtonRender` trait `CloseButton`'s `ref` points at. That second lookup
 * used to call `resolveConfigRefEmitNames` with NO call-site config —
 * resolving `ButtonRender`'s `emits { @config.action }` against its OWN
 * bare declared default (`"ACTION"` here) before `CloseButton`'s
 * `action: CLOSE` override ever reached it. Because the substitution
 * rewrites the `@config.<knob>` marker to a concrete literal in place, the
 * marker was gone by the time the OUTER call (which DOES carry the real
 * override) ran the same resolution again — a silent no-op, and the wrong
 * name stuck.
 */
import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition } from '@almadar/core';

/** The base atom: one trait whose emit name is DEFINED by a config knob
 * (`emits { @config.action }`, mirroring `ui-button.orb`'s `ButtonRender` —
 * bare declared default `"ACTION"`, no override at this level). */
function buttonOrbital(): Orbital {
  return {
    name: 'ButtonOrbital',
    entity: { name: 'Widget', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'ButtonRender',
        scope: 'instance',
        linkedEntity: 'Widget',
        config: {
          action: { type: 'event', default: 'ACTION', label: 'Action' },
        },
        emits: [{ event: '@config.action', definerKnob: 'action', scope: 'external' }],
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [
            { key: 'INIT', name: 'Initialize' },
            { key: '@config.action', name: 'Action' },
          ],
          transitions: [
            { from: 'idle', to: 'idle', event: 'INIT', effects: [] },
            { from: 'idle', to: 'idle', event: '@config.action', effects: [] },
          ],
        },
      },
    ],
    pages: [],
  };
}

/** The middle atom: declares `CloseButton = Button.traits.ButtonRender
 * { config: { action: CLOSE } }` — a `ref`-shaped top-level entry, exactly
 * `std-approval-gate.lolo`'s own `CloseButton` declaration. */
function wrapperOrbital(): Orbital {
  return {
    name: 'WrapperOrbital',
    uses: [{ from: './button.orb', as: 'Button' }],
    entity: { name: 'Widget', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{ ref: 'Button.traits.ButtonRender', name: 'CloseButton', config: { action: 'CLOSE' } }],
    pages: [],
  };
}

function consumerOrbital(): OrbitalDefinition {
  return {
    name: 'ConsumerOrbital',
    uses: [{ from: './wrapper.orb', as: 'Wrapper' }],
    entity: { name: 'Order', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [{ ref: 'Wrapper.traits.CloseButton', name: 'MyCloseButton' }],
    pages: [],
  };
}

function makeLoader(): SchemaLoader {
  const button = buttonOrbital();
  const wrapper = wrapperOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './button.orb') {
        return { success: true, data: { orbital: button, sourcePath: './button.orb', importPath } };
      }
      if (importPath === './wrapper.orb') {
        return { success: true, data: { orbital: wrapper, sourcePath: './wrapper.orb', importPath } };
      }
      return { success: false, error: `unexpected import path: ${importPath}` };
    },
    resolvePath(p: string) {
      return { success: true, data: p };
    },
    clearCache() {
      /* no-op */
    },
    getCacheStats() {
      return { size: 0 };
    },
  };
}

describe('ReferenceResolver — two-hop @config.<knob> emit-name override (C1-J4, item A)', () => {
  it('a THIRD orbital referencing a ref-shaped entry sees the MIDDLE hop\'s config override, not the base atom\'s bare default', async () => {
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const result = await resolver.resolve(consumerOrbital());
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = result.data.traits.find((rt) => rt.trait.name === 'MyCloseButton');
    expect(resolved).toBeDefined();
    expect(resolved!.trait.emits?.map((e) => e.event)).toEqual(['CLOSE']);
    expect(resolved!.trait.stateMachine?.events.map((e) => e.key)).toEqual(['INIT', 'CLOSE']);
    // The declared knob's own default lands the override too (GAP-AG-VALUE-DRIFT fold).
    expect(resolved!.trait.config?.action?.default).toBe('CLOSE');
  });

  it('resolving the MIDDLE hop directly (Wrapper.traits.CloseButton with no further override) still sees "CLOSE"', async () => {
    // Same bug, one hop shallower: `resolveTraitEntry`'s nested lookup for
    // `ButtonRender` (inside resolving `CloseButton` itself) is exactly the
    // buggy call site, with no third orbital needed.
    const resolver = new ReferenceResolver({ basePath: '.', loader: makeLoader() });
    const orbital: OrbitalDefinition = {
      name: 'DirectConsumerOrbital',
      uses: [{ from: './wrapper.orb', as: 'Wrapper' }],
      entity: { name: 'Order', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
      traits: [{ ref: 'Wrapper.traits.CloseButton' }],
      pages: [],
    };
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const resolved = result.data.traits.find((rt) => rt.trait.name === 'CloseButton');
    expect(resolved).toBeDefined();
    expect(resolved!.trait.emits?.map((e) => e.event)).toEqual(['CLOSE']);
    expect(resolved!.trait.stateMachine?.events.map((e) => e.key)).toEqual(['INIT', 'CLOSE']);
  });
});
