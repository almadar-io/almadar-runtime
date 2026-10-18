/**
 * A `set` whose value is a whole binding that resolves to nothing stores null, never the binding's text.
 * Twin of `orbital-core-runtime` `kernel::set_object_literal_tests` (G-ORBITAL-CORE-019).
 */
import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext, type EffectHandlers } from '../src/index.js';

async function stored(value: string): Promise<{ called: boolean; value: unknown }> {
  const calls: Array<Parameters<NonNullable<EffectHandlers['set']>>> = [];
  const set: EffectHandlers['set'] = (...args) => {
    calls.push(args);
  };
  const handlers = stubEffectHandlers({ emit: vi.fn(), set });
  const bindings: BindingContext = { entity: { id: 'e1' }, payload: { data: { id: 'abc' } } };
  const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
  await new EffectExecutor({ handlers, bindings, context }).execute(['set', '@entity.prof', value]);
  return { called: calls.length > 0, value: calls[0]?.[2] };
}

describe('EffectExecutor set of a bare binding', () => {
  it('a binding that resolves to nothing stores null', async () => {
    expect(await stored('@payload.status')).toEqual({ called: true, value: null });
  });
  it('control: a binding that resolves stores its value', async () => {
    expect(await stored('@payload.data.id')).toEqual({ called: true, value: 'abc' });
  });
  it('edge: a plain string is stored as written', async () => {
    expect(await stored('open')).toEqual({ called: true, value: 'open' });
  });
});
