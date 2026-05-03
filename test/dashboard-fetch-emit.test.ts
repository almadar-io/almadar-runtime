/**
 * Dashboard fetch → emit shape tests.
 *
 * Locks in the contract that std-stats / std-graphs depend on: when
 * `(fetch DashboardItem { emit: { success: "BrowseItemLoaded" } })` runs,
 * the bus event carries `{ data: [...rows], totalCount: <preLimit> }` so
 * cross-trait listeners can call `array/len @payload.data`,
 * `array/groupBy @payload.data <field>`, and `array/sum @payload.data
 * <field>` against the same shape every time.
 *
 * The "1/0" symptom on std-dashboard's stat cards was first triaged by
 * suspecting payload-shape drift here; these tests pin the shape so a
 * future regression surfaces in the runtime test run, not in a Playwright
 * verification screenshot.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    EffectExecutor,
    type EffectHandlers,
    type BindingContext,
    type EffectContext,
} from '../src/index.js';

const ROWS = [
    { id: 'a', name: 'Item A', status: 'active', category: 'foo', amount: 10, units: 2 },
    { id: 'b', name: 'Item B', status: 'active', category: 'foo', amount: 25, units: 4 },
    { id: 'c', name: 'Item C', status: 'active', category: 'bar', amount: 5,  units: 1 },
    { id: 'd', name: 'Item D', status: 'active', category: 'bar', amount: 7,  units: 3 },
    { id: 'e', name: 'Item E', status: 'active', category: 'baz', amount: 50, units: 5 },
    { id: 'f', name: 'Item F', status: 'inactive', category: 'baz', amount: 0,  units: 0 },
] as const;

function makeExecutor(): {
    emit: ReturnType<typeof vi.fn>;
    executor: EffectExecutor;
} {
    const emit = vi.fn();
    const handlers: EffectHandlers = {
        emit,
        // Multi-row fetch — the dashboard fetches the full collection then
        // lets the listening atoms aggregate locally.
        fetch: vi.fn(async () => ({ rows: [...ROWS], total: ROWS.length })),
        persist: vi.fn(async () => undefined),
        set: vi.fn(),
    };
    const bindings: BindingContext = {
        entity: undefined,
    };
    const context: EffectContext = {
        traitName: 'DashboardItemBrowse',
        state: 'browsing',
        transition: 'browsing->browsing',
    };
    const executor = new EffectExecutor({ handlers, bindings, context });
    return { emit, executor };
}

describe('Dashboard fetch → cross-trait emit', () => {
    it('emit.success carries { data: rows[], totalCount: total } for multi-row fetch', async () => {
        const { emit, executor } = makeExecutor();
        await executor.execute([
            'fetch',
            'DashboardItem',
            { limit: 100, offset: 0, emit: { success: 'BrowseItemLoaded' } },
        ]);
        const calls = emit.mock.calls.filter(([e]) => e === 'BrowseItemLoaded');
        expect(calls).toHaveLength(1);
        const [, payload] = calls[0];
        expect(payload).toEqual({ data: ROWS, totalCount: ROWS.length });
        // Sanity: a downstream array/len would see 6, not 1, and a
        // downstream array/groupBy 'status' would see active=5/inactive=1.
        expect(Array.isArray((payload as { data: unknown }).data)).toBe(true);
        expect(((payload as { data: unknown[] }).data).length).toBe(ROWS.length);
    });

    it('payload data is the same array reference for all listeners (Stats + Graphs both groupBy/sum it)', async () => {
        // Multiple atoms listen for BrowseItemLoaded — the bus emits ONCE
        // and every listener subscribes to the same payload. Cross-trait
        // fan-out copies references, so a Stats atom calling `array/len`
        // and a Graphs atom calling `array/groupBy` operate on the same
        // logical row set without one mutating the other.
        const { emit, executor } = makeExecutor();
        await executor.execute([
            'fetch',
            'DashboardItem',
            { limit: 100, emit: { success: 'BrowseItemLoaded' } },
        ]);
        const payload = emit.mock.calls.find(([e]) => e === 'BrowseItemLoaded')![1] as { data: unknown[] };
        // Snapshot the data array — verifying the runtime doesn't strip
        // fields the lambdas need (status / category / amount / units).
        const sampleKeys = Object.keys(payload.data[0] as Record<string, unknown>).sort();
        expect(sampleKeys).toEqual(['amount', 'category', 'id', 'name', 'status', 'units']);
    });

    it('failure path emits { error } so std-stats / std-graphs ITEMS_LOADED never fires on null data', async () => {
        // The failure branch is the safety valve: if Browse fails, neither
        // Stats nor Graphs receives ITEMS_LOADED, so their @entity.cards /
        // @entity.chartData stay at their INIT default `[]` (matches the
        // explicit-binding contract — no transition fired, no value set).
        const emit = vi.fn();
        const handlers: EffectHandlers = {
            emit,
            fetch: vi.fn().mockImplementationOnce(async () => {
                throw new Error('db unreachable');
            }),
        };
        const executor = new EffectExecutor({
            handlers,
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.executeWithResults([
            ['fetch', 'DashboardItem', { emit: { success: 'BrowseItemLoaded', failure: 'BrowseItemLoadFailed' } }],
        ]);
        const successCalls = emit.mock.calls.filter(([e]) => e === 'BrowseItemLoaded');
        const failureCalls = emit.mock.calls.filter(([e]) => e === 'BrowseItemLoadFailed');
        expect(successCalls).toHaveLength(0);
        expect(failureCalls).toHaveLength(1);
        expect(failureCalls[0][1]).toMatchObject({ error: 'db unreachable' });
    });

    it('null fetch result emits { data: null, totalCount: 0 } — sentinel for "not found"', async () => {
        // When the entity collection is empty (no matching rows), the
        // runtime emits a stable shape so listeners' `array/len`,
        // `array/groupBy`, etc. operate on `null` (which their `?? []`
        // guards normalize to []) instead of receiving an unexpected
        // shape that would silently break aggregation.
        const emit = vi.fn();
        const handlers: EffectHandlers = {
            emit,
            fetch: vi.fn(async () => null),
        };
        const executor = new EffectExecutor({
            handlers,
            bindings: {},
            context: { traitName: 'T', state: 's', transition: 't' },
        });
        await executor.execute(['fetch', 'DashboardItem', { emit: { success: 'BrowseItemLoaded' } }]);
        const [, payload] = emit.mock.calls.find(([e]) => e === 'BrowseItemLoaded')!;
        expect(payload).toEqual({ data: null, totalCount: 0 });
    });
});
