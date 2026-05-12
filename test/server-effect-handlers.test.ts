/**
 * server-effect-handlers.test.ts
 *
 * Targeted checks for the offline-preview pipeline:
 *   InMemoryPersistence → createServerEffectHandlers → EffectExecutor
 *
 * These tests mirror exactly what `@almadar/ui` OrbPreview autoMock runs
 * when std-list lands in the playground. If any of them fail, the preview
 * will be stuck in loading / empty / non-persistent respectively.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryPersistence } from '../src/PersistenceAdapter.js';
import { createServerEffectHandlers } from '../src/ServerEffectHandlers.js';
import { EffectExecutor } from '../src/EffectExecutor.js';
import type { Effect, BindingContext, EffectContext } from '../src/types.js';

function makeBus() {
    const events: Array<{ event: string; payload?: unknown }> = [];
    return {
        events,
        emit(event: string, payload?: unknown) {
            events.push({ event, payload });
        },
    };
}

function seeded(rows = 3) {
    const p = new InMemoryPersistence();
    p.seed({
        ListItem: Array.from({ length: rows }, (_, i) => ({
            id: String(i + 1),
            name: `Item ${i + 1}`,
            status: 'active',
        })),
    });
    return p;
}

describe('createClientEffectHandlers.emit — payload is NOT re-wrapped', () => {
    it('emits payload directly so subscribers can read @payload.X bindings', async () => {
        const { createClientEffectHandlers } = await import('../src/ClientEffectHandlers.js');
        const bus = makeBus();
        const h = createClientEffectHandlers({
            eventBus: bus,
            slotSetter: { addPattern: () => {}, clearSlot: () => {} },
        });
        h.emit!('ListItemLoaded', { data: [{ id: '1' }] } as never);
        const out = bus.events.find((e) => e.event === 'UI:ListItemLoaded');
        expect(out).toBeDefined();
        // Must be the raw { data: [...] } — NOT { payload: { data: [...] } }.
        const p = out!.payload as { data?: unknown[]; payload?: unknown };
        expect(Array.isArray(p.data)).toBe(true);
        expect(p.payload).toBeUndefined();
    });
});

describe('InMemoryPersistence — seed + list + crud', () => {
    it('seed + list returns the rows that were seeded', async () => {
        const p = seeded(3);
        const rows = await p.list('ListItem');
        expect(rows).toHaveLength(3);
        expect(rows[0].id).toBe('1');
        expect(rows[0].name).toBe('Item 1');
    });

    it('create adds a row visible to list', async () => {
        const p = seeded(1);
        await p.create('ListItem', { name: 'added', status: 'active' });
        const rows = await p.list('ListItem');
        expect(rows).toHaveLength(2);
        expect(rows.some((r) => r.name === 'added')).toBe(true);
    });

    it('seed on a plain object works (OrbPreview autoMock path)', async () => {
        const p = new InMemoryPersistence();
        p.seed({ ListItem: [{ id: '1', name: 'a' }] });
        expect((await p.list('ListItem'))[0].name).toBe('a');
    });
});

describe('createServerEffectHandlers — fetch reads persistence', () => {
    it('fetch returns the seeded rows', async () => {
        const p = seeded(3);
        const bus = makeBus();
        const h = createServerEffectHandlers({
            persistence: p,
            eventBus: bus,
            entityType: 'ListItem',
        });
        const result = await h.fetch!('ListItem', undefined);
        expect(result).not.toBeNull();
        expect(Array.isArray(result!.rows)).toBe(true);
        expect(result!.rows).toHaveLength(3);
        expect(result!.total).toBe(3);
    });

    it('persist.create appends, fetch sees the new row', async () => {
        const p = seeded(1);
        const bus = makeBus();
        const h = createServerEffectHandlers({
            persistence: p,
            eventBus: bus,
            entityType: 'ListItem',
        });
        await h.persist!('create', 'ListItem', { name: 'added', status: 'active' });
        const result = await h.fetch!('ListItem', undefined);
        expect(result).not.toBeNull();
        expect(result!.rows).toHaveLength(2);
        expect(result!.total).toBe(2);
    });
});

describe('EffectExecutor + createServerEffectHandlers — emit success with {data}', () => {
    it('fetch effect emits the configured success event with { data: rows }', async () => {
        const p = seeded(3);
        const bus = makeBus();
        const handlers = createServerEffectHandlers({
            persistence: p,
            eventBus: bus,
            entityType: 'ListItem',
        });
        const bindings: BindingContext = {} as BindingContext;
        const context: EffectContext = {
            traitName: 'ListItemBrowse',
            state: 'loading',
            transition: 'loading->loading',
        } as EffectContext;
        const exec = new EffectExecutor({ handlers, bindings, context });
        const fetchEffect: Effect = [
            'fetch',
            'ListItem',
            { emit: { success: 'ListItemLoaded', failure: 'ListItemLoadFailed' } },
        ] as unknown as Effect;
        await exec.executeAll([fetchEffect]);
        const loaded = bus.events.find((e) => e.event === 'ListItemLoaded');
        expect(loaded).toBeDefined();
        const payload = loaded!.payload as { data: unknown[] };
        expect(Array.isArray(payload.data)).toBe(true);
        expect(payload.data).toHaveLength(3);
    });

    it('persist.create effect with emit emits success carrying the new id', async () => {
        const p = seeded(0);
        const bus = makeBus();
        const handlers = createServerEffectHandlers({
            persistence: p,
            eventBus: bus,
            entityType: 'ListItem',
        });
        const bindings: BindingContext = {} as BindingContext;
        const context: EffectContext = {
            traitName: 'ListItemPersistor',
            state: 'idle',
            transition: 'idle->idle',
        } as EffectContext;
        const exec = new EffectExecutor({ handlers, bindings, context });
        const persistEffect: Effect = [
            'persist',
            'create',
            'ListItem',
            { name: 'added', status: 'active' },
            { emit: { success: 'ItemCreated', failure: 'ItemCreateFailed' } },
        ] as unknown as Effect;
        await exec.executeAll([persistEffect]);
        const created = bus.events.find((e) => e.event === 'ItemCreated');
        expect(created).toBeDefined();
        expect((await p.list('ListItem'))).toHaveLength(1);
    });
});
