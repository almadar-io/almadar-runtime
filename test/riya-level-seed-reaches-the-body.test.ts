/**
 * Riya levels (owner report 2026-09-24: riya falls through the ground, arrows
 * do nothing): `SineLevelData`'s INIT emits the RIYA_LEVEL_DATA seed; the play
 * trait routes it on as SINE_SET_PLATFORMS / SINE_SET_SKATE_CURVE into the
 * body, whose collision surfaces come ONLY from that seed. The observable
 * consequence is the body holding its skate curve after boot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { OrbitalServerRuntime } from '../src/server/OrbitalServerRuntime.js';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

async function sine(): Promise<OrbitalSchema> {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/riya/atoms/riya-level-sine.orb'), 'utf-8')) as OrbitalSchema;
  const res = await preprocessSchema(raw, {
    basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
    stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
    allowOutsideBasePath: true,
  });
  if (!res.success) throw new Error(res.errors.join('; '));
  return res.data.schema;
}

const PAGE = ['SineLevelData', 'SineBody', 'SineGate', 'SineFx', 'SinePickup', 'SineChoice', 'SineTutorial', 'RiyaSineGenre', 'RiyaSinePlay', 'SineChallenge', 'RiyaSineClear'];

/** Each mount INIT leg as the client posts it: after running that INIT
 *  locally, with the page's mounted set and the traits still awaiting INIT. */
async function boot(runtime: OrbitalServerRuntime, order: string[]) {
  let last;
  for (let i = 0; i < order.length; i += 1) {
    last = await runtime.processOrbitalEvent('RiyaSineOrbital', {
      event: 'INIT',
      targetTrait: order[i],
      payload: { _activeTraits: PAGE, _awaitingInit: order.slice(i + 1) },
    });
  }
  return last;
}

describe('riya-level-sine boot seed on the stateful host', () => {
  it('SineBody holds its skate curve once the page has booted', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false, persistence: new InMemoryPersistence() });
    await runtime.register(await sine());
    await boot(runtime, ['SineLevelData', 'SineBody', 'RiyaSinePlay']);
    const body = await runtime.processOrbitalEvent('RiyaSineOrbital', { event: 'SINE_STOP', targetTrait: 'RiyaSinePlay', payload: { _activeTraits: PAGE, _awaitingInit: [] } });
    const curve = body.entityByTrait?.['SineBody']?.['skateCurve'];
    expect(Array.isArray(curve) ? curve.length : 0).toBeGreaterThan(0);
  });

  it('a trait whose INIT never reaches the server is released once the client reports it initialized', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false, persistence: new InMemoryPersistence() });
    await runtime.register(await sine());
    await boot(runtime, ['SineLevelData', 'SineBody']);
    // RiyaSinePlay's INIT stayed client-side; its next request says nothing awaits.
    const next = await runtime.processOrbitalEvent('RiyaSineOrbital', { event: 'SINE_STOP', targetTrait: 'RiyaSinePlay', payload: { _activeTraits: PAGE, _awaitingInit: [] } });
    const curve = next.entityByTrait?.['SineBody']?.['skateCurve'];
    expect(Array.isArray(curve) ? curve.length : 0).toBeGreaterThan(0);
  });
});
