/**
 * Re-export shim. The seeded PRNG and the mock-seed policy both live in
 * `@almadar/core/mock` now — core cannot import this package (that would be a
 * cycle), so the generator had to move up, not down.
 *
 * This file stays because `@almadar/runtime/mockRandom` is a published subpath
 * that `@almadar/verify` imports; deleting it would break a public contract.
 * Bindings are listed explicitly rather than `export *` because the bundler
 * treats `@almadar/core` as external and cannot see through a star re-export.
 */

export {
  randomAnytimeDate,
  randomArrayElement,
  randomBoolean,
  randomColor,
  randomEmail,
  randomFloat,
  randomInt,
  randomPassword,
  randomPastDate,
  randomPhone,
  randomRecentDate,
  randomSentence,
  randomUrl,
  randomUuid,
  randomWords,
  seedRandom,
  shuffleArray,
} from '@almadar/core/mock';
