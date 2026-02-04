/**
 * EventBus - Platform-Agnostic Pub/Sub Implementation
 *
 * Pure TypeScript event bus for cross-trait communication.
 * Works on both client (browser) and server (Node.js).
 *
 * @packageDocumentation
 */

import type { IEventBus, RuntimeEvent, EventListener, Unsubscribe } from './types.js';

/**
 * EventBus - Simple pub/sub event bus
 *
 * @example
 * ```typescript
 * const bus = new EventBus({ debug: true });
 *
 * // Subscribe
 * const unsub = bus.on('ORDER_CONFIRMED', (event) => {
 *   console.log('Order confirmed:', event.payload);
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
    private debug: boolean;

    constructor(options: { debug?: boolean } = {}) {
        this.debug = options.debug ?? false;
    }

    /**
     * Emit an event to all registered listeners
     */
    emit(
        type: string,
        payload?: Record<string, unknown>,
        source?: RuntimeEvent['source']
    ): void {
        const event: RuntimeEvent = {
            type,
            payload,
            timestamp: Date.now(),
            source,
        };

        const listeners = this.listeners.get(type);
        const listenerCount = listeners?.size ?? 0;

        if (this.debug) {
            if (listenerCount > 0) {
                console.log(`[EventBus] Emit: ${type} → ${listenerCount} listener(s)`, payload);
            } else {
                console.warn(`[EventBus] Emit: ${type} (NO LISTENERS)`, payload);
            }
        }

        if (listeners) {
            // Copy to avoid mutation during iteration
            const listenersCopy = Array.from(listeners);
            for (const listener of listenersCopy) {
                try {
                    listener(event);
                } catch (error) {
                    console.error(`[EventBus] Error in listener for '${type}':`, error);
                }
            }
        }

        // Wildcard listeners receive all events
        if (type !== '*') {
            const wildcardListeners = this.listeners.get('*');
            if (wildcardListeners) {
                for (const listener of Array.from(wildcardListeners)) {
                    try {
                        listener(event);
                    } catch (error) {
                        console.error(`[EventBus] Error in wildcard listener:`, error);
                    }
                }
            }
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

        if (this.debug) {
            console.log(`[EventBus] Subscribed to '${type}', total: ${listeners.size}`);
        }

        return () => {
            listeners.delete(listener);
            if (this.debug) {
                console.log(`[EventBus] Unsubscribed from '${type}', remaining: ${listeners.size}`);
            }
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
        if (this.debug) {
            console.log(`[EventBus] Clearing all listeners (${this.listeners.size} event types)`);
        }
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
