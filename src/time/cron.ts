/**
 * Cron expression parsing and matching — the ONE canonical implementation
 * every engine that schedules a cron-shaped interval delegates to (the
 * `os/watch-cron` effect handler in `createOsHandlers.ts`, `OrbitalServerRuntime`,
 * `TickScheduler`, and generated client codegen). No Node.js dependencies, so
 * it's safe to import client-side too.
 *
 * @packageDocumentation
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
}

export function parseCronField(field: string, min: number, max: number): Set<number> {
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

export function parseCron(expression: string): CronFields {
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

/** Returns true if `expression` is a syntactically valid 5-field cron expression. */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.has(date.getMinutes()) &&
    fields.hour.has(date.getHours()) &&
    fields.day.has(date.getDate()) &&
    fields.month.has(date.getMonth() + 1) &&
    fields.weekday.has(date.getDay())
  );
}

/** Calendar-minute key for once-per-minute dedup — the same shape `os/watch-cron` uses. */
export function cronMinuteKey(date: Date): number {
  return (
    date.getFullYear() * 1e8 +
    date.getMonth() * 1e6 +
    date.getDate() * 1e4 +
    date.getHours() * 100 +
    date.getMinutes()
  );
}
