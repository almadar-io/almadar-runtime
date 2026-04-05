/**
 * Almadar Structured Logger (Runtime copy)
 *
 * Namespace-based logging with level gating.
 * Duplicated from @almadar/ui/lib/logger because @almadar/runtime
 * does not depend on @almadar/ui.
 *
 * @packageDocumentation
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Structured log data payload */
type LogData = { [key: string]: string | number | boolean | null | undefined | LogData | LogData[] };

const LEVEL_PRIORITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const ENV: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {};

const NODE_ENV = ENV.NODE_ENV ?? 'development';
const CONFIGURED_LEVEL = (
  ENV.LOG_LEVEL ?? (NODE_ENV === 'production' ? 'info' : 'debug')
).toUpperCase() as LogLevel;
const MIN_PRIORITY = LEVEL_PRIORITY[CONFIGURED_LEVEL] ?? 0;

const DEBUG_FILTER = (ENV.ALMADAR_DEBUG ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

function matchesNamespace(namespace: string): boolean {
  if (DEBUG_FILTER.length === 0) return true;
  return DEBUG_FILTER.some(pattern => {
    if (pattern === '*' || pattern === 'almadar:*') return true;
    if (pattern.endsWith(':*')) return namespace.startsWith(pattern.slice(0, -1));
    return namespace === pattern;
  });
}

export interface Logger {
  debug: (msg: string, data?: LogData) => void;
  info: (msg: string, data?: LogData) => void;
  warn: (msg: string, data?: LogData) => void;
  error: (msg: string, data?: LogData) => void;
}

export function createLogger(namespace: string): Logger {
  const nsAllowed = matchesNamespace(namespace);

  const log = (level: LogLevel, message: string, data?: LogData) => {
    if (LEVEL_PRIORITY[level] < MIN_PRIORITY) return;
    if (level === 'DEBUG' && !nsAllowed) return;

    const prefix = `[${namespace}]`;

    switch (level) {
      case 'DEBUG': console.debug(prefix, message, data ?? ''); break;
      case 'INFO':  console.info(prefix, message, data ?? ''); break;
      case 'WARN':  console.warn(prefix, message, data ?? ''); break;
      case 'ERROR': console.error(prefix, message, data ?? ''); break;
    }
  };

  return {
    debug: (msg: string, data?: LogData) => log('DEBUG', msg, data),
    info:  (msg: string, data?: LogData) => log('INFO', msg, data),
    warn:  (msg: string, data?: LogData) => log('WARN', msg, data),
    error: (msg: string, data?: LogData) => log('ERROR', msg, data),
  };
}
