/**
 * TickScheduler — a single coalesced clock for every registered tick.
 *
 * Replaces "one independent timer per tick" with ONE requestAnimationFrame
 * accumulator loop (falling back to a single ~60fps `setInterval` where rAF
 * isn't available, e.g. Node/SSR) that walks every registered tick each pass
 * and fires whichever one(s) have crossed their own interval — so ticks due
 * in the same pass commit together instead of on independent, uncoordinated
 * timers. Each interval tick fires AT MOST ONCE per pass: missed beats are
 * dropped (the phase remainder is kept, so healthy cadence is unchanged),
 * because bursting catch-up firings after a slow pass multiplies the work
 * that made the pass slow — an unbounded accumulator is a spiral-of-death
 * amplifier that pegs the main thread and starves input. Framework-light:
 * no React, usable from `OrbitalServerRuntime` (this package) and from
 * `@almadar/ui`'s `useTraitStateMachine` alike.
 *
 * @packageDocumentation
 */

import { parseCron, cronMatches, cronMinuteKey, type CronFields } from './cron.js';

/** Sentinel: an interval of 0 (or less) means "fire on every pass" (a frame-interval tick). */
const EVERY_PASS = 0;

/** Cron ticks only need calendar-minute resolution — check at most once a second per tick. */
const CRON_CHECK_INTERVAL_MS = 1000;

interface IntervalTick {
  kind: 'interval';
  intervalMs: number;
  accumulatedMs: number;
  lastTimestamp: number | null;
  onDue: () => void;
}

interface CronTick {
  kind: 'cron';
  fields: CronFields;
  /** ms since the last cron-match check, throttled to CRON_CHECK_INTERVAL_MS. */
  accumulatedMs: number;
  lastTimestamp: number | null;
  /** Calendar-minute key of the last fire, so a match isn't re-fired all through that minute. */
  lastFiredMinuteKey: number;
  onDue: () => void;
}

type ScheduledTick = IntervalTick | CronTick;

export interface TickHandle {
  /** Stop just this tick; the shared loop keeps running for any others still registered. */
  stop(): void;
}

/**
 * Coalesced tick scheduler. One instance drives every tick registered on it
 * through a single shared clock.
 */
export class TickScheduler {
  private ticks = new Map<number, ScheduledTick>();
  private nextId = 1;
  private running = false;
  private paused = false;
  private frameHandle: number | ReturnType<typeof setInterval> | null = null;
  private readonly hasRaf: boolean;

  constructor() {
    this.hasRaf =
      typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';
  }

  /**
   * Register a tick. `intervalMs <= 0` means "every pass" (a frame-interval
   * tick, matching LOLO's `interval: "frame"`). Returns a handle to stop
   * just this tick.
   */
  add(intervalMs: number, onDue: () => void): TickHandle {
    const id = this.nextId++;
    this.ticks.set(id, {
      kind: 'interval',
      intervalMs: intervalMs > 0 ? intervalMs : EVERY_PASS,
      accumulatedMs: 0,
      lastTimestamp: null,
      onDue,
    });
    this.ensureRunning();
    return {
      stop: () => {
        this.ticks.delete(id);
        this.maybeStop();
      },
    };
  }

  /**
   * Register a cron-scheduled tick (`ticks { ... every "0 9 * * *" }`).
   * Fires at most once per matching calendar minute — the same dedup shape
   * `os/watch-cron` uses. Throws if `expression` isn't a valid 5-field cron
   * string; callers on a path the compiler has already validated (e.g.
   * generated code) won't hit this, but a raw runtime value might.
   */
  addCron(expression: string, onDue: () => void): TickHandle {
    const fields = parseCron(expression);
    const id = this.nextId++;
    this.ticks.set(id, {
      kind: 'cron',
      fields,
      accumulatedMs: CRON_CHECK_INTERVAL_MS, // check on the first pass, not after a full second
      lastTimestamp: null,
      lastFiredMinuteKey: -1,
      onDue,
    });
    this.ensureRunning();
    return {
      stop: () => {
        this.ticks.delete(id);
        this.maybeStop();
      },
    };
  }

  /** Stop every tick and the shared loop. */
  stopAll(): void {
    this.ticks.clear();
    this.maybeStop();
  }

  /** True while the scheduler is paused (no tick callback fires and no backlog accumulates). */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Halt the shared loop without dropping registered ticks. No `onDue`
   * fires again until `resume()`. A no-op if already paused.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stopLoop();
  }

  /**
   * Restart the shared loop after `pause()`. Every registered tick's phase
   * is reset (`lastTimestamp = null`) so the paused duration is never
   * counted as elapsed time — the same "first pass just captures the
   * timestamp" behavior a freshly `add()`-ed tick gets, which is what keeps
   * resume from bursting a backlog of missed beats. A no-op if not paused.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const tick of this.ticks.values()) {
      tick.lastTimestamp = null;
    }
    if (this.ticks.size > 0) {
      this.ensureRunning();
    }
  }

  private ensureRunning(): void {
    if (this.running || this.paused) return;
    this.running = true;
    if (this.hasRaf) {
      const loop = (timestamp: number) => {
        if (!this.running) return;
        this.advance(timestamp);
        this.frameHandle = requestAnimationFrame(loop);
      };
      this.frameHandle = requestAnimationFrame(loop);
    } else {
      this.frameHandle = setInterval(() => this.advance(Date.now()), 16);
    }
  }

  private maybeStop(): void {
    if (this.ticks.size > 0 || !this.running) return;
    this.stopLoop();
  }

  /** Cancel the active rAF/interval loop, if any, and clear the running flag. */
  private stopLoop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      if (this.hasRaf) {
        cancelAnimationFrame(this.frameHandle as number);
      } else {
        clearInterval(this.frameHandle as ReturnType<typeof setInterval>);
      }
      this.frameHandle = null;
    }
  }

  private advance(timestamp: number): void {
    for (const tick of this.ticks.values()) {
      if (tick.kind === 'cron') {
        this.advanceCron(tick, timestamp);
        continue;
      }
      if (tick.intervalMs <= EVERY_PASS) {
        tick.onDue();
        continue;
      }
      if (tick.lastTimestamp === null) {
        tick.lastTimestamp = timestamp;
        continue;
      }
      tick.accumulatedMs += timestamp - tick.lastTimestamp;
      tick.lastTimestamp = timestamp;
      if (tick.accumulatedMs >= tick.intervalMs) {
        tick.onDue();
        // Fire once per pass; keep only the phase remainder. Whole missed
        // beats are dropped so an overloaded pass can never burst.
        tick.accumulatedMs = tick.accumulatedMs % tick.intervalMs;
      }
    }
  }

  /** Cron ticks check calendar-match at most once a second, deduped per matching minute. */
  private advanceCron(tick: CronTick, timestamp: number): void {
    if (tick.lastTimestamp === null) {
      tick.lastTimestamp = timestamp;
      return;
    }
    tick.accumulatedMs += timestamp - tick.lastTimestamp;
    tick.lastTimestamp = timestamp;
    if (tick.accumulatedMs < CRON_CHECK_INTERVAL_MS) return;
    tick.accumulatedMs = 0;

    const now = new Date();
    const minuteKey = cronMinuteKey(now);
    if (minuteKey !== tick.lastFiredMinuteKey && cronMatches(tick.fields, now)) {
      tick.lastFiredMinuteKey = minuteKey;
      tick.onDue();
    }
  }
}

/** Construct a new, independent `TickScheduler`. */
export function createTickScheduler(): TickScheduler {
  return new TickScheduler();
}
