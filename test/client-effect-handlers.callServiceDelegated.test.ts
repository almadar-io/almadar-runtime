import { describe, it, expect, vi } from 'vitest';
import { createClientEffectHandlers } from '../src/ClientEffectHandlers.js';

// Bridge mode (no consumer callService): the server runs every call-service
// and its cascade carries the result — the client handlers must declare the
// mock as DELEGATED so the runtime executor skips it instead of also
// running the mock and emitting a synthetic success (see `EffectHandlers.callServiceDelegated`).
function make(callServiceDelegated?: boolean) {
    return createClientEffectHandlers({
        eventBus: { emit: vi.fn() },
        slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        liveEntity: {},
        ...(callServiceDelegated !== undefined ? { callServiceDelegated } : {}),
    });
}

describe('createClientEffectHandlers — callServiceDelegated', () => {
    it('is set when the hook reports no consumer callService (bridge mode)', () => {
        expect(make(true).callServiceDelegated).toBe(true);
    });

    it('is absent when omitted or false', () => {
        expect(make(false).callServiceDelegated).toBeUndefined();
        expect(make().callServiceDelegated).toBeUndefined();
    });

    it('callService is still a callable returning the mock shape', async () => {
        const result = await make().callService('payments', 'charge', { amount: 100 });
        expect(result).toMatchObject({ success: true, status: 'succeeded', amount: 100 });
    });
});
