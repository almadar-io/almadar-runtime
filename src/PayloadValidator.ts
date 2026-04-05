/**
 * PayloadValidator - Cross-Trait Payload Shape Validation (RCG-10)
 *
 * Validates that listener `payloadMapping` references match the emitter's
 * payload field names. Catches mismatches like `@payload.task_id` when the
 * emitter defines `taskId`.
 *
 * @packageDocumentation
 */

import type { TraitDefinition, EventPayload } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Emit declaration from a trait.
 */
interface EmitDeclaration {
    event: string;
    payload?: Array<{ name: string; type?: string }>;
}

/**
 * Payload validation error.
 */
export interface PayloadMismatch {
    /** Listening trait name */
    listenerTrait: string;
    /** Emitting trait name */
    emitterTrait: string;
    /** Event name */
    event: string;
    /** The payload field referenced in the listener's payloadMapping */
    referencedField: string;
    /** Available fields from the emitter's payload declaration */
    availableFields: string[];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that all listener payloadMapping references match emitter payload fields.
 *
 * @param traits - All trait definitions in the schema
 * @param emits - Emit declarations per trait (traitName → EmitDeclaration[])
 * @returns Array of payload mismatches (empty if all valid)
 *
 * @example
 * ```ts
 * const mismatches = validatePayloadShapes(traits, emitsMap);
 * for (const m of mismatches) {
 *   console.warn(
 *     `Trait "${m.listenerTrait}" references @payload.${m.referencedField} ` +
 *     `for event "${m.event}" but emitter "${m.emitterTrait}" only declares: ` +
 *     `${m.availableFields.join(', ')}`
 *   );
 * }
 * ```
 */
export function validatePayloadShapes(
    traits: TraitDefinition[],
    emits: Map<string, EmitDeclaration[]>
): PayloadMismatch[] {
    const mismatches: PayloadMismatch[] = [];

    // Build event→emitter lookup: event name → { traitName, payload fields }
    const emitIndex = new Map<string, { traitName: string; fields: string[] }>();
    for (const [traitName, declarations] of emits) {
        for (const decl of declarations) {
            const fields = decl.payload?.map((p) => p.name) ?? [];
            emitIndex.set(decl.event, { traitName, fields });
        }
    }

    // Check each listener's payloadMapping references
    for (const trait of traits) {
        if (!trait.listens) continue;

        for (const listener of trait.listens) {
            const emitter = emitIndex.get(listener.event);
            if (!emitter) continue; // No emitter found — separate validation concern

            if (!listener.payloadMapping) continue;

            // Extract @payload.X references from payloadMapping values
            const payloadRefs = extractPayloadReferences(listener.payloadMapping);

            for (const ref of payloadRefs) {
                if (!emitter.fields.includes(ref)) {
                    mismatches.push({
                        listenerTrait: trait.name,
                        emitterTrait: emitter.traitName,
                        event: listener.event,
                        referencedField: ref,
                        availableFields: emitter.fields,
                    });
                }
            }
        }
    }

    return mismatches;
}

/**
 * Extract payload field references from a payloadMapping object.
 * Finds all `@payload.fieldName` patterns and returns the field names.
 */
function extractPayloadReferences(mapping: EventPayload): string[] {
    const refs: string[] = [];

    function collect(value: unknown): void {
        if (typeof value === 'string') {
            const match = value.match(/^@payload\.(\w+)$/);
            if (match) {
                refs.push(match[1]);
            }
        } else if (typeof value === 'object' && value !== null) {
            if (Array.isArray(value)) {
                value.forEach(collect);
            } else {
                Object.values(value as EventPayload).forEach(collect);
            }
        }
    }

    Object.values(mapping).forEach(collect);
    return [...new Set(refs)];
}

/**
 * Build emit declarations map from trait definitions.
 * Extracts emits from transitions that use the `emit` effect.
 *
 * Note: This is a heuristic — it parses emit effects from transitions.
 * For full accuracy, the schema should include explicit `emits` declarations.
 */
export function buildEmitsFromTraits(
    traits: TraitDefinition[],
    explicitEmits?: Map<string, EmitDeclaration[]>
): Map<string, EmitDeclaration[]> {
    // Start with explicit emits if provided
    const result = new Map<string, EmitDeclaration[]>(explicitEmits ?? []);

    for (const trait of traits) {
        if (result.has(trait.name)) continue; // Explicit declarations take precedence

        const emitDecls: EmitDeclaration[] = [];
        for (const transition of trait.transitions) {
            if (!transition.effects) continue;

            for (const effect of transition.effects) {
                if (!Array.isArray(effect)) continue;
                if (effect[0] === 'emit' && typeof effect[1] === 'string') {
                    const event = effect[1] as string;
                    // Payload is in effect[2] if present
                    const payloadObj = effect[2] as EventPayload | undefined;
                    const payload = payloadObj
                        ? Object.keys(payloadObj).map((name) => ({ name }))
                        : undefined;

                    // Avoid duplicates
                    if (!emitDecls.some((d) => d.event === event)) {
                        emitDecls.push({ event, payload });
                    }
                }
            }
        }

        if (emitDecls.length > 0) {
            result.set(trait.name, emitDecls);
        }
    }

    return result;
}
