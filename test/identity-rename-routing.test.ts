/**
 * Rabit V4 Phase 4 — the payoff test (interpreter path).
 *
 * A mid-session trait rename is modeled as a ledger `curName` edit: the
 * OWNER's display name changes (and its ledger row), but the name strings
 * held by every REFERENCE are deliberately NOT rewritten — that rewrite is
 * exactly what ids exist to make unnecessary.
 *
 * With ids present, cross-trait routing keys on the emitter's stable
 * `traitId` + `eventId`, so the receiver's listen still resolves after the
 * rename: zero broken bindings, events still route. The name-only control
 * shows the same rename breaks a name-keyed schema — proving the id path is
 * what preserves the binding, not luck.
 */
import { describe, it, expect } from 'vitest';
import { OrbitalServerRuntime } from '../src/OrbitalServerRuntime.js';
import {
  StateMachineManager,
  type TraitDefinition,
} from '../src/StateMachineCore.js';
import type { OrbitalSchema } from '@almadar/core';
import { asOrbitalId, asEntityId, asTraitId, asEventId } from '@almadar/core';

const ORB = asOrbitalId('orb_01HAAAAAAAAAAAAAAAAAAAAAAA');
const ENT = asEntityId('ent_01HAAAAAAAAAAAAAAAAAAAAAAA');
const TID_A = asTraitId('trt_01HAAAAAAAAAAAAAAAAAAAAAAA');
const TID_B = asTraitId('trt_01HBBBBBBBBBBBBBBBBBBBBBBB');
const EID_SIG = asEventId('evt_01HSIGSIGSIGSIGSIGSIGSIGSI');
const EID_RCV = asEventId('evt_01HRCVRCVRCVRCVRCVRCVRCVR');

/**
 * Two intra-orbital traits: `Emitter` fires `SIGNAL` on `GO`; `Receiver`
 * listens for the Emitter's `SIGNAL` and re-emits `RECEIVED` on its
 * triggered `RECEIVE`. `emitterName` is the parameter a rename changes;
 * `withIds` toggles the V4 dual-carry id fields on every node + reference.
 */
function buildSchema(emitterName: string, withIds: boolean): OrbitalSchema {
  const emitter: Record<string, unknown> = {
    ...(withIds ? { id: TID_A } : {}),
    name: emitterName,
    scope: 'instance',
    linkedEntity: 'Sig',
    ...(withIds ? { linkedEntityId: ENT } : {}),
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'GO', name: 'Go' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'GO', effects: [['emit', 'SIGNAL', {}]] },
      ],
    },
    emits: [
      { event: 'SIGNAL', ...(withIds ? { eventId: EID_SIG } : {}), scope: 'external' },
    ],
  };

  const receiver: Record<string, unknown> = {
    ...(withIds ? { id: TID_B } : {}),
    name: 'Receiver',
    scope: 'instance',
    linkedEntity: 'Sig',
    ...(withIds ? { linkedEntityId: ENT } : {}),
    stateMachine: {
      states: [{ name: 'idle', isInitial: true }],
      events: [{ key: 'RECEIVE', name: 'Receive' }],
      transitions: [
        { from: 'idle', to: 'idle', event: 'RECEIVE', effects: [['emit', 'RECEIVED', {}]] },
      ],
    },
    emits: [
      { event: 'RECEIVED', ...(withIds ? { eventId: EID_RCV } : {}), scope: 'external' },
    ],
    // The listen holds the emitter's identity. Under a rename its `trait`
    // name string is NOT updated (references aren't rewritten); the id is
    // the stable key that survives.
    listens: [
      {
        event: 'SIGNAL',
        ...(withIds ? { eventId: EID_SIG } : {}),
        triggers: 'RECEIVE',
        scope: 'external',
        source: {
          kind: 'trait',
          // Frozen at the emitter's ORIGINAL name — never rewritten.
          trait: 'Emitter',
          ...(withIds ? { traitId: TID_A } : {}),
        },
      },
    ],
  };

  return {
    name: 'SignalApp',
    ...(withIds
      ? {
          schemaVersion: 4,
          ledger: {
            schemaVersion: 1 as const,
            entries: {
              [TID_A]: {
                id: TID_A,
                kind: 'trait',
                bakedName: 'Emitter',
                curName: emitterName,
                renames:
                  emitterName === 'Emitter'
                    ? []
                    : [{ from: 'Emitter', to: emitterName, at: '2026-07-14T00:00:00Z' }],
                owner: 'workspace',
              },
            },
          },
        }
      : {}),
    orbitals: [
      {
        ...(withIds ? { id: ORB } : {}),
        name: 'SignalOrbital',
        entity: { name: 'Sig', persistence: 'runtime', fields: [{ name: 'id', type: 'string' }] },
        traits: [emitter, receiver],
        pages: [],
      },
    ],
  } as unknown as OrbitalSchema;
}

/** Fire `GO` and collect the bus event names emitted during the cascade. */
async function runGoAndRecord(schema: OrbitalSchema): Promise<string[]> {
  const runtime = new OrbitalServerRuntime({ debug: false });
  await runtime.register(schema);
  const recorded: string[] = [];
  runtime.getEventBus().onAny((e) => recorded.push(e.type));
  await runtime.processOrbitalEvent('SignalOrbital', { event: 'GO' });
  // Let the async cross-trait cascade (SIGNAL → RECEIVE → RECEIVED) settle.
  await new Promise((r) => setTimeout(r, 30));
  return recorded;
}

describe('V4 interpreter — cross-trait routing survives a trait rename when ids are present', () => {
  it('baseline: routes before any rename (ids)', async () => {
    const recorded = await runGoAndRecord(buildSchema('Emitter', true));
    expect(recorded).toContain('SIGNAL');
    expect(recorded).toContain('RECEIVED');
  });

  it('payoff: rename the emitter (ledger curName edit) — binding intact, RECEIVED still routes', async () => {
    // Emitter renamed to "PulseEmitter"; the receiver's listen still names
    // the OLD "Emitter" but carries the stable traitId + eventId.
    const recorded = await runGoAndRecord(buildSchema('PulseEmitter', true));
    expect(recorded).toContain('SIGNAL');
    expect(recorded).toContain('RECEIVED');
  });

  it('control: the SAME rename breaks a name-only schema (no ids)', async () => {
    const before = await runGoAndRecord(buildSchema('Emitter', false));
    expect(before).toContain('RECEIVED'); // name routing works pre-rename

    const after = await runGoAndRecord(buildSchema('PulseEmitter', false));
    expect(after).toContain('SIGNAL'); // emitter still fires
    expect(after).not.toContain('RECEIVED'); // but the name-keyed listen no longer matches
  });
});

describe('V4 interpreter — StateMachineManager id-first lookup + rename', () => {
  function traitDef(id: string, name: string): TraitDefinition {
    return {
      id: asTraitId(id),
      name,
      states: [{ name: 'idle', isInitial: true }],
      transitions: [{ from: 'idle', to: 'busy', event: 'GO' }],
    };
  }

  it('getStateById resolves by id and survives renameTrait', () => {
    const mgr = new StateMachineManager([traitDef(TID_A, 'Emitter')]);
    // Drive a transition so the trait has non-initial live state.
    mgr.sendEvent('GO');
    expect(mgr.getStateById(TID_A)?.currentState).toBe('busy');

    // Rename: the id holder still reads the live 'busy' state, unchanged.
    mgr.renameTrait('Emitter', 'PulseEmitter');
    expect(mgr.getState('Emitter')).toBeUndefined();
    expect(mgr.getStateById(TID_A)?.currentState).toBe('busy');
    expect(mgr.getState('PulseEmitter')?.currentState).toBe('busy');
  });

  it('getStateById returns undefined for id-free (legacy) traits — name path only', () => {
    const mgr = new StateMachineManager([
      { name: 'Legacy', states: [{ name: 'idle', isInitial: true }], transitions: [] },
    ]);
    expect(mgr.getStateById('trt_01HZZZZZZZZZZZZZZZZZZZZZZZ')).toBeUndefined();
    expect(mgr.getState('Legacy')?.currentState).toBe('idle');
  });
});
