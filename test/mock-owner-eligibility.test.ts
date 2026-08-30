/**
 * Owner-stamping/relation-linking must be role-blind-safe: a gate-rejected
 * stamp (the boot default persona can't author under the entity's @create
 * policy) lands a deterministic ELIGIBLE owner instead of a random value,
 * and `linkRelationFields` never randomly credits an ineligible identity
 * with authorship of a row it fills in later.
 */
import { describe, it, expect } from 'vitest';
import { MockPersistenceAdapter } from '../src/MockPersistenceAdapter.js';
import type { EntitySchema } from '../src/MockPersistenceAdapter.js';

const contributorSchema: EntitySchema = {
  name: 'Contributor',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'role', type: 'string', required: true },
  ],
  seedData: [
    { id: 'c-1', role: 'reader' },
    { id: 'c-2', role: 'reader' },
    { id: 'c-3', role: 'author' },
    { id: 'c-4', role: 'reviewer' },
  ],
};

const wikiPageSchema: EntitySchema = {
  name: 'WikiPage',
  fields: [
    { name: 'id', type: 'string', required: true },
    { name: 'title', type: 'string', required: true },
    {
      name: 'authorId',
      type: 'relation',
      relation: { entity: 'Contributor', cardinality: 'one' },
    },
  ],
};

/** Only author|reviewer roles may create a WikiPage — mirrors an
 *  `@create: (or (= @user.role "author") (= @user.role "reviewer"))` policy. */
function authorOrReviewer(role: unknown): boolean {
  return role === 'author' || role === 'reviewer';
}

function buildAdapter(): MockPersistenceAdapter {
  const adapter = new MockPersistenceAdapter({
    ownerId: 'c-1', // the default persona is a READER
    ownerFields: ['WikiPage.authorId'],
  });
  // The boot default user is a fixed reader, so the fixed-viewer gate always
  // rejects — same shape as OrbitalServerRuntime.installOwnerGate's closure
  // evaluating the @create policy against a role-ineligible default user.
  adapter.setOwnerGate(() => false);
  adapter.setOwnerCandidateGate((_storeKey, _candidateRow, candidateIdentityRow) =>
    authorOrReviewer(candidateIdentityRow.role),
  );
  adapter.registerEntity(contributorSchema);
  adapter.registerEntity(wikiPageSchema, 6);
  return adapter;
}

describe('eligible-owner seed fallback', () => {
  it('stamps the first eligible author instead of skipping', async () => {
    const adapter = buildAdapter();
    const pages = await adapter.list('WikiPage');

    // Rows the owner-stamp loop attempts (every other row) land on the FIRST
    // eligible identity in seed order — c-1/c-2 are readers, c-3 is the
    // first author — deterministically, never a skip.
    for (let i = 0; i < pages.length; i += 2) {
      expect(pages[i]!.authorId).toBe('c-3');
    }
  });

  it('never leaves a policy-ineligible identity as author, on any row', async () => {
    const adapter = buildAdapter();
    const pages = await adapter.list('WikiPage');
    const contributors = await adapter.list('Contributor');
    const roleById = new Map(contributors.map((c) => [c.id as string, c.role]));

    for (const page of pages) {
      const role = roleById.get(page.authorId as string);
      expect(authorOrReviewer(role)).toBe(true);
    }
  });
});

describe('journal-protected cells', () => {
  it('a fallback-stamped cell is not relinked by a later relation pass', async () => {
    const adapter = buildAdapter();
    const before = await adapter.list('WikiPage');
    const stampedIds = before.filter((_row, i) => i % 2 === 0).map((row) => row.id as string);
    expect(stampedIds.length).toBeGreaterThan(0);

    // A second global relink pass (e.g. a sibling entity registering later)
    // must not disturb cells already in the owner-stamp journal.
    adapter.linkRelationFields();
    adapter.linkRelationFields();

    const after = await adapter.list('WikiPage');
    const byId = new Map(after.map((row) => [row.id as string, row]));
    for (const id of stampedIds) {
      expect(byId.get(id)!.authorId).toBe('c-3');
    }
  });
});
