/**
 * Runtime contract enforcement for renderer implementations.
 *
 * @packageDocumentation
 */

/**
 * Error thrown when a renderer implementation violates the
 * `@almadar/runtime/ui` contract (e.g. a `SlotManager` is missing required
 * methods).
 */
export class RendererContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RendererContractViolationError';
  }
}

/**
 * Structured error returned by {@link validateSlotContent} when a slot content
 * value does not satisfy the runtime contract.
 */
export interface SlotContentValidationError {
  /** Human-readable error message. */
  readonly message: string;
  /** Dotted path to the offending field, or `'.'` for the root value. */
  readonly path: string;
}
