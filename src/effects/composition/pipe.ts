/**
 * Pipe Behaviors
 *
 * Left-to-right composition. Each step receives the previous result as its
 * first argument and returns the value handed to the next step.
 *
 * @packageDocumentation
 */

/**
 * A single step in a behavior pipeline.
 */
export type PipeStep<I, O> = (input: I) => O;

/**
 * Apply a series of transformation steps to a seed value, left to right.
 * Each step receives the previous step's output as its first argument.
 *
 * @example
 * ```ts
 * pipeBehaviors(1, (n) => n + 1, (n) => n * 10); // -> 20
 * ```
 */
export function pipeBehaviors<T>(
    seed: T,
    ...steps: Array<PipeStep<unknown, unknown>>
): unknown {
    let current: unknown = seed;
    for (const step of steps) {
        current = step(current);
    }
    return current;
}
