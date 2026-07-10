import { describe, it, expect } from 'vitest';
import type { EventPayload } from '@almadar/core';
import { wrapCallbackForEvent } from '../../src/ui/wrapCallbackForEvent';

describe('@almadar/runtime/ui wrapCallbackForEvent', () => {
  it('emits the event with no payload when callbackArgs is empty', () => {
    const emitted: Array<{ event: string; payload?: EventPayload }> = [];
    const wrap = wrapCallbackForEvent('UI:Orbital.Trait.TAB_CHANGED', [], (event, payload) => {
      emitted.push({ event, payload });
    });
    wrap();
    expect(emitted).toEqual([{ event: 'UI:Orbital.Trait.TAB_CHANGED' }]);
  });

  it('emits an object payload keyed by arg names', () => {
    const emitted: Array<{ event: string; payload?: EventPayload }> = [];
    const wrap = wrapCallbackForEvent(
      'UI:Orbital.Trait.FILTER_CHANGED',
      [{ name: 'value' }, { name: 'index' }],
      (event, payload) => {
        emitted.push({ event, payload });
      },
    );
    wrap('active', 3);
    expect(emitted).toEqual([
      { event: 'UI:Orbital.Trait.FILTER_CHANGED', payload: { value: 'active', index: 3 } },
    ]);
  });
});
