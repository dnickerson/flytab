/**
 * PauseDetector (A6): notices when FlyTab's JavaScript wasn't running.
 *
 * 2026-10-13/14: Chromium froze FlyTab's page ~30-40 s after it was hidden
 * (screen off or another app in front): engine alerts, the flight recorder and
 * traffic all stopped, silently. v11.18 keeps the page running (KeepAliveWebView),
 * and anything that still stops it (a renderer restart is separate) is reported:
 * a 1 s tick that sees a gap >= THRESHOLD_MS on the monotonic clock.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

const PauseDetector = new Function(readFileSync('web/shared/pause-detector.js', 'utf8') + '\nreturn PauseDetector;')();

function clocks(mono0 = 1000, wall0 = Date.parse('2026-10-14T16:13:00Z')) {
    const c = { mono: mono0, wall: wall0 };
    c.advance = (ms, { wallMs = ms } = {}) => { c.mono += ms; c.wall += wallMs; };
    return c;
}

describe('PauseDetector', () => {
    it('ticks a second apart: nothing to report', () => {
        const c = clocks(), onPause = vi.fn();
        const d = new PauseDetector({ onPause, now: () => c.mono, wall: () => c.wall });
        for (let i = 0; i < 120; i++) { d.check(); c.advance(1000); }
        expect(onPause).not.toHaveBeenCalled();
    });

    it('replay of 10-13 12:13-12:27: a 14 min gap is reported with its start, end and length', () => {
        const c = clocks(), onPause = vi.fn();
        const d = new PauseDetector({ onPause, now: () => c.mono, wall: () => c.wall });
        d.check();
        const start = c.wall;
        c.advance(14 * 60 * 1000);
        d.check();
        expect(onPause).toHaveBeenCalledTimes(1);
        expect(onPause.mock.calls[0][0]).toEqual({ startedAt: start, endedAt: c.wall, durationMs: 14 * 60 * 1000 });
    });

    it('a gap just under the threshold is not a pause; at the threshold it is', () => {
        const c = clocks(), onPause = vi.fn();
        const d = new PauseDetector({ onPause, now: () => c.mono, wall: () => c.wall });
        d.check(); c.advance(PauseDetector.THRESHOLD_MS - 1); d.check();
        expect(onPause).not.toHaveBeenCalled();
        c.advance(PauseDetector.THRESHOLD_MS); d.check();
        expect(onPause).toHaveBeenCalledTimes(1);
    });

    it('the wall clock set BACK is not a pause', () => {
        const c = clocks(), onPause = vi.fn();
        const d = new PauseDetector({ onPause, now: () => c.mono, wall: () => c.wall });
        d.check(); c.advance(1000, { wallMs: -3600 * 1000 }); d.check();
        expect(onPause).not.toHaveBeenCalled();
    });

    it('device asleep: the monotonic clock stops, the wall clock does not -> reported (PR A review #9)', () => {
        // performance.now() (CLOCK_MONOTONIC on Android) doesn't count suspend.
        const c = clocks(), onPause = vi.fn();
        const d = new PauseDetector({ onPause, now: () => c.mono, wall: () => c.wall });
        d.check();
        const start = c.wall;
        c.advance(1000, { wallMs: 5 * 60 * 1000 });   // 5 min asleep, 1 s of monotonic time
        d.check();
        expect(onPause).toHaveBeenCalledTimes(1);
        expect(onPause.mock.calls[0][0]).toEqual({ startedAt: start, endedAt: c.wall, durationMs: 5 * 60 * 1000 });
    });

    it('an absurd wall-clock jump (over a day) is not reported', () => {
        const c = clocks(), onPause = vi.fn();
        const d = new PauseDetector({ onPause, now: () => c.mono, wall: () => c.wall });
        d.check(); c.advance(1000, { wallMs: 3 * 24 * 3600 * 1000 }); d.check();
        expect(onPause).not.toHaveBeenCalled();
    });

    it('start() checks every second; stop() ends it', () => {
        vi.useFakeTimers();
        const d = new PauseDetector({ onPause: () => {} });
        const spy = vi.spyOn(d, 'check');
        d.start();
        vi.advanceTimersByTime(3000);
        expect(spy).toHaveBeenCalledTimes(4);          // once at start, then each second
        d.stop();
        vi.advanceTimersByTime(3000);
        expect(spy).toHaveBeenCalledTimes(4);
        vi.useRealTimers();
    });

    it('the pilot message: duration, local times, and what was off', () => {
        process.env.TZ = 'America/New_York';
        const p = { startedAt: Date.parse('2026-10-14T16:13:05Z'), endedAt: Date.parse('2026-10-14T16:27:40Z'), durationMs: 875_000 };
        expect(PauseDetector.message(p, true)).toBe('FlyTab wasn’t running for 15 min (12:13–12:27). Engine alerts and the flight recording were off.');
        const short = { startedAt: Date.parse('2026-10-14T16:40:11Z'), endedAt: Date.parse('2026-10-14T16:40:53Z'), durationMs: 42_000 };
        expect(PauseDetector.message(short, false)).toBe('FlyTab wasn’t running for 42 s (12:40:11–12:40:53). Engine alerts were off.');
    });
});
