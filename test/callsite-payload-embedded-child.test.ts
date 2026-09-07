/**
 * Callsite-payload capture — embedded child re-render.
 *
 * The bug: a JSX render site inside a parent trait's transition
 * (`<Button.traits.ButtonRender disabled={(if (= ?data.status resolved) …)} />`)
 * is hoisted by the lolo lowerer into a sibling "inline" trait, referenced
 * from the parent's render-ui via `@trait.X`, with the `?field` reads
 * rewritten to `@callsitePayload.<field>` — meaning "resolve against the
 * COMPOSING transition's triggering event payload" (see the Rust
 * `CALLSITE_PAYLOAD_PREFIX` doc in `orbital-core/src/schema/types.rs`,
 * mirrored by `@almadar/core`'s `CORE_BINDINGS`). Pre-fix, nothing ever
 * handed the composing payload to the child: the child rendered once at
 * its own mount-time INIT and never again, so its `@callsitePayload.*`
 * reads stayed frozen at whatever it captured at mount (undefined, since
 * mount fires with the page's `initPayload`, not a real transition's
 * payload).
 *
 * Fix: `OrbitalServerRuntime.executeEffects` surfaces the composing
 * effect's payload on the binding context as `callsitePayload`; after a
 * trait's own transition runs, `rerenderCallsiteCaptureChildren` re-fires
 * every capture-bearing embedded child's lifecycle transition under that
 * payload, through the same `executeEffects` — so the child's refreshed
 * frame lands in `clientEffectsByTrait` alongside the parent's.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitalServerRuntime, type ClientRenderUITuple } from '../src/OrbitalServerRuntime.js';
import { preprocessSchema } from '../src/UsesIntegration.js';
import type { OrbitalSchema, Trait } from '@almadar/core';

const REPO_ROOT = join(__dirname, '..', '..', '..');

// `['render-ui', slot, pattern, props, priority]` — the resolved leaf
// values (label/disabled/content/…) live in `pattern` (index 2), the fully
// interpolated `PatternConfig` the renderer paints; `props` (index 3) is a
// separate, usually-empty slot. Picks the LAST matching entry so a re-fired
// capture child's REFRESHED frame (pushed after the mount-time one) wins.
function renderPatternFor(
  clientEffectsByTrait: Array<{ traitName: string; effect: unknown }> | undefined,
  traitName: string,
): Record<string, unknown> | undefined {
  const entries = clientEffectsByTrait?.filter((e) => e.traitName === traitName);
  const entry = entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
  if (!entry) return undefined;
  const effect = entry.effect as ClientRenderUITuple;
  return effect[2] as Record<string, unknown> | undefined;
}

// ============================================================================
// (a) Synthetic schema — portable, no dependency on the real corpus.
// ============================================================================

function buildSyntheticSchema(): OrbitalSchema {
  const host: Trait = {
    name: 'Host',
    scope: 'instance',
    linkedEntity: 'Ticket',
    stateMachine: {
      states: [{ name: 'loading', isInitial: true }, { name: 'viewing' }],
      events: [{ key: 'LOADED', name: 'Loaded' }],
      transitions: [
        {
          from: 'loading',
          to: 'viewing',
          event: 'LOADED',
          effects: [
            ['render-ui', 'main', {
              type: 'stack',
              children: ['@trait.Child'],
            }],
          ],
        },
        // Self-loop so a SECOND `LOADED` (a re-fetch, different payload)
        // still composes Child — proves the re-render tracks each firing's
        // OWN payload, not just the first.
        {
          from: 'viewing',
          to: 'viewing',
          event: 'LOADED',
          effects: [
            ['render-ui', 'main', {
              type: 'stack',
              children: ['@trait.Child'],
            }],
          ],
        },
      ],
    },
  };

  // The InlineButtonRender7 / InlineTypographyRender22 shape: a whole-value
  // capture AND a nested capture inside an `if`/`and`/`=` S-expression, both
  // in DECLARED config defaults (no `configByTrait` entry — an embedded
  // sub-trait never gets one).
  const child: Trait = {
    name: 'Child',
    scope: 'instance',
    linkedEntity: 'Ticket',
    config: {
      content: { type: 'string', default: '@callsitePayload.error' },
      disabled: {
        type: 'boolean',
        default: ['if', ['and', ['=', '@callsitePayload.data.status', 'resolved'], true], false, true],
      },
    },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [
        {
          from: 'idle',
          to: 'idle',
          event: 'INIT',
          effects: [
            ['render-ui', 'main', { type: 'button', label: '@config.content', disabled: '@config.disabled' }],
          ],
        },
      ],
    },
  };

  return {
    name: 'SyntheticApp',
    schemaVersion: 4,
    orbitals: [
      {
        name: 'HostOrbital',
        entity: { name: 'Ticket', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [host, child],
        pages: [],
      },
    ],
  };
}

describe('callsite-payload capture — embedded child re-render (synthetic)', () => {
  it('re-renders the embedded child with the composing payload, resolving whole-value AND nested captures', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildSyntheticSchema());

    // Mount: Child's own INIT fires with no composing payload — captures
    // resolve to their "no payload yet" shape (undefined / the `if`'s
    // false-arm, since `@callsitePayload.data.status` isn't "resolved").
    const mountResp = await runtime.processOrbitalEvent('HostOrbital', { event: 'INIT', targetTrait: 'Child' });
    expect(mountResp.success).toBe(true);
    const mountProps = renderPatternFor(mountResp.clientEffectsByTrait, 'Child');
    expect(mountProps?.label).toBeUndefined();
    expect(mountProps?.disabled).toBe(true);

    // Host's LOADED transition composes Child — the child must re-render
    // under Host's payload.
    const loadedResp = await runtime.processOrbitalEvent('HostOrbital', {
      event: 'LOADED',
      targetTrait: 'Host',
      payload: { error: 'Boom', data: { status: 'resolved' } },
    });
    expect(loadedResp.success).toBe(true);
    const childFrame = loadedResp.clientEffectsByTrait?.find((e) => e.traitName === 'Child');
    expect(childFrame).toBeDefined();
    const resolvedProps = renderPatternFor(loadedResp.clientEffectsByTrait, 'Child');
    expect(resolvedProps?.label).toBe('Boom');
    expect(resolvedProps?.disabled).toBe(false);

    // A DIFFERENT composing payload flips the nested capture the other way.
    const openResp = await runtime.processOrbitalEvent('HostOrbital', {
      event: 'LOADED',
      targetTrait: 'Host',
      payload: { error: 'Still broken', data: { status: 'open' } },
    });
    const openProps = renderPatternFor(openResp.clientEffectsByTrait, 'Child');
    expect(openProps?.label).toBe('Still broken');
    expect(openProps?.disabled).toBe(true);
  });
});

// ============================================================================
// (b) Real organism — std-helpdesk, resolved with the JS resolver (no CLI
// binary dependency: the registry .orb already carries every `ref`-composed
// trait `preprocessSchema` needs to inline).
// ============================================================================

const HELPDESK_ORB = join(
  REPO_ROOT,
  'packages/almadar-behaviors/behaviors/registry/app/organisms/std-helpdesk.orb',
);
const canRunHelpdesk = existsSync(HELPDESK_ORB);

describe.skipIf(!canRunHelpdesk)('callsite-payload capture — std-helpdesk (real organism)', () => {
  async function registerHelpdesk(): Promise<OrbitalServerRuntime> {
    const raw = JSON.parse(readFileSync(HELPDESK_ORB, 'utf-8')) as OrbitalSchema;
    const result = await preprocessSchema(raw, {
      basePath: join(REPO_ROOT, 'packages/almadar-behaviors'),
      stdLibPath: join(REPO_ROOT, 'packages/almadar-std'),
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`preprocessSchema failed: ${result.errors.join('; ')}`);
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(result.data.schema);
    return runtime;
  }

  it('InlineButtonRender7.disabled resolves false when TicketDetailLoaded carries a resolved ticket with no CSAT score', async () => {
    const runtime = await registerHelpdesk();
    const resp = await runtime.processOrbitalEvent('TicketOrbital', {
      event: 'TicketDetailLoaded',
      targetTrait: 'TicketDetail',
      payload: { data: { id: 'tk1', status: 'resolved', csatScore: null, subject: 'Broken widget' } },
    });
    expect(resp.success).toBe(true);
    const props = renderPatternFor(resp.clientEffectsByTrait, 'InlineButtonRender7');
    expect(props).toBeDefined();
    expect(props?.disabled).toBe(false);
  });

  it('InlineButtonRender7.disabled resolves true when the ticket is still open', async () => {
    const runtime = await registerHelpdesk();
    const resp = await runtime.processOrbitalEvent('TicketOrbital', {
      event: 'TicketDetailLoaded',
      targetTrait: 'TicketDetail',
      payload: { data: { id: 'tk2', status: 'open', csatScore: null, subject: 'Still broken' } },
    });
    expect(resp.success).toBe(true);
    const props = renderPatternFor(resp.clientEffectsByTrait, 'InlineButtonRender7');
    expect(props).toBeDefined();
    expect(props?.disabled).toBe(true);
  });

  it('InlineTypographyRender22.content resolves the TicketReply failure payload\'s error message', async () => {
    const runtime = await registerHelpdesk();
    const resp = await runtime.processOrbitalEvent('TicketReplyOrbital', {
      event: 'TicketReplyLoadFailed',
      targetTrait: 'TicketReplyBrowse',
      payload: { error: 'Boom' },
    });
    expect(resp.success).toBe(true);
    const props = renderPatternFor(resp.clientEffectsByTrait, 'InlineTypographyRender22');
    expect(props).toBeDefined();
    expect(props?.content).toBe('Boom');
  });
});
