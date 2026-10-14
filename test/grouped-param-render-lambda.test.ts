/**
 * A per-row render lambda travels to the renderer as its `(fn …)` source. The compiler groups a
 * multi-parameter lambda as `["fn", ["col", "colIndex"], body]` (the form `@almadar/ui`'s
 * `isFnFormLambda` accepts); the resolver kept only the single-parameter shorthand, so a grouped
 * one (std-board's `renderItem`) was evaluated into a function, dropped at the server bridge, and
 * the board painted rows with no field values.
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeValue, SExpr } from '@almadar/core';
import { deferEntityBindings, interpolateValue, createContextFromBindings } from '../src/evaluation/BindingResolver.js';

const ctx = createContextFromBindings({ entity: { id: 'a' }, payload: {}, state: 'idle', config: {} });
const wire = (value: RuntimeValue): RuntimeValue => JSON.parse(JSON.stringify(value));

const body = { label: '@col.key', index: '@colIndex' };
const grouped: SExpr = ['fn', ['col', 'colIndex'], body];
const single: SExpr = ['fn', 'col', body];

describe('a render lambda with grouped parameters', () => {
  it('interpolateValue keeps it as its (fn …) source', () => {
    expect(wire(interpolateValue({ renderItem: grouped }, ctx))).toEqual({ renderItem: grouped });
  });

  it('deferEntityBindings keeps it as its (fn …) source', () => {
    expect(wire(deferEntityBindings({ renderItem: grouped } as SExpr, ctx))).toEqual({ renderItem: grouped });
  });

  it('control: the single-parameter shorthand is unchanged', () => {
    expect(wire(interpolateValue({ renderItem: single }, ctx))).toEqual({ renderItem: single });
  });

  it('control: a lambda handed to an operator is still evaluated, grouped or not', () => {
    const expr: SExpr = ['array/map', [{ key: 'a' }, { key: 'b' }], ['fn', ['c', 'i'], ['object/get', '@c', 'key']]];
    expect(interpolateValue(expr, ctx)).toEqual(['a', 'b']);
  });
});
