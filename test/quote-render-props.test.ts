/**
 * G-CROSS-041: a quoted guard/effect handed to a render-ui prop arrives as
 * data — the eager and the deferring prop walks both decode the encoded body
 * and never resolve, defer or `@config`-substitute the bindings inside it.
 */

import { describe, it, expect } from 'vitest';
import {
  createContextFromBindings,
  deferEntityBindings,
  interpolateValue,
} from '../src/evaluation/BindingResolver.js';
import { isRenderBindingMarker, quoteExpr, type SExpr } from '@almadar/core';

const ctx = createContextFromBindings({
  entity: { status: 'pending' },
  payload: { amount: 7 },
  config: { label: 'static label' },
});

const GUARD: SExpr = ['>', '@payload.amount', 0];
const EFFECT_ARGS: SExpr = ['@entity.status', '@config.label'];

describe('quote in render-ui props', () => {
  it('the eager walk decodes the quoted guard verbatim', () => {
    expect(interpolateValue(quoteExpr(GUARD), ctx)).toEqual(GUARD);
  });

  it('control: the unquoted guard is evaluated', () => {
    expect(interpolateValue(GUARD, ctx)).toBe(true);
  });

  it('the deferring walk decodes instead of deferring an entity binding', () => {
    const out = deferEntityBindings(quoteExpr(EFFECT_ARGS), ctx);
    expect(isRenderBindingMarker(out)).toBe(false);
    expect(out).toEqual(['@entity.status', '@config.label']);
  });

  it('control: the unquoted entity binding defers to a marker', () => {
    expect(isRenderBindingMarker(deferEntityBindings('@entity.status', ctx))).toBe(true);
  });

  it('a whole quoted transition object reaches the pattern as data', () => {
    const transition: SExpr = {
      from: 'pending',
      to: 'paid',
      event: 'PAY',
      guard: GUARD,
      effects: [{ type: 'set', args: EFFECT_ARGS }],
      index: 0,
    };
    const props = interpolateValue({ type: 'avl-transition-explainer', transition: quoteExpr(transition) }, ctx);
    expect(props).toEqual({ type: 'avl-transition-explainer', transition });
  });
});
