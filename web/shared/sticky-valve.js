/**
 * FlyTab — Sticky valve detection, run on the tablet.
 *
 * The rule is the Pi's check_sticky_valve() (engine_monitor.py, removed from the
 * Pi in c6ca2d6): during the first 10 minutes after engine start, a cylinder
 * whose EGT stays below 50% of the other three's average for 30 seconds is the
 * cold-cylinder signature of a sticking exhaust valve ("morning sickness").
 * Nothing is compared until the engine is making heat (average EGT >= 200°F).
 *
 * Classic script, loaded after engine-client.js. Two parts:
 *   StickyValveDetector -- the rule itself, pure (no DOM, no clock of its own).
 *   StickyValveMonitor  -- feeds the detector from EngineClient's engine:data,
 *                          latches an alert until the pilot dismisses it, and
 *                          fires 'change' for the map and ENG page banners.
 */

const StickyValve = {
    /**
     * Thresholds, as the Pi had them. cockpit-config.json `enginePage` may set
     * stickyValveThresholdPct (50) and stickyValveWindowMinutes (10).
     */
    DEFAULTS: {
        warmupMin: 10,     // only look during the first 10 minutes after start
        egtRatio: 0.50,    // a cylinder below 50% of the others' average is low
        minEgt: 200,       // °F; the others must average at least this to compare
        persistSec: 30,    // continuously low this long before alerting
        gapSec: 4,         // samples further apart than this are a hole in the data
                           // (frames come at 1 Hz, or every 2 s on HTTP fallback)
        startRpm: 500,     // RPM above this = engine started
        stopRpm: 300,      // RPM below this...
        stopSec: 30,       // ...for this long = engine stopped. Recorded EDM data on
                           // this airframe has RPM reading 0 for 1-13 s with the
                           // engine running (73 times across 56 starts, mostly at
                           // ~1700 RPM -- likely the mag check); the Pi treated each
                           // as a stop + restart, clearing any alert.
    },

    /** DEFAULTS with the cockpit-config.json `enginePage` keys applied. */
    config() {
        const cfg = { ...StickyValve.DEFAULTS };
        let ep = null;
        try {
            ep = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get) ? CockpitConfig.get('enginePage') : null;
        } catch (_) { /* defaults */ }
        const pct = Number(ep?.stickyValveThresholdPct);
        if (pct > 0 && pct < 100) cfg.egtRatio = pct / 100;
        const min = Number(ep?.stickyValveWindowMinutes);
        if (min > 0) cfg.warmupMin = min;
        return cfg;
    },
};

class StickyValveDetector {
    constructor(cfg = StickyValve.DEFAULTS) {
        this.cfg = { ...StickyValve.DEFAULTS, ...cfg };
        this.engineStart = null;            // seconds, or null when not running
        this.endedBy = null;                // how the last run ended: 'rpm' | 'gap' | null
        this._lastT = null;                 // time of the last sample
        this._belowStopSince = null;        // when RPM went below stopRpm, while running
        this._lowSince = [null, null, null, null];
        this.alerting = [false, false, false, false];
        this.lastRatios = [null, null, null, null];
        this.lastOthersAvg = [null, null, null, null];
    }

    /** Lowest-numbered alerting cylinder (1-4), or null. */
    get alert() {
        const i = this.alerting.indexOf(true);
        return i === -1 ? null : i + 1;
    }

    /** Whether the warm-up window is open at time tSec. */
    watching(tSec) {
        return this.engineStart !== null && (tSec - this.engineStart) / 60 <= this.cfg.warmupMin;
    }

    /**
     * One EDM sample.
     * @param {number} rpm
     * @param {number[]} egt  EGT1-4, °F
     * @param {number} tSec   sample time in seconds
     * @returns {{ started: boolean, prevEnd: 'rpm'|'gap'|null }} started is true on
     *          the sample that detected a new engine start; prevEnd says how the
     *          run before it ended ('gap' = data stopped, so we never saw a stop).
     */
    sample(rpm, egt, tSec) {
        const c = this.cfg;
        const none = { started: false, prevEnd: null };

        // Time since the last sample. A short hole breaks the "30 s in a row"; a
        // hole longer than stopSec (Pi/EDM powered off, tablet asleep, clock
        // stepped back) means we can't know the engine kept running, so the run
        // ends and the next RPM > startRpm sample is watched as a new start.
        if (this._lastT !== null) {
            const dt = tSec - this._lastT;
            if (dt < 0 || dt > c.gapSec) this._resetTimers();
            if ((dt < 0 || dt > c.stopSec) && this.engineStart !== null) this._endRun('gap');
        }
        this._lastT = tSec;

        if (!Number.isFinite(rpm)) { this._resetTimers(); return none; }

        if (this.engineStart === null) {
            if (rpm > c.startRpm) {
                const prevEnd = this.endedBy;
                this.engineStart = tSec;
                this.endedBy = null;
                this._belowStopSince = null;
                this._resetTimers();
                this.alerting = [false, false, false, false];
                this.lastRatios = [null, null, null, null];
                this.lastOthersAvg = [null, null, null, null];
                return { started: true, prevEnd };
            }
            return none;
        }

        // Stop is checked before the warm-up window closes the rule (the Pi
        // checked it after, so a second start in one Pi session was never watched).
        // Low RPM only counts as a stop once it has lasted stopSec. Until then the
        // EGTs are still judged: these are the run-up RPM dropouts, engine running.
        if (rpm < c.stopRpm) {
            if (this._belowStopSince === null) this._belowStopSince = tSec;
            if (tSec - this._belowStopSince >= c.stopSec) { this._endRun('rpm'); return none; }
        } else {
            this._belowStopSince = null;
        }

        // Past the warm-up window: keep whatever was found, look no further.
        if (!this.watching(tSec)) return none;

        // A missing value is skipped; 0 is a reading, as on the Pi -- a cylinder
        // that isn't firing at all may well read 0, and a dead probe that raises
        // a ground warning is the cheaper mistake.
        const valid = [0, 1, 2, 3].filter(i => Number.isFinite(egt[i]));
        if (valid.length < 3) { this._resetTimers(); return none; }

        // Not judged while the engine isn't making heat; that time doesn't count
        // toward the 30 s either.
        const avgAll = valid.reduce((s, i) => s + egt[i], 0) / valid.length;
        if (avgAll < c.minEgt) { this._resetTimers(); return none; }

        for (let i = 0; i < 4; i++) {
            this.lastRatios[i] = null;
            this.lastOthersAvg[i] = null;
            if (!valid.includes(i)) { this._lowSince[i] = null; continue; }
            const others = valid.filter(j => j !== i);
            const avgOthers = others.reduce((s, j) => s + egt[j], 0) / others.length;
            if (avgOthers < c.minEgt) { this._lowSince[i] = null; continue; }

            const ratio = egt[i] / avgOthers;
            this.lastRatios[i] = ratio;
            this.lastOthersAvg[i] = avgOthers;
            if (ratio < c.egtRatio) {
                if (this._lowSince[i] === null) this._lowSince[i] = tSec;
                if (tSec - this._lowSince[i] >= c.persistSec) this.alerting[i] = true;
            } else {
                this._lowSince[i] = null;
                this.alerting[i] = false;   // recovered
            }
        }
        return none;
    }

    /**
     * No current EDM data (Pi stale, disconnected, or EDM quiet). The low-EGT
     * time must be continuous data, so the persistence timers restart; a long
     * gap also ends the run, on the next sample (see sample()).
     */
    gap() {
        this._resetTimers();
    }

    _endRun(reason) {
        this.engineStart = null;
        this.endedBy = reason;
        this._belowStopSince = null;
        this._resetTimers();
    }

    _resetTimers() {
        this._lowSince = [null, null, null, null];
    }
}

class StickyValveMonitor extends EventTarget {
    /**
     * @param {EventTarget|null} engineClient  EngineClient (engine:data / engine:stale / engine:disconnect)
     * @param {{ now?: () => number, cfg?: object }} [opts]  now() in ms; tests pass
     *        their own. Wall-clock by default: it keeps counting while the tablet
     *        sleeps, so a sleep shows up as a gap (performance.now() may not).
     */
    constructor(engineClient = null, opts = {}) {
        super();
        this._now = opts.now || (() => Date.now());
        this.detector = new StickyValveDetector(opts.cfg || StickyValve.config());
        // Latched alerts: cylinder -> { cyl, egt, othersAvg, at, recovered }. Kept
        // after the cylinder recovers so the pilot still sees it happened; cleared
        // at the next engine start after a seen shutdown.
        this._latched = new Map();
        this._dismissed = false;
        this._engineClient = null;
        if (engineClient) this._listen(engineClient);
    }

    /**
     * What the banners show: { visible, cylinders: [{ cyl, egt, othersAvg, at, recovered }] }
     * (at = Date.now() when it alerted). visible is false once dismissed, until a
     * cylinder goes low again (a new one, or one that had recovered).
     */
    get state() {
        const cylinders = [...this._latched.values()].sort((a, b) => a.cyl - b.cyl).map(c => ({ ...c }));
        return { visible: cylinders.length > 0 && !this._dismissed, cylinders };
    }

    /** Hide the warning (both banners). */
    dismiss() {
        if (this._dismissed) return;
        this._dismissed = true;
        this._emit();
    }

    /**
     * Feed one Pi status frame (raw, as engine:data carries it; the EDM row is
     * nested under `data`). Frames whose EDM row is not current are a data gap.
     */
    feed(raw) {
        if (!raw || (typeof EngineClient !== 'undefined' && !EngineClient.edmCurrent(raw))) {
            this.detector.gap();
            return;
        }
        const now = this._now();
        const d = raw.data ? { ...raw, ...raw.data } : raw;
        const num = (v) => (v == null || v === '' ? NaN : Number(v));
        const rpm = num(d.RPM ?? d.rpm);
        const egt = [1, 2, 3, 4].map(n => num(d[`EGT${n}`] ?? d[`egt${n}`]));

        const det = this.detector;
        const before = det.alerting.slice();
        const { started, prevEnd } = det.sample(rpm, egt, now / 1000);
        let changed = false;

        // A new start after a shutdown we saw clears the last run's warning. After
        // a data gap we never saw the engine stop, so an unacknowledged warning
        // stays up rather than vanishing because the Pi dropped out.
        if (started && prevEnd !== 'gap' && (this._latched.size || this._dismissed)) {
            this._latched.clear();
            this._dismissed = false;
            changed = true;
        }

        for (let i = 0; i < 4; i++) {
            const cyl = i + 1;
            const on = det.alerting[i];
            const latched = this._latched.get(cyl);
            if (on && !before[i]) {
                // A cylinder going low -- the first time, or again after it had
                // recovered -- is news: show the banner even if it was dismissed.
                const entry = { cyl, egt: Math.round(egt[i]), othersAvg: Math.round(det.lastOthersAvg[i]), at: Date.now(), recovered: false };
                this._latched.set(cyl, entry);
                this._dismissed = false;
                this.dispatchEvent(new CustomEvent('alert', { detail: { ...entry } }));
                changed = true;
            } else if (!on && before[i] && latched && !latched.recovered
                       && det.lastRatios[i] != null && det.lastRatios[i] >= det.cfg.egtRatio) {
                // Back above the line during warm-up (not a restart or the window closing).
                latched.recovered = true;
                changed = true;
            }
        }
        if (changed) this._emit();
    }

    _listen(engineClient) {
        this._engineClient = engineClient;
        this._onData = (e) => this.feed(e.detail);
        this._onStale = (e) => { if (e.detail?.stale) this.detector.gap(); };
        this._onDisconnect = () => this.detector.gap();
        engineClient.addEventListener('engine:data', this._onData);
        engineClient.addEventListener('engine:stale', this._onStale);
        engineClient.addEventListener('engine:disconnect', this._onDisconnect);
    }

    _emit() {
        this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    }

    destroy() {
        if (!this._engineClient) return;
        this._engineClient.removeEventListener('engine:data', this._onData);
        this._engineClient.removeEventListener('engine:stale', this._onStale);
        this._engineClient.removeEventListener('engine:disconnect', this._onDisconnect);
        this._engineClient = null;
    }

    /** Banner text for one latched cylinder. */
    static describe(c) {
        if (c.recovered) return `CYL ${c.cyl} EGT was low after start (${c.egt}°F vs ${c.othersAvg}°F), now recovered`;
        return `CYL ${c.cyl} EGT ${c.egt}°F vs ${c.othersAvg}°F others`;
    }
}
