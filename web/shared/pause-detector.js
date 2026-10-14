/**
 * FlyTab — PauseDetector: notices when FlyTab's JavaScript wasn't running.
 *
 * Engine alerts, the flight recorder and traffic all run in this page; when it
 * stops, they stop, silently. 2026-10-13/14: Chromium froze the page ~30-40 s
 * after it was hidden (screen off or another app in front). KeepAliveWebView
 * now prevents that; anything else that stops the page is caught here, so the
 * pilot is told instead of not knowing.
 *
 * A 1 s tick: a gap of THRESHOLD_MS or more on the monotonic clock
 * (performance.now) means the page wasn't running. The wall clock is used only
 * for the times shown, so a clock change (GPS time sync) isn't a pause.
 */
class PauseDetector {
    /**
     * @param {{onPause: function({startedAt:number, endedAt:number, durationMs:number}),
     *          now?: function(): number, wall?: function(): number}} opts
     */
    constructor({ onPause, now = () => performance.now(), wall = () => Date.now() }) {
        this._onPause = onPause;
        this._now = now;
        this._wall = wall;
        this._lastMono = null;
        this._lastWall = null;
        this._timer = null;
    }

    start() {
        this.check();
        this._timer = setInterval(() => this.check(), 1000);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    check() {
        const mono = this._now(), wall = this._wall();
        if (this._lastMono != null) {
            const gap = mono - this._lastMono;
            if (gap >= PauseDetector.THRESHOLD_MS) {
                this._onPause?.({ startedAt: this._lastWall, endedAt: wall, durationMs: gap });
            }
        }
        this._lastMono = mono;
        this._lastWall = wall;
    }

    /** For the pilot: how long, when (local time), and what was off. */
    static message(p, recording) {
        const s = Math.round(p.durationMs / 1000);
        const len = s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
        const p2 = (n) => String(n).padStart(2, '0');
        // Seconds too for a short pause, or it reads "19:40–19:40".
        const hm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}` + (s < 90 ? `:${p2(d.getSeconds())}` : ''); };
        const off = recording ? 'Engine alerts and the flight recording were off.' : 'Engine alerts were off.';
        return `FlyTab wasn’t running for ${len} (${hm(p.startedAt)}–${hm(p.endedAt)}). ${off}`;
    }
}

PauseDetector.THRESHOLD_MS = 15000;
