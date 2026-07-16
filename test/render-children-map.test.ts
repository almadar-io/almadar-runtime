/**
 * Dynamic-collection children (FC-5) — render-time `array/map` in a `children:`
 * position. The canonical IR is a `children` entry kept verbatim:
 *   ["array/map", <collectionExpr>, ["fn", "<param>", <RenderUINode>]]
 * At render time the entry evaluates through the evaluator's `array/map` (which
 * binds the lambda param as the per-item `@item` scope) and the resolved nodes
 * splice flat into the host `children`, so components receive a plain
 * RenderUINode[]. These tests pin that contract at the BindingResolver layer.
 */

import { describe, it, expect } from 'vitest';
import {
    interpolateProps,
    createContextFromBindings,
    type BindingContext,
} from '../src/BindingResolver.js';
import type { RenderUINode } from '@almadar/core';

function makeCtx(entity: Record<string, unknown>) {
    const bindings: BindingContext = {
        entity: entity as unknown as BindingContext['entity'],
        payload: {},
        state: 'idle',
    };
    return createContextFromBindings(bindings);
}

describe('render-children map — array/map in children:', () => {
    it('renders N resolved children with @item fields resolved per item', () => {
        const ctx = makeCtx({
            tasks: [
                { title: 'Alpha', done: true },
                { title: 'Beta', done: false },
                { title: 'Gamma', done: true },
            ],
        });
        const pattern = {
            type: 'stack',
            children: [
                [
                    'array/map',
                    '@entity.tasks',
                    ['fn', 'item', { type: 'typography', content: '@item.title' }],
                ],
            ],
        };
        const result = interpolateProps(pattern, ctx);
        const children = result.children as Array<{ type: string; content: string }>;
        expect(children).toHaveLength(3);
        expect(children.map((c) => c.content)).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(children.every((c) => c.type === 'typography')).toBe(true);
    });

    it('preserves static entries alongside a map entry, flattened in order', () => {
        const ctx = makeCtx({ tags: [{ label: 'x' }, { label: 'y' }] });
        const pattern = {
            type: 'stack',
            children: [
                { type: 'heading', content: 'Tags' },
                [
                    'array/map',
                    '@entity.tags',
                    ['fn', 'item', { type: 'chip', content: '@item.label' }],
                ],
                { type: 'divider' },
            ],
        };
        const result = interpolateProps(pattern, ctx);
        const children = result.children as Array<{ type: string; content?: string }>;
        expect(children.map((c) => c.type)).toEqual(['heading', 'chip', 'chip', 'divider']);
        expect(children[1].content).toBe('x');
        expect(children[2].content).toBe('y');
    });

    it('empty collection yields empty (flattened away) children', () => {
        const ctx = makeCtx({ tasks: [] });
        const pattern = {
            type: 'stack',
            children: [
                [
                    'array/map',
                    '@entity.tasks',
                    ['fn', 'item', { type: 'typography', content: '@item.title' }],
                ],
            ],
        };
        const result = interpolateProps(pattern, ctx);
        expect(result.children).toEqual([]);
    });

    it('non-tuple children entries are unchanged (regression)', () => {
        const ctx = makeCtx({ name: 'Osamah' });
        const pattern = {
            type: 'stack',
            children: [
                { type: 'typography', content: '@entity.name' },
                { type: 'button', content: 'Save' },
            ],
        };
        const result = interpolateProps(pattern, ctx);
        const children = result.children as Array<{ type: string; content: string }>;
        expect(children).toHaveLength(2);
        expect(children[0].content).toBe('Osamah');
        expect(children[1].content).toBe('Save');
    });

    it('core type-level: the tuple form type-checks in a RenderUINode literal', () => {
        const node: RenderUINode = {
            type: 'stack',
            children: [
                { type: 'heading', content: 'Items' },
                [
                    'array/map',
                    '@entity.items',
                    ['fn', 'item', { type: 'typography', content: '@item.title' }],
                ],
            ],
        };
        expect(node.children).toHaveLength(2);
    });
});
