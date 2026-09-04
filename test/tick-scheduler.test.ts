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

    it('never bursts catch-up firings after a stalled pass (spiral-of-death guard)', () => {
        const scheduler = createTickScheduler();
        const onDue = vi.fn();
        scheduler.add(33, onDue);

        tickFrame(0);
        tickFrame(1000); // one stalled pass ≈ 30 missed beats
        expect(onDue).toHaveBeenCalledTimes(1); // fires once, drops the debt

        // Healthy cadence is preserved through the phase remainder: the stall
        // left 1000 % 33 = 10ms of phase; two more 16ms frames reach 42ms ≥ 33ms.
        onDue.mockClear();
        tickFrame(16);
        tickFrame(16);
        expect(onDue).toHaveBeenCalledTimes(1);

        scheduler.stopAll();
    });

    describe('pause/resume', () => {
        it('isPaused reflects state and pause()/resume() are idempotent', () => {
            const scheduler = createTickScheduler();
            expect(scheduler.isPaused).toBe(false);

            scheduler.pause();
            expect(scheduler.isPaused).toBe(true);
            scheduler.pause(); // no-op, still paused
            expect(scheduler.isPaused).toBe(true);

            scheduler.resume();
            expect(scheduler.isPaused).toBe(false);
            scheduler.resume(); // no-op, still running
            expect(scheduler.isPaused).toBe(false);

            scheduler.stopAll();
        });

        it('a paused tick does not fire while paused, and no pending frame is scheduled', () => {
            const scheduler = createTickScheduler();
            const onDue = vi.fn();
            scheduler.add(10, onDue);

            tickFrame(0); // establish lastTimestamp, schedules next frame
            expect(pendingFrameCount()).toBe(1);

            scheduler.pause();
            expect(pendingFrameCount()).toBe(0); // loop torn down — nothing left to advance

            onDue.mockClear();
            scheduler.resume();
            expect(pendingFrameCount()).toBe(1); // loop restarted

            scheduler.stopAll();
        });

        it('resume() does not burst a backlog of missed ticks from the paused duration', () => {
            const scheduler = createTickScheduler();
            const onDue = vi.fn();
            scheduler.add(33, onDue);

            tickFrame(0);
            tickFrame(20); // partway through the interval, not yet due
            expect(onDue).not.toHaveBeenCalled();

            scheduler.pause();
            scheduler.resume();

            // First frame after resume just re-establishes lastTimestamp (same
            // as a freshly add()-ed tick) — even though real time may have
            // moved on a lot while paused, that gap is never counted.
            tickFrame(500);
            expect(onDue).not.toHaveBeenCalled();

            // Healthy cadence resumes from here.
            tickFrame(40);
            expect(onDue).toHaveBeenCalledTimes(1);

            scheduler.stopAll();
        });

        it('add()/addCron() while paused does not restart the loop', () => {
            const scheduler = createTickScheduler();
            scheduler.pause();
            expect(pendingFrameCount()).toBe(0);

            const onDue = vi.fn();
            scheduler.add(10, onDue);
            expect(pendingFrameCount()).toBe(0); // still paused, no loop started

            scheduler.resume();
            expect(pendingFrameCount()).toBe(1);

            scheduler.stopAll();
        });

        it('pausing with no registered ticks is a harmless no-op', () => {
            const scheduler = createTickScheduler();
            expect(() => scheduler.pause()).not.toThrow();
            expect(scheduler.isPaused).toBe(true);
            expect(() => scheduler.resume()).not.toThrow();
            expect(scheduler.isPaused).toBe(false);
            expect(pendingFrameCount()).toBe(0); // no ticks to drive a loop
        });
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
