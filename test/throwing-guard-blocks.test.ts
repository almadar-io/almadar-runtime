/**
 * A guard that throws blocks its arm exactly like a false guard, and the next
 * candidate is tried — the same rule on every path (Rust kernel twin:
 * orbital-core `state_machine::core` throwing-guard tests). It never fires the
 * arm (drift D-7, G-CROSS-158).
 */
import { describe, it, expect } from 'vitest';
import { processEvent } from '../src/traits/StateMachineCore.js';
import type { TraitDefinition, TraitState } from '../src/types.js';

const traitState: TraitState = {
  traitName: 'Guarded',
  currentState: 'idle',
  previousState: null,
  lastEvent: null,
  context: {},
};

function trait(secondGuard: TraitDefinition['transitions'][number]['guard']): TraitDefinition {
  return {
    name: 'Guarded',
    states: [{ name: 'idle', isInitial: true }, { name: 'done' }],
    transitions: [
      { from: 'idle', event: 'GO', to: 'idle', guard: ['=', 1], effects: [['emit', 'THROWN_ARM', {}]] },
      { from: 'idle', event: 'GO', to: 'done', guard: secondGuard, effects: [['emit', 'NEXT_ARM', {}]] },
    ],
  };
}

describe('a guard that throws', () => {
  it('blocks its arm like a false guard; the next arm is tried and fires', () => {
    const result = processEvent({ traitState, trait: trait(['=', 1, 1]), eventKey: 'GO', payload: {}, entityData: {} });
    expect(result.executed).toBe(true);
    expect(result.newState).toBe('done');
    expect(JSON.stringify(result.effects)).toContain('NEXT_ARM');
    expect(JSON.stringify(result.effects)).not.toContain('THROWN_ARM');
  });

  it('control: when no other arm passes, nothing fires and the state is unchanged', () => {
    const result = processEvent({ traitState, trait: trait(['=', 1, 2]), eventKey: 'GO', payload: {}, entityData: {} });
    expect(result.executed).toBe(false);
    expect(result.newState).toBe('idle');
  });
});
