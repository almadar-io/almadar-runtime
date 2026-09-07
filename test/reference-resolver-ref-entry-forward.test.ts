/**
 * `{ref}`-entry call-site config forward through the embedder chain
 * (ledger (n)-JS, ref-entry half; `pullSiblingTraits`'s local `embedderChain`
 * over ALREADY-PULLED siblings is the other half).
 *
 * A composed atom's TOP-LEVEL `orbital.traits` list can carry a `{ref}`
 * entry whose call-site `config` override is itself a whole-string
 * `@config.<k>` forward — `std-timeline.orb`'s `InlineTypographyRender4`
 * (`UiTypo.traits.TypographyRender { config: { content: @config.title } }`)
 * three `{ref}` `Stack` wrappers below the atom (`TimelineFeed`) that
 * actually declares `title`, none of which publish a `title` knob
 * themselves. Left unresolved, `preprocessSchema`'s output keeps the raw
 * string `"@config.title"` as the trait's effective `content`, and the
 * render substrate paints the literal token instead of the heading.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { SchemaLoader, LoadResult, LoadedSchema } from '../src/loader/schema-loader.js';
import type { Orbital, OrbitalDefinition, OrbitalSchema, TraitRef } from '@almadar/core';
import { normalizeCallSiteConfigToValues, isCallSiteConfigDeclaration } from '@almadar/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_DIR = path.join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry');
const hasCorpus = existsSync(REGISTRY_DIR);

/** The upstream `Typo` behavior — one inline trait declaring `content` with
 *  no default of its own, matching `UiTypo.traits.TypographyRender`'s role
 *  as the leaf atom a `{ref}` entry's call-site config overrides. */
function typoOrbital(): Orbital {
  return {
    name: 'TypoOrbital',
    entity: { name: 'TypoItem', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'TypographyRender',
        scope: 'instance',
        config: { content: { type: 'string' }, variant: { type: 'string', default: 'body' } },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

/** The upstream `Stack` behavior — one inline trait declaring `children`,
 *  matching `UiStack.traits.StackRender`'s role as the wrapper `{ref}`
 *  entries in between publish no `title` knob of their own. */
function stackOrbital(): Orbital {
  return {
    name: 'StackOrbital',
    entity: { name: 'StackItem', persistence: 'runtime', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'StackRender',
        scope: 'instance',
        config: { children: { type: '[unknown]' } },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
    ],
    pages: [],
  };
}

function makeTimelineLoader(): SchemaLoader {
  const typo = typoOrbital();
  const stack = stackOrbital();
  return {
    async load(): Promise<LoadResult<LoadedSchema>> {
      return { success: false, error: 'not used' };
    },
    async loadOrbital(importPath: string) {
      if (importPath === './typo.orb') {
        return { success: true, data: { orbital: typo, sourcePath: './typo.orb', importPath } };
      }
      if (importPath === './stack.orb') {
        return { success: true, data: { orbital: stack, sourcePath: './stack.orb', importPath } };
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

/**
 * `TimelineFeed` (the atom, declares `title`) embeds `InlineStackRender8`
 * via its OWN config default's `@trait.X` token (`bodyContent`, mirroring
 * `std-browse`'s `contentTrait`-style composition slot); `InlineStackRender8`
 * embeds `InlineStackRender5` via ITS call-site `children` override;
 * `InlineStackRender5` embeds `InlineTypographyRender4` the same way — three
 * `{ref}` hops, none declaring `title`, before `InlineTypographyRender4`'s
 * own call-site `content: @config.title` override. A sibling orphan entry
 * (`InlineTypographyRenderOrphan`, embedded by nobody) forwards a knob no
 * rung ever declares, proving an unresolvable forward keeps its literal.
 */
function timelineSchema(): OrbitalSchema {
  const orbital: OrbitalDefinition = {
    name: 'TimelineOrbital',
    uses: [
      { from: './typo.orb', as: 'Typo' },
      { from: './stack.orb', as: 'Stack' },
    ],
    entity: { name: 'TimelineEntry', persistence: 'persistent', fields: [{ name: 'id', type: 'string', required: true }] },
    traits: [
      {
        name: 'TimelineFeed',
        scope: 'instance',
        config: {
          title: { type: 'string', default: 'Activity Timeline' },
          bodyContent: { type: 'unknown', default: '@trait.InlineStackRender8' },
        },
        stateMachine: {
          states: [{ name: 'idle', isInitial: true }],
          events: [{ key: 'INIT', name: 'Init' }],
          transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [] }],
        },
      },
      {
        ref: 'Stack.traits.StackRender',
        name: 'InlineStackRender8',
        config: { children: { type: 'unknown', default: ['@trait.InlineStackRender5'] } },
      },
      {
        ref: 'Stack.traits.StackRender',
        name: 'InlineStackRender5',
        config: { children: { type: 'unknown', default: ['@trait.InlineTypographyRender4'] } },
      },
      {
        ref: 'Typo.traits.TypographyRender',
        name: 'InlineTypographyRender4',
        config: { content: { type: 'unknown', default: '@config.title' } },
      },
      {
        ref: 'Typo.traits.TypographyRender',
        name: 'InlineTypographyRenderOrphan',
        config: { content: { type: 'unknown', default: '@config.nonExistentKnob' } },
      },
    ],
    pages: [],
  };
  return { name: 'TimelineApp', orbitals: [orbital] };
}

/**
 * Find a resolved `preprocessSchema` output entry by its LOCAL name.
 * `preprocessSchema` (`UsesIntegration.ts`) packages an entry with a
 * call-site override as `{ ref: <name>, config, _resolved }` (no top-level
 * `name`) and an entry without one as the plain inline `Trait` (`.name`
 * directly) — check both shapes.
 */
function findTraitRefByName(traits: readonly TraitRef[], name: string): Exclude<TraitRef, string> | undefined {
  for (const t of traits) {
    if (typeof t === 'string') continue;
    if ('stateMachine' in t) {
      if (t.name === name) return t;
      continue;
    }
    const refObj = t as { ref: string; name?: string };
    if (refObj.ref === name) return t;
  }
  return undefined;
}

describe('ReferenceResolver — {ref}-entry call-site config forward through the embedder chain (ledger (n)-JS)', () => {
  it('resolves a three-deep hoisted `@config.<k>` call-site forward to the declaring atom\'s literal via pure preprocessSchema', async () => {
    const result = await preprocessSchema(timelineSchema(), { basePath: '.', loader: makeTimelineLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const orbital = result.data.schema.orbitals.find((o) => o.name === 'TimelineOrbital');
    expect(orbital).toBeDefined();
    if (!orbital) return;

    const typography4 = findTraitRefByName(orbital.traits, 'InlineTypographyRender4');
    expect(typography4).toBeDefined();
    const values = normalizeCallSiteConfigToValues(typography4?.config);
    expect(values?.content).toBe('Activity Timeline');
  });

  it('leaves a forward nobody declares as the literal token', async () => {
    const result = await preprocessSchema(timelineSchema(), { basePath: '.', loader: makeTimelineLoader() });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const orbital = result.data.schema.orbitals.find((o) => o.name === 'TimelineOrbital');
    expect(orbital).toBeDefined();
    if (!orbital) return;

    const orphan = findTraitRefByName(orbital.traits, 'InlineTypographyRenderOrphan');
    expect(orphan).toBeDefined();
    const values = normalizeCallSiteConfigToValues(orphan?.config);
    expect(values?.content).toBe('@config.nonExistentKnob');
  });
});

/**
 * Corpus sweep: every registry `.orb` the ledger (n)-JS ref-entry fix
 * closes. Each row's `{ref}` entry's call-site config forward resolves to
 * the value the owning atom actually declares once `preprocessSchema` runs
 * pure (`basePath`/`stdLibPath` point at the real registries, no server).
 *
 * `std-lms.orb` is excluded: its `EnrollmentOrbital` fails to even LOAD
 * (`UI-FORM-SECTION-INVALID-ITEM-TYPE`, `docs/Almadar_Std_Gaps.md`) — a
 * pre-existing, unrelated zod-schema mismatch in a sibling atom
 * (`ui-form-section.orb`) that has nothing to do with this ledger item; the
 * trait under test here (`InlineTypographyRender23`) lives in a DIFFERENT
 * orbital of the same file (`CourseOrbital`), which never gets a chance to
 * preprocess because `preprocessSchema` fails the whole schema on the first
 * orbital error.
 */
describe.skipIf(!hasCorpus)('ReferenceResolver — {ref}-entry call-site config forward: real registry corpus', () => {
  const cases: ReadonlyArray<{
    file: string;
    trait: string;
    knob: string;
    expected: number | string;
  }> = [
    { file: 'app/atoms/std-timeline.orb', trait: 'InlineTypographyRender4', knob: 'content', expected: 'Activity Timeline' },
    { file: 'app/atoms/std-timeline.orb', trait: 'InlineTypographyRender16', knob: 'content', expected: 'Activity Timeline' },
    { file: 'app/atoms/std-ledger-entry.orb', trait: 'InlineTypographyRender10', knob: 'content', expected: 'Journal Entries' },
    { file: 'app/atoms/std-incident.orb', trait: 'InlineMeterRender23', knob: 'max', expected: 5 },
    { file: 'app/atoms/std-prescription.orb', trait: 'InlineMeterRender33', knob: 'max', expected: 5 },
    { file: 'app/atoms/std-recurring-charge.orb', trait: 'InlineMeterRender21', knob: 'max', expected: 4 },
  ];

  for (const { file, trait, knob, expected } of cases) {
    it(`resolves ${file}'s ${trait}.${knob} to the declaring atom's literal`, async () => {
      const schemaPath = path.join(REPO_ROOT, 'packages/almadar-behaviors/behaviors/registry', file);
      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as OrbitalSchema;

      const result = await preprocessSchema(schema, {
        basePath: path.join(REPO_ROOT, 'packages/almadar-behaviors'),
        stdLibPath: path.join(REPO_ROOT, 'packages/almadar-std'),
        allowOutsideBasePath: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      let found: Exclude<TraitRef, string> | undefined;
      for (const orbital of result.data.schema.orbitals) {
        found = findTraitRefByName(orbital.traits, trait);
        if (found) break;
      }
      expect(found).toBeDefined();
      const values = normalizeCallSiteConfigToValues(found?.config);
      expect(values?.[knob]).toBe(expected);
    });
  }
});

/**
 * `ConfigFieldDeclaration.forwardedFrom` (B4-J5, core type + zod; `lintWiring`
 * consumes it) — the collapsed field's ORIGINAL `@config.<knob>` token
 * survives the fold so a dead-knob check can still recognize the knob as
 * forwarded on an already-resolved schema. Set at every `walkConfigForwardChain`
 * consumer: declared defaults (`resolveForwardedSiblingConfigFrom`) and the
 * `{ref}`-entry call-site path (`resolveCallSiteConfigForwards`) tested here.
 */
describe.skipIf(!hasCorpus)('ReferenceResolver — forwardedFrom provenance on a collapsed call-site forward', () => {
  it('records the original `@config.<knob>` token on std-time-tracking.orb\'s TimesheetAppLayout.config.appName', async () => {
    const schemaPath = path.join(
      REPO_ROOT,
      'packages/almadar-behaviors/behaviors/registry/app/organisms/std-time-tracking.orb',
    );
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as OrbitalSchema;

    const result = await preprocessSchema(schema, {
      basePath: path.join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: path.join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    let found: Exclude<TraitRef, string> | undefined;
    for (const orbital of result.data.schema.orbitals) {
      found = findTraitRefByName(orbital.traits, 'TimesheetAppLayout');
      if (found) break;
    }
    expect(found).toBeDefined();
    const appName = found?.config?.appName;
    expect(appName).toBeDefined();
    if (appName === undefined || !isCallSiteConfigDeclaration(appName)) {
      throw new Error('appName did not collapse to the annotated declaration form');
    }
    expect(appName.default).toBe('Time Tracking');
    expect(appName.forwardedFrom).toBe('@config.appName');
  });
});
