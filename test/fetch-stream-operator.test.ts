/**
 * Interpreter-path proof for the fetch-stream operator.
 *
 * Drives the EffectExecutor directly: verifies that on_message fires once per
 * chunk with { chunk }, success fires once on completion with { data }, and
 * failure fires once (with { error }) when the handler throws.
 */

import { describe, it, expect, vi } from 'vitest';
import { EffectExecutor, type EffectHandlers } from '../src/index.js';

const CHUNKS = [
    { id: 'c1', content: 'Hello', index: 0 },
    { id: 'c2', content: 'World', index: 1 },
    { id: 'c3', content: 'Done',  index: 2 },
] as const;

function makeExecutor(fetchStream: EffectHandlers['fetchStream']): {
    emit: ReturnType<typeof vi.fn>;
    executor: EffectExecutor;
} {
    const emit = vi.fn();
    const executor = new EffectExecutor({
        handlers: {
            emit,
            fetch: vi.fn(async () => ({ rows: [], total: 0 })),
            persist: vi.fn(async () => undefined),
            set: vi.fn(),
            fetchStream,
        },
        bindings: { entity: undefined },
        context: {
            traitName: 'StreamChunkStream',
            state: 'idle',
            transition: 'idle->streaming',
        },
    });
    return { emit, executor };
}

describe('fetch-stream operator — interpreter path', () => {
    it('fires on_message once per chunk with { chunk } payload', async () => {
        const { emit, executor } = makeExecutor(async (_entity, _opts, onChunk) => {
            for (const chunk of CHUNKS) {
                onChunk(chunk);
            }
            return CHUNKS;
        });

        await executor.execute([
            'fetch-stream',
            'StreamChunk',
            { emit: { on_message: 'CHUNK_RECEIVED', success: 'STREAM_LOADED', failure: 'STREAM_FAILED' } },
        ]);

        const chunkCalls = emit.mock.calls.filter(([e]) => e === 'CHUNK_RECEIVED');
        expect(chunkCalls).toHaveLength(CHUNKS.length);
        chunkCalls.forEach((call, i) => {
            expect(call[1]).toEqual({ chunk: CHUNKS[i] });
        });
    });

    it('fires success once on completion with { data: finalResult }', async () => {
        const { emit, executor } = makeExecutor(async (_entity, _opts, onChunk) => {
            for (const chunk of CHUNKS) {
                onChunk(chunk);
            }
            return CHUNKS;
        });

        await executor.execute([
            'fetch-stream',
            'StreamChunk',
            { emit: { on_message: 'CHUNK_RECEIVED', success: 'STREAM_LOADED', failure: 'STREAM_FAILED' } },
        ]);

        const successCalls = emit.mock.calls.filter(([e]) => e === 'STREAM_LOADED');
        expect(successCalls).toHaveLength(1);
        expect(successCalls[0][1]).toEqual({ data: CHUNKS });
    });

    it('fires failure with { error } and does not fire success when handler throws', async () => {
        const { emit, executor } = makeExecutor(async () => {
            throw new Error('stream disconnected');
        });

        await expect(
            executor.execute([
                'fetch-stream',
                'StreamChunk',
                { emit: { on_message: 'CHUNK_RECEIVED', success: 'STREAM_LOADED', failure: 'STREAM_FAILED' } },
            ]),
        ).rejects.toThrow('stream disconnected');

        const successCalls = emit.mock.calls.filter(([e]) => e === 'STREAM_LOADED');
        const failureCalls = emit.mock.calls.filter(([e]) => e === 'STREAM_FAILED');
        expect(successCalls).toHaveLength(0);
        expect(failureCalls).toHaveLength(1);
        expect(failureCalls[0][1]).toMatchObject({ error: 'stream disconnected' });
    });

    it('fires on_message for each chunk in order before success', async () => {
        const order: string[] = [];
        const { emit, executor } = makeExecutor(async (_entity, _opts, onChunk) => {
            for (const chunk of CHUNKS) {
                onChunk(chunk);
            }
            return CHUNKS;
        });
        emit.mockImplementation((event: string) => { order.push(event); });

        await executor.execute([
            'fetch-stream',
            'StreamChunk',
            { emit: { on_message: 'CHUNK_RECEIVED', success: 'STREAM_LOADED' } },
        ]);

        const chunkIdx = order.lastIndexOf('CHUNK_RECEIVED');
        const successIdx = order.indexOf('STREAM_LOADED');
        expect(chunkIdx).toBeLessThan(successIdx);
        expect(order.filter((e) => e === 'CHUNK_RECEIVED')).toHaveLength(CHUNKS.length);
        expect(order.filter((e) => e === 'STREAM_LOADED')).toHaveLength(1);
    });
});
