/**
 * G-CROSS-046 follow-up, the JS twin of orbital-compiler's
 * `composed_trait_own_event_address.rs`: an `event` knob addressing the atom's
 * OWN trait (`PageWatch.ITEM_FOUND`) follows a composed-trait rename
 * (`FeedWatch`) into the value an effect reads through `@config.itemEvent`.
 * The fixture is `orb emit` output of a minimal `.lolo` atom.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrbitalSchema, Trait } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { buildTraitIndex } from '../src/index.js';
import { STD_ROOT } from './helpers/behavior-packages.js';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/own-event-address/page-watch.orb'), 'utf-8');
const atom = (address: string): string => FIXTURE.replace('"PageWatch.ITEM_FOUND"', JSON.stringify(address));
const consumer = (events: string): string => `{
  "name": "consumer",
  "version": "1.0.0",
  "orbitals": [{
    "name": "FeedOrbital",
    "uses": [ { "from": "./page-watch.orb", "as": "Watch" } ],
    "entity": {
      "name": "Feed", "persistence": "runtime",
      "fields": [ { "name": "id", "type": "string", "required": true } ]
    },
    "traits": [ { "ref": "Watch.traits.PageWatch", "name": "FeedWatch"${events} } ],
    "pages": [ { "name": "Home", "path": "/", "traits": [ { "ref": "FeedWatch" } ] } ]
  }]
}`;

async function feedWatch(address: string, events = ''): Promise<Trait> {
  const dir = mkdtempSync(join(tmpdir(), 'own-event-address-'));
  writeFileSync(join(dir, 'page-watch.orb'), atom(address));
  const raw = JSON.parse(consumer(events)) as OrbitalSchema;
  const resolved = await preprocessSchema(raw, { basePath: dir, stdLibPath: STD_ROOT, allowOutsideBasePath: true });
  if (!resolved.success) throw new Error(resolved.errors.join('; '));
  const trait = buildTraitIndex(resolved.data.schema.orbitals).byName.get('FeedWatch')?.irTrait;
  if (trait === undefined) throw new Error('FeedWatch is not resolved');
  return trait;
}

function effectEvent(trait: Trait): unknown {
  const init = trait.stateMachine?.transitions.find((t) => t.event === 'INIT');
  const effect = init?.effects?.[0];
  if (!Array.isArray(effect)) throw new Error('INIT effect is not a list');
  const args = effect[3];
  const value = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>).event : undefined;
  // The runtime keeps `@config.<knob>` live in the effect and reads the knob when it runs.
  return typeof value === 'string' && value.startsWith('@config.') ? trait.config?.[value.slice('@config.'.length)]?.default : value;
}

function configEvent(trait: Trait): unknown {
  return trait.config?.itemEvent?.default;
}

describe('own-trait event address follows a composed-trait rename', () => {
  it('reaches the effect copy', async () => {
    expect(effectEvent(await feedWatch('PageWatch.ITEM_FOUND'))).toBe('FeedWatch.ITEM_FOUND');
  });

  it('control: the config default follows the rename too', async () => {
    expect(configEvent(await feedWatch('PageWatch.ITEM_FOUND'))).toBe('FeedWatch.ITEM_FOUND');
  });

  it('control: an address naming another trait is left alone', async () => {
    expect(effectEvent(await feedWatch('OtherTrait.ITEM_FOUND'))).toBe('OtherTrait.ITEM_FOUND');
  });

  it('edge: an events rename of the addressed event carries into the effect', async () => {
    expect(effectEvent(await feedWatch('PageWatch.ITEM_FOUND', ', "events": { "ITEM_FOUND": "VIDEO_FOUND" }'))).toBe('FeedWatch.VIDEO_FOUND');
  });
});
