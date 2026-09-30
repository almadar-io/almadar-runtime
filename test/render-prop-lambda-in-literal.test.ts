/**
 * A lambda stored in a literal inside an operator call — the action item's
 * per-row `when` after config folding puts `[{ event, when: (fn row …) }]`
 * inside `(array/filter <list> <role gate>)` — evaluates to a function, which
 * JSON drops at the server bridge. The render-prop interpolation hands the
 * renderer the lambda's `(fn …)` source instead, so the row condition
 * reaches the list component on the wire.
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeValue, SExpr } from '@almadar/core';
import { interpolateValue, createContextFromBindings } from '../src/evaluation/BindingResolver.js';

const ctx = createContextFromBindings({
  entity: {},
  payload: {},
  state: 'idle',
  config: { viewerRole: 'member' },
  user: { id: 'u-alice', role: 'member', permissions: [] },
});

const when: SExpr = ['fn', 'row', ['=', ['object/get', '@row', 'ownerId'], '@user.id']];
const roleGate: SExpr = ['fn', 'action', ['or', ['=', ['array/len', ['object/get', '@action', 'roles', []]], 0], ['array/includes', ['object/get', '@action', 'roles', []], '@config.viewerRole']]];

const wire = (value: RuntimeValue): RuntimeValue => JSON.parse(JSON.stringify(value));

describe('a lambda inside a literal in a render-prop operator call', () => {
  it('reaches the wire as its (fn …) source', () => {
    const expr: SExpr = ['array/filter', [{ event: 'VIEW', label: 'Open' }, { event: 'EDIT', label: 'Edit', when }], roleGate];
    expect(wire(interpolateValue(expr, ctx))).toEqual([
      { event: 'VIEW', label: 'Open' },
      { event: 'EDIT', label: 'Edit', when },
    ]);
  });

  it('control: the role gate still filters, and a gated-out item takes its lambda with it', () => {
    const expr: SExpr = ['array/filter', [{ event: 'VIEW', label: 'Open' }, { event: 'DELETE', label: 'Delete', roles: ['manager'], when }], roleGate];
    expect(wire(interpolateValue(expr, ctx))).toEqual([{ event: 'VIEW', label: 'Open' }]);
  });

  it('reaches the wire from a literal nested deeper than the list', () => {
    const expr: SExpr = ['array/map', [1], ['fn', 'n', { groups: [{ items: [{ when }] }] }]];
    expect(wire(interpolateValue(expr, ctx))).toEqual([{ groups: [{ items: [{ when }] }] }]);
  });

  it('control: the bound config form is unchanged', () => {
    const bound = createContextFromBindings({
      entity: {},
      payload: {},
      state: 'idle',
      config: { viewerRole: 'member', itemActions: [{ event: 'EDIT', label: 'Edit', when }] },
    });
    const expr: SExpr = ['array/filter', '@config.itemActions', roleGate];
    expect(wire(interpolateValue(expr, bound))).toEqual([{ event: 'EDIT', label: 'Edit', when }]);
  });

  it('control: a literal with no lambda comes back as the same values', () => {
    const expr: SExpr = ['array/filter', [{ event: 'VIEW', label: 'Open' }], roleGate];
    expect(interpolateValue(expr, ctx)).toEqual([{ event: 'VIEW', label: 'Open' }]);
  });

  it('edge: a lambda that is consumed by the operator (not stored) never surfaces', () => {
    const expr: SExpr = ['array/map', [1, 2], ['fn', 'n', ['*', '@n', 2]]];
    expect(interpolateValue(expr, ctx)).toEqual([2, 4]);
  });
});
