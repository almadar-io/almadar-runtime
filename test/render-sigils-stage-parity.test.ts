/**
 * `@pages` / `@currentTheme` resolve the same on the index stage runner (the stateless and
 * client legs) as on the server stage — the app's root pages across every orbital, and the
 * orbital's theme. The index runner seeded `@pages` empty and the theme as 'default', so a
 * standalone std-app-layout filtered `@config.navItems` (`= @pages`) on null.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, OrbitalSchema, RuntimeValue } from '@almadar/core';
import { DEFAULT_VIEWER } from '@almadar/core';
import { MockPersistenceAdapter } from '../src/entities/MockPersistenceAdapter.js';
import { OrbitalServerRuntime, type ClientRenderUITuple } from '../src/server/OrbitalServerRuntime.js';
import { buildTraitIndex, createClientKernel, createIndexStageRunner, createInProcessTransport, createMemoryCircuitStore, evaluateOrbitalEvent, StateMachineManager } from '../src/index.js';

const schema: OrbitalSchema = {
  name: 'SigilApp',
  schemaVersion: 4,
  orbitals: [
    {
      name: 'ShellOrbital',
      theme: 'ocean',
      entity: { name: 'Shell', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [{
        name: 'Layout', scope: 'instance', linkedEntity: 'Shell',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }], events: [],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'stack', items: '@pages', theme: '@currentTheme' }]] }],
        },
      }],
      pages: [{ name: 'HomePage', path: '/', traits: [{ ref: 'Layout' }] }, { name: 'DetailPage', path: '/items/:id', traits: [{ ref: 'Layout' }] }],
    },
    {
      name: 'ItemsOrbital',
      entity: { name: 'Item', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [],
      pages: [{ name: 'ItemsPage', path: '/items', label: 'Items', traits: [] }],
    },
  ],
};

const renderOf = (effects: Array<{ traitName: string; effect: RuntimeValue[] }> | undefined): Record<string, RuntimeValue> | undefined => {
  const entry = effects?.find((e) => e.traitName === 'Layout');
  return entry ? ((entry.effect as ClientRenderUITuple)[2] as Record<string, RuntimeValue>) : undefined;
};

describe('render sigils: index stage runner matches the server stage', () => {
  it('@pages is every orbital\'s root pages; @currentTheme the orbital\'s theme — on both legs', async () => {
    const persistence = new MockPersistenceAdapter({ ownerId: DEFAULT_VIEWER.id });
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false, persistence });
    await runtime.register(schema);
    const server = renderOf((await runtime.processOrbitalEvent('ShellOrbital', { event: 'INIT', targetTrait: 'Layout' })).clientEffectsByTrait);

    const traitIndex = buildTraitIndex(schema.orbitals);
    const manager = new StateMachineManager([...traitIndex.byName.values()].map((e) => e.traitDef));
    const frames = new Map<string, EntityRow>();
    const indexed = renderOf((await evaluateOrbitalEvent(
      { traitIndex, manager, persistence, frames, runEffects: createIndexStageRunner({ traitIndex, persistence, frames, manager, schema }) },
      { event: 'INIT', targetTrait: 'Layout' },
    )).clientEffectsByTrait);

    const store = createMemoryCircuitStore([...traitIndex.byName.values()].map((e) => e.traitDef));
    const kernel = createClientKernel({
      orbitalName: 'ShellOrbital', traitIndex, fullTraitIndex: traitIndex, store, carriesCircuitState: false,
      transport: createInProcessTransport((o, request) => runtime.processOrbitalEvent(o, request)),
    });
    let local: Record<string, RuntimeValue> | undefined;
    await kernel.dispatch({ event: 'INIT', targetTrait: 'Layout' }, { onLocal: (r) => { local = renderOf(r.clientEffectsByTrait) ?? local; } });

    expect(server?.items).toEqual([{ href: '/', label: 'HomePage' }, { href: '/items', label: 'Items' }]);
    expect(indexed?.items).toEqual(server?.items);
    expect(indexed?.theme).toEqual(server?.theme);
    expect(local?.items).toEqual(server?.items);
    expect(local?.theme).toEqual(server?.theme);
  });
});
