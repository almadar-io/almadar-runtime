import { describe, it, expect, vi } from 'vitest';
import { createClientEffectHandlers } from '../src/effects/ClientEffectHandlers.js';
import type { EntityRow } from '../src/types.js';
import { mockServiceAnswer } from '@almadar/core/mock';
import type { BusEventSource } from '@almadar/core';
import { mockCallService } from '../src/effects/defaultCallService.js';

vi.mock('@almadar/core/mock', async (importOriginal) => {
    const { withTestService } = await import('./helpers/test-service-mock.js');
    return withTestService(await importOriginal<typeof import('@almadar/core/mock')>());
});

// Coverage for the two behaviors folded in from @almadar/ui's copy that had
// no prior test anywhere (docs/Almadar_Runtime_Stateless_Stateful_PLAN.md §4.2):
// emit forwarding `source`, and the `liveEntity`-backed `set`.

describe('createClientEffectHandlers — emit source forwarding', () => {
    it('forwards the source stamp through to the event bus unchanged', () => {
        const emit = vi.fn();
        const h = createClientEffectHandlers({
            eventBus: { emit },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        });
        const source: BusEventSource = { orbital: 'App', trait: 'Composer', transition: 'ready->ready' };
        h.emit('SAVE', { text: 'hi' }, source);
        expect(emit).toHaveBeenCalledWith('UI:SAVE', { text: 'hi' }, source);
    });

    it('does not double-prefix an already-namespaced event', () => {
        const emit = vi.fn();
        const h = createClientEffectHandlers({
            eventBus: { emit },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        });
        h.emit('UI:SAVE', undefined, undefined);
        expect(emit).toHaveBeenCalledWith('UI:SAVE', undefined, undefined);
    });
});

describe('createClientEffectHandlers — liveEntity-backed set', () => {
    it('mutates the live entity in place when supplied', async () => {
        const liveEntity: EntityRow = { id: 'e1', score: 0 };
        const h = createClientEffectHandlers({
            eventBus: { emit: vi.fn() },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
            liveEntity,
        });
        await h.set('e1', 'score', 42);
        expect(liveEntity.score).toBe(42);
    });

    it('is a no-op (bridge mode) when no liveEntity is supplied', () => {
        const h = createClientEffectHandlers({
            eventBus: { emit: vi.fn() },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        });
        expect(h.set('e1', 'score', 42)).toBeUndefined();
    });
});

describe('createClientEffectHandlers — callService mock fallback', () => {
    const make = () => createClientEffectHandlers({
        eventBus: { emit: vi.fn() },
        slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
    });

    it('answers with the registry-shaped mock the server path gives (one mock source)', async () => {
        const params = { url: 'https://hooks.example.com/in', event: 'ORDER_PLACED' };
        const expected = mockServiceAnswer('test-svc', 'run');
        if (!expected.ok) throw new Error('control: test-svc.run is in the test registry');
        expect(await make().callService('test-svc', 'run', params)).toEqual(expected.value);
        expect(await mockCallService('test-svc', 'run')).toEqual(expected.value);
    });

    it('refuses a service the registry does not declare, as the server mock does', async () => {
        await expect(make().callService('payments', 'charge', { amount: 100 })).rejects.toThrow('Unknown service: payments');
        await expect(mockCallService('payments', 'charge')).rejects.toThrow('Unknown service: payments');
    });

    it('refuses an action the service does not declare', async () => {
        await expect(make().callService('test-svc', 'charge', {})).rejects.toThrow('No mock response for action: charge');
    });

    it('runs the consumer-supplied handler instead of the mock when provided', async () => {
        const consumerCallService = vi.fn().mockResolvedValue({ ok: true });
        const h = createClientEffectHandlers({
            eventBus: { emit: vi.fn() },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
            callService: consumerCallService,
        });
        const result = await h.callService('payments', 'charge', { amount: 5 });
        expect(consumerCallService).toHaveBeenCalledWith('payments', 'charge', { amount: 5 });
        expect(result).toEqual({ ok: true });
    });
});
