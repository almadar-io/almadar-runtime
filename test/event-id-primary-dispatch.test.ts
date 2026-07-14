/**
 * Rabit V4 W3d-JS — id-primary EVENT DISPATCH (interpreter path).
 *
 * The transition-match terminal (`findMatchingTransitions` in
 * `StateMachineCore.ts`) now prefers `Transition.eventId` over
 * `Transition.event` when the fired event carries an id. Proves two things:
 *  - a transition survives a stale/renamed `event` string as long as its
 *    `eventId` still matches the fired event's id (id-primary dispatch);
 *  - a name-only event (no id anywhere) still dispatches via the existing
 *    name fallback — old, id-free schemas are unaffected.
 */
import { describe, it, expect } from 'vitest';
import { StateMachineManager, type TraitDefinition } from '../src/StateMachineCore.js';
import { asEventId } from '@almadar/core';

const EID_GO = asEventId('evt_01HGOGOGOGOGOGOGOGOGOGOGOG');
const EID_OTHER = asEventId('evt_01HOTHEROTHEROTHEROTHEROTH');

describe('V4 interpreter — id-primary transition dispatch', () => {
  it('fires a transition whose `event` name is stale when `eventId` matches the fired event id', () => {
    const trait: TraitDefinition = {
      name: 'Door',
      states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
      transitions: [
        {
          from: 'closed',
          to: 'open',
          // Deliberately WRONG name — a rename that never touched this
          // string. Only the id sibling reflects the current identity.
          event: 'STALE_EVENT_NAME',
          eventId: EID_GO,
        },
      ],
    };
    const mgr = new StateMachineManager([trait]);

    // Dispatch under the CURRENT name ('OPEN_DOOR') with the matching id.
    // Name comparison alone would miss; id comparison hits.
    const results = mgr.sendEvent('OPEN_DOOR', undefined, undefined, undefined, EID_GO);

    expect(results).toHaveLength(1);
    expect(results[0]?.result.executed).toBe(true);
    expect(mgr.getState('Door')?.currentState).toBe('open');
  });

  it('does not fire when the dispatched id does not match the transition id', () => {
    const trait: TraitDefinition = {
      name: 'Door',
      states: [{ name: 'closed', isInitial: true }, { name: 'open' }],
      transitions: [
        { from: 'closed', to: 'open', event: 'OPEN_DOOR', eventId: EID_GO },
      ],
    };
    const mgr = new StateMachineManager([trait]);

    // Same name would match, but a mismatched id takes priority and blocks
    // the transition — id-primary means id wins over name once both sides
    // carry one.
    const results = mgr.sendEvent('OPEN_DOOR', undefined, undefined, undefined, EID_OTHER);

    expect(results).toHaveLength(0);
    expect(mgr.getState('Door')?.currentState).toBe('closed');
  });

  it('name-only event (no ids anywhere) still dispatches via the legacy name fallback', () => {
    const trait: TraitDefinition = {
      name: 'Legacy',
      states: [{ name: 'idle', isInitial: true }, { name: 'busy' }],
      transitions: [{ from: 'idle', to: 'busy', event: 'GO' }],
    };
    const mgr = new StateMachineManager([trait]);

    // No eventId supplied by the caller, transition carries none either —
    // falls back to the pre-V4 name comparison, unaffected by this change.
    const results = mgr.sendEvent('GO');

    expect(results).toHaveLength(1);
    expect(mgr.getState('Legacy')?.currentState).toBe('busy');
  });

  it('caller-supplied eventId with a transition that has none falls back to name match', () => {
    const trait: TraitDefinition = {
      name: 'Mixed',
      states: [{ name: 'idle', isInitial: true }, { name: 'busy' }],
      // No eventId on the transition — id-free authoring, even though the
      // caller happens to carry one (e.g. a listen with `triggersId` firing
      // into a trait that predates the V4 flip).
      transitions: [{ from: 'idle', to: 'busy', event: 'GO' }],
    };
    const mgr = new StateMachineManager([trait]);

    const results = mgr.sendEvent('GO', undefined, undefined, undefined, EID_GO);

    expect(results).toHaveLength(1);
    expect(mgr.getState('Mixed')?.currentState).toBe('busy');
  });
});
