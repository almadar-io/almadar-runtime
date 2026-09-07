import { vi } from 'vitest';
import type { EffectHandlers } from '../../src/types.js';

type Stubbed = 'persist' | 'set' | 'callService';

/** Complete `EffectHandlers` from the members a test exercises; the three the
 *  contract requires are stubbed (denied persist, no-op set, null service). */
export function stubEffectHandlers(
    handlers: Omit<EffectHandlers, Stubbed> & Partial<Pick<EffectHandlers, Stubbed>>,
): EffectHandlers {
    return {
        persist: vi.fn(async () => undefined),
        set: vi.fn(),
        callService: vi.fn(async () => null),
        ...handlers,
    };
}
