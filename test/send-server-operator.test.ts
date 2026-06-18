/**
 * Interpreter-path proof for the send-server operator.
 *
 * Drives the EffectExecutor directly: verifies that the `sendServer` handler
 * is called with the correct (event, payload) pair and that the wire-message
 * shape matches the server contract:
 *   { type: 'ORBITAL_EVENT', payload: { orbital, event, payload } }
 */

import { describe, it, expect, vi } from 'vitest';
import { EffectExecutor, type EffectHandlers } from '../src/index.js';

function makeExecutor(sendServer: EffectHandlers['sendServer']): {
    executor: EffectExecutor;
} {
    const executor = new EffectExecutor({
        handlers: {
            emit: vi.fn(),
            fetch: vi.fn(async () => ({ rows: [], total: 0 })),
            persist: vi.fn(async () => undefined),
            set: vi.fn(),
            sendServer,
        },
        bindings: { entity: undefined },
        context: {
            traitName: 'ChatMessageChat',
            state: 'idle',
            transition: 'idle->sending',
        },
    });
    return { executor };
}

describe('send-server operator — interpreter path', () => {
    it('calls sendServer handler with event name and payload', async () => {
        const sendServer = vi.fn();
        const { executor } = makeExecutor(sendServer);

        await executor.execute(['send-server', 'CHAT_MESSAGE', { text: 'Hello' }]);

        expect(sendServer).toHaveBeenCalledTimes(1);
        expect(sendServer).toHaveBeenCalledWith('CHAT_MESSAGE', { text: 'Hello' });
    });

    it('calls sendServer with undefined payload when payload omitted', async () => {
        const sendServer = vi.fn();
        const { executor } = makeExecutor(sendServer);

        await executor.execute(['send-server', 'PING']);

        expect(sendServer).toHaveBeenCalledTimes(1);
        expect(sendServer).toHaveBeenCalledWith('PING', undefined);
    });

    it('does not throw when sendServer handler is not provided', async () => {
        const executor = new EffectExecutor({
            handlers: {
                emit: vi.fn(),
                fetch: vi.fn(async () => ({ rows: [], total: 0 })),
                persist: vi.fn(async () => undefined),
                set: vi.fn(),
            },
            bindings: { entity: undefined },
            context: {
                traitName: 'ChatMessageChat',
                state: 'idle',
                transition: 'idle->sending',
            },
        });

        await expect(executor.execute(['send-server', 'CHAT_MESSAGE', { text: 'Hello' }])).resolves.not.toThrow();
    });

    it('produces the server wire-message shape from a custom sendServer implementation', async () => {
        const sent: string[] = [];
        const sendServer = vi.fn((event: string, payload?: Record<string, unknown>) => {
            const msg = JSON.stringify({
                type: 'ORBITAL_EVENT',
                payload: { orbital: 'ChatOrbital', event, payload: payload ?? null },
            });
            sent.push(msg);
        });
        const { executor } = makeExecutor(sendServer);

        await executor.execute(['send-server', 'CHAT_MESSAGE', { text: 'Hi' }]);

        expect(sent).toHaveLength(1);
        const parsed = JSON.parse(sent[0]);
        expect(parsed).toMatchObject({
            type: 'ORBITAL_EVENT',
            payload: {
                orbital: 'ChatOrbital',
                event: 'CHAT_MESSAGE',
                payload: { text: 'Hi' },
            },
        });
    });
});
