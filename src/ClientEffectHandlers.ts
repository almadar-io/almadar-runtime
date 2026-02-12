/**
 * Client Effect Handlers Factory
 *
 * Creates the standard effect handler set for client-side trait execution.
 * Platform-agnostic — works with any UI framework that provides the required interfaces.
 *
 * @packageDocumentation
 */

import type { EffectHandlers } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal event bus interface required by the factory.
 */
export interface ClientEventBus {
    emit: (type: string, payload?: Record<string, unknown>) => void;
}

/**
 * Slot setter interface for render-ui effects.
 * The factory doesn't know about React state — it just calls this function.
 */
export interface SlotSetter {
    /** Accumulate a pattern into the pending slot map */
    addPattern: (slot: string, pattern: unknown, props?: Record<string, unknown>) => void;
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
    navigate?: (path: string, params?: Record<string, unknown>) => void;
    /** Notify function for notification effects */
    notify?: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
    /** Entity enrichment: inject linkedEntity into entity-aware patterns */
    enrichPattern?: (pattern: unknown) => unknown;
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
    const { eventBus, slotSetter, navigate, notify, enrichPattern } = options;

    return {
        emit: (event: string, payload?: Record<string, unknown>) => {
            const prefixedEvent = event.startsWith('UI:') ? event : `UI:${event}`;
            eventBus.emit(prefixedEvent, { payload });
        },

        persist: async () => {
            console.warn('[ClientEffectHandlers] persist is server-side only, ignored on client');
        },

        set: () => {
            console.warn('[ClientEffectHandlers] set is server-side only, ignored on client');
        },

        callService: async () => {
            console.warn('[ClientEffectHandlers] callService is server-side only, ignored on client');
            return {};
        },

        renderUI: (slot: string, pattern: unknown, props?: Record<string, unknown>) => {
            if (pattern === null) {
                slotSetter.clearSlot(slot);
                return;
            }
            const enriched = enrichPattern ? enrichPattern(pattern) : pattern;
            slotSetter.addPattern(slot, enriched, props);
        },

        navigate: navigate ?? ((path: string) => {
            console.warn('[ClientEffectHandlers] No navigate handler, ignoring:', path);
        }),

        notify: notify ?? ((msg: string, type?: string) => {
            console.log(`[ClientEffectHandlers] notify (${type}):`, msg);
        }),
    };
}
