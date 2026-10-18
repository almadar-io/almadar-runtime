/**
 * A `render-ui` slot written as a binding paints into the slot it names. One that names no slot (an unset
 * knob) fails the effect, never paints into a slot of that text. Twin of `orbital-core-runtime`
 * `tests/unset_config_knob.rs` (G-ORBITAL-CORE-027).
 */
import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext, type EffectHandlers } from '../src/index.js';

async function paintedSlots(bindings: BindingContext, slot: string): Promise<{ slots: string[]; failed: boolean }> {
  const slots: string[] = [];
  const renderUI: EffectHandlers['renderUI'] = (s) => {
    slots.push(s);
  };
  const handlers = stubEffectHandlers({ emit: vi.fn(), renderUI });
  const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
  const executor = new EffectExecutor({ handlers, bindings, context });
  const failed = await executor.execute(['render-ui', slot, { type: 'typography', content: 'x' }]).then(() => false, () => true);
  return { slots, failed };
}

describe('EffectExecutor render-ui slot bound to a knob', () => {
  it('paints into the knob value', async () => {
    expect(await paintedSlots({ entity: { id: 'e1' }, config: { detailSlot: 'modal' } }, '@config.detailSlot')).toEqual({ slots: ['modal'], failed: false });
  });

  it('control: a literal slot paints into itself', async () => {
    expect(await paintedSlots({ entity: { id: 'e1' } }, 'main')).toEqual({ slots: ['main'], failed: false });
  });

  it('edge: a slot bound to an unset knob fails and paints nothing', async () => {
    expect(await paintedSlots({ entity: { id: 'e1' }, config: {} }, '@config.detailSlot')).toEqual({ slots: [], failed: true });
  });
});
