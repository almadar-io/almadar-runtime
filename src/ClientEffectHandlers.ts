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
    /**
     * Send-server handler for `send-server` effects.
     * When omitted, defaults to a lazy WebSocket transport connecting to the
     * server's `/ws/events` endpoint. The handler produces the server wire
     * message `{ type: 'ORBITAL_EVENT', payload: { orbital, event, payload } }`
     * that `setupEventBroadcast` decodes.
     *
     * Pass a custom function here to override the transport (e.g. in tests or
     * when the WS URL differs from the default).
     *
     * `orbitalName` is injected at call time by the EffectContext when available.
     */
    sendServer?: (event: string, payload?: EventPayload) => void;
    /** Orbital name used to stamp the WS message (used by the default transport) */
    orbitalName?: string;
}

// ============================================================================
// Factory
// ============================================================================

// ============================================================================
// WS Transport (lazy singleton per page-load)
// ============================================================================

/** Lazily-opened WebSocket to the server's /ws/events endpoint. */
let _ws: WebSocket | null = null;
let _wsQueue: string[] = [];

function getOrOpenWs(): WebSocket | null {
    if (typeof WebSocket === 'undefined' || typeof location === 'undefined') return null;
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
        return _ws;
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/events`;
    try {
        _ws = new WebSocket(url);
        _ws.addEventListener('open', () => {
            const queued = _wsQueue.splice(0);
            for (const msg of queued) {
                _ws!.send(msg);
            }
        });
        _ws.addEventListener('error', () => {
            _ws = null;
        });
        _ws.addEventListener('close', () => {
            _ws = null;
        });
    } catch {
        _ws = null;
    }
    return _ws;
}

function sendServerEvent(orbital: string, event: string, payload?: EventPayload): void {
    const msg = JSON.stringify({
        type: 'ORBITAL_EVENT',
        payload: { orbital, event, payload: payload ?? null },
    });
    const ws = getOrOpenWs();
    if (!ws) {
        log.warn('send-server:no-ws', { event });
        return;
    }
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
    } else {
        _wsQueue.push(msg);
    }
}

/**
 * Create client-side effect handlers for trait state machine execution.
 *
 * Client handles: emit, renderUI, navigate, notify, sendServer
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
    const { eventBus, slotSetter, navigate, notify, sendServer, orbitalName = '' } = options;

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

        sendServer: sendServer ?? ((event: string, payload?: EventPayload) => {
            sendServerEvent(orbitalName, event, payload);
        }),
    };
}
