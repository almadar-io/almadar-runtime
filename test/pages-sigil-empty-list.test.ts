/**
 * `@pages` is the app-wide list of labelled root pages (Almadar_LOLO.md "Nav entries"): an app with no
 * labelled page has the EMPTY list, not an unbound sigil, so `(array/len @pages)` and a `[NavItem] = @pages`
 * knob read through `array/filter` work in a standalone atom.
 */
import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '@almadar/db/mock';

function schema(label?: string): OrbitalSchema {
  return {
    name: 'pages-sigil',
    version: '1.0.0',
    orbitals: [{
      name: 'NavOrbital',
      pages: [{ name: 'Home', path: '/', traits: [{ ref: 'Nav' }], ...(label !== undefined ? { label } : {}) }],
      entity: { name: 'Shell', persistence: 'runtime', fields: [{ name: 'id', type: 'string', primaryKey: true }] },
      traits: [{
        name: 'Nav',
        scope: 'instance',
        linkedEntity: 'Shell',
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'INIT' }],
          transitions: [{
            from: 'idle', to: 'idle', event: 'INIT',
            effects: [['render-ui', 'main', { type: 'typography', content: ['str/concat', 'entries:', ['array/len', ['array/filter', '@pages', ['fn', 'item', true]]]] }]],
          }],
        },
      }],
    }],
  };
}

async function entries(s: OrbitalSchema): Promise<{ ok: boolean; error?: string; content?: unknown }> {
  const runtime = new OrbitalServerRuntime({ persistence: new InMemoryPersistence(), debug: false, mode: 'mock' });
  await runtime.register(s);
  const res = await runtime.processOrbitalEvent('NavOrbital', { event: 'INIT', targetTrait: 'Nav' });
  runtime.unregisterAll();
  const painted = res.clientEffects?.find((e) => e[0] === 'render-ui');
  return { ok: res.success, ...(res.error !== undefined ? { error: res.error } : {}), content: painted?.[2] };
}

describe('@pages with no labelled page', () => {
  it('is the empty list', async () => {
    const out = await entries(schema());
    expect(out.error).toBeUndefined();
    expect(JSON.stringify(out.content)).toContain('entries:0');
  });

  it('control: a labelled root page is one entry', async () => {
    const out = await entries(schema('Home'));
    expect(out.error).toBeUndefined();
    expect(JSON.stringify(out.content)).toContain('entries:1');
  });
});
