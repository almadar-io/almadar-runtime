// The dispatch memory is owned by @almadar/core (shared with compiled clients); the runtime adds the effect view.
import type { DispatchScope } from '@almadar/core';

export { DispatchMemory, type DispatchScope as DispatchView } from '@almadar/core';

/** An effect's view: the guard's view plus the transition it belongs to (`state` reads `toState`). */
export interface EffectDispatch extends DispatchScope {
  fromState: string;
  toState: string;
}
