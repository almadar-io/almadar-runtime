import { describe, it, expect } from 'vitest';
import type { OrbitalSchema, ResolvedTrait, Trait, TraitRef } from '@almadar/core';
import { collectTraitRefsFromResolvedTrait, collectEmbeddedTraits } from '../../src/ui/embedded-traits';

function trait(overrides: Partial<ResolvedTrait>): ResolvedTrait {
  return {
    name: 'PageTrait',
    source: 'inline',
    states: [],
    events: [],
    transitions: [],
    guards: [],
    ticks: [],
    listens: [],
    dataEntities: [],
    ...overrides,
  } as ResolvedTrait;
}

describe('@almadar/runtime/ui collectTraitRefsFromResolvedTrait', () => {
  it('collects @trait.X references from transition render-ui effects', () => {
    const t = trait({
      transitions: [
        {
          effects: [
            ['render-ui', 'main', { type: 'stack', children: ['@trait.InterviewWeek', { type: 'divider' }] }],
          ],
        },
      ],
    } as Partial<ResolvedTrait>);
    const refs = collectTraitRefsFromResolvedTrait(t);
    expect(refs.has('InterviewWeek')).toBe(true);
  });

  it('collects refs from tick effects too, and ignores non-@trait strings', () => {
    const t = trait({
      ticks: [{ effects: [['render-ui', 'main', { content: '@trait.SidebarMeta', label: 'plain text' }]] }],
    } as Partial<ResolvedTrait>);
    const refs = collectTraitRefsFromResolvedTrait(t);
    expect(refs.has('SidebarMeta')).toBe(true);
    expect(refs.has('plain text')).toBe(false);
  });

  it('returns an empty set for a trait with no embedded refs', () => {
    const t = trait({
      transitions: [{ effects: [['render-ui', 'main', { type: 'data-grid', entity: '@payload.data' }]] }],
    } as Partial<ResolvedTrait>);
    expect(collectTraitRefsFromResolvedTrait(t).size).toBe(0);
  });
});

// The std-snake shape (G-UI-012's subject): the composer trait's render-ui
// effect embeds `@trait.SnakeShell`, and the game-shell WRAPPER's call-site
// config defaults place `@trait.SnakeCanvas` / `@trait.SnakeHud`. The atom's
// OWN declared config (`_resolved.config`) carries only generic defaults —
// so a scanner that reads `_resolved.config` alone misses the canvas/hud and
// their render-ui writes land in the shared slot as extra panels.
function buildSnakeSchema(): OrbitalSchema {
  const snakePlay: Trait = {
    name: 'SnakePlay',
    scope: 'instance',
    linkedEntity: 'Snake',
    stateMachine: {
      states: [{ name: 'playing', isInitial: true }],
      events: [],
      transitions: [
        {
          from: 'playing',
          to: 'playing',
          event: 'INIT',
          effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.SnakeShell'] }]],
        },
      ],
    },
  };

  const shellResolved: Trait = {
    name: 'SnakeShell',
    scope: 'instance',
    linkedEntity: 'Snake',
    config: { appName: { type: 'string', default: 'App' } },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [],
      transitions: [],
    },
  };

  const snakeShellRef: TraitRef = {
    ref: 'std-game-shell',
    name: 'SnakeShell',
    config: {
      appName: { type: 'unknown', default: 'Snake' },
      children: { type: 'unknown', default: ['@trait.SnakeCanvas'] },
      hud: { type: 'unknown', default: '@trait.SnakeHud' },
    },
    _resolved: shellResolved,
  };

  return {
    name: 'SnakeApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'SnakeOrbital',
        entity: { name: 'Snake', persistence: 'runtime', fields: [] },
        traits: [snakePlay, snakeShellRef, 'SnakeCanvas', 'SnakeHud', 'SnakeMechanic'],
        pages: [],
      },
    ],
  };
}

describe('@almadar/runtime/ui collectEmbeddedTraits', () => {
  it('returns an empty set for an absent schema', () => {
    expect(collectEmbeddedTraits(undefined).size).toBe(0);
    expect(collectEmbeddedTraits(null).size).toBe(0);
  });

  it('collects the snake shape: the sibling effect ref AND the wrapper call-site config refs', () => {
    const embedded = collectEmbeddedTraits(buildSnakeSchema());
    // SnakePlay's render-ui effect tree references the shell.
    expect(embedded.has('SnakeShell')).toBe(true);
    // SnakeShell's CALL-SITE config defaults reference the canvas + hud —
    // `_resolved.config` alone (generic "App" default) carries neither.
    expect(embedded.has('SnakeCanvas')).toBe(true);
    expect(embedded.has('SnakeHud')).toBe(true);
    // The composer and unrelated traits are not embedded.
    expect(embedded.has('SnakePlay')).toBe(false);
    expect(embedded.has('SnakeMechanic')).toBe(false);
  });

  it('an inline trait with no refs contributes nothing, even beside referencing siblings', () => {
    const schema = buildSnakeSchema();
    const embedded = collectEmbeddedTraits(schema);
    expect(embedded.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Real organism — std-snake, resolved with the JS resolver (same pipeline the
// server runs; no CLI dependency). Pins the render contract the embedded
// routing depends on: after resolution, the @trait.X refs that make
// SnakeShell/SnakeCanvas/SnakeHud "embedded" must SURVIVE into the schema the
// client analyzes — if resolution folds call-site config away, the embedded
// set comes out empty/wrong, those traits render into `main` under their own
// scope (the triple-panel symptom), and keyMap emits from the canvas never
// bubble to SnakePlay's scope (dead WASD). See game-keyboard-routing.test.ts
// (ui) for the circuit half of that contract.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SNAKE_ORB = join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry/game/organisms/std-snake.orb');
const canRunSnake = existsSync(SNAKE_ORB);

describe.skipIf(!canRunSnake)('@almadar/runtime/ui collectEmbeddedTraits — real std-snake', () => {
  it('the embedded set contains exactly the trio SnakePlay composes (shell via effect, canvas+hud via wrapper config)', async () => {
    const { preprocessSchema } = await import('../../src/traits/UsesIntegration.js');
    const raw = JSON.parse(readFileSync(SNAKE_ORB, 'utf-8')) as OrbitalSchema;
    const result = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    if (!result.success) throw new Error(`preprocessSchema failed: ${result.errors.join('; ')}`);
    expect(result.success).toBe(true);

    const resolved = result.data.schema;
    const embedded = collectEmbeddedTraits(resolved);
    expect(embedded.has('SnakeShell')).toBe(true);
    expect(embedded.has('SnakeCanvas')).toBe(true);
    expect(embedded.has('SnakeHud')).toBe(true);
    expect(embedded.has('SnakePlay')).toBe(false);
    expect(embedded.has('SnakeMechanic')).toBe(false);
    expect(embedded.has('SnakeFx')).toBe(false);
  });
});
