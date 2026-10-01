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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitalServerRuntime, type ClientRenderUITuple } from '../src/server/OrbitalServerRuntime.js';
import { preprocessSchema } from '../src/traits/UsesIntegration.js';
import { normalizeCallSiteConfigToValues } from '@almadar/core';
import type { ClientEffectTuple, OrbitalSchema, RenderUIEffect, RuntimeValue, Trait } from '@almadar/core';
import { IO_ROOT, STD_ROOT } from './helpers/behavior-packages.js';

// `['render-ui', slot, pattern, props, priority]` — the resolved leaf
// values (label/disabled/content/…) live in `pattern` (index 2), the fully
// interpolated `PatternConfig` the renderer paints; `props` (index 3) is a
// separate, usually-empty slot. Picks the LAST matching entry so a re-fired
// capture child's REFRESHED frame (pushed after the mount-time one) wins.
function renderPatternFor(
  clientEffectsByTrait: Array<{ traitName: string; effect: ClientEffectTuple }> | undefined,
  traitName: string,
): Record<string, RuntimeValue> | undefined {
  const entries = clientEffectsByTrait?.filter((e) => e.traitName === traitName);
  const entry = entries && entries.length > 0 ? entries[entries.length - 1] : undefined;
  if (!entry) return undefined;
  const effect = entry.effect as ClientRenderUITuple;
  return effect[2] as Record<string, RuntimeValue> | undefined;
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

  // The std-helpdesk Rate button / reply error text shape: a whole-value
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

const HELPDESK_ORB = join(IO_ROOT, 'behaviors/registry/app/organisms/std-helpdesk.orb');

/**
 * The `{ref}` entry of `ref` in `orbital` whose call-site `knob` is `value` —
 * selected by what it declares, never by its generated `Inline<Pattern><N>`
 * name, which renumbers on every re-emit.
 */
function helpdeskRefEntry(orbital: string, ref: string, knob: string, value: RuntimeValue): string {
  const raw = JSON.parse(readFileSync(HELPDESK_ORB, 'utf-8')) as OrbitalSchema;
  const names = (raw.orbitals.find((o) => o.name === orbital)?.traits ?? []).flatMap((t) =>
    typeof t !== 'string' &&
    'ref' in t &&
    t.ref === ref &&
    t.name !== undefined &&
    normalizeCallSiteConfigToValues(t.config)?.[knob] === value
      ? [t.name]
      : [],
  );
  expect(names).toHaveLength(1);
  return names[0];
}

describe('callsite-payload capture — std-helpdesk (real organism)', () => {
  const rateButton = (): string => helpdeskRefEntry('TicketOrbital', 'Button.traits.ButtonRender', 'action', 'RATE');
  const replyError = (): string =>
    helpdeskRefEntry('TicketReplyOrbital', 'Typography.traits.TypographyRender', 'content', '@callsitePayload.error');

  async function registerHelpdesk(): Promise<OrbitalServerRuntime> {
    const raw = JSON.parse(readFileSync(HELPDESK_ORB, 'utf-8')) as OrbitalSchema;
    const result = await preprocessSchema(raw, {
      basePath: IO_ROOT,
      stdLibPath: STD_ROOT,
      allowOutsideBasePath: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`preprocessSchema failed: ${result.errors.join('; ')}`);
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(result.data.schema);
    return runtime;
  }

  it('the Rate button\'s disabled resolves false when TicketDetailLoaded carries a resolved ticket with no CSAT score', async () => {
    const runtime = await registerHelpdesk();
    const resp = await runtime.processOrbitalEvent('TicketOrbital', {
      event: 'TicketDetailLoaded',
      targetTrait: 'TicketDetail',
      payload: { data: { id: 'tk1', status: 'resolved', csatScore: null, subject: 'Broken widget' } },
    });
    expect(resp.success).toBe(true);
    const props = renderPatternFor(resp.clientEffectsByTrait, rateButton());
    expect(props).toBeDefined();
    expect(props?.disabled).toBe(false);
  });

  it('the Rate button\'s disabled resolves true when the ticket is still open', async () => {
    const runtime = await registerHelpdesk();
    const resp = await runtime.processOrbitalEvent('TicketOrbital', {
      event: 'TicketDetailLoaded',
      targetTrait: 'TicketDetail',
      payload: { data: { id: 'tk2', status: 'open', csatScore: null, subject: 'Still broken' } },
    });
    expect(resp.success).toBe(true);
    const props = renderPatternFor(resp.clientEffectsByTrait, rateButton());
    expect(props).toBeDefined();
    expect(props?.disabled).toBe(true);
  });

  it('the reply error text resolves the TicketReply failure payload\'s error message', async () => {
    const runtime = await registerHelpdesk();
    const resp = await runtime.processOrbitalEvent('TicketReplyOrbital', {
      event: 'TicketReplyLoadFailed',
      targetTrait: 'TicketReplyBrowse',
      payload: { error: 'Boom' },
    });
    expect(resp.success).toBe(true);
    const props = renderPatternFor(resp.clientEffectsByTrait, replyError());
    expect(props).toBeDefined();
    expect(props?.content).toBe('Boom');
  });
});

// ============================================================================
// (c) A repaint never moves the embedded child. std-inventory /stock-levels:
// every parent transition replayed the ledger's `browsing -> loading` INIT and
// the response carried `loading`, so the page sat on its spinner.
// ============================================================================

function buildPassThroughSchema(): OrbitalSchema {
  const render = (children: string[]): RenderUIEffect => ['render-ui', 'main', { type: 'stack', children }];
  const host: Trait = {
    name: 'Host',
    scope: 'instance',
    linkedEntity: 'Ticket',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'PING', name: 'Ping' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'PING', effects: [render(['@trait.Ledger'])] }],
    },
  };
  const ledger: Trait = {
    name: 'Ledger',
    scope: 'instance',
    linkedEntity: 'Ticket',
    stateMachine: {
      states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'LOADED', name: 'Loaded' }],
      transitions: [
        { from: 'loading', to: 'loading', event: 'INIT', effects: [render(['@trait.Child'])] },
        { from: 'loading', to: 'browsing', event: 'LOADED', effects: [render(['@trait.Child'])] },
        { from: 'browsing', to: 'loading', event: 'INIT', effects: [render(['@trait.Child'])] },
      ],
    },
  };
  const child: Trait = {
    name: 'Child',
    scope: 'instance',
    linkedEntity: 'Ticket',
    config: { content: { type: 'string', default: '@callsitePayload.label' } },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'button', label: '@config.content' }]] }],
    },
  };
  return {
    name: 'PassThroughApp',
    schemaVersion: 4,
    orbitals: [{
      name: 'HostOrbital',
      entity: { name: 'Ticket', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
      traits: [host, ledger, child],
      pages: [],
    }],
  };
}

describe('callsite-payload capture — a repaint keeps the embedded child in its state', () => {
  it('a loaded pass-through child stays loaded; its grandchild repaints with what the child composed it with', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildPassThroughSchema());
    await runtime.processOrbitalEvent('HostOrbital', { event: 'INIT', targetTrait: 'Ledger' });
    await runtime.processOrbitalEvent('HostOrbital', { event: 'LOADED', targetTrait: 'Ledger', payload: { label: 'Ledger' } });
    const resp = await runtime.processOrbitalEvent('HostOrbital', { event: 'PING', targetTrait: 'Host', payload: { label: 'Fresh' } });
    expect(resp.states?.['Ledger']).toBe('browsing');
    expect(resp.clientEffectsByTrait?.some((e) => e.traitName === 'Ledger')).toBe(false);
    expect(renderPatternFor(resp.clientEffectsByTrait, 'Child')?.label).toBe('Ledger');
  });

  it('control: a child whose lifecycle arm is a self-loop is repainted under the payload', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildPassThroughSchema());
    await runtime.processOrbitalEvent('HostOrbital', { event: 'INIT', targetTrait: 'Ledger' });
    const resp = await runtime.processOrbitalEvent('HostOrbital', { event: 'PING', targetTrait: 'Host', payload: { label: 'Fresh' } });
    expect(resp.states?.['Ledger']).toBe('loading');
    expect(resp.clientEffectsByTrait?.some((e) => e.traitName === 'Ledger')).toBe(true);
    expect(renderPatternFor(resp.clientEffectsByTrait, 'Child')?.label).toBe('Fresh');
  });
});

// ============================================================================
// (d) A capture nested inside a `children` array of pattern objects — the
// std-timeline shape (`{type: timeline, entity: ?data}` hoisted next to sibling
// `@trait.X` refs). std-construction-pm /site-diary: the rows loaded and the
// timeline rendered "No events".
// ============================================================================

describe('callsite-payload capture — nested inside a children array', () => {
  it('the composing payload reaches a pattern object inside the child\'s children', async () => {
    const host: Trait = {
      name: 'Feed',
      scope: 'instance',
      linkedEntity: 'Ticket',
      stateMachine: {
        states: [{ name: 'loading', isInitial: true }, { name: 'browsing' }],
        events: [{ key: 'LOADED', name: 'Loaded' }],
        transitions: [{ from: 'loading', to: 'browsing', event: 'LOADED', effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Body'] }]] }],
      },
    };
    const body: Trait = {
      name: 'Body',
      scope: 'instance',
      linkedEntity: 'Ticket',
      config: {
        children: { type: 'unknown', default: ['@trait.Title', { type: 'timeline', entity: '@callsitePayload.data', fields: ['title'] }] },
      },
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'stack', children: '@config.children' }]] }],
      },
    };
    const title: Trait = {
      name: 'Title',
      scope: 'instance',
      linkedEntity: 'Ticket',
      stateMachine: {
        states: [{ name: 'idle', isInitial: true }],
        events: [{ key: 'INIT', name: 'Init' }],
        transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'typography', content: 'Log' }]] }],
      },
    };
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register({
      name: 'NestedApp',
      schemaVersion: 4,
      orbitals: [{
        name: 'FeedOrbital',
        entity: { name: 'Ticket', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [host, body, title],
        pages: [],
      }],
    });
    const rows = [{ id: 't1', title: 'Pour' }, { id: 't2', title: 'Frame' }];
    const resp = await runtime.processOrbitalEvent('FeedOrbital', { event: 'LOADED', targetTrait: 'Feed', payload: { data: rows } });
    const stack = renderPatternFor(resp.clientEffectsByTrait, 'Body');
    const children = stack?.children as Array<Record<string, RuntimeValue> | string> | undefined;
    const timeline = children?.find((c): c is Record<string, RuntimeValue> => typeof c === 'object' && c !== null && c['type'] === 'timeline');
    expect(timeline?.['entity']).toEqual(rows);
  });
});

// ============================================================================
// (e) The capture is sticky: a child's own lifecycle run resolves
// `@callsitePayload` to the payload its composer last composed it with (the
// compiled path renders the child inside its composer with `lastPayload`), and
// the child's frame carries that payload so a client can repaint it the same way.
// ============================================================================

describe('callsite-payload capture — sticky across the child\'s own lifecycle', () => {
  it('the child\'s own INIT after composition keeps the composed payload', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildSyntheticSchema());
    await runtime.processOrbitalEvent('HostOrbital', { event: 'LOADED', targetTrait: 'Host', payload: { error: 'Boom', data: { status: 'resolved' } } });
    const own = await runtime.processOrbitalEvent('HostOrbital', { event: 'INIT', targetTrait: 'Child' });
    expect(renderPatternFor(own.clientEffectsByTrait, 'Child')?.label).toBe('Boom');
    const entry = own.clientEffectsByTrait?.find((e) => e.traitName === 'Child');
    expect(entry?.callsitePayload).toEqual({ error: 'Boom', data: { status: 'resolved' } });
  });

  it('control: before any composition the child\'s own INIT has no payload to capture', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildSyntheticSchema());
    const own = await runtime.processOrbitalEvent('HostOrbital', { event: 'INIT', targetTrait: 'Child' });
    expect(renderPatternFor(own.clientEffectsByTrait, 'Child')?.label).toBeUndefined();
    expect(own.clientEffectsByTrait?.find((e) => e.traitName === 'Child')?.callsitePayload).toBeUndefined();
  });

  it('edge: a later composition replaces the sticky payload', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildSyntheticSchema());
    await runtime.processOrbitalEvent('HostOrbital', { event: 'LOADED', targetTrait: 'Host', payload: { error: 'First', data: { status: 'open' } } });
    await runtime.processOrbitalEvent('HostOrbital', { event: 'LOADED', targetTrait: 'Host', payload: { error: 'Second', data: { status: 'open' } } });
    const own = await runtime.processOrbitalEvent('HostOrbital', { event: 'INIT', targetTrait: 'Child' });
    expect(renderPatternFor(own.clientEffectsByTrait, 'Child')?.label).toBe('Second');
  });
});

// ============================================================================
// (f) Walking THROUGH a child that is not repainted (its lifecycle arm
// reloads) must not recompose that child's own children with the ancestor's
// payload — they keep what their composer last gave them. std-devops-dashboard
// /activity: ActivityPanel's INIT walked through ActivityFeed and repainted the
// feed's timeline under `{}`, erasing its rows.
// ============================================================================

function buildWalkThroughSchema(): OrbitalSchema {
  const host: Trait = {
    name: 'Host', scope: 'instance', linkedEntity: 'Ticket',
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'PING', name: 'Ping' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'PING', effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Feed'] }]] }],
    },
  };
  const feed: Trait = {
    name: 'Feed', scope: 'instance', linkedEntity: 'Ticket',
    stateMachine: {
      states: [{ name: 'browsing', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }, { key: 'LOADED', name: 'Loaded' }],
      transitions: [
        { from: 'browsing', to: 'browsing', event: 'INIT', effects: [['set', '@entity.id', 'reload'], ['render-ui', 'main', { type: 'spinner' }]] },
        { from: 'browsing', to: 'browsing', event: 'LOADED', effects: [['render-ui', 'main', { type: 'stack', children: ['@trait.Leaf'] }]] },
      ],
    },
  };
  const leaf: Trait = {
    name: 'Leaf', scope: 'instance', linkedEntity: 'Ticket',
    config: { content: { type: 'string', default: '@callsitePayload.label' } },
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'INIT', name: 'Init' }],
      transitions: [{ from: 'idle', to: 'idle', event: 'INIT', effects: [['render-ui', 'main', { type: 'button', label: '@config.content' }]] }],
    },
  };
  return {
    name: 'WalkApp', schemaVersion: 4,
    orbitals: [{ name: 'HostOrbital', entity: { name: 'Ticket', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] }, traits: [host, feed, leaf], pages: [] }],
  };
}

describe('callsite-payload capture — walking through a reloading child', () => {
  it('the grandchild keeps the payload its own composer gave it', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildWalkThroughSchema());
    await runtime.processOrbitalEvent('HostOrbital', { event: 'LOADED', targetTrait: 'Feed', payload: { label: 'Mine' } });
    const resp = await runtime.processOrbitalEvent('HostOrbital', { event: 'PING', targetTrait: 'Host', payload: { label: 'Host' } });
    expect(renderPatternFor(resp.clientEffectsByTrait, 'Leaf')?.label).toBe('Mine');
  });

  it('control: a grandchild never composed yet takes the ancestor\'s payload', async () => {
    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(buildWalkThroughSchema());
    const resp = await runtime.processOrbitalEvent('HostOrbital', { event: 'PING', targetTrait: 'Host', payload: { label: 'Host' } });
    expect(renderPatternFor(resp.clientEffectsByTrait, 'Leaf')?.label).toBe('Host');
  });
});
