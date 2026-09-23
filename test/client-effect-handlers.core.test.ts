import { describe, it, expect, vi } from 'vitest';
import { createClientEffectHandlers } from '../src/effects/ClientEffectHandlers.js';
import type { EntityRow } from '../src/types.js';
import type { BusEventSource } from '@almadar/core';

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

describe('createClientEffectHandlers — callService mock fallback shape', () => {
    it('echoes primitive params and mints an id/clientSecret pair', async () => {
        const h = createClientEffectHandlers({
            eventBus: { emit: vi.fn() },
            slotSetter: { addPattern: vi.fn(), clearSlot: vi.fn() },
        });
        const result = await h.callService('payments', 'charge', { amount: 100, note: 'x' });
        expect(result).toMatchObject({ success: true, status: 'succeeded', amount: 100, note: 'x' });
        expect(String(result?.id)).toMatch(/^mock_payments_charge_/);
        expect(String(result?.clientSecret)).toMatch(/^secret_mock_payments_charge_/);
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
