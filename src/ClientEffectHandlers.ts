/**
 * Client Effect Handlers Factory
 *
 * Creates the standard effect handler set for client-side trait execution.
 * Platform-agnostic — works with any UI framework that provides the required interfaces.
 *
 * @packageDocumentation
 */

import { createLogger } from '@almadar/logger';
import type { EffectHandlers, EventPayload, PatternProps } from './types.js';

const log = createLogger('almadar:runtime:effects:client');

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal event bus interface required by the factory.
 */
export interface ClientEventBus {
    emit: (type: string, payload?: EventPayload) => void;
}

/**
 * Slot setter interface for render-ui effects.
 * The factory doesn't know about React state — it just calls this function.
 */
export interface SlotSetter {
    /** Accumulate a pattern into the pending slot map */
    addPattern: (slot: string, pattern: unknown, props?: PatternProps) => void;
    /** Mark a slot for clearing */
    clearSlot: (slot: string) => void;
}

/**
 * Options for creating client effect handlers.
 */
export interface CreateClientEffectHandlersOptions {
    /** Event bus for emit effects */
    eventBus: ClientEventBus;
    /** Slot setter for render-ui effects */
    slotSetter: SlotSetter;
    /** Navigate function for navigate effects */
    navigate?: (path: string, params?: { [key: string]: string }) => void;
    /** Notify function for notification effects */
    notify?: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create client-side effect handlers for trait state machine execution.
 *
 * Client handles: emit, renderUI, navigate, notify
 * Server handles: persist, set, callService (logged as warnings on client)
 *
 * @example
 * ```ts
 * const handlers = createClientEffectHandlers({
 *   eventBus,
 *   slotSetter: {
 *     addPattern: (slot, pattern, props) => pendingSlots.get(slot)?.push({ pattern, props }),
 *     clearSlot: (slot) => pendingSlots.set(slot, []),
 *   },
 *   navigate: (path) => router.push(path),
 *   notify: (msg, type) => toast[type](msg),
 * });
 * ```
 */
export function createClientEffectHandlers(
    options: CreateClientEffectHandlersOptions
): EffectHandlers {
    const { eventBus, slotSetter, navigate, notify } = options;

    return {
        emit: (event: string, payload?: EventPayload) => {
            // The event bus emits with shape `{ type, payload, source }` per
            // IEventBus. Subscribers read `event.payload` to get the trait-
            // supplied payload. Wrapping it again as `{ payload }` here
            // produced a doubly-nested envelope — `@payload.X` bindings on
            // the receiving render-ui then resolved to `undefined` because
            // the real keys lived one level deeper. Pass the payload through
            // directly so the subscriber sees exactly what the trait emitted.
            const prefixedEvent = event.startsWith('UI:') ? event : `UI:${event}`;
            eventBus.emit(prefixedEvent, payload);
        },

        persist: async () => {
            log.warn('persist-server-side-only');
        },

        set: () => {
            log.warn('set-server-side-only');
        },

        callService: async () => {
            log.warn('call-service-server-side-only');
            return {};
        },

        renderUI: (slot: string, pattern: unknown, props?: PatternProps) => {
            if (pattern === null) {
                slotSetter.clearSlot(slot);
                return;
            }
            slotSetter.addPattern(slot, pattern, props);
        },

        navigate: navigate ?? ((path: string) => {
            log.warn('navigate-no-handler', { path });
        }),

        notify: notify ?? ((msg: string, type?: string) => {
            log.debug('notify', { type: type ?? null, message: msg });
        }),
    };
}
