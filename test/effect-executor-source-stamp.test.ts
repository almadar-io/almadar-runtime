import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import { EffectExecutor, type BindingContext, type EffectContext } from '../src/index.js';
import { asTraitId, asOrbitalId, asEventId } from '@almadar/core';

/**
 * `EffectExecutor.sourceStamp` — V4 dual-carry ids (2026-09-22, the chat
 * SAVE → DO_CREATE relay dying on the stateful path). An id-scoped
 * `listens` matcher (`buildSourceMatcher`) compares ids ONLY when the
 * listen source carries one, so a name-only client stamp never matches a
 * `traitId`-carrying listen. The stamp must carry the ids when the context
 * has them (parity with `OrbitalServerRuntime`'s emit stamp) and omit them
 * cleanly when it doesn't (id-free schemas keep the legacy name-only
 * stamp, byte-for-byte).
 */
describe('EffectExecutor.sourceStamp — V4 dual-carry ids', () => {
    it('stamps traitId/orbitalId/eventId from the context', async () => {
        const emit = vi.fn();
        const handlers = stubEffectHandlers({ emit });
        const bindings: BindingContext = { entity: {} };
        const context: EffectContext = {
            traitName: 'ChatComposer',
            orbitalName: 'ChatOrbital',
            traitId: asTraitId('trt_composer'),
            orbitalId: asOrbitalId('orb_chat'),
            emits: [{ event: 'SAVE', eventId: asEventId('evt_save') }],
            state: 'ready',
            transition: 'ready->ready',
        };
        const executor = new EffectExecutor({ handlers, bindings, context });

        await executor.executeAll([['emit', 'SAVE', { data: { content: 'hi' } }]]);

        expect(emit).toHaveBeenCalledWith('SAVE', { data: { content: 'hi' } }, {
            orbital: 'ChatOrbital',
            trait: 'ChatComposer',
            transition: 'ready->ready',
            traitId: 'trt_composer',
            orbitalId: 'orb_chat',
            eventId: 'evt_save',
        });
    });

    it('omits the ids when the context carries none (legacy name-only stamp unchanged)', async () => {
        const emit = vi.fn();
        const handlers = stubEffectHandlers({ emit });
        const bindings: BindingContext = { entity: {} };
        const context: EffectContext = { traitName: 'T', state: 'idle', transition: 'idle->idle' };
        const executor = new EffectExecutor({ handlers, bindings, context });

        await executor.executeAll([['emit', 'PING', {}]]);

        expect(emit).toHaveBeenCalledWith('PING', {}, {
            orbital: undefined,
            trait: 'T',
            transition: 'idle->idle',
        });
    });

    it('stamps eventId from the emits contract only for a matching event name', async () => {
        const emit = vi.fn();
        const handlers = stubEffectHandlers({ emit });
        const bindings: BindingContext = { entity: {} };
        const context: EffectContext = {
            traitName: 'ChatComposer',
            orbitalName: 'ChatOrbital',
            traitId: asTraitId('trt_composer'),
            orbitalId: asOrbitalId('orb_chat'),
            emits: [{ event: 'SAVE', eventId: asEventId('evt_save') }],
            state: 'ready',
            transition: 'ready->ready',
        };
        const executor = new EffectExecutor({ handlers, bindings, context });

        await executor.executeAll([['emit', 'CHANNEL_SELECTED', {}]]);

        const stamp = emit.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(stamp['eventId']).toBeUndefined();
        expect(stamp['traitId']).toBe('trt_composer');
        expect(stamp['orbitalId']).toBe('orb_chat');
    });
});
