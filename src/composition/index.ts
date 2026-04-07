/**
 * Composition Module
 *
 * Runtime-side TypeScript composition layer for behavior/* operators.
 *
 * Composition is normally a compile-time concept, evaluated by the Rust
 * compiler pass before code generation. The runtime ships an equivalent
 * TypeScript implementation so dev-mode hot reload, agent-driven dynamic
 * composition, and the legacy `composeBehaviors()` callers all have a
 * usable in-process implementation. The handlers are wired into
 * `EffectExecutor` as optional handlers (`composeBehaviors`,
 * `applyEventWiring`, `detectLayoutStrategy`, `pipeBehaviors`) so
 * consumers that do not need composition pay no cost.
 *
 * @packageDocumentation
 */

// Compose behaviors (main entry point)
export {
    type ComposeBehaviorsInput,
    type ComposeBehaviorsResult,
    composeBehaviors,
} from './compose-behaviors.js';

// Event wiring
export { type EventWiringEntry, applyEventWiring } from './event-wiring.js';

// Layout strategy detection
export { type LayoutStrategy, detectLayoutStrategy } from './layout-strategy.js';

// Pipe (left-to-right behavior pipeline)
export { type PipeStep, pipeBehaviors } from './pipe.js';
