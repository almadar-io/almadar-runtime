import { describe, it, expect, vi } from 'vitest';
import { createClientEffectHandlers } from '../src/ClientEffectHandlers.js';

// Bridge mode (no live client entity): the server executes every persist,
// so the client handlers must declare the placeholder as DELEGATED — the
// runtime executor then neither logs a denial nor fires the declared
// failure event locally (see `EffectHandlers.persistDelegated`).
function make(persistDelegated?: boolean) {
    return createClientEffectHandlers({
        eventBus: { emit: vi.fn() },
        slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        liveEntity: {},
        ...(persistDelegated !== undefined ? { persistDelegated } : {}),
    });
}

describe('createClientEffectHandlers — persistDelegated', () => {
    it('is set when the hook reports no local persistence adapter (bridge mode) — independent of liveEntity, which the hook always binds', () => {
        expect(make(true).persistDelegated).toBe(true);
    });

    it('is absent when a persistence adapter is wired (offline preview owns its writes locally)', () => {
        expect(make(false).persistDelegated).toBeUndefined();
        expect(make().persistDelegated).toBeUndefined();
    });

    it('the bridge-mode placeholder still resolves to undefined (nothing is written client-side)', async () => {
        await expect(make().persist('update', 'Note', { id: 'n1' })).resolves.toBeUndefined();
    });
});
