/**
 * CircuitStore — P2, `docs/Almadar_Runtime_Stateless_Stateful_PLAN.md` §4.2.
 *
 * The contract `evaluateOrbitalEvent` already consumes as two separate deps
 * (`manager: StateMachineManager`, `frames: Map<string, EntityRow>`), made
 * explicit as one port so a deployment (stateless per-request, stateful
 * long-lived, browser client) constructs/shares ONE of these instead of the
 * composition's callers inventing their own manager+frames wiring.
 *
 * `snapshot`/`restore` are the JS twin of orbital-core's
 * `RuntimeKernel::snapshot_trait`/`restore_trait` (`runtime/kernel.rs`) — the
 * `runtimeOptimistic` rollback point. `subscribe`/`getVersion` let a later
 * React adapter drive `useSyncExternalStore` off this store without the
 * store knowing anything about React.
 *
 * @packageDocumentation
 */
import { StateMachineManager, type TraitDefinition } from '../traits/StateMachineCore.js';
import type { EntityRow, RuntimeConfig, TransitionObserver } from '../types.js';

/**
 * A trait instance's state + entity frame at a point in time — the twin of
 * orbital-core's `TraitSnapshot { state, entity }`. `frame` is `undefined`
 * when the trait had no frame row yet (mirrors Rust's `Value::Null` case:
 * restoring must leave the row absent, not invent one).
 */
export interface TraitSnapshot {
  state: string;
  frame: EntityRow | undefined;
}

export interface CircuitStore {
  readonly manager: StateMachineManager;
  /** The entity-frame map (`(set @entity.X)` writes), keyed by
   *  `IndexedTrait.frameKey`. */
  readonly frames: Map<string, EntityRow>;
  /**
   * Capture `trait`'s current state + its frame row, for a
   * `runtimeOptimistic` dispatch's pre-commit rollback point. `frameKey`
   * defaults to `trait` (the non-`[shared]`-entity case); a caller holding
   * the trait's `IndexedTrait.frameKey` (the `[shared]` case) passes it
   * explicitly so the snapshot reads the SAME row the dispatch will write.
   */
  snapshot(trait: string, entityId?: string, frameKey?: string): TraitSnapshot;
  /**
   * Roll `trait` back to a prior snapshot: state via a reconcile write (no
   * guard evaluation — `seedState`), frame via REPLACE (never merge — an
   * optimistic commit may have added fields since the snapshot that a merge
   * would keep, the same reasoning as `RuntimeKernel::restore_trait`).
   */
  restore(trait: string, entityId: string | undefined, snapshot: TraitSnapshot, frameKey?: string): void;
  /**
   * Notify subscribers that circuit state changed. Callers (the client
   * role, `client-role.ts`) call this ONCE after a dispatch/fold finishes
   * writing state — the store itself never wraps/monkey-patches the
   * manager to auto-fire this on every internal commit.
   */
  notify(): void;
  /** `useSyncExternalStore`-shaped subscription. Returns the unsubscribe fn. */
  subscribe(listener: () => void): () => void;
  /** Monotonic version, bumped by every `notify()` call. */
  getVersion(): number;
}

/**
 * The one in-memory `CircuitStore` implementation. Per-request (stateless
 * server) or long-lived (stateful server, browser client) is only a
 * question of how long the caller HOLDS the returned store — the
 * implementation itself carries no lifetime opinion.
 */
export function createMemoryCircuitStore(
  traits: TraitDefinition[] = [],
  config: RuntimeConfig = {},
  observer?: TransitionObserver,
): CircuitStore {
  const manager = new StateMachineManager(traits, config, observer);
  const frames = new Map<string, EntityRow>();
  const listeners = new Set<() => void>();
  let version = 0;

  return {
    manager,
    frames,
    snapshot(trait, entityId, frameKey) {
      const key = frameKey ?? trait;
      const frame = frames.get(key);
      return {
        state: manager.getState(trait, entityId)?.currentState ?? '',
        frame: frame !== undefined ? { ...frame } : undefined,
      };
    },
    restore(trait, entityId, snap, frameKey) {
      const key = frameKey ?? trait;
      if (snap.state !== '') {
        manager.seedState(trait, snap.state, entityId);
      }
      if (snap.frame === undefined) {
        frames.delete(key);
      } else {
        frames.set(key, { ...snap.frame });
      }
    },
    notify() {
      version += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion() {
      return version;
    },
  };
}
