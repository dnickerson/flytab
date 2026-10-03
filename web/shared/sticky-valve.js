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
 *   StickyValveDetector -- the rule itself, pure (no DOM, no clock).
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
        this._belowStopSince = null;        // when RPM went below stopRpm, while running
        this._lowSince = [null, null, null, null];
        this.alerting = [false, false, false, false];
        this.lastRatios = [null, null, null, null];
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
     * @param {number} tSec   sample time in seconds (any monotonic clock)
     * @returns {{ started: boolean }} started is true on the sample that detected
     *          a new engine start (the caller clears any old alert then).
     */
    sample(rpm, egt, tSec) {
        const c = this.cfg;
        if (!Number.isFinite(rpm)) { this.gap(); return { started: false }; }

        if (this.engineStart === null) {
            if (rpm > c.startRpm) {
                this.engineStart = tSec;
                this._belowStopSince = null;
                this._lowSince = [null, null, null, null];
                this.alerting = [false, false, false, false];
                this.lastRatios = [null, null, null, null];
                return { started: true };
            }
            return { started: false };
        }

        // Stop is checked before the warm-up window closes the rule (the Pi
        // checked it after, so a second start in one Pi session was never watched).
        // Low RPM only counts as a stop once it has lasted stopSec; until then the
        // samples are a gap (persistence timers restart, alert and window kept).
        if (rpm < c.stopRpm) {
            if (this._belowStopSince === null) this._belowStopSince = tSec;
            this._resetTimers();
            if (tSec - this._belowStopSince >= c.stopSec) {
                this.engineStart = null;
                this._belowStopSince = null;
            }
            return { started: false };
        }
        this._belowStopSince = null;

        // Past the warm-up window: keep whatever was found, look no further.
        if (!this.watching(tSec)) return { started: false };

        // An EGT of 0 or less is no reading (the Pi sends 0 for an empty EDM
        // field), not a cold cylinder: that probe is never a candidate and does
        // not drag down the others' average.
        const valid = [0, 1, 2, 3].filter(i => Number.isFinite(egt[i]) && egt[i] > 0);
        if (valid.length < 3) { this._resetTimers(); return { started: false }; }

        const avgAll = valid.reduce((s, i) => s + egt[i], 0) / valid.length;
        if (avgAll < c.minEgt) return { started: false };

        for (let i = 0; i < 4; i++) {
            if (!valid.includes(i)) {
                this._lowSince[i] = null;
                this.alerting[i] = false;
                this.lastRatios[i] = null;
                continue;
            }
            const others = valid.filter(j => j !== i);
            const avgOthers = others.reduce((s, j) => s + egt[j], 0) / others.length;
            if (avgOthers < c.minEgt) { this.lastRatios[i] = null; continue; }

            const ratio = egt[i] / avgOthers;
            this.lastRatios[i] = ratio;
            if (ratio < c.egtRatio) {
                if (this._lowSince[i] === null) this._lowSince[i] = tSec;
                if (tSec - this._lowSince[i] >= c.persistSec) this.alerting[i] = true;
            } else {
                this._lowSince[i] = null;
                this.alerting[i] = false;   // recovered
            }
        }
        return { started: false };
    }

    /**
     * No current EDM data (Pi stale, disconnected, or EDM quiet). The low-EGT
     * time must be continuous data, so the persistence timers restart; the
     * engine-start time and any alert are kept.
     */
    gap() {
        this._resetTimers();
    }

    _resetTimers() {
        this._lowSince = [null, null, null, null];
    }
}

class StickyValveMonitor extends EventTarget {
    /**
     * @param {EventTarget|null} engineClient  EngineClient (engine:data / engine:stale / engine:disconnect)
     * @param {{ now?: () => number, cfg?: object }} [opts]  now(): a monotonic
     *        clock in ms (default performance.now(), which a wall-clock change
     *        can't move); tests pass their own.
     */
    constructor(engineClient = null, opts = {}) {
        super();
        this._now = opts.now
            || ((typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now());
        this.detector = new StickyValveDetector(opts.cfg || StickyValve.config());
        // Latched alerts for this engine run: cylinder -> { cyl, egt, othersAvg, at, recovered }.
        // Kept after the cylinder recovers so the pilot still sees it happened.
        this._latched = new Map();
        this._dismissed = false;
        this._engineClient = null;
        if (engineClient) this._listen(engineClient);
    }

    /**
     * What the banners show: { visible, cylinders: [{ cyl, egt, othersAvg, at, recovered }] }
     * (at = Date.now() when it alerted).
     * visible is false once dismissed, until a different cylinder alerts or the
     * engine is restarted.
     */
    get state() {
        const cylinders = [...this._latched.values()].sort((a, b) => a.cyl - b.cyl).map(c => ({ ...c }));
        return { visible: cylinders.length > 0 && !this._dismissed, cylinders };
    }

    /** Hide the warning for this engine run (both banners). */
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
        const now = this._now();
        if (!raw || (typeof EngineClient !== 'undefined' && !EngineClient.edmCurrent(raw))) {
            this.detector.gap();
            return;
        }
        const d = raw.data ? { ...raw, ...raw.data } : raw;
        const num = (v) => (v == null || v === '' ? NaN : Number(v));
        const rpm = num(d.RPM ?? d.rpm);
        const egt = [1, 2, 3, 4].map(n => num(d[`EGT${n}`] ?? d[`egt${n}`]));

        const before = this.detector.alerting.slice();
        const { started } = this.detector.sample(rpm, egt, now / 1000);
        let changed = false;

        if (started && (this._latched.size || this._dismissed)) {
            this._latched.clear();
            this._dismissed = false;
            changed = true;
        }

        for (let i = 0; i < 4; i++) {
            const cyl = i + 1;
            const on = this.detector.alerting[i];
            const latched = this._latched.get(cyl);
            if (on && !before[i]) {
                const others = [0, 1, 2, 3].filter(j => j !== i && egt[j] > 0);
                const othersAvg = others.reduce((s, j) => s + egt[j], 0) / others.length;
                const isNew = !latched;
                this._latched.set(cyl, { cyl, egt: Math.round(egt[i]), othersAvg: Math.round(othersAvg), at: Date.now(), recovered: false });
                // A cylinder the pilot hasn't been told about re-shows a dismissed banner.
                if (isNew) {
                    this._dismissed = false;
                    this.dispatchEvent(new CustomEvent('alert', { detail: { ...this._latched.get(cyl) } }));
                }
                changed = true;
            } else if (!on && latched && !latched.recovered && this.detector.engineStart !== null
                       && this.detector.watching(now / 1000)) {
                // Only a real recovery (ratio back above the line during warm-up)
                // marks it recovered -- not a stopped engine or the window closing.
                if (this.detector.lastRatios[i] != null && this.detector.lastRatios[i] >= this.detector.cfg.egtRatio) {
                    latched.recovered = true;
                    changed = true;
                }
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
