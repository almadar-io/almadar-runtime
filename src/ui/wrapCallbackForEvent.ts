import type { PatternCallbackArg } from '@almadar/core/patterns';
import type { EventPayload, EventPayloadValue } from '@almadar/core';

/**
 * Build the runtime wrapper that turns a string-typed callback prop
 * (e.g. `onTabChange: "TAB_CHANGED"`) into a function the component can
 * invoke. The wrapper consumes the component's positional callback args
 * by name and dispatches an OBJECT payload `{ argName: value, ... }` so
 * the bus carries the trait's declared event payload, not a raw
 * positional spread. Mirrors the codegen wrapper in
 * `orbital-shell-typescript/src/codegen/pattern.rs` (C2 compiled path).
 *
 * Single-sourcing this logic across runtime and codegen (shared shape,
 * not shared code — codegen emits string source) is what keeps the two
 * paths from silently diverging on payload shape.
 */
export function wrapCallbackForEvent(
  qualifiedEvent: string,
  callbackArgs: PatternCallbackArg[] | undefined,
  emit: (eventKey: string, payload?: EventPayload) => void,
): (...args: EventPayloadValue[]) => void {
  const argNames = (callbackArgs ?? []).map((a) => a.name);
  if (argNames.length === 0) {
    return () => emit(qualifiedEvent);
  }
  return (...args: EventPayloadValue[]) => {
    const payload: EventPayload = {};
    for (let i = 0; i < argNames.length; i += 1) {
      payload[argNames[i]] = args[i];
    }
    emit(qualifiedEvent, payload);
  };
}
