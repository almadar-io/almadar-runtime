/**
 * TickScheduler — coalesced tick clock tests.
 *
 * Verifies the shared accumulator loop fires ticks due in the same pass
 * together (rather than on independent, uncoordinated timers), honors
 * per-tick intervals, supports the frame-interval ("every pass") sentinel,
 * and that `stop()`/`stopAll()` actually halt future firings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTickScheduler } from '../src/index.js';

describe('TickScheduler', () => {
    let pending: Map<number, (ts: number) => void>;
    let nextHandle: number;
    let now: number;

    beforeEach(() => {
        pending = new Map();
        nextHandle = 1;
        now = 0;
        vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
            const handle = nextHandle++;
            pending.set(handle, cb);
            return handle;
        });
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
            pending.delete(handle);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** Advance the fake rAF clock by `deltaMs` and run exactly one queued frame. */
    function tickFrame(deltaMs: number): void {
        now += deltaMs;
        const due = [...pending.values()];
        pending.clear();
        for (const cb of due) cb(now);
    }

    function pendingFrameCount(): number {
        return pending.size;
    }

    it('fires a single-tick at its own interval', () => {
        const scheduler = createTickScheduler();
        const onDue = vi.fn();
        scheduler.add(100, onDue);

        tickFrame(0); // establish lastTimestamp
        tickFrame(50);
        expect(onDue).not.toHaveBeenCalled();
        tickFrame(60); // total elapsed 110ms >= 100ms
        expect(onDue).toHaveBeenCalledTimes(1);

        scheduler.stopAll();
    });

    it('fires two ticks due in the same accumulated pass TOGETHER, not as separate timers', () => {
        const scheduler = createTickScheduler();
        const fast = vi.fn();
        const slow = vi.fn();
        scheduler.add(33, fast);
        scheduler.add(100, slow);

        tickFrame(0);
        tickFrame(150); // both intervals elapsed within this single advance() pass
        expect(fast).toHaveBeenCalled();
        expect(slow).toHaveBeenCalledTimes(1);

        scheduler.stopAll();
    });

    it('treats interval <= 0 as "every pass" (frame-interval tick)', () => {
        const scheduler = createTickScheduler();
        const onDue = vi.fn();
        scheduler.add(0, onDue);

        tickFrame(0);
        tickFrame(1);
        tickFrame(1);
        expect(onDue).toHaveBeenCalledTimes(3);

        scheduler.stopAll();
    });

    it('stop() halts only that tick, leaving others running', () => {
        const scheduler = createTickScheduler();
        const a = vi.fn();
        const b = vi.fn();
        const handleA = scheduler.add(50, a);
        scheduler.add(50, b);

        tickFrame(0);
        tickFrame(60); // one period elapsed (>=50, <100) — fires exactly once each
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);

        handleA.stop();
        tickFrame(60);
        expect(a).toHaveBeenCalledTimes(1); // unchanged — stopped
        expect(b).toHaveBeenCalledTimes(2);

        scheduler.stopAll();
    });

    it('stopAll() halts every tick and no further frames are scheduled', () => {
        const scheduler = createTickScheduler();
        const onDue = vi.fn();
        scheduler.add(10, onDue);

        tickFrame(0); // establishes the loop + reschedules the next frame
        expect(pendingFrameCount()).toBe(1);

        scheduler.stopAll();
        expect(pendingFrameCount()).toBe(0);
    });

    describe('addCron', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('fires only on a matching calendar minute, not every check', () => {
            // 2026-01-01 09:00:00 is a Thursday — "0 9 * * *" fires daily at 9:00.
            vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 0));
            const scheduler = createTickScheduler();
            const onDue = vi.fn();
            scheduler.addCron('0 9 * * *', onDue);

            tickFrame(0); // establish lastTimestamp, no check yet
            tickFrame(1000); // first 1s check window — matches
            expect(onDue).toHaveBeenCalledTimes(1);

            // Still within the same matching minute — must not re-fire.
            tickFrame(1000);
            tickFrame(1000);
            expect(onDue).toHaveBeenCalledTimes(1);

            scheduler.stopAll();
        });

        it('does not fire on a non-matching minute', () => {
            vi.setSystemTime(new Date(2026, 0, 1, 10, 30, 0));
            const scheduler = createTickScheduler();
            const onDue = vi.fn();
            scheduler.addCron('0 9 * * *', onDue);

            tickFrame(0);
            tickFrame(1000);
            tickFrame(1000);
            expect(onDue).not.toHaveBeenCalled();

            scheduler.stopAll();
        });

        it('fires again once the calendar minute advances to the next match', () => {
            vi.setSystemTime(new Date(2026, 0, 1, 9, 0, 0));
            const scheduler = createTickScheduler();
            const onDue = vi.fn();
            scheduler.addCron('*/5 * * * *', onDue); // every 5 minutes

            tickFrame(0);
            tickFrame(1000);
            expect(onDue).toHaveBeenCalledTimes(1);

            // Advance real + fake system clock together to the next 5-minute mark.
            vi.setSystemTime(new Date(2026, 0, 1, 9, 5, 0));
            tickFrame(1000);
            expect(onDue).toHaveBeenCalledTimes(2);

            scheduler.stopAll();
        });

        it('throws on an invalid cron expression instead of silently misbehaving', () => {
            const scheduler = createTickScheduler();
            expect(() => scheduler.addCron('not a cron', vi.fn())).toThrow(
                /Invalid cron expression/,
            );
        });
    });
});
