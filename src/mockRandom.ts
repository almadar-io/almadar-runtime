/**
 * Lightweight seeded pseudo-random generator for mock data.
 *
 * Replaces @faker-js/faker in browser-facing code so the client bundle does
 * not pay the ~3.7 MB faker cost. The API surface is intentionally narrow:
 * only the helpers actually used by MockPersistenceAdapter.
 */

let seedState = 42;

/** Re-seed the generator. Same signature as `faker.seed()`. */
export function seedRandom(value: number | undefined): void {
  seedState = (value ?? 42) >>> 0;
}

/** Linear congruential generator returning a float in [0, 1). */
function nextFloat(): number {
  seedState = (seedState * 1664525 + 1013904223) >>> 0;
  return seedState / 4294967296;
}

/** Integer in [min, max]. */
export function randomInt({ min, max }: { min: number; max: number }): number {
  return Math.floor(nextFloat() * (max - min + 1)) + min;
}

/** Float in [min, max] with fixed fraction digits. */
export function randomFloat({
  min,
  max,
  fractionDigits = 2,
}: {
  min: number;
  max: number;
  fractionDigits?: number;
}): number {
  const value = nextFloat() * (max - min) + min;
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}

/** True/false with 50% probability. */
export function randomBoolean(): boolean {
  return nextFloat() < 0.5;
}

/** Pick one element from an array. */
export function randomArrayElement<T>(array: ReadonlyArray<T>): T {
  return array[randomInt({ min: 0, max: array.length - 1 })]!;
}

/** Return a shallow-shuffled copy of the array (Fisher-Yates). */
export function shuffleArray<T>(array: ReadonlyArray<T>): T[] {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt({ min: 0, max: i });
    const tmp = copy[i];
    copy[i] = copy[j]!;
    copy[j] = tmp!;
  }
  return copy;
}

/** ISO-8601 date string roughly `years` in the past. */
export function randomPastDate({ years = 1 }: { years?: number } = {}): Date {
  const now = Date.now();
  const maxAge = years * 365 * 24 * 60 * 60 * 1000;
  const age = Math.floor(nextFloat() * maxAge);
  return new Date(now - age);
}

/** ISO-8601 date string within the last `days`. */
export function randomRecentDate({ days = 30 }: { days?: number } = {}): Date {
  const now = Date.now();
  const maxAge = days * 24 * 60 * 60 * 1000;
  const age = Math.floor(nextFloat() * maxAge);
  return new Date(now - age);
}

/** Any date in the last ~100 years. */
export function randomAnytimeDate(): Date {
  const now = Date.now();
  const maxAge = 100 * 365 * 24 * 60 * 60 * 1000;
  const age = Math.floor(nextFloat() * maxAge);
  return new Date(now - age);
}

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
  'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
];

/** A few random words. */
export function randomWords(count: number): string {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(randomArrayElement(LOREM_WORDS));
  }
  return words.join(' ');
}

/** A short sentence. */
export function randomSentence(): string {
  const words = randomWords(randomInt({ min: 4, max: 8 }));
  return words.charAt(0).toUpperCase() + words.slice(1) + '.';
}

/** UUID v4-like string (random, not strictly compliant). */
export function randomUuid(): string {
  const hex = () => randomInt({ min: 0, max: 15 }).toString(16);
  return `${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}-${hex()}${hex()}${hex()}${hex()}-4${hex()}${hex()}${hex()}-${hex()}${hex()}${hex()}${hex()}-${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}${hex()}`;
}

/** Random hex color (#rrggbb). */
export function randomColor(): string {
  const channel = () => randomInt({ min: 0, max: 255 }).toString(16).padStart(2, '0');
  return `#${channel()}${channel()}${channel()}`;
}

const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';

/** Random password of the given length. */
export function randomPassword(length = 12): string {
  let password = '';
  for (let i = 0; i < length; i++) {
    password += randomArrayElement(PASSWORD_CHARS.split(''));
  }
  return password;
}

/** Random email address. */
export function randomEmail(): string {
  const user = randomWords(1).toLowerCase().replace(/\s+/g, '.');
  const domain = randomWords(1).toLowerCase().replace(/\s+/g, '');
  return `${user}@${domain}.com`;
}

/** Random URL. */
export function randomUrl(): string {
  const slug = randomWords(2).toLowerCase().replace(/\s+/g, '-');
  return `https://example.com/${slug}`;
}

/** Random phone number. */
export function randomPhone(): string {
  const area = randomInt({ min: 200, max: 999 });
  const prefix = randomInt({ min: 200, max: 999 });
  const line = randomInt({ min: 0, max: 9999 }).toString().padStart(4, '0');
  return `+1 (${area}) ${prefix}-${line}`;
}
