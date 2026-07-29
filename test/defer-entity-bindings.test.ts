/**
 * deferEntityBindings — the render-ui arg walk that carries
 * `@entity`-dependent leaves into slot content as `RenderBindingMarker`s
 * instead of resolving them at flush time. Pins the deferral boundary:
 * entity-only leaves defer, payload-referencing leaves stay eager
 * (`@payload` is event-scoped), `fn` lambdas pass through raw, literal
 * children trees recurse, and everything else resolves through the same
 * eager interpolation as the non-deferring path. Also pins the
 * EffectExecutor `deferRenderBindings` wiring end to end.
 */

import { describe, it, expect } from 'vitest';
import { deferEntityBindings, createContextFromBindings } from '../src/BindingResolver.js';
import { EffectExecutor } from '../src/EffectExecutor.js';
import { isRenderBindingMarker, type PatternConfig } from '@almadar/core';

const ctx = createContextFromBindings({
  entity: { hp: 7 },
  payload: { row: { id: 'r1' } },
  state: 'playing',
  config: { label: 'static label' },
});

describe('deferEntityBindings', () => {
  it('defers a pure @entity binding to a marker', () => {
    const out = deferEntityBindings('@entity.hp', ctx);
    expect(isRenderBindingMarker(out)).toBe(true);
    if (isRenderBindingMarker(out)) {
      expect(out.expression).toBe('@entity.hp');
    }
  });

  it('defers an embedded-binding string', () => {
    const out = deferEntityBindings('HP: @entity.hp', ctx);
    expect(isRenderBindingMarker(out)).toBe(true);
  });

  it('defers an entity-referencing s-expression as one marker', () => {
    const expr = ['+', '@entity.hp', 1];
    const out = deferEntityBindings(expr, ctx);
    expect(isRenderBindingMarker(out)).toBe(true);
    if (isRenderBindingMarker(out)) {
      expect(out.expression).toEqual(expr);
    }
  });

  it('keeps payload-referencing leaves eager', () => {
    expect(deferEntityBindings('@payload.row', ctx)).toEqual({ id: 'r1' });
    // Mixed entity+payload s-expr: payload dies at render time, so the
    // whole expression must evaluate eagerly at flush.
    const mixed = deferEntityBindings(['str/concat', '@entity.hp', '@payload.row'], ctx);
    expect(isRenderBindingMarker(mixed)).toBe(false);
  });

  it('resolves non-entity leaves eagerly', () => {
    expect(deferEntityBindings('@config.label', ctx)).toBe('static label');
    expect(deferEntityBindings(42, ctx)).toBe(42);
    expect(deferEntityBindings('plain', ctx)).toBe('plain');
  });

  it('passes fn render lambdas through raw', () => {
    const lambda = ['fn', 'item', { type: 'typography', content: '@item.name' }];
    expect(deferEntityBindings(lambda, ctx)).toBe(lambda);
  });

  it('recurses into literal children trees, marking nested entity leaves', () => {
    const children = [
      { type: 'typography', content: 'HP: @entity.hp' },
      { type: 'button', label: 'Attack' },
    ];
    const out = deferEntityBindings(children, ctx);
    expect(Array.isArray(out)).toBe(true);
    if (!Array.isArray(out)) return;
    const [first, second] = out as Array<Record<string, unknown>>;
    expect(isRenderBindingMarker((first as { content: unknown }).content)).toBe(true);
    expect((second as { label: unknown }).label).toBe('Attack');
  });
});

describe('EffectExecutor deferRenderBindings', () => {
  const renderEffect = ['render-ui', 'main', { type: 'typography', content: 'HP: @entity.hp' }];

  it('carries markers into the renderUI handler when deferring', async () => {
    let captured: PatternConfig | null = null;
    const executor = new EffectExecutor({
      handlers: {
        renderUI: (_slot, pattern) => { captured = pattern; },
      },
      bindings: { entity: { hp: 7 }, payload: {}, state: 'playing' },
      context: { traitName: 'T', state: 'playing', transition: 'a->b' },
      deferRenderBindings: true,
    });
    await executor.execute(renderEffect);
    expect(captured).not.toBeNull();
    const content = (captured as unknown as Record<string, unknown>).content;
    expect(isRenderBindingMarker(content)).toBe(true);
  });

  it('resolves eagerly when not deferring (server persistent-entity path)', async () => {
    let captured: PatternConfig | null = null;
    const executor = new EffectExecutor({
      handlers: {
        renderUI: (_slot, pattern) => { captured = pattern; },
      },
      bindings: { entity: { hp: 7 }, payload: {}, state: 'playing' },
      context: { traitName: 'T', state: 'playing', transition: 'a->b' },
    });
    await executor.execute(renderEffect);
    expect((captured as unknown as Record<string, unknown>).content).toBe('HP: 7');
  });
});
