/**
 * Duration-string parsing — the one canonical parser for a tick interval
 * written as `'5ms'`/`'5s'`/`'1m'`/`'1h'` (as opposed to a cron expression;
 * see `./cron.js`). Shared by `OrbitalServerRuntime` and any client consumer
 * (`@almadar/ui`'s `useTraitStateMachine`) so both agree on the same
 * milliseconds for the same string.
 *
 * @packageDocumentation
 */

/**
 * Parse a duration string to milliseconds. Supports `'5ms'`/`'5s'`/`'1m'`/`'1h'`,
 * and a bare number-as-string (assumed ms). Throws on anything else — a
 * caller should check `isValidCronExpression` first if the string might be
 * cron-shaped instead.
 */
export function parseDurationString(interval: string): number {
  const match = interval.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(
      `Invalid duration '${interval}': expected a shape like '5ms'/'5s'/'1m'/'1h'`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] || "ms";

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      return value;
  }
}

/** Returns true if `interval` matches the duration-string shape `parseDurationString` accepts. */
export function isValidDurationString(interval: string): boolean {
  return /^(\d+)(ms|s|m|h)?$/.test(interval);
}
