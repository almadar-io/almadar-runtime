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
import { execFileSync } from "child_process";
import { createLogger } from '@almadar/logger';
import type { EventPayload, OsEmitConfig } from './types.js';
import type { EffectHandlers } from "./types.js";
import { parseCron, cronMatches, cronMinuteKey, type CronFields } from './cron.js';

const log = createLogger('almadar:runtime:os-handlers');

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
        log.warn('watch-files-failed-to-start', { error: err instanceof Error ? err : String(err) });
      }
    },

    osWatchProcess: (name: string, subcommand?: string, emit?: OsEmitConfig) => {
      const searchTerm = subcommand ? `${name} ${subcommand}` : name;
      // execFileSync below runs pgrep with no shell, so searchTerm can never inject
      // a command; this guard additionally rejects pathological / metacharacter input.
      if (!/^[\w .\-/:@]+$/.test(searchTerm)) {
        log.warn('watch-process-invalid-name', { searchTerm });
        return;
      }
      let wasRunning = false;
      // Both start + exit transitions share one event name when emit.on_message
      // is configured (consumers discriminate on the payload's `process` field).
      const startEvent = resolveOnMessage(emit, "OS_PROCESS_STARTED");
      const exitEvent = resolveOnMessage(emit, "OS_PROCESS_EXITED");

      const interval = setInterval(() => {
        let isRunning = false;
        try {
          const result = execFileSync("pgrep", ["-f", searchTerm], {
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
        log.warn('watch-port-only-tcp-supported', { protocol });
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
        log.warn('watch-http-compiled-only', {
          pattern: urlPattern,
          method: method ?? null,
        });
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
        log.warn('watch-cron-invalid-expression', { error: err instanceof Error ? err : String(err) });
        return;
      }

      let lastFired = -1;
      const eventName = resolveOnMessage(emit, "OS_CRON_FIRE");

      const interval = setInterval(() => {
        const now = new Date();
        const minuteKey = cronMinuteKey(now);

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
        log.warn('watch-signal-cannot-listen', { signal: sig, error: err instanceof Error ? err : String(err) });
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
