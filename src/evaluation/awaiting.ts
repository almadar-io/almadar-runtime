/**
 * Which traits are awaiting a server round trip right now — the kernel contract
 * behind awaiting-server skeletons (`AwaitingTrait`, `@almadar/core`). The
 * client kernel begins an entry right before a server leg's send and ends it
 * when the leg folds or fails; local/hybrid traits and tick legs never enter.
 * Subscriptions are per trait, so only the slots that trait owns re-render.
 */
import type { AwaitingTrait } from '@almadar/core';

export class AwaitingRegistry {
  private readonly entries = new Map<string, AwaitingTrait>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly anyListeners = new Set<() => void>();
  private version = 0;

  begin(list: readonly AwaitingTrait[]): void {
    for (const entry of list) {
      this.entries.set(entry.trait, entry);
      this.emit(entry.trait);
    }
  }

  end(traits: readonly string[]): void {
    for (const trait of traits) {
      if (!this.entries.delete(trait)) continue;
      this.emit(trait);
    }
  }

  get(trait: string): AwaitingTrait | undefined {
    return this.entries.get(trait);
  }

  list(): AwaitingTrait[] {
    return [...this.entries.values()];
  }

  subscribe(trait: string, listener: () => void): () => void {
    let set = this.listeners.get(trait);
    if (!set) {
      set = new Set();
      this.listeners.set(trait, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(trait);
    };
  }

  /** Any trait's awaiting change (an empty slot does not know which trait will fill it). */
  subscribeAll(listener: () => void): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** Bumped on every change — a stable snapshot key for `useSyncExternalStore`. */
  getVersion(): number {
    return this.version;
  }

  private emit(trait: string): void {
    this.version += 1;
    this.listeners.get(trait)?.forEach((listener) => listener());
    this.anyListeners.forEach((listener) => listener());
  }
}
