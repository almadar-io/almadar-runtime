/**
 * Browser device effect dispatch tests.
 *
 * Proves the JS runtime routes the four `browser/*` device effects to their
 * dedicated `EffectHandlers` methods with the uniform `{ result }` / `{ error }`
 * emit parity — and that they are NOT swallowed by the namespaced substrate
 * `default` arm (the regression this guards). Host APIs (window / navigator)
 * are stubbed via the handlers, so this runs headless.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    EffectExecutor,
    type EffectHandlers,
    type BrowserGeolocationPosition,
} from '../src/index.js';

interface Emitted {
    event: string;
    payload: unknown;
}

function makeExecutor(handlers: Partial<EffectHandlers>) {
    const emitted: Emitted[] = [];
    const emit = vi.fn((event: string, payload?: unknown) => {
        emitted.push({ event, payload });
    });
    const executor = new EffectExecutor({
        handlers: { emit, ...handlers } as EffectHandlers,
        bindings: {},
        context: { traitName: 'DeviceProbeTrait', state: 'idle', transition: 'idle->idle' },
    });
    return { executor, emitted, emit };
}

describe('browser/* device effect dispatch', () => {
    it('browser/open-file-picker → handler + emit.success with { result: { files } }', async () => {
        const files = [{ name: 'a.txt', size: 1, type: 'text/plain', lastModified: 0 }];
        const browserOpenFilePicker = vi.fn(async () => ({ files }));
        const { executor, emitted } = makeExecutor({ browserOpenFilePicker });

        await executor.execute([
            'browser/open-file-picker',
            { emit: { success: 'FILES_PICKED', failure: 'PICK_FAILED' } },
        ]);

        expect(browserOpenFilePicker).toHaveBeenCalledOnce();
        expect(browserOpenFilePicker).toHaveBeenCalledWith(undefined);
        expect(emitted).toEqual([
            { event: 'FILES_PICKED', payload: { result: { files } } },
        ]);
    });

    it('browser/clipboard-read → handler + emit.success with { result: { text } }', async () => {
        const browserClipboardRead = vi.fn(async () => ({ text: 'copied' }));
        const { executor, emitted } = makeExecutor({ browserClipboardRead });

        await executor.execute([
            'browser/clipboard-read',
            { emit: { success: 'CLIP_READ', failure: 'CLIP_READ_FAILED' } },
        ]);

        expect(browserClipboardRead).toHaveBeenCalledOnce();
        expect(emitted).toEqual([
            { event: 'CLIP_READ', payload: { result: { text: 'copied' } } },
        ]);
    });

    it('browser/clipboard-write → handler receives text + emit.success echoes { result: { text } }', async () => {
        const browserClipboardWrite = vi.fn(async (text: string) => ({ text }));
        const { executor, emitted } = makeExecutor({ browserClipboardWrite });

        await executor.execute([
            'browser/clipboard-write',
            'hello from orbital',
            { emit: { success: 'CLIP_WRITTEN', failure: 'CLIP_WRITE_FAILED' } },
        ]);

        expect(browserClipboardWrite).toHaveBeenCalledOnce();
        expect(browserClipboardWrite).toHaveBeenCalledWith('hello from orbital');
        expect(emitted).toEqual([
            { event: 'CLIP_WRITTEN', payload: { result: { text: 'hello from orbital' } } },
        ]);
    });

    it('browser/geolocation-current → handler + emit.success with { result: position }', async () => {
        const position: BrowserGeolocationPosition = { latitude: 1, longitude: 2, accuracy: 3 };
        const browserGeolocationCurrent = vi.fn(async () => position);
        const { executor, emitted } = makeExecutor({ browserGeolocationCurrent });

        await executor.execute([
            'browser/geolocation-current',
            { emit: { success: 'GEO_OK', failure: 'GEO_FAILED' } },
        ]);

        expect(browserGeolocationCurrent).toHaveBeenCalledOnce();
        expect(browserGeolocationCurrent).toHaveBeenCalledWith(undefined);
        expect(emitted).toEqual([
            { event: 'GEO_OK', payload: { result: position } },
        ]);
    });

    it('handler throwing fires emit.failure with { error }', async () => {
        const browserClipboardRead = vi.fn(async () => {
            throw new Error('denied');
        });
        const { executor, emitted } = makeExecutor({ browserClipboardRead });

        await executor.execute([
            'browser/clipboard-read',
            { emit: { success: 'CLIP_READ', failure: 'CLIP_READ_FAILED' } },
        ]);

        expect(emitted).toEqual([
            { event: 'CLIP_READ_FAILED', payload: { error: 'denied' } },
        ]);
    });

    it('regression: browser/* with no handler does not fall through to the evaluator default', async () => {
        // No browser handlers registered — the dedicated case logs unsupported
        // and emits success with { result: null } rather than routing to the
        // namespaced substrate default (which would try to evaluate the op as a
        // value-position S-expression).
        const { executor, emitted } = makeExecutor({});

        await executor.execute([
            'browser/clipboard-read',
            { emit: { success: 'CLIP_READ', failure: 'CLIP_READ_FAILED' } },
        ]);

        expect(emitted).toEqual([
            { event: 'CLIP_READ', payload: { result: null } },
        ]);
    });
});
