/**
 * `@user` binding resolution — the persona contract.
 *
 * Anchor: R-USER-DROPPED-IN-BINDING-CONTEXT. `OrbitalServerRuntime` carried the
 * authenticated viewer onto the `BindingContext`, but `createContextFromBindings`
 * never copied it onto the `EvaluationContext`, so every `@user.id` / `@user.role`
 * read in the interpreter resolved to `undefined` — ownership filters matched no
 * rows and role gates were permanently inert, while the compiled path honoured
 * both. Guards were doubly broken: `ProcessEventOptions` had no `user` field at
 * all, so a role predicate could not see a viewer even once the converter was
 * fixed.
 *
 * These tests pin the whole contract at the unit layer: the field survives the
 * conversion, resolves in value expressions, decides guards, and `uid`-shaped
 * provider claims normalize to the `id` every behavior in the library reads.
 */

import { describe, it, expect } from 'vitest';
import { normalizeUserContext, type UserContext } from '@almadar/core';
import {
    interpolateValue,
    createContextFromBindings,
    type BindingContext,
} from '../src/BindingResolver.js';
import { processEvent } from '../src/StateMachineCore.js';
import type { TraitDefinition, TraitState } from '../src/StateMachineCore.js';

function ctxFor(user: UserContext | undefined) {
    const bindings: BindingContext = {
        entity: {} as unknown as BindingContext['entity'],
        payload: {},
        state: 'idle',
        user,
    };
    return createContextFromBindings(bindings);
}

const ADMIN: UserContext = { id: 'admin-1', role: 'admin', name: 'Ada' };
const MEMBER: UserContext = { id: 'member-1', role: 'member' };

describe('@user in value expressions', () => {
    it('resolves @user.id and @user.role', () => {
        const ctx = ctxFor(ADMIN);
        expect(interpolateValue('@user.id', ctx)).toBe('admin-1');
        expect(interpolateValue('@user.role', ctx)).toBe('admin');
        expect(interpolateValue('@user.name', ctx)).toBe('Ada');
    });

    it('picks the branch a persona predicate selects — the persona-nav mechanic', () => {
        const tree = ['if', ['=', '@user.role', 'admin'], 'Admin view', 'Member view'];
        expect(interpolateValue(tree, ctxFor(ADMIN))).toBe('Admin view');
        expect(interpolateValue(tree, ctxFor(MEMBER))).toBe('Member view');
    });

    it('treats an absent viewer as the negative branch, not an error', () => {
        const tree = ['if', ['=', '@user.role', 'admin'], 'Admin view', 'Member view'];
        expect(interpolateValue(tree, ctxFor(undefined))).toBe('Member view');
        expect(interpolateValue('@user.id', ctxFor(undefined))).toBeUndefined();
    });

    it('scopes rows by owner — the std-row-access-control filter shape', () => {
        const rows = [
            { id: 'r1', memberId: 'member-1' },
            { id: 'r2', memberId: 'other' },
            { id: 'r3', memberId: 'member-1' },
        ];
        const filter = ['array/filter', '@payload.data', ['fn', 'row', ['=', ['object/get', '@row', 'memberId'], '@user.id']]];
        const bindings: BindingContext = {
            entity: {} as unknown as BindingContext['entity'],
            payload: { data: rows },
            state: 'idle',
            user: MEMBER,
        };
        const mine = interpolateValue(filter, createContextFromBindings(bindings)) as Array<{ id: string }>;
        expect(mine.map((r) => r.id)).toEqual(['r1', 'r3']);
    });
});

describe('@user in transition guards', () => {
    const trait: TraitDefinition = {
        name: 'Gated',
        initialState: 'idle',
        transitions: [
            {
                from: 'idle',
                event: 'PROMOTE',
                to: 'promoted',
                guard: ['=', '@user.role', 'admin'] as unknown as TraitDefinition['transitions'][0]['guard'],
                effects: [],
            },
        ],
    } as unknown as TraitDefinition;

    const traitState = { currentState: 'idle', context: {} } as unknown as TraitState;

    function promoteAs(user: UserContext | undefined) {
        return processEvent({ traitState, trait, eventKey: 'PROMOTE', user });
    }

    it('passes a role gate for the matching role', () => {
        expect(promoteAs(ADMIN).executed).toBe(true);
    });

    it('blocks a role gate for a non-matching role', () => {
        expect(promoteAs(MEMBER).executed).toBe(false);
    });

    it('blocks a role gate for an absent viewer', () => {
        expect(promoteAs(undefined).executed).toBe(false);
    });
});

describe('normalizeUserContext', () => {
    it('maps a provider `uid` onto the `id` every behavior reads', () => {
        const user = normalizeUserContext({ uid: 'firebase-abc', email: 'a@b.c' });
        expect(user?.id).toBe('firebase-abc');
        expect(user?.uid).toBe('firebase-abc');
        expect(user?.email).toBe('a@b.c');
    });

    it('maps `displayName` onto `name` and keeps extra claims readable', () => {
        const user = normalizeUserContext({ uid: 'u1', displayName: 'Ada L', tenantId: 't1' });
        expect(user?.name).toBe('Ada L');
        expect(user?.tenantId).toBe('t1');
    });

    it('prefers an explicit id and preserves role/permissions', () => {
        const user = normalizeUserContext({ id: 'u1', uid: 'ignored', role: 'admin', permissions: ['x'] });
        expect(user?.id).toBe('u1');
        expect(user?.role).toBe('admin');
        expect(user?.permissions).toEqual(['x']);
    });

    it('returns undefined for claims with no subject, so "no auth" stays distinguishable', () => {
        expect(normalizeUserContext(undefined)).toBeUndefined();
        expect(normalizeUserContext(null)).toBeUndefined();
        expect(normalizeUserContext({})).toBeUndefined();
        expect(normalizeUserContext({ uid: '' })).toBeUndefined();
    });
});
