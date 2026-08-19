/**
 * `@currentTheme` app-level seeding — the runtime twin of the compiler's
 * `resolve_theme_key` precedence chain: orbital `theme` > schema-level
 * `theme` (the `.lolo` app-header `theme "<key>"` line) > DEFAULT_THEME_KEY.
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import type { OrbitalSchema } from '@almadar/core';

function themedSchema(appTheme?: string, orbitalTheme?: string): OrbitalSchema {
  return {
    name: 'theme-seed-app',
    version: '1.0.0',
    ...(appTheme !== undefined ? { theme: appTheme } : {}),
    orbitals: [
      {
        name: 'Chrome',
        pages: [],
        ...(orbitalTheme !== undefined ? { theme: orbitalTheme } : {}),
        entity: { name: 'Chrome', fields: [{ name: 'status', type: 'string' }] },
        traits: [
          {
            name: 'shell',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [{ key: 'PAINT', name: 'PAINT' }],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'PAINT',
                  effects: [
                    ['render-ui', 'main', { type: 'box', 'data-theme': '@currentTheme' }],
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function paintedTheme(schema: OrbitalSchema): Promise<string | undefined> {
  const runtime = new OrbitalServerRuntime({ debug: false });
  await runtime.register(schema);
  const result = await runtime.processOrbitalEvent('Chrome', { event: 'PAINT' });
  const render = result.clientEffects?.find(
    (e): e is [string, string, Record<string, unknown>] =>
      Array.isArray(e) && e[0] === 'render-ui',
  );
  return render?.[2]?.['data-theme'] as string | undefined;
}

describe('@currentTheme precedence: orbital > app > default', () => {
  it('seeds from the app-level schema theme when the orbital declares none', async () => {
    expect(await paintedTheme(themedSchema('clay-light'))).toBe('clay-light');
  });

  it('lets the orbital theme beat the app theme', async () => {
    expect(await paintedTheme(themedSchema('clay-light', 'terminal-dark'))).toBe('terminal-dark');
  });

  it('falls back to the baseline default when nothing declares a theme', async () => {
    expect(await paintedTheme(themedSchema())).toBe('minimalist-light');
  });
});
