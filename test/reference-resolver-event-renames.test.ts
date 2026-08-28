import { describe, it, expect } from 'vitest';
import { ReferenceResolver } from '../src/resolver/reference-resolver.js';
import type { OrbitalDefinition, Trait } from '@almadar/core';

// R-CLIENT-RENAMED-CASCADE-DEAD: the call-site `events: { OLD: NEW }`
// rename map rewrote transition triggers / render-ui props / events list /
// emits list, but NOT `(emit OLD …)` SExpr heads, tick effects, fetch/
// persist `emit:` option maps, or listen triggers — so a composed atom's
// machine-originated emits fired the pre-rename name while every listener
// subscribed the renamed key, and renamed cascades never delivered on the
// runtime path. The compiled path rewrites all of these at compose time
// (orbital-compiler inline/rewrite.rs); the runtime must produce the same
// fully-renamed trait at registration time.

function atomTrait(): Trait {
  return {
    name: 'PlatformerBody',
    scope: 'instance',
    stateMachine: {
      states: [
        { name: 'idle', isInitial: true },
        { name: 'moving' },
      ],
      events: [
        { key: 'BODY_MOVED', name: 'Body moved' },
        { key: 'BODY_SAVED', name: 'Body saved' },
      ],
      transitions: [
        {
          from: 'idle',
          to: 'moving',
          event: 'BODY_MOVED',
          effects: [
            ['emit', 'BODY_MOVED', { x: 1 }],
            ['persist', 'create', 'Row', { id: '1' }, { emit: { success: 'BODY_SAVED' } }],
            ['fetch', 'Row', { emit: 'BODY_SAVED' }],
            ['render-ui', 'main', { type: 'button', action: 'BODY_MOVED', label: 'Go' }],
            ['do', ['emit', 'BODY_MOVED'], ['emit', 'UNCHANGED']],
          ],
        },
      ],
    },
    ticks: [
      {
        name: 'physicsTick',
        interval: '33ms',
        effects: [['emit', 'BODY_MOVED', { x: 0 }]],
      },
    ],
    emits: [{ event: 'BODY_MOVED' }, { event: 'BODY_SAVED' }, { event: 'UNCHANGED' }],
    listens: [
      // Sourced: `event` names the SOURCE trait's vocabulary — untouched;
      // `triggers` names THIS trait's own transition event — renamed.
      { event: 'RESTART', triggers: 'BODY_RESET', source: { kind: 'trait', trait: 'Play' } },
      // Unsourced: follows this trait's own renames.
      { event: 'BODY_MOVED', triggers: 'BODY_MOVED' },
    ],
  } as unknown as Trait;
}

const RENAMES = {
  BODY_MOVED: 'OW_MOVED',
  BODY_SAVED: 'OW_SAVED',
  BODY_RESET: 'OW_RESET',
};

async function resolveRenamed(): Promise<Trait> {
  const atom = atomTrait();
  const resolver = new ReferenceResolver({
    basePath: '.',
    skipExternalLoading: true,
    localTraits: new Map<string, Trait>([['PlatformerBody', atom]]),
  });
  const orbital: OrbitalDefinition = {
    name: 'App',
    entity: {
      name: 'Row',
      persistence: 'runtime',
      fields: [{ name: 'id', type: 'string', required: true }],
    },
    traits: [{ ref: 'PlatformerBody', name: 'OwBody', events: RENAMES }],
    pages: [],
  } as unknown as OrbitalDefinition;
  const result = await resolver.resolve(orbital);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.errors.join(', '));
  return result.data.traits[0].trait;
}

describe('applyEventRenames — full rename coverage (compiled-path parity)', () => {
  it('rewrites (emit OLD …) heads in transition effects', async () => {
    const t = await resolveRenamed();
    const effects = t.stateMachine!.transitions[0].effects as unknown[][];
    expect(effects[0]).toEqual(['emit', 'OW_MOVED', { x: 1 }]);
    // nested inside a (do …) wrapper
    expect(effects[4]).toEqual(['do', ['emit', 'OW_MOVED'], ['emit', 'UNCHANGED']]);
  });

  it('rewrites transition triggers, events list, and emits list', async () => {
    const t = await resolveRenamed();
    expect(t.stateMachine!.transitions[0].event).toBe('OW_MOVED');
    expect(t.stateMachine!.events!.map((e) => e.key)).toEqual(['OW_MOVED', 'OW_SAVED']);
    expect((t.emits as { event: string }[]).map((e) => e.event)).toEqual([
      'OW_MOVED',
      'OW_SAVED',
      'UNCHANGED',
    ]);
  });

  it('rewrites fetch/persist emit: option maps (object and string forms)', async () => {
    const t = await resolveRenamed();
    const effects = t.stateMachine!.transitions[0].effects as unknown as [
      unknown,
      [string, string, string, unknown, { emit: { success: string } }],
      [string, string, { emit: string }],
    ];
    expect(effects[1][4].emit.success).toBe('OW_SAVED');
    expect(effects[2][2].emit).toBe('OW_SAVED');
  });

  it('rewrites render-ui event-name props', async () => {
    const t = await resolveRenamed();
    const effects = t.stateMachine!.transitions[0].effects as unknown as [
      unknown, unknown, unknown,
      [string, string, { action: string }],
    ];
    expect(effects[3][2].action).toBe('OW_MOVED');
  });

  it('rewrites (emit OLD …) heads in tick effects', async () => {
    const t = await resolveRenamed();
    expect(t.ticks![0].effects).toEqual([['emit', 'OW_MOVED', { x: 0 }]]);
  });

  it('renames listen triggers; renames unsourced listen events only', async () => {
    const t = await resolveRenamed();
    const [sourced, unsourced] = t.listens!;
    expect(sourced.event).toBe('RESTART'); // source-trait vocabulary
    expect(sourced.triggers).toBe('OW_RESET');
    expect(unsourced.event).toBe('OW_MOVED');
    expect(unsourced.triggers).toBe('OW_MOVED');
  });

  it('leaves the trait untouched when the rename map is empty', async () => {
    const atom = atomTrait();
    const resolver = new ReferenceResolver({
      basePath: '.',
      skipExternalLoading: true,
      localTraits: new Map<string, Trait>([['PlatformerBody', atom]]),
    });
    const orbital: OrbitalDefinition = {
      name: 'App',
      entity: {
        name: 'Row',
        persistence: 'runtime',
        fields: [{ name: 'id', type: 'string', required: true }],
      },
      traits: [{ ref: 'PlatformerBody' }],
      pages: [],
    } as unknown as OrbitalDefinition;
    const result = await resolver.resolve(orbital);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const t = result.data.traits[0].trait;
    expect(t.stateMachine!.transitions[0].event).toBe('BODY_MOVED');
    expect((t.stateMachine!.transitions[0].effects as unknown[][])[0]).toEqual([
      'emit',
      'BODY_MOVED',
      { x: 1 },
    ]);
    expect(t.ticks![0].effects).toEqual([['emit', 'BODY_MOVED', { x: 0 }]]);
  });
});
