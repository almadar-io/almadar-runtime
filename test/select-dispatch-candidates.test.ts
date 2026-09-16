/**
 * `selectDispatchCandidates` — the trait-eligibility decision extracted out
 * of `StateMachineManager.sendEvent`'s inline loop so the stateless
 * per-request transition path (`playground-runtime`'s `transition-handler.ts`)
 * shares the identical answer instead of an independently-written copy that
 * only happens to agree. See CLAUDE.md's "no duplicates" doctrine and the
 * `_activeTraits` bug this converges (2026-09-16).
 */

import { describe, it, expect } from 'vitest';
import { selectDispatchCandidates } from '../src/index.js';

describe('selectDispatchCandidates', () => {
  it('with neither targetTrait nor activeTraits, every trait is eligible', () => {
    const result = selectDispatchCandidates(['TraitA', 'TraitB', 'TraitC'], {});
    expect(result).toEqual(['TraitA', 'TraitB', 'TraitC']);
  });

  it('targetTrait wins outright — only that trait, regardless of activeTraits', () => {
    const result = selectDispatchCandidates(['TraitA', 'TraitB'], {
      targetTrait: 'TraitB',
      activeTraits: new Set(['TraitA']),
    });
    expect(result).toEqual(['TraitB']);
  });

  it('targetTrait naming a trait not in the list yields no candidates', () => {
    expect(
      selectDispatchCandidates(['TraitA'], { targetTrait: 'Nonexistent' }),
    ).toEqual([]);
  });

  it('activeTraits narrows to the page-scoped set when targetTrait is absent', () => {
    const result = selectDispatchCandidates(['TraitA', 'TraitB', 'TraitC'], {
      activeTraits: new Set(['TraitA', 'TraitC']),
    });
    expect(result).toEqual(['TraitA', 'TraitC']);
  });

  it('an empty activeTraits set excludes every trait (not treated as "no filter")', () => {
    const result = selectDispatchCandidates(['TraitA', 'TraitB'], {
      activeTraits: new Set(),
    });
    expect(result).toEqual([]);
  });

  it('canHandle is consulted only after targetTrait/activeTraits already passed', () => {
    const asked: string[] = [];
    const result = selectDispatchCandidates(['TraitA', 'TraitB', 'TraitC'], {
      activeTraits: new Set(['TraitA', 'TraitB']),
      canHandle: (name) => {
        asked.push(name);
        return name === 'TraitA';
      },
    });
    expect(result).toEqual(['TraitA']);
    // TraitC was excluded by activeTraits before canHandle was ever asked.
    expect(asked).toEqual(['TraitA', 'TraitB']);
  });

  it('targetTrait bypasses canHandle entirely', () => {
    const result = selectDispatchCandidates(['TraitA'], {
      targetTrait: 'TraitA',
      canHandle: () => false,
    });
    expect(result).toEqual(['TraitA']);
  });
});
