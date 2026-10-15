/**
 * D-A21 gate: whatever @almadar/core's compiler turns into a RowPredicate must select exactly the rows the evaluator
 * selects (`applyRowAccess`), over rows with missing and null fields, in every wrapper (bare, not, or, and). A shape
 * that differs must not compile.
 */
import { describe, expect, it } from 'vitest';
import { compileRowPredicate, rowMatchesPredicate, type EntityRow, type SExpr } from '@almadar/core';
import { applyRowAccess } from '@almadar/evaluator/entityAccess';

const f = (n: string): SExpr => ['object/get', '@entity', n];
const LEAVES: Record<string, SExpr> = {
  eqS: ['=', f('s'), 'a'], neS: ['!=', f('s'), 'a'], eqN: ['=', f('n'), 0], neN: ['!=', f('n'), 3],
  eqNull: ['=', f('n'), null], neNull: ['!=', f('n'), null],
  lt: ['<', f('n'), 3], le: ['<=', f('n'), 3], gt: ['>', f('n'), 3], ge: ['>=', f('n'), 3],
  ltS: ['<', f('s'), 'b'], flipped: ['>', 3, f('n')],
  member: ['array/includes', ['a', 'b'], f('s')], hasElement: ['array/includes', f('t'), 'a'],
  containsCs: ['str/includes', f('s'), 'a'], containsCi: ['str/includes', ['str/lower', f('s')], 'a'],
  eqB: ['=', f('b'), true], neB: ['!=', f('b'), true],
};
const WRAPS: Array<[string, (e: SExpr) => SExpr]> = [
  ['bare', (e) => e],
  ['not', (e) => ['not', e]],
  ['or', (e) => ['or', e, ['=', f('s'), 'zzz']]],
  ['and', (e) => ['and', e, ['!=', f('s'), 'q']]],
];
const MIXED: EntityRow[] = [
  { id: 'r1' },
  { id: 'r2', s: null, n: null, t: null, b: null },
  { id: 'r3', s: 'a', n: 3, t: ['a'], b: true },
  { id: 'r4', s: 'z', n: 0, t: ['z'], b: false },
  { id: 'r5', s: 'A', n: 5, t: [], b: false },
  { id: 'r6', s: 'b', n: 2, t: ['a', 'b'], b: true },
];
const PRESENT: EntityRow[] = MIXED.filter((r) => r.s !== undefined && r.s !== null);

const ids = (rows: EntityRow[]): string[] => rows.map((r) => String(r.id));

describe.each(Object.entries(LEAVES))('%s', (_name, leaf) => {
  it.each(WRAPS)('%s: compiles only where it agrees on missing and null fields', (_w, wrapExpr) => {
    const expr = wrapExpr(leaf);
    const compiled = compileRowPredicate(expr, {});
    if (compiled.kind !== 'predicate') return;
    const viaEvaluator = ids(applyRowAccess(MIXED, undefined, expr, {}));
    const viaPredicate = ids(MIXED.filter((r) => rowMatchesPredicate(r, compiled.predicate)));
    expect(viaPredicate).toEqual(viaEvaluator);
  });

  it.each(WRAPS)('%s: with every field required it agrees on rows that have them', (_w, wrapExpr) => {
    const expr = wrapExpr(leaf);
    const compiled = compileRowPredicate(expr, { requiredFields: new Set(['s', 'n', 't', 'b']) });
    if (compiled.kind !== 'predicate') return;
    const viaEvaluator = ids(applyRowAccess(PRESENT, undefined, expr, {}));
    const viaPredicate = ids(PRESENT.filter((r) => rowMatchesPredicate(r, compiled.predicate)));
    expect(viaPredicate).toEqual(viaEvaluator);
  });
});

describe('the ordering comparisons the evaluator and RowPredicate disagree on do not compile without a required field', () => {
  it.each(['lt', 'le', 'gt', 'ge'])('%s', (name) => {
    expect(compileRowPredicate(LEAVES[name], {}).kind).toBe('null-semantics');
  });
});
