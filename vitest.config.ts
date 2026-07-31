import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: [
            'test/**/*.test.ts',
            'src/**/__tests__/**/*.test.ts',
        ],
        globals: true,
        // The SSE suites (`sse-stream`, `sse-incremental`) boot a real Express
        // server and drive a live event stream. Their bodies run in ~1.4-4.2s,
        // which fits vitest's 5s default only when they run alone — with two
        // such files in parallel workers the pair failed 4/4 runs at HEAD.
        // Budget for the contended case; a genuine hang still trips this.
        testTimeout: 20000,
        hookTimeout: 20000,
    },
});
