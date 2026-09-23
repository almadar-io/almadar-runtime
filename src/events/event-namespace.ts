/**
 * Event Namespace Utilities
 *
 * Utilities for working with namespaced events in the trait-centric event model.
 * External events are namespaced as "TraitName.EVENT_NAME".
 *
 * @packageDocumentation
 */

// ============================================================================
// Constants
// ============================================================================

/** Separator used in namespaced event names */
export const NAMESPACE_SEPARATOR = '.';

/** Regex for valid event names (UPPER_SNAKE_CASE) */
export const EVENT_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/** Regex for valid namespaced events (TraitName.EVENT_NAME) */
export const NAMESPACED_EVENT_REGEX = /^[A-Z][a-zA-Z0-9_]*\.[A-Z][A-Z0-9_]*$/;

// ============================================================================
// Namespace Functions
// ============================================================================

/**
 * Create a namespaced event name from trait name and event name.
 *
 * @param traitName - The trait name (e.g., "UserManagement")
 * @param eventName - The event name (e.g., "USER_REGISTERED")
 * @returns Namespaced event (e.g., "UserManagement.USER_REGISTERED")
 */
export function namespaceEvent(traitName: string, eventName: string): string {
    return `${traitName}${NAMESPACE_SEPARATOR}${eventName}`;
}

/**
 * Parse a namespaced event into its components.
 *
 * @param namespacedEvent - The namespaced event (e.g., "UserManagement.USER_REGISTERED")
 * @returns Object with traitName and eventName, or null if not namespaced
 */
export function parseNamespacedEvent(
    namespacedEvent: string
): { traitName: string; eventName: string } | null {
    const separatorIndex = namespacedEvent.indexOf(NAMESPACE_SEPARATOR);
    if (separatorIndex === -1) {
        return null;
    }

    return {
        traitName: namespacedEvent.substring(0, separatorIndex),
        eventName: namespacedEvent.substring(separatorIndex + 1),
    };
}

/**
 * Check if an event name is namespaced.
 *
 * @param event - The event name to check
 * @returns True if the event is namespaced (contains a dot with valid format)
 */
export function isNamespacedEvent(event: string): boolean {
    return NAMESPACED_EVENT_REGEX.test(event);
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Check if an event name follows UPPER_SNAKE_CASE convention.
 *
 * @param eventName - The event name to validate
 * @returns True if valid UPPER_SNAKE_CASE
 */
export function isValidEventName(eventName: string): boolean {
    return EVENT_NAME_REGEX.test(eventName);
}

/**
 * Validate a namespaced event format.
 *
 * @param event - The event to validate
 * @returns Object with valid flag and optional error message
 */
export function validateEventFormat(event: string): { valid: boolean; error?: string } {
    // Check if it's a simple event name
    if (!event.includes(NAMESPACE_SEPARATOR)) {
        if (!isValidEventName(event)) {
            return {
                valid: false,
                error: `Event name "${event}" must be UPPER_SNAKE_CASE`,
            };
        }
        return { valid: true };
    }

    // Check if it's a valid namespaced event
    const parsed = parseNamespacedEvent(event);
    if (!parsed) {
        return {
            valid: false,
            error: `Invalid namespaced event format: "${event}"`,
        };
    }

    if (!isValidEventName(parsed.eventName)) {
        return {
            valid: false,
            error: `Event name "${parsed.eventName}" in namespaced event must be UPPER_SNAKE_CASE`,
        };
    }

    return { valid: true };
}

// ============================================================================
// Collection Utilities
// ============================================================================

/**
 * Group events by trait name.
 *
 * @param events - Array of namespaced events
 * @returns Map of trait name to event names
 */
export function groupEventsByTrait(events: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();

    for (const event of events) {
        const parsed = parseNamespacedEvent(event);
        if (parsed) {
            const existing = grouped.get(parsed.traitName) || [];
            existing.push(parsed.eventName);
            grouped.set(parsed.traitName, existing);
        }
    }

    return grouped;
}

/**
 * Extract all unique trait names from namespaced events.
 *
 * @param events - Array of namespaced events
 * @returns Set of trait names
 */
export function extractTraitNames(events: string[]): Set<string> {
    const traitNames = new Set<string>();

    for (const event of events) {
        const parsed = parseNamespacedEvent(event);
        if (parsed) {
            traitNames.add(parsed.traitName);
        }
    }

    return traitNames;
}
