import { describe, it, expect } from 'vitest';
import { applyRowAccess, checkMutationAccess } from '../src/entityAccess.js';
import type { EntityRow, SExpr, UserContext } from '@almadar/core';

/** `["=", "@entity.memberId", "@user.id"]` — the ownership-scoping shape. */
const ownerPredicate: SExpr = ['=', '@entity.memberId', '@user.id'];

function row(id: string, owner: string): EntityRow {
  return { id, memberId: owner };
}

function viewer(id: string): UserContext {
  return { id };
}

describe('applyRowAccess', () => {
  it('scopes rows to the viewer', () => {
    const rows = [row('r1', 'member-1'), row('r2', 'member-2'), row('r3', 'member-1')];
    const result = applyRowAccess(rows, ownerPredicate, undefined, { user: viewer('member-1') });
    expect(result).toHaveLength(2);
  });

  it('a different viewer gets the complement', () => {
    const rows = [row('r1', 'member-1'), row('r2', 'member-2'), row('r3', 'member-1')];
    const result = applyRowAccess(rows, ownerPredicate, undefined, { user: viewer('member-2') });
    expect(result).toHaveLength(1);
  });

  it('no viewer scopes to nothing rather than everything', () => {
    const rows = [row('r1', 'member-1'), row('r2', 'member-2')];
    const result = applyRowAccess(rows, ownerPredicate, undefined, {});
    expect(result).toHaveLength(0);
  });

  it('absent policy and filter keeps every row', () => {
    const rows = [row('r1', 'member-1'), row('r2', 'member-2')];
    const result = applyRowAccess(rows, undefined, undefined, { user: viewer('member-1') });
    expect(result).toHaveLength(2);
  });

  it('the policy and the call-site filter narrow together, never widen', () => {
    const rows = [
      { id: 'r1', memberId: 'member-1', status: 'open' },
      { id: 'r2', memberId: 'member-1', status: 'closed' },
      { id: 'r3', memberId: 'member-2', status: 'open' },
    ];
    const statusOpen: SExpr = ['=', '@entity.status', 'open'];
    const result = applyRowAccess(rows, ownerPredicate, statusOpen, { user: viewer('member-1') });
    expect(result).toEqual([{ id: 'r1', memberId: 'member-1', status: 'open' }]);
  });
});

describe('checkMutationAccess', () => {
  it('checks create against the incoming data', () => {
    const incoming = row('new', 'member-1');
    expect(checkMutationAccess(incoming, ownerPredicate, { user: viewer('member-1') })).toBe(true);

    const incomingWrongOwner = row('new', 'member-2');
    expect(checkMutationAccess(incomingWrongOwner, ownerPredicate, { user: viewer('member-1') })).toBe(
      false,
    );
  });

  it('checks update/delete against the existing row', () => {
    const existing = row('r1', 'member-1');
    expect(checkMutationAccess(existing, ownerPredicate, { user: viewer('member-2') })).toBe(false);
    expect(checkMutationAccess(existing, ownerPredicate, { user: viewer('member-1') })).toBe(true);
  });

  it('no policy allows the mutation', () => {
    const existing = row('r1', 'member-2');
    expect(checkMutationAccess(existing, undefined, { user: viewer('member-1') })).toBe(true);
  });
});
