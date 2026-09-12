/**
 * EffectExecutor `persist create` — REQUIRED-column check.
 *
 * A `persist create` whose data lacks a REQUIRED column must be a FAILED
 * effect outcome routed to `emit.failure`, exactly like the existing denied
 * path (`persist:denied`): logged, `emitFailure`d, and returned as
 * `{ failed: true, error }` — the store is never called. "Required column"
 * mirrors the Rust kernel's definition: a field with `required: true`,
 * excluding `id`/`createdAt`/`updatedAt`, any `@intrinsic` field, any
 * field declaring a `default`, and any field carrying `mergedFrom` (an
 * imported atom's own write contract on a rebind, never the host writer's).
 * "Missing" is key-absent or `undefined`/`null`/`''`.
 *
 * `resolveEntityFields` is supplied only by a caller holding the registered
 * schema (`OrbitalServerRuntime`); this file exercises `EffectExecutor`'s
 * own generic dispatch logic directly, independent of that caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { stubEffectHandlers } from './fixtures/effect-handlers.js';
import {
    EffectExecutor,
    type BindingContext,
    type EffectContext,
    type EntityRow,
} from '../src/index.js';
import type { EntityField } from '@almadar/core';

const CHAT_MESSAGE_FIELDS: EntityField[] = [
    { name: 'id', type: 'string', required: true, primaryKey: true },
    { name: 'content', type: 'string', required: true },
    { name: 'authorId', type: 'string', required: true, default: 'system' },
    { name: 'draft', type: 'string', required: true, intrinsic: true },
    { name: 'name', type: 'string', required: true, mergedFrom: 'BrowseItem' },
];

function makeContext(resolveEntityFields?: (entityType: string) => readonly EntityField[]) {
    const persist = vi.fn(async (_action: string, _entityType: string, data?: EntityRow) => ({
        ...(data ?? {}),
        id: (data?.id as string | undefined) ?? 'row-1',
    }));
    const emit = vi.fn();
    const handlers = stubEffectHandlers({ persist, emit });
    const bindings: BindingContext = {};
    const context: EffectContext = { traitName: 'Composer', state: 'idle', transition: 'idle->idle' };
    const executor = new EffectExecutor({ handlers, bindings, context, resolveEntityFields });
    return { persist, emit, executor };
}

describe('EffectExecutor persist create — required-column check', () => {
    it('fails a create missing a required column, routes emit.failure, never calls the store', async () => {
        const { persist, emit, executor } = makeContext(() => CHAT_MESSAGE_FIELDS);

        const [result] = await executor.executeWithResults([[
            'persist', 'create', 'ChatMessage',
            { id: 'msg-1', authorId: 'u1' },
            { emit: { success: 'MESSAGE_CREATED', failure: 'MESSAGE_CREATE_FAILED' } },
        ]]);

        expect(persist).not.toHaveBeenCalled();
        expect(result?.status).toBe('failed');
        expect(result?.error).toBe('persist create ChatMessage: required field(s) content missing');
        expect(emit).toHaveBeenCalledTimes(1);
        const [eventName, payload] = emit.mock.calls[0] as [string, { error?: string }];
        expect(eventName).toBe('MESSAGE_CREATE_FAILED');
        expect(payload.error).toBe('persist create ChatMessage: required field(s) content missing');
    });

    it('lists every missing required field', async () => {
        const { executor } = makeContext(() => CHAT_MESSAGE_FIELDS);

        const [result] = await executor.executeWithResults([[
            'persist', 'create', 'ChatMessage',
            { id: 'msg-1', content: '' },
            { emit: { failure: 'MESSAGE_CREATE_FAILED' } },
        ]]);

        expect(result?.status).toBe('failed');
        expect(result?.error).toBe('persist create ChatMessage: required field(s) content missing');
    });

    it('calls the store on a complete row', async () => {
        const { persist, executor } = makeContext(() => CHAT_MESSAGE_FIELDS);

        await executor.execute([
            'persist', 'create', 'ChatMessage',
            { id: 'msg-1', content: 'hello', authorId: 'u1' },
            { emit: { success: 'MESSAGE_CREATED' } },
        ]);

        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('does not treat a field with a declared default as missing when omitted', async () => {
        const { persist, executor } = makeContext(() => CHAT_MESSAGE_FIELDS);

        await executor.execute([
            'persist', 'create', 'ChatMessage',
            { id: 'msg-1', content: 'hello' },
        ]);

        expect(persist).toHaveBeenCalledTimes(1);
        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect('authorId' in writtenData).toBe(false);
    });

    it('does not treat an @intrinsic required field as missing when omitted', async () => {
        const { persist, executor } = makeContext(() => CHAT_MESSAGE_FIELDS);

        await executor.execute([
            'persist', 'create', 'ChatMessage',
            { id: 'msg-1', content: 'hello', authorId: 'u1' },
        ]);

        expect(persist).toHaveBeenCalledTimes(1);
        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect('draft' in writtenData).toBe(false);
    });

    it('does not treat a mergedFrom required field as missing when omitted', async () => {
        const { persist, executor } = makeContext(() => CHAT_MESSAGE_FIELDS);

        await executor.execute([
            'persist', 'create', 'ChatMessage',
            { id: 'msg-1', content: 'hello', authorId: 'u1' },
        ]);

        expect(persist).toHaveBeenCalledTimes(1);
        const writtenData = persist.mock.calls[0]?.[2] as EntityRow;
        expect('name' in writtenData).toBe(false);
    });

    it('leaves create verbatim when no resolveEntityFields is supplied (no schema)', async () => {
        const { persist, executor } = makeContext(undefined);

        await executor.execute(['persist', 'create', 'ChatMessage', { id: 'msg-1' }]);

        expect(persist).toHaveBeenCalledTimes(1);
    });
});
