/**
 * The API-boundary payload check enforces the container a field's declared
 * `type` names, not only `required`. An object arriving in a `[object]` slot
 * used to pass the boundary and crash inside the evaluator's array ops —
 * `(t ?? []) is not iterable` / `(s ?? []).map is not a function` on the
 * game boards — instead of being rejected with the event and field named.
 */
import { describe, it, expect } from 'vitest';
import type { PayloadField } from '@almadar/core';
import { validateEventPayload } from '../src/traits/PayloadValidator.js';

const FX_ELEMENT: PayloadField[] = [
  { name: 'id', type: 'string', required: true },
  { name: 'x', type: 'number', required: true },
];

const BURST_SCHEMA: PayloadField[] = [{ name: 'particles', type: '[object]', properties: FX_ELEMENT }];

describe('validateEventPayload — declared container', () => {
  it('rejects an object in an [object] field', () => {
    expect(validateEventPayload('BURST', { particles: { id: 'p', x: 1 } }, BURST_SCHEMA)).toEqual([
      { event: 'BURST', field: 'particles', reason: 'wrong-type', expectedType: '[object]' },
    ]);
  });

  it('control: accepts an array in an [object] field, including an empty one', () => {
    expect(validateEventPayload('BURST', { particles: [{ id: 'p', x: 1 }] }, BURST_SCHEMA)).toEqual([]);
    expect(validateEventPayload('BURST', { particles: [] }, BURST_SCHEMA)).toEqual([]);
  });

  it('rejects a scalar in a scalar-array field', () => {
    expect(validateEventPayload('TAGS', { tags: 'a' }, [{ name: 'tags', type: '[string]' }])).toEqual([
      { event: 'TAGS', field: 'tags', reason: 'wrong-type', expectedType: '[string]' },
    ]);
  });

  it('rejects an array in an object field', () => {
    expect(validateEventPayload('SAVE', { data: [1] }, [{ name: 'data', type: 'object', properties: FX_ELEMENT }])).toEqual([
      { event: 'SAVE', field: 'data', reason: 'wrong-type', expectedType: 'object' },
    ]);
  });

  it('checks optional fields when present, and skips them when absent or null', () => {
    expect(validateEventPayload('BURST', {}, BURST_SCHEMA)).toEqual([]);
    expect(validateEventPayload('BURST', { particles: null }, BURST_SCHEMA)).toEqual([]);
  });

  it('keeps required-field reporting unchanged', () => {
    const required: PayloadField[] = [{ name: 'particles', type: '[object]', required: true }];
    expect(validateEventPayload('BURST', {}, required)).toEqual([
      { event: 'BURST', field: 'particles', reason: 'missing', expectedType: '[object]' },
    ]);
  });

  it('leaves opaque types (scalars, entity refs, type variables) to other rungs', () => {
    const schema: PayloadField[] = [
      { name: 'a', type: 'number' },
      { name: 'b', type: '@entity' },
      { name: 'c', type: '$t' },
      { name: 'd', type: 'CartItem' },
    ];
    expect(validateEventPayload('E', { a: 'x', b: 'id-1', c: [1], d: 'row' }, schema)).toEqual([]);
  });
});
