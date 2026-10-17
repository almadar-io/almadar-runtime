import { describe, it, expect, vi } from 'vitest';
import { createClientEffectHandlers } from '../src/effects/ClientEffectHandlers.js';

vi.mock('@almadar/core/mock', async (importOriginal) => {
    const { withTestService } = await import('./helpers/test-service-mock.js');
    return withTestService(await importOriginal<typeof import('@almadar/core/mock')>());
});

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

    it('callService is still a callable returning the registry-shaped mock', async () => {
        const result = await make().callService('test-svc', 'run', { url: 'https://hooks.example.com/in', event: 'ORDER_PLACED' });
        expect(result).toMatchObject({ status: expect.any(Number), ok: true, durationMs: expect.any(Number) });
    });
});
