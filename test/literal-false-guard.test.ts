/**
 * A guard that resolve constant-folded to the LITERAL `false` must block its
 * arm — `if (!guard)` used to classify it as "unguarded" and fire it
 * unconditionally, which is how std-browse's `selfFetch: false` view traits
 * kept racing the hydrated fetch they were configured to suppress.
 */
import { describe, it, expect } from 'vitest';
import { processEvent } from '../src/StateMachineCore.js';

const trait = {
  name: 'GuardedTrait',
  transitions: [
    { from: 'idle', event: 'GO', to: 'idle', guard: false, effects: [['emit', 'FIRED', {}]] },
    { from: 'idle', event: 'GO', to: 'idle', guard: ['not', false], effects: [['emit', 'HELD_FIRED', {}]] },
  ],
};

describe('literal boolean guards', () => {
  it('a literal false guard blocks; the sibling literal-true arm wins', () => {
    const result = processEvent({
      trait: trait as never,
      traitState: { traitName: 'GuardedTrait', currentState: 'idle' } as never,
      eventKey: 'GO',
      payload: {},
      entityData: {},
    } as never);
    expect(result.executed).toBe(true);
    expect(JSON.stringify(result.effects)).toContain('HELD_FIRED');
    expect(JSON.stringify(result.effects)).not.toContain('"FIRED"');
  });
});
