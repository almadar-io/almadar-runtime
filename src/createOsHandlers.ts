/**
 * OS Trigger Handlers — Server-Side Only
 *
 * Provides Node.js implementations for all 8 os/* operators.
 * Used by OrbitalServerRuntime (interpreted path).
 *
 * NOT exported from the main index.ts because it imports Node.js-only modules.
 * Import directly: import { createOsHandlers } from '@almadar/runtime/createOsHandlers';
 *
 * @packageDocumentation
 */

import * as fs from "fs";
import * as net from "net";
import { execSync } from "child_process";
import type { EventPayload, OsEmitConfig } from './types.js';
import type { EffectHandlers } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface OsHandlerContext {
  /** Emit an event on the EventBus */
  emitEvent: (type: string, payload: EventPayload) => void;
  /** Working directory for file watching (defaults to process.cwd()) */
  cwd?: string;
}

export interface OsHandlerResult {
  handlers: Partial<EffectHandlers>;
  cleanup: () => void;
}

// ============================================================================
// Glob Matching (minimal, no external dependency)
// ============================================================================

function globToRegex(glob: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches any path segment
        regex += ".*";
        i += 2;
        if (glob[i] === "/") i++; // skip trailing slash
        continue;
      }
      // * matches anything except /
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if (c === ".") {
      regex += "\\.";
    } else if (c === "/" || c === "-" || c === "_") {
      regex += c;
    } else if (/[{}()[\]^$+|\\]/.test(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp("^" + regex + "$");
}

// ============================================================================
// Cron Parsing (5-field standard: min hour day month weekday)
// ============================================================================

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      const start = range === "*" ? min : parseInt(range, 10);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return values;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression (expected 5 fields): ${expression}`);
  }
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    day: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    weekday: parseCronField(parts[4], 0, 6),
  };
}

function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.day.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    fields.weekday.has(date.getDay())
  );
}

// ============================================================================
// Factory
// ============================================================================

export function createOsHandlers(ctx: OsHandlerContext): OsHandlerResult {
  const cwd = ctx.cwd ?? process.cwd();

  // Resource tracking for cleanup
  const watchers: fs.FSWatcher[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  let httpWatchActive = false;

  // Debounce configuration: { eventType: ms }
  const debounceConfig = new Map<string, number>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function debouncedEmit(eventType: string, payload: EventPayload): void {
    const ms = debounceConfig.get(eventType);
    if (ms !== undefined && ms > 0) {
      const existing = debounceTimers.get(eventType);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        eventType,
        setTimeout(() => {
          debounceTimers.delete(eventType);
          ctx.emitEvent(eventType, payload);
        }, ms),
      );
    } else {
      ctx.emitEvent(eventType, payload);
    }
  }

  // ============================================================================
  // Handler Implementations
  // ============================================================================

  // When an author sets `emit: { on_message: "X" }` on an os/watch-* effect,
  // we swap the hardcoded default event name for X. Null-safe: absent emit
  // config preserves the legacy names so existing schemas keep working.
  const resolveOnMessage = (emit: OsEmitConfig | undefined, fallback: string): string =>
    emit?.on_message ?? fallback;

  const handlers: Partial<EffectHandlers> = {
    osWatchFiles: (
      glob: string,
      options: { recursive?: boolean; debounce?: number },
      emit?: OsEmitConfig,
    ) => {
      const recursive = (options.recursive as boolean) !== false;
      const pattern = globToRegex(glob);
      const eventName = resolveOnMessage(emit, "OS_FILE_MODIFIED");

      try {
        const watcher = fs.watch(cwd, { recursive }, (_event, filename) => {
          if (filename && pattern.test(filename)) {
            debouncedEmit(eventName, {
              file: filename,
              glob,
              cwd,
            });
          }
        });
        watchers.push(watcher);
      } catch (err) {
        if (emit?.failure) {
          ctx.emitEvent(emit.failure, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        console.warn("[os/watch-files] Failed to start watcher:", err);
      }
    },

    osWatchProcess: (name: string, subcommand?: string, emit?: OsEmitConfig) => {
      const searchTerm = subcommand ? `${name} ${subcommand}` : name;
      let wasRunning = false;
      // Both start + exit transitions share one event name when emit.on_message
      // is configured (consumers discriminate on the payload's `process` field).
      const startEvent = resolveOnMessage(emit, "OS_PROCESS_STARTED");
      const exitEvent = resolveOnMessage(emit, "OS_PROCESS_EXITED");

      const interval = setInterval(() => {
        let isRunning = false;
        try {
          const result = execSync(`pgrep -f "${searchTerm}" 2>/dev/null`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          isRunning = result.trim().length > 0;
        } catch {
          isRunning = false;
        }

        if (isRunning && !wasRunning) {
          debouncedEmit(startEvent, { process: name, subcommand: subcommand ?? null });
        } else if (!isRunning && wasRunning) {
          debouncedEmit(exitEvent, { process: name, subcommand: subcommand ?? null });
        }
        wasRunning = isRunning;
      }, 2000);

      intervals.push(interval);
    },

    osWatchPort: (port: number, protocol: string, emit?: OsEmitConfig) => {
      if (protocol !== "tcp") {
        console.warn(`[os/watch-port] Only TCP is supported, got: ${protocol}`);
        return;
      }

      let wasOpen = false;
      const openEvent = resolveOnMessage(emit, "OS_PORT_OPENED");
      const closeEvent = resolveOnMessage(emit, "OS_PORT_CLOSED");

      const interval = setInterval(() => {
        const socket = new net.Socket();
        socket.setTimeout(1000);

        socket.on("connect", () => {
          socket.destroy();
          if (!wasOpen) {
            wasOpen = true;
            debouncedEmit(openEvent, { port, protocol });
          }
        });

        socket.on("error", () => {
          socket.destroy();
          if (wasOpen) {
            wasOpen = false;
            debouncedEmit(closeEvent, { port, protocol });
          }
        });

        socket.on("timeout", () => {
          socket.destroy();
          if (wasOpen) {
            wasOpen = false;
            debouncedEmit(closeEvent, { port, protocol });
          }
        });

        socket.connect(port, "127.0.0.1");
      }, 3000);

      intervals.push(interval);
    },

    osWatchHttp: (urlPattern: string, method?: string, _emit?: OsEmitConfig) => {
      // HTTP interception requires monkey-patching Node.js module exports (read-only in TS types).
      // The compiled path (backend.rs) generates untyped inline code that handles this.
      // For the interpreted runtime, log a warning.
      if (!httpWatchActive) {
        httpWatchActive = true;
        console.warn(
          `[os/watch-http] HTTP interception is only supported in compiled mode. ` +
          `Pattern: ${urlPattern}${method ? `, method: ${method}` : ""}`,
        );
      }
    },

    osWatchCron: (expression: string, emit?: OsEmitConfig) => {
      let fields: CronFields;
      try {
        fields = parseCron(expression);
      } catch (err) {
        if (emit?.failure) {
          ctx.emitEvent(emit.failure, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        console.warn("[os/watch-cron] Invalid expression:", err);
        return;
      }

      let lastFired = -1;
      const eventName = resolveOnMessage(emit, "OS_CRON_FIRE");

      const interval = setInterval(() => {
        const now = new Date();
        const minuteKey = now.getFullYear() * 1e8 + now.getMonth() * 1e6 +
          now.getDate() * 1e4 + now.getHours() * 100 + now.getMinutes();

        if (minuteKey !== lastFired && cronMatches(fields, now)) {
          lastFired = minuteKey;
          debouncedEmit(eventName, {
            expression,
            firedAt: now.toISOString(),
          });
        }
      }, 1000);

      intervals.push(interval);
    },

    osWatchSignal: (signal: string, emit?: OsEmitConfig) => {
      const sig = signal.toUpperCase() as NodeJS.Signals;
      // Default name keeps the per-signal suffix (OS_SIGNAL_TERM); a
      // configured on_message drops that convention in favor of the single
      // author-chosen event.
      const handler = () => {
        const eventName = emit?.on_message ?? `OS_SIGNAL_${sig}`;
        debouncedEmit(eventName, { signal: sig });
      };

      try {
        process.on(sig, handler);
        signalHandlers.push({ signal: sig, handler });
      } catch (err) {
        if (emit?.failure) {
          ctx.emitEvent(emit.failure, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        console.warn(`[os/watch-signal] Cannot listen for ${sig}:`, err);
      }
    },

    osWatchEnv: (variable: string, emit?: OsEmitConfig) => {
      let lastValue = process.env[variable];
      const eventName = resolveOnMessage(emit, "OS_ENV_CHANGED");

      const interval = setInterval(() => {
        const current = process.env[variable];
        if (current !== lastValue) {
          const previous = lastValue;
          lastValue = current;
          debouncedEmit(eventName, {
            variable,
            value: current ?? null,
            previous: previous ?? null,
          });
        }
      }, 1000);

      intervals.push(interval);
    },

    osDebounce: (ms: number, eventType: string) => {
      debounceConfig.set(eventType, ms);
    },
  };

  // ============================================================================
  // Cleanup
  // ============================================================================

  function cleanup(): void {
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    watchers.length = 0;

    for (const i of intervals) {
      clearInterval(i);
    }
    intervals.length = 0;

    for (const { signal, handler } of signalHandlers) {
      try { process.removeListener(signal, handler); } catch { /* noop */ }
    }
    signalHandlers.length = 0;

    httpWatchActive = false;

    // Clear pending debounce timers
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
  }

  return { handlers, cleanup };
}
