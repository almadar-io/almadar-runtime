/**
 * Renderer-agnostic perf instrumentation.
 *
 * Contains the timing ring + mark/measure primitives used by runtime-side
 * schema prep and other framework-free work. React-specific consumption hooks
 * stay in `@almadar/ui/lib/perf` and read this shared ring.
 *
 * Gated behind `createLogger('almadar:perf:canvas')` so production builds
 * (LOG_LEVEL >= WARN) skip the work.
 *
 * @packageDocumentation
 */

import { createLogger, isLogLevelEnabled } from '@almadar/logger';

export const PERF_NAMESPACE = 'almadar:perf:canvas';

const log = createLogger(PERF_NAMESPACE);

/**
 * Perf metadata values are local instrumentation scalars. There is no
 * corresponding @almadar/core concept, so this local fallback type replaces
 * the previous Record<string, unknown> while keeping the surface concrete.
 */
export type PerfDetailValue = string | number | boolean | null | undefined;

export interface PerfDetail {
  readonly [key: string]: PerfDetailValue;
}

export interface PerfEntry {
  readonly name: string;
  readonly durationMs: number;
  readonly ts: number;
  readonly detail?: Readonly<PerfDetail>;
}

const RING_SIZE = 50;
const ring: PerfEntry[] = [];
let writeIdx = 0;

const subscribers = new Set<() => void>();
let notifyScheduled = false;
let revision = 0;
let cachedSnapshot: readonly PerfEntry[] = [];
let cachedRevision = -1;

function scheduleNotify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    revision++;
    for (const fn of subscribers) fn();
  });
}

function push(entry: PerfEntry): void {
  if (ring.length < RING_SIZE) {
    ring.push(entry);
  } else {
    ring[writeIdx] = entry;
  }
  writeIdx = (writeIdx + 1) % RING_SIZE;
  scheduleNotify();
}

function isEnabled(): boolean {
  // Namespace gate (log config) OR the probe switch `__ALMADAR_PERF__` — the
  // latter enables timing + aggregation WITHOUT the per-entry debug lines,
  // so a probe run doesn't recreate the console firehose it's measuring.
  return (
    isLogLevelEnabled('DEBUG', PERF_NAMESPACE) ||
    (globalThis as { __ALMADAR_PERF__?: boolean }).__ALMADAR_PERF__ === true
  );
}

/** Per-entry debug lines only when the namespace itself is enabled. */
function isVerbose(): boolean {
  return isLogLevelEnabled('DEBUG', PERF_NAMESPACE);
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Start a phase. Returns an opaque token; pass to {@link perfEnd}.
 * Returns -1 when the namespace is gated off.
 */
export function perfStart(name: string): number {
  if (!isEnabled()) return -1;
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try { performance.mark(`${name}-start`); } catch { /* ignore */ }
  }
  return now();
}

export function perfEnd(name: string, startToken: number, detail?: PerfDetail): void {
  if (startToken < 0 || !isEnabled()) return;
  const endTs = now();
  const durationMs = endTs - startToken;
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.mark(`${name}-end`);
      performance.measure(name, `${name}-start`, `${name}-end`);
    } catch { /* ignore */ }
  }
  push({ name, durationMs, ts: endTs, detail });
  aggregate(name, durationMs);
  if (isVerbose()) log.debug(name, () => ({ durationMs, ...(detail ?? {}) }));
}

/** Synchronous wrapper that times a fn end-to-end. */
export function perfTime<T>(name: string, fn: () => T, detail?: PerfDetail): T {
  const t = perfStart(name);
  try {
    return fn();
  } finally {
    perfEnd(name, t, detail);
  }
}

/** Async wrapper — the tick/effect paths are async end-to-end. */
export async function perfTimeAsync<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t = perfStart(name);
  try {
    return await fn();
  } finally {
    perfEnd(name, t);
  }
}

/** Record a non-duration scalar (queue depth, entries/pass) into the summary. */
export function perfGauge(name: string, value: number): void {
  if (!isEnabled()) return;
  aggregate(name, value);
}

// Aggregation: per-phase buckets dumped as one sorted `[PROFILE] summary`
// line every 5s (WARN so it survives quiet-by-default log configs — the
// probe is opt-in, so the line is signal, not noise).
interface PerfBucket {
  count: number;
  totalMs: number;
  maxMs: number;
}
const buckets = new Map<string, PerfBucket>();
let dumpTimer: ReturnType<typeof setInterval> | null = null;

function aggregate(name: string, ms: number): void {
  const b = buckets.get(name);
  if (b) {
    b.count++;
    b.totalMs += ms;
    if (ms > b.maxMs) b.maxMs = ms;
  } else {
    buckets.set(name, { count: 1, totalMs: ms, maxMs: ms });
  }
  if (dumpTimer === null) {
    dumpTimer = setInterval(dumpSummary, 5000);
    if (typeof dumpTimer === 'object' && 'unref' in dumpTimer) dumpTimer.unref();
  }
}

function dumpSummary(): void {
  if (buckets.size === 0) return;
  const rows = [...buckets.entries()]
    .map(([name, b]) => ({
      name,
      count: b.count,
      totalMs: Math.round(b.totalMs),
      avgMs: Math.round((b.totalMs / b.count) * 100) / 100,
      maxMs: Math.round(b.maxMs * 10) / 10,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  log.warn('[PROFILE] summary', { phases: JSON.stringify(rows) });
  buckets.clear();
}

/** Snapshot in insertion order (oldest first). Stable identity until next push. */
function getPerfSnapshot(): readonly PerfEntry[] {
  if (ring.length < RING_SIZE) return ring.slice();
  return [...ring.slice(writeIdx), ...ring.slice(0, writeIdx)];
}

function getSnapshot(): readonly PerfEntry[] {
  if (cachedRevision !== revision) {
    cachedSnapshot = getPerfSnapshot();
    cachedRevision = revision;
  }
  return cachedSnapshot;
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Push a pre-computed entry (e.g. React.Profiler callback). */
export function pushPerfEntry(entry: PerfEntry): void {
  if (!isEnabled()) return;
  push(entry);
}

/** Clear the ring and notify subscribers. */
export function clearPerf(): void {
  ring.length = 0;
  writeIdx = 0;
  scheduleNotify();
}

/**
 * Primitives a renderer-specific hook (e.g. React's `useSyncExternalStore`)
 * uses to consume the perf ring.
 */
export const perfStore = {
  subscribe,
  getSnapshot,
};
