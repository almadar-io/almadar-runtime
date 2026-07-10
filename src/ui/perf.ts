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
  log.debug(name, () => ({ durationMs, ...(detail ?? {}) }));
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
