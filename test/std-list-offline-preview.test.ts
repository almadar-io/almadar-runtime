/**
 * std-list-offline-preview.test.ts
 *
 * End-to-end check: a real std-list schema → InMemoryPersistence →
 * createServerEffectHandlers → EffectExecutor. Verifies that running
 * INIT from the `loading` state emits `ListItemLoaded` with the 10 mock
 * rows the preview seeds. If this passes but the playground UI is still
 * empty, the failure is in the `@almadar/ui` integration — not in the
 * effect pipeline.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryPersistence } from '../src/PersistenceAdapter.js';
import { createServerEffectHandlers } from '../src/ServerEffectHandlers.js';
import { EffectExecutor } from '../src/EffectExecutor.js';
import type { BindingContext, EffectContext } from '../src/types.js';

const FETCH_EFFECT: unknown[] = [
    'fetch',
    'ListItem',
    {
        emit: {
            success: 'ListItemLoaded',
            failure: 'ListItemLoadFailed',
        },
    },
];

function mockRow(i: number) {
    return {
        id: String(i),
        name: `ListItem Name ${i}`,
        description: `ListItem Description ${i}`,
        status: 'active',
    };
}

function buildSeeded(rowCount = 10) {
    const p = new InMemoryPersistence();
    p.seed({
        ListItem: Array.from({ length: rowCount }, (_, i) => mockRow(i + 1)),
    });
    return p;
}

describe('std-list offline preview — loading INIT emits ListItemLoaded', () => {
    it('fetch ListItem in `loading` state emits ListItemLoaded with 10 rows', async () => {
        const persistence = buildSeeded(10);
        const bus = { events: [] as Array<{ event: string; payload?: unknown }>, emit(e: string, p?: unknown) { this.events.push({ event: e, payload: p }); } };
        const handlers = createServerEffectHandlers({
            persistence,
            eventBus: bus,
            entityType: 'ListItem',
        });
        const bindings: BindingContext = { payload: {} } as BindingContext;
        const context: EffectContext = {
            traitName: 'ListItemBrowse',
            state: 'loading',
            transition: 'loading->loading',
        } as EffectContext;
        const exec = new EffectExecutor({ handlers, bindings, context });
        await exec.executeAll([FETCH_EFFECT as never]);
        const loaded = bus.events.find((e) => e.event === 'ListItemLoaded');
        expect(loaded, 'ListItemLoaded must fire').toBeDefined();
        const payload = loaded!.payload as { data: unknown[] };
        expect(payload.data).toHaveLength(10);
        expect((payload.data[0] as { name: string }).name).toBe('ListItem Name 1');
    });

    it('persist.create on ListItem adds a row the next fetch can see', async () => {
        const persistence = buildSeeded(2);
        const bus = { events: [] as Array<{ event: string; payload?: unknown }>, emit(e: string, p?: unknown) { this.events.push({ event: e, payload: p }); } };
        const handlers = createServerEffectHandlers({
            persistence,
            eventBus: bus,
            entityType: 'ListItem',
        });
        const bindings: BindingContext = { payload: {} } as BindingContext;
        const context: EffectContext = {
            traitName: 'ListItemPersistor',
            state: 'idle',
            transition: 'idle->idle',
        } as EffectContext;
        const exec = new EffectExecutor({ handlers, bindings, context });
        const createEffect: unknown[] = [
            'persist',
            'create',
            'ListItem',
            { name: 'user-created', status: 'active' },
            { emit: { success: 'ITEM_CREATED', failure: 'ITEM_CREATE_FAILED' } },
        ];
        await exec.executeAll([createEffect as never]);
        // Subsequent fetch should see 3 rows.
        await exec.executeAll([FETCH_EFFECT as never]);
        const last = [...bus.events].reverse().find((e) => e.event === 'ListItemLoaded');
        expect(last).toBeDefined();
        const payload = last!.payload as { data: unknown[] };
        expect(payload.data).toHaveLength(3);
        expect((payload.data[2] as { name: string }).name).toBe('user-created');
    });

    it('fetch does NOT mutate bindings — consumers read via bus event payload', async () => {
        // Contract: no implicit entity binding. fetch emits its result as a
        // bus event; bindings is only mutated by explicit (set @entity.X Y)
        // in a transition. If you want @entity.X to be populated after a
        // fetch, the trait must listen for the *Loaded event and (set ...).
        const persistence = buildSeeded(5);
        const bus = { events: [] as Array<{ event: string; payload?: unknown }>, emit(e: string, p?: unknown) { this.events.push({ event: e, payload: p }); } };
        const bindings = { payload: {}, entity: undefined } as BindingContext;
        const handlers = createServerEffectHandlers({
            persistence,
            eventBus: bus,
            entityType: 'ListItem',
            bindings,
        });
        const exec = new EffectExecutor({
            handlers,
            bindings,
            context: {
                traitName: 'ListItemBrowse',
                state: 'loading',
                transition: 'loading->loading',
            } as EffectContext,
        });
        await exec.executeAll([FETCH_EFFECT as never]);
        expect((bindings as { ListItem?: unknown }).ListItem).toBeUndefined();
        expect(bindings.entity).toBeUndefined();
        const loaded = bus.events.find((e) => e.event === 'ListItemLoaded');
        expect(loaded, 'ListItemLoaded carries the result instead').toBeDefined();
        expect((loaded!.payload as { data: unknown[] }).data).toHaveLength(5);
    });
});
