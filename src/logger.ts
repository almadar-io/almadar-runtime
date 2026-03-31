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
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export function createLogger(namespace: string): Logger {
  const nsAllowed = matchesNamespace(namespace);

  const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
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
    debug: (msg: string, data?: Record<string, unknown>) => log('DEBUG', msg, data),
    info:  (msg: string, data?: Record<string, unknown>) => log('INFO', msg, data),
    warn:  (msg: string, data?: Record<string, unknown>) => log('WARN', msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log('ERROR', msg, data),
  };
}
