/**
 * Regression for a composed/reference-form cross-trait cascade that
 * silently dropped every hop (verified against the real `vim-mode` plugin,
 * `packages/almadar-behaviors/behaviors/registry/plugins/atoms/vim-mode.orb`,
 * via `OrbitalServerRuntime` in mock mode — `docs/Almadar_Runtime_Gaps.md`).
 *
 * Root cause: `TraitEventListener.eventId` is "optional until the Phase-7
 * flip" (`@almadar/core`'s `trait.ts`). The compose/resolve pipeline
 * (`orb resolve`, and the checked-in `.orb` registries it mirrors) already
 * stamps a V4 ledger id onto every `emits[]` CONTRACT entry, but does not
 * yet stamp the matching id onto the `listens[]` entries elsewhere in the
 * schema that name that same event via `Trait.EVENT -> X` (source-qualified,
 * `uses`-resolved) form — those entries carry `triggersId` (the id of the
 * listener's OWN triggered event) but never `eventId` (the id of the event
 * being listened FOR).
 *
 * `OrbitalServerRuntime`'s emit handler (`executeEffects`'s `emit` closure)
 * always looks up and stamps the emitting trait's own `emits[].eventId`
 * when present, and routes the bus emit under an id-qualified key
 * (`eventRouteKey`) whenever that id exists. `setupEventListeners` used to
 * trust `listener.eventId` alone to compute ITS subscription key — so
 * whenever an emitter's contract had a ledger id but the listener's own
 * entry didn't (yet), the emit routed under `@evt:<id>` while the listener
 * subscribed under the bare event name: two different bus keys for the
 * same logical event, and the listener never received it. This bites EVERY
 * composed/renamed trait that listens across a `uses`-resolved alias
 * (`trait Shell = ShellAtom.traits.StudioShellTrait -> ... {}`), because
 * that's exactly the shape whose `emits[]` gets ledgered first.
 *
 * Fix (`OrbitalServerRuntime.resolveSourceEmitEventId`): when a listener's
 * own `eventId` is absent, resolve it from the SAME canonical place the
 * emitter itself reads — the source trait's declared `emits[]` contract —
 * instead of trusting a possibly-unpopulated sibling field. `kind: "any"`
 * listens (no single resolvable source) are left on bare-name routing,
 * which was already correct there.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import { asOrbitalId, asEntityId, asTraitId, asEventId, isInlineTrait } from '@almadar/core';
import type { OrbitalSchema, Trait, Entity } from '@almadar/core';

const ORB = asOrbitalId('orb_01HCCAAAAAAAAAAAAAAAAAAAAA');
const ENT = asEntityId('ent_01HCCAAAAAAAAAAAAAAAAAAAAA');
const TID_SOURCE = asTraitId('trt_01HCCSOURCESOURCESOURCESO');
const TID_LISTENER = asTraitId('trt_01HCCLISTENLISTENLISTENLI');
const EID_PING = asEventId('evt_01HCCPINGPINGPINGPINGPING');
const EID_RECEIVED_TICK = asEventId('evt_01HCCTICKTICKTICKTICKTIC');

/**
 * Two intra-orbital traits shaped exactly like vim-mode's `Shell` /
 * `VimStudioBridge`: `Source` is a reference-form composed trait (its own
 * `emits[]` carries a V4 ledger id for `PING`) and `Listener` names it via
 * a source-qualified `listens { Source PING -> TICK }` entry that carries
 * `source.traitId` + `triggersId` but deliberately NO `eventId` — the exact
 * partial-ledger shape `orb resolve` produces today.
 */
function buildSchema(): OrbitalSchema {
  const source: Trait = {
    id: TID_SOURCE,
    name: 'Source',
    scope: 'instance',
    linkedEntity: 'Ping',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'FIRE', name: 'Fire' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'FIRE', effects: [['emit', 'PING', {}]] },
      ],
    },
    // The emitter's OWN emits contract already carries the ledger id — this
    // is the half of dual-carry that lands first.
    emits: [{ event: 'PING', eventId: EID_PING, scope: 'external' }],
  };

  const listener: Trait = {
    id: TID_LISTENER,
    name: 'Listener',
    scope: 'instance',
    linkedEntity: 'Ping',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'active', isInitial: true }],
      events: [{ key: 'TICK', name: 'Tick' }],
      transitions: [
        { from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] },
      ],
    },
    emits: [{ event: 'RECEIVED', eventId: EID_RECEIVED_TICK, scope: 'external' }],
    // Source-qualified listen, resolved the way `uses` composition produces
    // it: `source.traitId` + `triggers`/`triggersId` for the LISTENER's own
    // triggered event, but no `eventId` for the event being listened to.
    listens: [
      {
        event: 'PING',
        triggers: 'TICK',
        scope: 'external',
        source: { kind: 'trait', trait: 'Source', traitId: TID_SOURCE },
      },
    ],
  };

  return {
    name: 'PingApp',
    schemaVersion: 4,
    orbitals: [
      {
        id: ORB,
        name: 'PingOrbital',
        entity: { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [source, listener],
        pages: [],
      },
    ],
  };
}

describe('composed-trait listens route by the SOURCE emit contract id, not listener.eventId alone', () => {
  it('a listener with no eventId still receives an id-routed emit from its declared source', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildSchema());

    const seen: string[] = [];
    runtime.getEventBus().onAny((e) => seen.push(e.type));

    await runtime.processOrbitalEvent('PingOrbital', { event: 'FIRE', targetTrait: 'Source' });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toContain('PING');
    expect(seen).toContain('RECEIVED');
  });
});

// ---------------------------------------------------------------------------
// PF-16 regressions (docs/oppurtunities/krulz/Almadar_Project_Friday.md).
// Two dual-carry routing holes beyond the no-eventId case above:
//  (a) STALE listener eventId — L1 mints every listen entry's eventId from
//      the listener's own declaration; orbital-kind sources into
//      reference-form orbitals are never re-pointed post-inline, so the
//      listener subscribes under an id the emitter never publishes to.
//  (b) ANY-KIND (`*.EVENT`) listens carry NO eventId and subscribe under the
//      bare name, while the emit side routes ONLY under the id key.
// Fixes: source-first id resolution in `setupEventListeners` (the source
// trait's emits[] contract is the canonical id the emitter stamps), and
// name-channel dual-publish in `EventBus.emit` for id-keyed emits.
// ---------------------------------------------------------------------------
const ORB_B = asOrbitalId('orb_01HCCBBBBBBBBBBBBBBBBBBBBB');
const TID_SOURCE_B = asTraitId('trt_01HCCSOURCEBSOURCEBSOURC');
const EID_STALE = asEventId('evt_01HCCSTALESTALESTALESTAL');

function buildCrossOrbitalSchema(mode: 'stale-id' | 'any-kind'): OrbitalSchema {
  const source: Trait = {
    id: TID_SOURCE_B,
    name: 'Source',
    scope: 'instance',
    linkedEntity: 'Ping',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'FIRE', name: 'Fire' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'FIRE', effects: [['emit', 'PING', {}]] },
      ],
    },
    emits: [{ event: 'PING', eventId: EID_PING, scope: 'external' }],
  };

  const listener: Trait = {
    id: TID_LISTENER,
    name: 'Listener',
    scope: 'instance',
    linkedEntity: 'Ping',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'active', isInitial: true }],
      events: [{ key: 'TICK', name: 'Tick' }],
      transitions: [
        { from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] },
      ],
    },
    emits: [{ event: 'RECEIVED', eventId: EID_RECEIVED_TICK, scope: 'external' }],
    listens: [
      mode === 'stale-id'
        ? {
            event: 'PING',
            // L1-minted on the listener, never re-pointed to the source's id.
            eventId: EID_STALE,
            triggers: 'TICK',
            scope: 'external',
            source: {
              kind: 'orbital',
              orbital: 'SourceOrbital',
              trait: 'Source',
              orbitalId: ORB_B,
              traitId: TID_SOURCE_B,
            },
          }
        : {
            event: 'PING',
            triggers: 'TICK',
            scope: 'external',
            source: { kind: 'any' },
          },
    ],
  };

  const entity: Entity = { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] };
  return {
    name: 'CrossApp',
    schemaVersion: 4,
    orbitals: [
      { id: ORB_B, name: 'SourceOrbital', entity, traits: [source], pages: [] },
      { id: ORB, name: 'ListenerOrbital', entity, traits: [listener], pages: [] },
    ],
  };
}

describe('PF-16 dual-carry routing holes', () => {
  it('a stale listener-minted eventId loses to the source trait emits[] contract (orbital-kind source)', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildCrossOrbitalSchema('stale-id'));

    const seen: string[] = [];
    runtime.getEventBus().onAny((e) => seen.push(e.type));

    await runtime.processOrbitalEvent('SourceOrbital', { event: 'FIRE', targetTrait: 'Source' });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toContain('PING');
    expect(seen).toContain('RECEIVED');
  });

  it('an any-kind (*.EVENT) listen receives an id-stamped emit via name-channel dual-publish', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildCrossOrbitalSchema('any-kind'));

    const seen: string[] = [];
    runtime.getEventBus().onAny((e) => seen.push(e.type));

    await runtime.processOrbitalEvent('SourceOrbital', { event: 'FIRE', targetTrait: 'Source' });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toContain('PING');
    expect(seen).toContain('RECEIVED');
  });

  it('an any-kind listen carrying a stale L1-minted eventId still receives the emit (bare-name routing)', async () => {
    // The PF global-search shape: `listens { *.MODULE_SEARCH_REQUESTED -> … }`
    // compiles to source {kind:'any'} PLUS an L1-minted listener eventId that
    // no emitter stamps. The `?? listener.eventId` fallback re-subscribed
    // under that stale id; any-scope must route bare-name unconditionally.
    const schema = buildCrossOrbitalSchema('any-kind');
    const listenerTrait = schema.orbitals[1].traits[0];
    if (!isInlineTrait(listenerTrait)) throw new Error('expected an inline trait');
    listenerTrait.listens![0].eventId = EID_STALE;

    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(schema);

    const seen: string[] = [];
    runtime.getEventBus().onAny((e) => seen.push(e.type));

    await runtime.processOrbitalEvent('SourceOrbital', { event: 'FIRE', targetTrait: 'Source' });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toContain('PING');
    expect(seen).toContain('RECEIVED');
  });
});

// ---------------------------------------------------------------------------
// Listen-level guard parity (orbital-core listener.rs evaluates `guard`
// against the raw payload in a payload-only context and skips on false/error;
// the JS server path dispatched unconditionally — every guarded listen
// over-fired, e.g. all five PF search responders answering every request).
// ---------------------------------------------------------------------------
function buildGuardedListenSchema(): OrbitalSchema {
  const source: Trait = {
    id: TID_SOURCE_B,
    name: 'Source',
    scope: 'instance',
    linkedEntity: 'Ping',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [
        { key: 'FIRE_TASKS', name: 'FireTasks' },
        { key: 'FIRE_CLIENTS', name: 'FireClients' },
      ],
      transitions: [
        { from: 'idle', to: 'idle', event: 'FIRE_TASKS', effects: [['emit', 'PING', { moduleKey: 'tasks' }]] },
        { from: 'idle', to: 'idle', event: 'FIRE_CLIENTS', effects: [['emit', 'PING', { moduleKey: 'clients' }]] },
      ],
    },
    emits: [{ event: 'PING', eventId: EID_PING, scope: 'external' }],
  };

  const listener: Trait = {
    id: TID_LISTENER,
    name: 'Listener',
    scope: 'instance',
    linkedEntity: 'Ping',
    linkedEntityId: ENT,
    stateMachine: {
      states: [{ name: 'active', isInitial: true }],
      events: [{ key: 'TICK', name: 'Tick' }],
      transitions: [
        { from: 'active', to: 'active', event: 'TICK', effects: [['emit', 'RECEIVED', {}]] },
      ],
    },
    emits: [{ event: 'RECEIVED', eventId: EID_RECEIVED_TICK, scope: 'external' }],
    listens: [
      {
        event: 'PING',
        triggers: 'TICK',
        scope: 'external',
        source: { kind: 'any' },
        guard: ['==', '@payload.moduleKey', 'tasks'],
      },
    ],
  };

  const entity: Entity = { name: 'Ping', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] };
  return {
    name: 'GuardApp',
    schemaVersion: 4,
    orbitals: [
      { id: ORB_B, name: 'SourceOrbital', entity, traits: [source], pages: [] },
      { id: ORB, name: 'ListenerOrbital', entity, traits: [listener], pages: [] },
    ],
  };
}

describe('listen-level guard evaluation (kernel parity)', () => {
  it('a guarded listen skips dispatch when the guard fails and fires when it passes', async () => {
    const runtime = new OrbitalServerRuntime({ debug: false });
    await runtime.register(buildGuardedListenSchema());

    const seen: string[] = [];
    runtime.getEventBus().onAny((e) => seen.push(e.type));

    await runtime.processOrbitalEvent('SourceOrbital', { event: 'FIRE_CLIENTS', targetTrait: 'Source' });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain('PING');
    expect(seen).not.toContain('RECEIVED');

    await runtime.processOrbitalEvent('SourceOrbital', { event: 'FIRE_TASKS', targetTrait: 'Source' });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain('RECEIVED');
  });
});

// ---------------------------------------------------------------------------
// Real plugin end-to-end: resolves the checked-in vim-mode registry .orb the
// way the studio does (`resolveSchemaWithOrbitalCLI`, i.e. `orb resolve`),
// then drives the exact host-event loop a Monaco/CodeMirror shell would.
// Skips (not fails) when the dev `orbital` binary isn't on this machine —
// the synthetic test above is the portable regression; this is the
// real-world confirmation.
// ---------------------------------------------------------------------------
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ORB_PATH = join(
  REPO_ROOT,
  'packages/almadar-behaviors/behaviors/registry/plugins/atoms/vim-mode.orb',
);
const ORB_BIN = join(homedir(), 'bin', 'orbital');
const canRunRealPlugin = existsSync(ORB_BIN) && existsSync(ORB_PATH);

function resolveViaCli(schema: object): OrbitalSchema {
  const tmpFile = join(tmpdir(), `vim-mode-cascade-${Date.now()}-${Math.random().toString(36).slice(2)}.orb`);
  writeFileSync(tmpFile, JSON.stringify(schema, null, 2));
  try {
    const out = execFileSync(ORB_BIN, ['resolve', tmpFile], {
      encoding: 'utf-8',
      env: { ...process.env, ALMADAR_DEV: '1', ALMADAR_ROOT: REPO_ROOT },
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out) as OrbitalSchema;
  } finally {
    unlinkSync(tmpFile);
  }
}

describe.skipIf(!canRunRealPlugin)('vim-mode plugin: composed-trait cascade end-to-end (real schema)', () => {
  it('SHELL_PLUGIN_ENABLED -> Shell.PLUGIN_ENABLED -> VimStudioBridge registers commands + shows NORMAL status', async () => {
    const raw = JSON.parse(readFileSync(ORB_PATH, 'utf-8'));
    const resolved = resolveViaCli(raw);

    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(resolved);

    const events: Array<{ type: string; payload?: unknown }> = [];
    runtime.getEventBus().onAny((e) => events.push({ type: e.type, payload: e.payload }));

    await runtime.processOrbitalEvent('VimModeOrbital', {
      event: 'SHELL_PLUGIN_ENABLED',
      payload: { pluginId: 'vim-mode' },
      targetTrait: 'Shell',
    });
    await new Promise((r) => setTimeout(r, 20));

    const registerCommands = events.filter((e) => e.type === 'REGISTER_COMMAND');
    expect(registerCommands).toHaveLength(2);
    const status = events.filter((e) => e.type === 'STATUS');
    expect(status.at(-1)?.payload).toMatchObject({ text: '-- NORMAL --' });
  });

  it('SHELL_KEY i -> Modes NORMAL->INSERT -> VimStudioBridge shows INSERT status, Escape returns to NORMAL', async () => {
    const raw = JSON.parse(readFileSync(ORB_PATH, 'utf-8'));
    const resolved = resolveViaCli(raw);

    const runtime = new OrbitalServerRuntime({ mode: 'mock', debug: false });
    await runtime.register(resolved);

    const events: Array<{ type: string; payload?: unknown }> = [];
    runtime.getEventBus().onAny((e) => events.push({ type: e.type, payload: e.payload }));

    const keyPayload = {
      editorId: 'editor-1',
      key: 'i',
      code: 'KeyI',
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      repeat: false,
    };

    await runtime.processOrbitalEvent('VimModeOrbital', {
      event: 'SHELL_KEY',
      payload: keyPayload,
      targetTrait: 'Shell',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.some((e) => e.type === 'SET_MODE')).toBe(true);
    const insertStatus = events.filter((e) => e.type === 'STATUS');
    expect(insertStatus.at(-1)?.payload).toMatchObject({ text: '-- INSERT --' });

    events.length = 0;
    await runtime.processOrbitalEvent('VimModeOrbital', {
      event: 'SHELL_KEY',
      payload: { ...keyPayload, key: 'Escape', code: 'Escape' },
      targetTrait: 'Shell',
    });
    await new Promise((r) => setTimeout(r, 20));

    const normalStatus = events.filter((e) => e.type === 'STATUS');
    expect(normalStatus.at(-1)?.payload).toMatchObject({ text: '-- NORMAL --' });
  });
});
