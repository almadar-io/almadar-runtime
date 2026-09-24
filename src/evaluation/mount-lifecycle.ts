/**
 * Mount lifecycle — a trait never receives a routed event before its own
 * lifecycle event (INIT/LOAD/$MOUNT) has run on the current mount. A
 * delivery that reaches a mounted-but-not-yet-initialized trait is held and
 * re-enqueued right after that trait's lifecycle step. Riya: SineLevelData's
 * INIT seeds the body's skate curve; delivered before SineBody's own INIT,
 * the INIT reset it and riya fell through the ground (2026-09-24).
 *
 * Rust twin: `MountLifecycle` in orbital-core `runtime/kernel.rs`.
 *
 * @packageDocumentation
 */
import { LIFECYCLE_EVENTS } from '../traits/StateMachineCore.js';

export function isLifecycleEvent(event: string): boolean {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(event);
}

export class MountLifecycle<Delivery> {
  private readonly awaiting = new Set<string>();
  private readonly held = new Map<string, Delivery[]>();

  /** Traits entering the mount whose lifecycle event has not run yet. */
  mounting(traits: Iterable<string>): void {
    for (const trait of traits) this.awaiting.add(trait);
  }

  /** Traits leaving the mount: nothing is held for a trait no longer there. */
  unmounted(traits: Iterable<string>): void {
    for (const trait of traits) {
      this.awaiting.delete(trait);
      this.held.delete(trait);
    }
  }

  /** The traits still awaiting their lifecycle event — what a client tells its server leg. */
  awaitingTraits(): string[] {
    return [...this.awaiting];
  }

  /**
   * A server host's mount follows the client's: `awaiting` is what the client
   * still awaits when it posts. A trait the client has since initialized is
   * released here — its own INIT may never reach this host (a dispatch posts
   * only when it has server work) — except the request's own lifecycle
   * target, which stays held until its step runs on this host.
   */
  sync(awaiting: Iterable<string>, lifecycleTarget: string | undefined): Delivery[] {
    const next = new Set(awaiting);
    if (lifecycleTarget !== undefined && this.awaiting.has(lifecycleTarget)) next.add(lifecycleTarget);
    const released: Delivery[] = [];
    for (const trait of this.awaiting) {
      if (next.has(trait)) continue;
      released.push(...(this.held.get(trait) ?? []));
      this.held.delete(trait);
    }
    this.awaiting.clear();
    for (const trait of next) this.awaiting.add(trait);
    return released;
  }

  isAwaiting(trait: string): boolean {
    return this.awaiting.has(trait);
  }

  hold(trait: string, delivery: Delivery): void {
    const list = this.held.get(trait);
    if (list === undefined) this.held.set(trait, [delivery]);
    else list.push(delivery);
  }

  /** The trait's lifecycle step ran: it is initialized, its held deliveries go out in arrival order. */
  initialized(trait: string): Delivery[] {
    this.awaiting.delete(trait);
    const list = this.held.get(trait) ?? [];
    this.held.delete(trait);
    return list;
  }
}
