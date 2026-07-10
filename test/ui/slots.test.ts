import { describe, it, expect, vi } from 'vitest';
import type { AnyPatternConfig, UISlot } from '@almadar/core';
import { createSlotSetter } from '../../src/ui/slots';

describe('@almadar/runtime/ui createSlotSetter', () => {
  it('adapts a minimal SlotManager to the SlotSetter shape', () => {
    const setContent = vi.fn();
    const clearSlot = vi.fn();
    const manager = {
      getContent: () => undefined,
      setContent,
      clearSlot,
      getAllSlots: () => new Map(),
      subscribe: () => () => {},
    };

    const setter = createSlotSetter(manager);

    const pattern: AnyPatternConfig = { type: 'button', label: 'Click' };
    setter.addPattern('main', pattern, { disabled: true });
    expect(setContent).toHaveBeenCalledWith({
      slot: 'main',
      pattern,
      props: { disabled: true },
    });

    setter.clearSlot('main');
    expect(clearSlot).toHaveBeenCalledWith('main');
  });
});
