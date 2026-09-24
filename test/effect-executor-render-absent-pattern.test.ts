/**
 * `ClientRenderUITuple`'s pattern slot is `PatternConfig | null` — null means
 * "clear this trait's slot". A render-ui whose pattern argument is absent
 * (`(render-ui modal)`, or an expression that evaluated to nothing) must reach
 * the handler as that clear, never as `undefined` cast to a pattern: the client
 * destructured `undefined` and crashed the whole page (std-realtime-chat,
 * stateless in-process repro 2026-09-24).
 */
import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext, type EffectHandlers } from '../src/index.js';

describe('EffectExecutor render-ui with an absent pattern', () => {
  it('hands the handler null, the clear sentinel', async () => {
    const calls: Array<Parameters<NonNullable<EffectHandlers['renderUI']>>> = [];
    const renderUI: EffectHandlers['renderUI'] = (...args) => {
      calls.push(args);
    };
    const handlers = stubEffectHandlers({ emit: vi.fn(), renderUI });
    const bindings: BindingContext = { entity: { id: 'e1' } };
    const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
    const executor = new EffectExecutor({ handlers, bindings, context });
    await executor.execute(['render-ui', 'modal']);
    expect(calls).toEqual([['modal', null, undefined, undefined]]);
  });
});
