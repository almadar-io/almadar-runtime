/**
 * Game keyboard (owner report: std-pong W/S, std-snake arrows do nothing):
 * the play trait turns a key into an intent (`PADDLE_MOVE`, `TURN`, `RESTART`)
 * and emits it, but the organism declared no `listens` route to the mechanic
 * that has the arm — a source-less `listens { PADDLE_MOVE { … } }` in the atom
 * only declares the payload it accepts. The intent reached the mechanic only
 * through the browser's old by-name bus delivery; on the declared-route
 * contract (the compiled shell, the kernel fan-out) it terminates in nothing.
 * Every event a trait emits that ANOTHER trait of the same app has an arm for
 * must reach that trait through a declared route.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrbitalSchema } from '@almadar/core';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { buildTraitIndex, collectListenerTargets, LIFECYCLE_EVENTS } from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const DIRS = [
  join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/game/organisms'),
  join(REPO_ROOT, 'packages/almadar-std/behaviors/registry/ui/game/organisms'),
  join(REPO_ROOT, 'packages/almadar-std/behaviors/registry/ui/game/atoms'),
];
const ORBS = DIRS.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.orb')).sort().map((f) => join(d, f)));

type Transition = { event: string; effects?: unknown[] };
type Tick = { effects?: unknown[] };

/** Every event a trait fires from its own logic: `(emit …)` effects (nested
 *  too), operator emit-config results, and tick effects — the same set
 *  orb validate's ORB_EMIT_UNROUTED_TO_HANDLER walks. */
function firedEvents(def: { transitions: Transition[]; ticks?: Tick[] }): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (node[0] === 'emit' && typeof node[1] === 'string') out.add(node[1]);
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      const emit = (node as Record<string, unknown>)['emit'];
      if (typeof emit === 'string') out.add(emit);
      else if (emit !== null && typeof emit === 'object') {
        for (const v of Object.values(emit as Record<string, unknown>)) if (typeof v === 'string') out.add(v);
      }
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  for (const t of def.transitions) walk(t.effects ?? []);
  for (const t of def.ticks ?? []) walk(t.effects ?? []);
  return out;
}

describe.each(ORBS)('%s', (file) => {
  it('every intent a trait emits reaches the traits that handle it', async () => {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as OrbitalSchema;
    const resolved = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    if (!resolved.success) throw new Error(resolved.errors.join('; '));
    const index = buildTraitIndex(resolved.data.schema.orbitals);
    const unrouted: string[] = [];
    const handles = (name: string, event: string): boolean =>
      (index.byName.get(name)?.traitDef.transitions as Transition[] | undefined ?? []).some((t) => t.event === event);
    const fired = new Map([...index.byName].map(([name, e]) => [name, firedEvents({
      transitions: e.traitDef.transitions as Transition[],
      ticks: (e.traitDef as { ticks?: Tick[] }).ticks,
    })]));
    for (const [emitter, entry] of index.byName) {
      for (const event of fired.get(emitter) ?? []) {
        if ((LIFECYCLE_EVENTS as readonly string[]).includes(event)) continue;
        const routed = new Set(
          collectListenerTargets(index, { orbital: entry.orbitalName, trait: emitter, ...(entry.orbitalId !== undefined ? { orbitalId: entry.orbitalId } : {}), ...(entry.irTrait.id !== undefined ? { traitId: entry.irTrait.id } : {}) }, event, {}).map((t) => t.listenerTrait),
        );
        for (const [handler, other] of index.byName) {
          if (handler === emitter || other.orbitalName !== entry.orbitalName || !handles(handler, event)) continue;
          // Two instances of one atom that each fire AND handle it themselves.
          if (handles(emitter, event) && (fired.get(handler)?.has(event) ?? false)) continue;
          if (!routed.has(handler)) unrouted.push(`${emitter} emits ${event} -> ${handler} has the arm, no route`);
        }
      }
    }
    expect(unrouted, unrouted.join("\n")).toEqual([]);
  }, 120_000);
});
