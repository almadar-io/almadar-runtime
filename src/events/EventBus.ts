/**
 * EventBus - Platform-Agnostic Pub/Sub Implementation
 *
 * Pure TypeScript event bus for cross-trait communication.
 * Works on both client (browser) and server (Node.js).
 *
 * @packageDocumentation
 */

import { createLogger } from '@almadar/logger';
import type { IEventBus, RuntimeEvent, EventListener, Unsubscribe, EventPayload } from '../types.js';

const log = createLogger('almadar:runtime:eventbus');

/**
 * EventBus - Simple pub/sub event bus
 *
 * @example
 * ```typescript
 * const bus = new EventBus({ debug: true });
 *
 * // Subscribe
 * const unsub = bus.on('ORDER_CONFIRMED', (event) => {
 *   log.debug('order-confirmed', { orderId: event.payload?.orderId });
 * });
 *
 * // Emit
 * bus.emit('ORDER_CONFIRMED', { orderId: '123' });
 *
 * // Unsubscribe
 * unsub();
 * ```
 */
export class EventBus implements IEventBus {
    private listeners: Map<string, Set<EventListener>> = new Map();
    /** Maximum recursion depth before circuit breaker activates (RCG-05) */
    private maxDepth: number;
    /** Current emission depth for circular loop detection */
    private depth: number = 0;

    constructor(options: { debug?: boolean; maxDepth?: number } = {}) {
        // `debug` is accepted for backwards-compatibility but is now a no-op;
        // diagnostic output is gated by @almadar/logger (env ALMADAR_DEBUG or
        // globalThis.__ALMADAR_DEBUG__='almadar:runtime:eventbus').
        void options.debug;
        this.maxDepth = options.maxDepth ?? 10;
    }

    /**
     * Emit an event to all registered listeners.
     *
     * Includes circuit breaker (RCG-05): if emit is called recursively
     * beyond `maxDepth`, the event is dropped and an error is logged.
     * This prevents infinite loops from circular emit/listen chains.
     */
    emit(
        type: string,
        payload?: EventPayload,
        source?: RuntimeEvent['source'],
        routingKey?: string
    ): void {
        // RCG-05: Circuit breaker for circular event loops
        if (this.depth >= this.maxDepth) {
            log.error('circular event loop dropped', { type, depth: this.depth, maxDepth: this.maxDepth });
            return;
        }

        const event: RuntimeEvent = {
            type,
            payload,
            timestamp: Date.now(),
            source,
        };

               // V4 identity routing: subscriptions are keyed under `routingKey`
        // (an event-id key when the schema carries ids) while the envelope
        // keeps the human `type`. Absent → key by name (legacy, unchanged).
        const deliveryKey = routingKey ?? type;
        // Dual-carry delivery: an id-keyed emit must ALSO reach bare-name
        // subscribers — any-kind (`*.EVENT`) listens and legacy id-free
        // subscriptions route by name only, and the emit side always stamps
        // an id post-V4, so without this hop they never fire. A listener
        // subscribed under both keys receives the event exactly once.
        const primary = this.listeners.get(deliveryKey);
        const secondary = routingKey !== undefined && routingKey !== type
            ? this.listeners.get(type)
            : undefined;
        const listenerCount = (primary?.size ?? 0) + (secondary?.size ?? 0);

        if (listenerCount > 0) {
            log.debug('emit', { type, listenerCount, depth: this.depth });
        } else {
            // DEBUG (not WARN): a zero-subscriber emit is a routing diagnostic,
            // not an actionable warning — internal/tick events commonly have no
            // runtime listener and that floods the console. Gate it behind the
            // `almadar:runtime:eventbus` namespace so it surfaces only when
            // debugging event routing. Real orphan emits are caught by the
            // closed-circuit validator at validate time, not here.
            log.debug('emit no listeners', { type });
        }

        this.depth++;
        try {
            const delivered = new Set<EventListener>();
            const deliverTo = (set: Set<EventListener> | undefined): void => {
                if (!set) return;
                // Copy to avoid mutation during iteration
                for (const listener of Array.from(set)) {
                    if (delivered.has(listener)) continue;
                    delivered.add(listener);
                    try {
                        listener(event);
                    } catch (error) {
                        log.error('listener threw', { type, error: error instanceof Error ? error : String(error) });
                    }
                }
            };
            deliverTo(primary);
            deliverTo(secondary);

            // Wildcard listeners receive all events
            if (type !== '*') {
                const wildcardListeners = this.listeners.get('*');
                if (wildcardListeners) {
                    for (const listener of Array.from(wildcardListeners)) {
                        try {
                            listener(event);
                        } catch (error) {
                            log.error('wildcard listener threw', { error: error instanceof Error ? error : String(error) });
                        }
                    }
                }
            }
        } finally {
            this.depth--;
        }
    }

    /**
     * Subscribe to an event type
     */
    on(type: string, listener: EventListener): Unsubscribe {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }

        const listeners = this.listeners.get(type)!;
        listeners.add(listener);

        log.debug('subscribe', { type, total: listeners.size });

        return () => {
            listeners.delete(listener);
            log.debug('unsubscribe', { type, remaining: listeners.size });
            if (listeners.size === 0) {
                this.listeners.delete(type);
            }
        };
    }

    /**
     * Subscribe to ALL events (wildcard listener)
     * Useful for event tracking, logging, debugging
     */
    onAny(listener: EventListener): Unsubscribe {
        return this.on('*', listener);
    }

    /**
     * Check if there are listeners for an event type
     */
    hasListeners(type: string): boolean {
        const listeners = this.listeners.get(type);
        return listeners !== undefined && listeners.size > 0;
    }

    /**
     * Get all registered event types
     */
    getRegisteredEvents(): string[] {
        return Array.from(this.listeners.keys());
    }

    /**
     * Clear all listeners
     */
    clear(): void {
        log.debug('clear', { eventTypeCount: this.listeners.size });
        this.listeners.clear();
    }

    /**
     * Get listener count for an event type (for testing)
     */
    getListenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
}

/**
 * Create a new EventBus instance
 */
export function createEventBus(options?: { debug?: boolean }): IEventBus {
    return new EventBus(options);
}
