/**
 * server-effect-handlers-access.test.ts
 *
 * The offline-preview pipeline honours the same `@read`/`@create`/`@update`/
 * `@delete` directives the interpreter and the generated server do. Before
 * this, `createServerEffectHandlers` carried its own inline filter loop — a
 * third copy of the predicate logic that applied the call-site `filter:` and
 * silently ignored every declared policy, so the preview showed rows the real
 * server would have withheld.
 *
 * `entityAccess` is optional: a caller that passes nothing keeps the old
 * unrestricted behavior, which is what `@almadar/ui`'s OrbPreview does today.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryPersistence } from '../src/PersistenceAdapter.js';
import { createServerEffectHandlers } from '../src/ServerEffectHandlers.js';
import { accessDeniedMessage } from '../src/entityAccess.js';
import type { EntityAccessPolicies, SExpr } from '@almadar/core';

/** `assignee == @user.id` — the ownership-scoping shape helpdesk declares. */
const ownedByViewer: SExpr = ['=', '@entity.assignee', '@user.id'];
/** `@user.role == "supervisor"` — the role-gate shape. */
const supervisorOnly: SExpr = ['=', '@user.role', 'supervisor'];

function seeded() {
  const p = new InMemoryPersistence();
  p.seed({
    Ticket: [
      { id: 't1', subject: 'One', assignee: 'agent-1' },
      { id: 't2', subject: 'Two', assignee: 'agent-2' },
      { id: 't3', subject: 'Three', assignee: 'agent-1' },
    ],
  });
  return p;
}

const bus = { emit: () => {} };

function handlers(
  persistence: InMemoryPersistence,
  policies: EntityAccessPolicies | undefined,
  user: { id: string; role?: string } | undefined,
) {
  return createServerEffectHandlers({
    persistence,
    eventBus: bus,
    entityType: 'Ticket',
    bindings: user ? { user } : {},
    entityAccess: policies ? new Map([['Ticket', policies]]) : undefined,
  });
}

describe('fetch honours the declared @read directive', () => {
  it('scopes a list to the viewer', async () => {
    const h = handlers(seeded(), { read: ownedByViewer }, { id: 'agent-1' });
    const result = await h.fetch?.('Ticket', {});
    expect(result?.rows).toHaveLength(2);
    expect(result?.total).toBe(2);
  });

  it('a different viewer gets the complement, not the same rows', async () => {
    const h = handlers(seeded(), { read: ownedByViewer }, { id: 'agent-2' });
    const result = await h.fetch?.('Ticket', {});
    expect(result?.rows).toHaveLength(1);
  });

  it('is a no-op when no policy is supplied — preview keeps today behaviour', async () => {
    const h = handlers(seeded(), undefined, { id: 'agent-1' });
    const result = await h.fetch?.('Ticket', {});
    expect(result?.rows).toHaveLength(3);
  });

  it('applies to a fetch BY ID too — a direct read is still a read', async () => {
    const h = handlers(seeded(), { read: ownedByViewer }, { id: 'agent-2' });
    // t1 belongs to agent-1, so agent-2 must not resolve it by id.
    expect(await h.fetch?.('Ticket', { id: 't1' })).toBeNull();
    expect((await h.fetch?.('Ticket', { id: 't2' }))?.rows).toBeTruthy();
  });

  it('narrows with BOTH policy and call-site filter, never widens', async () => {
    const h = handlers(seeded(), { read: ownedByViewer }, { id: 'agent-1' });
    const result = await h.fetch?.('Ticket', {
      filter: ['=', '@entity.subject', 'Three'] as SExpr,
    });
    expect(result?.rows).toHaveLength(1);
  });
});

describe('persist honours the declared mutation directives', () => {
  it('denies a create the @create policy rejects', async () => {
    const p = seeded();
    const h = handlers(p, { create: supervisorOnly }, { id: 'agent-1', role: 'agent' });
    await h.persist?.('create', 'Ticket', { id: 't9', subject: 'Nine' });
    expect(await p.list('Ticket')).toHaveLength(3);
  });

  it('allows the create when the viewer satisfies the policy', async () => {
    const p = seeded();
    const h = handlers(p, { create: supervisorOnly }, { id: 'sup-1', role: 'supervisor' });
    await h.persist?.('create', 'Ticket', { id: 't9', subject: 'Nine' });
    expect(await p.list('Ticket')).toHaveLength(4);
  });

  it('checks @update against the EXISTING row, not the incoming patch', async () => {
    const p = seeded();
    // agent-2 may not touch t1 (owned by agent-1) even by sending assignee:agent-2.
    const h = handlers(p, { update: ownedByViewer }, { id: 'agent-2' });
    await h.persist?.('update', 'Ticket', { id: 't1', assignee: 'agent-2' });
    const row = await p.getById('Ticket', 't1');
    expect(row?.['assignee']).toBe('agent-1');
  });

  it('denies a delete the @delete policy rejects and leaves the row', async () => {
    const p = seeded();
    const h = handlers(p, { delete: supervisorOnly }, { id: 'agent-1', role: 'agent' });
    await h.persist?.('delete', 'Ticket', 't1');
    expect(await p.getById('Ticket', 't1')).toBeTruthy();
  });

  it('records the denial as a failed effect carrying the shared message', async () => {
    const effectResults: Array<{ success: boolean; error?: string }> = [];
    const p = seeded();
    const h = createServerEffectHandlers({
      persistence: p,
      eventBus: bus,
      entityType: 'Ticket',
      bindings: { user: { id: 'agent-1', role: 'agent' } },
      entityAccess: new Map([['Ticket', { delete: supervisorOnly }]]),
      effectResults,
    });
    await h.persist?.('delete', 'Ticket', 't1');
    const denial = effectResults.find((r) => !r.success);
    expect(denial?.error).toBe(accessDeniedMessage('delete', 'Ticket'));
  });
});

describe('accessDeniedMessage is the one denial string', () => {
  it('names the operation and the entity', () => {
    expect(accessDeniedMessage('create', 'Ticket')).toBe(
      "@create denied: the declared access policy for 'Ticket' rejected this row",
    );
  });
});
