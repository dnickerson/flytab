/**
 * FlyTab — Sticky-exhaust-valve pre-takeoff check (NTSB SA-109), run on the tablet.
 *
 * Classic script, loaded after engine-client.js. Parts:
 *   StickyValve         -- shared-spec loader/validator (sticky_valve_spec.json +
 *                          phase_spec.json -> detector config) and REFERENCES.
 *   StickyValveDetector -- line-for-line port of the Python reference
 *                          engine_analysis/sticky_valve.py (read its module
 *                          docstring: per-sample order of work, run-end order,
 *                          window definitions). Pure: no DOM, no clock of its own
 *                          (time is sample.t only). A golden-parity test demands
 *                          the same event lists as Python, so keep the order of
 *                          checks, the comparisons and the left-to-right loops.
 *   StickyValveMonitor  -- TEMPORARY until Task 9 rewrites it: still today's Pi
 *                          rule on LegacyStickyValveDetector, feeding from
 *                          EngineClient's engine:data, latching an alert until the
 *                          pilot dismisses it, and firing 'change' for the map and
 *                          ENG page banners.
 */

// Sources a spec threshold may cite (mirrors _ALLOWED_SOURCES in
// engine_analysis/sticky_valve_spec.py).
const STICKY_VALVE_ALLOWED_SOURCES = ['pi-rule', 'SA-109', 'old-python-rule', 'replay-tuned', 'placeholder', 'claude-call'];
const STICKY_VALVE_NON_THRESHOLD_KEYS = ['version', 'sources'];

const StickyValve = {
    /**
     * Validate sticky_valve_spec.json: every numeric leaf carries a provenance
     * entry in `sources` (and vice versa), every source value is a known one.
     * Same checks and key phrases as validate_sticky_valve_spec() in Python.
     * @returns {object} the spec, unchanged
     */
    validateSpec(spec) {
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
            throw new Error('sticky_valve_spec must be an object');
        }
        if (!('version' in spec) || !('sources' in spec)) {
            throw new Error("sticky_valve_spec missing 'version' or 'sources'");
        }
        const sources = spec.sources;
        if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
            throw new Error("sticky_valve_spec 'sources' must be an object");
        }

        const leaves = new Set();
        for (const [section, body] of Object.entries(spec)) {
            if (STICKY_VALVE_NON_THRESHOLD_KEYS.includes(section)) continue;
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                throw new Error(`section '${section}' must be an object of numeric thresholds`);
            }
            for (const [key, val] of Object.entries(body)) {
                if (typeof val !== 'number' || !Number.isFinite(val)) {
                    throw new Error(`${section}.${key} must be numeric, got ${JSON.stringify(val)}`);
                }
                leaves.add(`${section}.${key}`);
            }
        }

        const missing = [...leaves].filter(k => !(k in sources)).sort();
        if (missing.length) throw new Error(`no source for numeric leaves: ${missing.join(', ')}`);

        const extra = Object.keys(sources).filter(k => !leaves.has(k)).sort();
        if (extra.length) throw new Error(`sources keys not in spec: ${extra.join(', ')}`);

        const bad = Object.entries(sources).filter(([, v]) => !STICKY_VALVE_ALLOWED_SOURCES.includes(v));
        if (bad.length) {
            throw new Error(`unknown source values: ${bad.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
        }
        return spec;
    },

    /**
     * The spec sections (copied) plus the phase thresholds the detector shares
     * with phase_spec.json under cfg.phase. Same shape as build_config() in Python.
     */
    buildConfig(spec, phaseSpec) {
        const cfg = {};
        for (const [k, v] of Object.entries(spec)) {
            if (!STICKY_VALVE_NON_THRESHOLD_KEYS.includes(k)) cfg[k] = { ...v };
        }
        const t = phaseSpec && phaseSpec.thresholds;
        for (const key of ['rpm_runup_min', 'rpm_takeoff_min', 'mp_full_power']) {
            if (!t || !(key in t)) throw new Error(`phase_spec.json thresholds missing key: ${key}`);
        }
        cfg.phase = {
            runup_rpm: t.rpm_runup_min,
            takeoff_rpm: t.rpm_takeoff_min,
            takeoff_mp: t.mp_full_power,
        };
        return cfg;
    },

    /**
     * cockpit-config.json `enginePage` may set stickyValveThresholdPct (0-100
     * exclusive -> cold_cylinder.egt_ratio) and stickyValveWindowMinutes (> 0 ->
     * verdict.fallback_min). Returns a new cfg; the one passed in is untouched.
     */
    applyCockpitOverrides(cfg) {
        const out = { ...cfg, cold_cylinder: { ...cfg.cold_cylinder }, verdict: { ...cfg.verdict } };
        let ep = null;
        try {
            ep = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get) ? CockpitConfig.get('enginePage') : null;
        } catch (_) { /* spec values */ }
        const pct = Number(ep?.stickyValveThresholdPct);
        if (pct > 0 && pct < 100) out.cold_cylinder.egt_ratio = pct / 100;
        const min = Number(ep?.stickyValveWindowMinutes);
        if (min > 0) out.verdict.fallback_min = min;
        return out;
    },

    /**
     * Fetch sticky_valve_spec.json and phase_spec.json (relative URLs, like
     * loadPhaseSpec), validate, build the config and apply cockpit overrides.
     * @param {Function} [fetchImpl]  injected in tests; defaults to global fetch
     * @returns {Promise<object>} the detector config
     */
    async loadSpec(fetchImpl) {
        const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
        if (!doFetch) {
            throw new Error('StickyValve.loadSpec requires a fetch implementation (none injected and no global fetch)');
        }
        const getJson = async (name) => {
            const res = await doFetch(name);
            if (!res.ok) throw new Error(`Failed to load ${name}: HTTP ${res.status}`);
            return res.json();
        };
        const [spec, phaseSpec] = await Promise.all([getJson('sticky_valve_spec.json'), getJson('phase_spec.json')]);
        StickyValve.validateSpec(spec);
        return StickyValve.applyCockpitOverrides(StickyValve.buildConfig(spec, phaseSpec));
    },

    /** Advisory text shown with a finding (REFERENCES in sticky_valve.py). */
    REFERENCES: 'Advisory — inspect per Lycoming SB 388C; see SI 1425A / SL L197A.',
};

// ============================================================================
// StickyValveDetector -- port of engine_analysis/sticky_valve.py
// ============================================================================
//
// A causal, per-sample state machine: feed it one sample at a time with
// sample({t, rpm, mp, ff, egt: [4], cht: [4], carb, gs}) (°F, inHg, GPH, kts;
// NaN for a missing value) and it returns the events that sample caused.
// cfg = StickyValve.buildConfig(spec, phaseSpec). The Python module docstring is
// the specification; the summary below is kept in step with it.
//
// Order of work inside sample() (as in Python):
//   1. time since the last sample: a hole > run.gap_sec resets persistence
//      timers, breaks open R2/R3 windows and clears the R4/R5 history; a hole >
//      run.stop_sec, or a backwards clock, ends a running run with reason 'gap'
//   2. non-finite RPM: treated as a hole (as 1), nothing else
//   3. not running: RPM > run.start_rpm starts a run (settled at once if this is
//      the detector's first sample or the first after a gap-ended run)
//   4. stop: RPM < run.stop_rpm held run.stop_sec ends the run with reason 'rpm'
//   5. settle: RPM > run.start_rpm held run.settle_sec (unless settled at once)
//   6. takeoff power (rpm >= phase.takeoff_rpm and mp >= phase.takeoff_mp) ends
//      the ground watch for the rest of the run
//   7. append the sample to the history, drop from the front every entry with
//      t < t_now - max(roughness.window_sec, divergence.mp_drop_window_sec)
//      (bounded by time, never by count); then ground: R1, R2, R3, R4, ground
//      context notes; airborne: R5
//   8. verdict trigger (once per run), then verdict update (rank only rises)
// Run end ('gap', 'rpm', or finish()'s 'eof'): close any open R2/R3 window; if
// the verdict trigger has fired, recompute the verdict and emit a 'verdict'
// event if it rose, at the run_end event's t; then emit 'run_end'.
//
// Naming (ruling R-10): every object KEY at any depth is the Python key in
// camelCase (settle_t -> settleT, rules_not_run -> rulesNotRun, mp_drop ->
// mpDrop); VALUES (rule names, note names, verdicts, end reasons) are exactly
// Python's. Python None is null; an event never holds NaN or undefined.
//
// Numerics (golden parity): every mean is an explicit left-to-right += loop
// (Python's code avoids sum(), which is compensated in 3.12), std uses d * d,
// median-of-three and min/max use comparisons in Python's argument order
// (pyMin/pyMax below reproduce Python's min()/max() tie and -0 behaviour). With
// IEEE doubles on both sides and the same operation order, the results are
// bit-identical. Python would raise ZeroDivisionError where JS gives
// Infinity/NaN; with the shipped spec no such division is reachable (see the
// guards at each division).

const STICKY_VALVE_VERDICT_RANK = Object.freeze({
    'CHECKING': 0, 'NOT CHECKED': 1, 'PARTIAL': 2, 'VALVES OK': 3, 'CAUTION': 4, 'NO-GO': 5,
});
// Ground rules, in report order. R5 (divergence, airborne) is not a ground rule
// and never appears in rulesRun / rulesNotRun.
const STICKY_VALVE_GROUND_RULES = Object.freeze(['cold_cylinder', 'slow_heatup', 'cht_lag', 'roughness']);
const STICKY_VALVE_VALVE_RULES = Object.freeze(['cold_cylinder', 'slow_heatup']);   // NO-GO on their own

/** Python _finite(): not None and finite. */
function svFinite(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

/** Python all(_finite(v) for v in vals). */
function svAllFinite(vals) {
    for (const v of vals) if (!svFinite(v)) return false;
    return true;
}

/** Left-to-right mean (Python _mean). */
function svMean(vals) {
    let total = 0.0;
    for (const v of vals) total += v;
    return total / vals.length;
}

/** Population standard deviation, explicit loops (Python _pstd). */
function svPstd(vals) {
    const m = svMean(vals);
    const sq = [];
    for (const v of vals) {
        const d = v - m;
        sq.push(d * d);
    }
    return Math.sqrt(svMean(sq));
}

/** Median of three values, by comparisons only (Python _median3). */
function svMedian3(a, b, c) {
    if (a > b) { const x = a; a = b; b = x; }
    // now a <= b
    if (c <= a) return a;
    if (c >= b) return b;
    return c;
}

/** Python min(a, b): a unless b < a (differs from Math.min on -0/+0 and NaN). */
function svPyMin(a, b) { return b < a ? b : a; }
/** Python max(a, b): a unless b > a. */
function svPyMax(a, b) { return b > a ? b : a; }

/**
 * R2 slow_heatup (on EGT) / R3 cht_lag (on CHT): a one-shot comparison of each
 * cylinder's rise since the settle point against the others' mean rise, at the
 * first sample with t >= settleT + windowSec. Only on a cold settle.
 * state: 'idle' (no settle yet) -> 'open' -> 'run' | 'not_run'. Any NaN in the
 * field, any hole, or the end of the ground watch while open -> 'not_run'. A
 * window that completes but where no cylinder's others-mean rise reaches
 * min_others_rise_f is 'not_run' too (no comparison was made).
 */
class StickyValveRiseWindow {
    constructor(rule, field, rcfg) {
        this.rule = rule;
        this.field = field;
        this.windowSec = rcfg.window_sec;
        this.riseRatio = rcfg.rise_ratio;
        this.minOthersRise = rcfg.min_others_rise_f;
        this.state = 'idle';
        this.settleT = null;
        this.base = null;
        this.minRatio = null;   // margin: lowest rise_i / others' mean rise
    }

    open(s, cold) {
        const vals = s[this.field];
        if (cold !== true || !svAllFinite(vals)) {
            this.state = 'not_run';
            return;
        }
        this.state = 'open';
        this.settleT = s.t;
        this.base = vals.slice();
    }

    /** A hole, the end of the ground watch, or the end of the run. */
    close() {
        if (this.state === 'idle' || this.state === 'open') this.state = 'not_run';
    }

    /** Returns [[cyl, detail], ...] for the cylinders that fire. */
    step(s) {
        if (this.state !== 'open') return [];
        const vals = s[this.field];
        if (!svAllFinite(vals)) {
            this.state = 'not_run';
            return [];
        }
        if (s.t < this.settleT + this.windowSec) return [];
        const rise = [];
        for (let i = 0; i < 4; i++) rise.push(vals[i] - this.base[i]);
        const fired = [];
        let compared = false;
        for (let i = 0; i < 4; i++) {
            const o = [];
            for (let j = 0; j < 4; j++) if (j !== i) o.push(rise[j]);
            const others = svMean(o);
            // others > 0 also guards the division should min_others_rise_f be tuned to 0.
            if (others < this.minOthersRise || others <= 0) continue;
            compared = true;
            const ratio = rise[i] / others;
            if (this.minRatio === null || ratio < this.minRatio) this.minRatio = ratio;
            if (rise[i] < this.riseRatio * others) {
                fired.push([i + 1, { rise: rise[i], othersRise: others, ratio }]);
            }
        }
        this.state = compared ? 'run' : 'not_run';
        return fired;
    }
}

class StickyValveDetector {
    /**
     * @param {object} cfg  StickyValve.buildConfig(spec, phaseSpec) (optionally
     *        through StickyValve.applyCockpitOverrides)
     * @param {{daysSinceFlight?: number|null}} [opts]  days since the previous
     *        flight, or null/undefined when unknown
     */
    constructor(cfg, { daysSinceFlight = null } = {}) {
        this.cfg = cfg;
        this.daysSinceFlight = daysSinceFlight ?? null;
        this._lastT = null;
        this._fresh = true;     // next sample is the first ever, or the first after a gap-ended run
        this._running = false;
        this._verdict = null;
        this._resetRun(null);
    }

    // ---- public ------------------------------------------------------------

    /** Shown verdict of the current (or, after it ends, the last) run; null
     *  before that run's verdict trigger. Cleared when the next run starts. */
    get verdict() {
        return this._verdict;
    }

    get runActive() {
        return this._running;
    }

    /** One sample {t, rpm, mp, ff, egt: [4], cht: [4], carb, gs}; returns its
     *  events. The detector keeps references to recent samples (history, R5
     *  baseline), as Python keeps its frozen Samples: pass a fresh object per
     *  call and do not mutate it afterwards. */
    sample(s) {
        const c = this.cfg;
        const rc = c.run;
        const ev = [];
        const t = s.t;

        // 1. Time since the last sample.
        let dt = null;
        if (this._lastT !== null) {
            dt = t - this._lastT;
            if (dt < 0 || dt > rc.gap_sec) this._hole();
            if ((dt < 0 || dt > rc.stop_sec) && this._running) {
                this._endRun('gap', this._lastT, t, ev);
                this._fresh = true;
            }
        }
        this._lastT = t;
        const fresh = this._fresh;
        this._fresh = false;

        // 2. No RPM: a hole in the data.
        if (!svFinite(s.rpm)) {
            this._hole();
            return ev;
        }

        // 3. Start.
        if (!this._running) {
            if (s.rpm <= rc.start_rpm) return ev;
            this._startRun(s, ev);
            if (fresh) this._settle(s);
        }

        // 4. Stop. Low RPM only counts once held stop_sec (run-up RPM dropouts
        // read 0 for 1-13 s with the engine running). Not reset by holes.
        if (s.rpm < rc.stop_rpm) {
            if (this._belowStopSince === null) this._belowStopSince = t;
            if (t - this._belowStopSince >= rc.stop_sec) {
                this._endRun('rpm', t, t, ev);
                return ev;
            }
        } else {
            this._belowStopSince = null;
        }

        // 5. Settle.
        if (this._settleT === null) {
            if (s.rpm > rc.start_rpm) {
                if (this._aboveStartSince === null) this._aboveStartSince = t;
            } else {
                this._aboveStartSince = null;
            }
            if (this._aboveStartSince === null || t - this._aboveStartSince < rc.settle_sec) return ev;
            this._settle(s);
        }

        // 6. Takeoff power ends the ground watch (NaN MP never qualifies).
        const ph = c.phase;
        if (!this._airborne && s.rpm >= ph.takeoff_rpm && svFinite(s.mp) && s.mp >= ph.takeoff_mp) {
            this._airborne = true;
            this._r2.close();
            this._r3.close();
        }

        // 7. History (bounded by time: a count cap would truncate the windows at
        // higher cadences), then rules.
        this._hist.push(s);
        const lo = t - this._histSpan;
        while (this._hist.length > 1 && this._hist[0].t < lo) this._hist.shift();
        if (!this._airborne) {
            this._ruleColdCylinder(s, ev);
            for (const w of [this._r2, this._r3]) {
                for (const [cyl, detail] of w.step(s)) this._addFinding(t, w.rule, cyl, detail, ev);
            }
            this._ruleRoughness(s, ev);
            this._groundContext(s, dt, ev);
        } else {
            this._ruleDivergence(s, ev);
        }

        // 8. Verdict trigger and update.
        if (this._verdictT === null) {
            const vc = c.verdict;
            if ((svFinite(s.gs) && s.gs >= vc.taxi_speed_kts)
                    || s.rpm >= ph.runup_rpm
                    || t - this._startT >= vc.fallback_min * 60) {
                this._verdictT = t;
                const d = this.daysSinceFlight;
                if (d !== null && d >= c.context.days_since_flight) {
                    this._addContext(t, 'days_since_flight', { days: d }, ev);
                }
            }
        }
        if (this._verdictT !== null) this._updateVerdict(t, ev);
        return ev;
    }

    /** End of data: close an active run with reason 'eof' through the same
     *  end-run path (run_end.t = t, result endT = the last sample's t). Call it
     *  once, after the last sample. Returns [] when no run is active. */
    finish(t) {
        const ev = [];
        if (this._running) {
            this._endRun('eof', this._lastT, t, ev);
            this._fresh = true;
        }
        return ev;
    }

    // ---- lifecycle -----------------------------------------------------------

    _resetRun(startT) {
        const c = this.cfg;
        this._startT = startT;
        this._settleT = null;
        this._verdictT = null;
        this._cold = null;
        this._airborne = false;
        this._belowStopSince = null;
        this._aboveStartSince = null;
        this._findings = [];
        this._context = [];
        this._contextSeen = new Set();
        this._inflight = [];
        this._valveCyl = [false, false, false, false];   // cylinder has an R1/R2 finding
        // R1
        this._lowSince = [null, null, null, null];
        this._r1Fired = [false, false, false, false];
        this._r1JudgedSec = 0.0;
        this._r1PrevT = null;              // t of the previous sample if it was judged
        this._r1MinRatio = null;
        // R2 / R3
        this._r2 = new StickyValveRiseWindow('slow_heatup', 'egt', c.slow_heatup);
        this._r3 = new StickyValveRiseWindow('cht_lag', 'cht', c.cht_lag);
        // R4 / R5 shared history of contiguous settled samples (bounded by time)
        this._hist = [];
        this._histSpan = svPyMax(c.roughness.window_sec, c.divergence.mp_drop_window_sec);
        // R4
        this._r4StreakT = null;            // t of the first sample of the idle-qualifying streak
        this._r4StreakN = 0;               // its sample count (the last n history entries)
        this._r4Evaluated = false;
        this._r4FiredEngine = false;
        this._r4Fired = [false, false, false, false];
        this._r4MaxRpmStd = null;
        this._r4MaxEgtRatio = null;
        // R5
        this._r5Event = null;              // open event: {t0, base, mpDrop, fired}
        this._r5Closest = null;
        // context
        this._idleSec = 0.0;
    }

    _startRun(s, ev) {
        this._resetRun(s.t);
        this._running = true;
        this._verdict = null;
        this._aboveStartSince = s.t;
        ev.push({ type: 'run_start', t: s.t });
    }

    _settle(s) {
        this._settleT = s.t;
        const chts = [];
        for (const v of s.cht) if (svFinite(v)) chts.push(v);
        // Cold vs hot = mean CHT at settle. No CHT at all: unknown (null), so
        // R2/R3 do not run and the verdict cannot be VALVES OK.
        this._cold = chts.length === 0 ? null : svMean(chts) <= this.cfg.verdict.cold_cht_max_f;
        this._r2.open(s, this._cold);
        this._r3.open(s, this._cold);
    }

    /** A break in continuous data: persistence and hold timers restart and open
     *  heat-up windows cannot complete. */
    _hole() {
        this._lowSince = [null, null, null, null];
        this._aboveStartSince = null;
        this._r1PrevT = null;
        this._hist = [];
        this._r4StreakT = null;
        this._r4StreakN = 0;
        if (this._running && this._settleT !== null) {
            this._r2.close();
            this._r3.close();
        }
    }

    /** endT: last sample the run had (for 'gap', the sample before the hole);
     *  t: the sample that ended it (the event's time). */
    _endRun(reason, endT, t, ev) {
        this._r2.close();
        this._r3.close();
        // Closing an open window can change the verdict (CHECKING -> PARTIAL):
        // resolve it before run_end so result.verdict and the verdict getter
        // agree with the last verdict event.
        if (this._verdictT !== null) this._updateVerdict(t, ev);
        const evaluated = this._evaluated();
        const result = {
            startT: this._startT,
            settleT: this._settleT,
            verdictT: this._verdictT,
            endT,
            endReason: reason,
            coldSettle: this._cold,
            verdict: this._verdict,
            findings: this._findings.slice(),
            rulesRun: STICKY_VALVE_GROUND_RULES.filter(r => evaluated[r]),
            rulesNotRun: STICKY_VALVE_GROUND_RULES.filter(r => !evaluated[r]),
            context: this._context.slice(),
            inflight: this._inflight.slice(),
            margins: {
                coldCylinderMinRatio: this._r1MinRatio,
                slowHeatupMinRatio: this._r2.minRatio,
                chtLagMinRatio: this._r3.minRatio,
                roughnessMaxRpmStd: this._r4MaxRpmStd,
                roughnessMaxEgtRatio: this._r4MaxEgtRatio,
                divergenceClosest: this._r5Closest,
            },
        };
        this._running = false;
        this._belowStopSince = null;
        this._lowSince = [null, null, null, null];
        ev.push({ type: 'run_end', t, reason, result });
    }

    // ---- rules -------------------------------------------------------------

    /** R1 cold_cylinder: the Pi rule. EGT 0 is a reading; only non-finite
     *  values are skipped. */
    _ruleColdCylinder(s, ev) {
        const r = this.cfg.cold_cylinder;
        const egt = s.egt;
        const valid = [];
        for (let i = 0; i < 4; i++) if (svFinite(egt[i])) valid.push(i);
        if (valid.length < 3) {
            this._lowSince = [null, null, null, null];
            this._r1PrevT = null;
            return;
        }
        if (svMean(valid.map(i => egt[i])) < r.min_egt) {
            this._lowSince = [null, null, null, null];
            this._r1PrevT = null;
            return;
        }
        // Judged time: only between consecutive judged samples (a hole > gap_sec
        // clears _r1PrevT, so each step here is <= gap_sec).
        if (this._r1PrevT !== null) this._r1JudgedSec += s.t - this._r1PrevT;
        this._r1PrevT = s.t;
        for (let i = 0; i < 4; i++) {
            if (!valid.includes(i)) {
                this._lowSince[i] = null;
                continue;
            }
            const o = [];
            for (const j of valid) if (j !== i) o.push(egt[j]);
            const others = svMean(o);
            // others >= min_egt (200 in the spec) also keeps the division below finite.
            if (others < r.min_egt) {
                this._lowSince[i] = null;
                continue;
            }
            const ratio = egt[i] / others;
            if (this._r1MinRatio === null || ratio < this._r1MinRatio) this._r1MinRatio = ratio;
            if (ratio < r.egt_ratio) {
                if (this._lowSince[i] === null) this._lowSince[i] = s.t;
                if (s.t - this._lowSince[i] >= r.persist_sec && !this._r1Fired[i]) {
                    this._r1Fired[i] = true;
                    this._addFinding(s.t, 'cold_cylinder', i + 1,
                        { egt: egt[i], othersAvg: others, ratio }, ev);
                }
            } else {
                this._lowSince[i] = null;
            }
        }
    }

    /** R4 roughness: RPM jitter, or one cylinder's EGT much less steady than the
     *  others', over a sliding window of the last window_sec seconds of
     *  consecutive samples at steady idle. See the Python module docstring for
     *  the window. */
    _ruleRoughness(s, ev) {
        const r = this.cfg.roughness;
        const idle = this.cfg.run.stop_rpm <= s.rpm && s.rpm < this.cfg.phase.runup_rpm;
        // A missing MP or EGT cannot be judged steady: it breaks the streak, so no
        // window ever holds one (a dead EGT probe leaves R4 not run).
        if (!(idle && svFinite(s.mp) && svAllFinite(s.egt))) {
            this._r4StreakT = null;
            this._r4StreakN = 0;
            return;
        }
        if (this._r4StreakT === null) this._r4StreakT = s.t;
        this._r4StreakN += 1;
        const lo = s.t - r.window_sec;
        if (this._r4StreakT > lo) return;
        // Every settled sample is appended to the history before the rules, so the
        // streak is the last streakN entries (fewer if pruning dropped its oldest,
        // which all have t < lo). Select from the streak, not by t alone: a
        // non-streak sample can share streakT (dt == 0 is not a hole).
        let first = this._hist.length - this._r4StreakN;
        if (first < 0) first = 0;
        const win = [];
        for (let k = first; k < this._hist.length; k++) {
            if (this._hist[k].t >= lo) win.push(this._hist[k]);
        }
        let mpLo = win[0].mp;
        let mpHi = win[0].mp;
        for (const w of win) {
            if (w.mp < mpLo) mpLo = w.mp;
            if (w.mp > mpHi) mpHi = w.mp;
        }
        if (mpHi - mpLo > r.mp_band_inhg) return;
        this._r4Evaluated = true;
        const rpmStd = svPstd(win.map(w => w.rpm));
        const egtStd = [];
        for (let i = 0; i < 4; i++) egtStd.push(svPstd(win.map(w => w.egt[i])));
        if (this._r4MaxRpmStd === null || rpmStd > this._r4MaxRpmStd) this._r4MaxRpmStd = rpmStd;
        if (rpmStd > r.rpm_std_max && !this._r4FiredEngine) {
            this._r4FiredEngine = true;
            this._addFinding(s.t, 'roughness', null, { rpmStd }, ev);
        }
        for (let i = 0; i < 4; i++) {
            const o = [];
            for (let j = 0; j < 4; j++) if (j !== i) o.push(egtStd[j]);
            const med = svMedian3(o[0], o[1], o[2]);
            // egt_std_floor_f (> 0 in the spec) keeps the division finite.
            const ratio = egtStd[i] / svPyMax(med, r.egt_std_floor_f);
            if (egtStd[i] < r.egt_std_min_f) {
                // Too steady to fire whatever the ratio; left out of the margin so a
                // near-zero median cannot inflate it.
                continue;
            }
            if (this._r4MaxEgtRatio === null || ratio > this._r4MaxEgtRatio) this._r4MaxEgtRatio = ratio;
            if (ratio > r.egt_std_ratio_max && !this._r4Fired[i]) {
                this._r4Fired[i] = true;
                this._addFinding(s.t, 'roughness', i + 1,
                    { egtStd: egtStd[i], othersMedian: med, ratio }, ev);
            }
        }
    }

    /** R5 divergence (CEN19LA199): after an airborne MP drop, one cylinder's EGT
     *  falls while a different one rises. MP only: fuel flow plays no part. */
    _ruleDivergence(s, ev) {
        const d = this.cfg.divergence;
        let e = this._r5Event;
        if (e !== null && s.t > e.t0 + d.watch_sec) {
            e = this._r5Event = null;
        }
        if (e === null && svFinite(s.mp)) {
            let mx = null;
            let base = null;
            const lo = s.t - d.mp_drop_window_sec;
            for (let k = 0; k < this._hist.length - 1; k++) {   // previous samples only
                const h = this._hist[k];
                if (lo <= h.t && h.t < s.t && svFinite(h.mp)) {
                    if (mx === null || h.mp >= mx) {   // >=: the latest sample holding the max
                        mx = h.mp;
                        base = h.egt;
                    }
                }
            }
            if (mx !== null && s.mp <= mx - d.mp_drop_inhg) {
                e = this._r5Event = { t0: s.t, base, mpDrop: mx - s.mp, fired: false };
            }
        }
        if (e === null) return;
        // null (JSON null) where a reading is missing, never NaN.
        const deltas = [];
        for (let i = 0; i < 4; i++) {
            if (svFinite(s.egt[i]) && svFinite(e.base[i])) deltas.push(s.egt[i] - e.base[i]);
            else deltas.push(null);
        }
        const fallF = d.fall_f, riseF = d.rise_f;
        // Margin: the (fall, rise) pair over different cylinders maximising
        // min(fall / fall_f, rise / rise_f); first pair wins ties.
        for (let i = 0; i < 4; i++) {
            if (!svFinite(deltas[i])) continue;
            for (let j = 0; j < 4; j++) {
                if (j === i || !svFinite(deltas[j])) continue;
                const fall = -deltas[i];
                const rise = deltas[j];
                const score = svPyMin(fall / fallF, rise / riseF);
                if (this._r5Closest === null || score > this._r5Closest.score) {
                    this._r5Closest = { t: s.t, fallCyl: i + 1, riseCyl: j + 1, fall, rise, score };
                }
            }
        }
        if (e.fired) return;
        const falling = [];
        const rising = [];
        for (let i = 0; i < 4; i++) if (svFinite(deltas[i]) && deltas[i] <= -fallF) falling.push(i + 1);
        for (let i = 0; i < 4; i++) if (svFinite(deltas[i]) && deltas[i] >= riseF) rising.push(i + 1);
        let diverged = false;
        for (const a of falling) {
            for (const b of rising) {
                if (a !== b) diverged = true;
            }
        }
        if (!diverged) return;
        e.fired = true;
        const inf = { type: 'inflight', t: s.t, falling, rising, deltas, mpDrop: e.mpDrop };
        this._inflight.push(inf);
        ev.push(inf);
    }

    // ---- findings, context, verdict -----------------------------------------

    _addFinding(t, rule, cyl, detail, ev) {
        // Level is fixed when the finding is made: an R3/R4 finding made before an
        // R1/R2 finding on the same cylinder stays CAUTION (the verdict is NO-GO
        // anyway via the R1/R2 finding).
        let level, corroborates;
        if (STICKY_VALVE_VALVE_RULES.includes(rule)) {
            level = 'NO-GO'; corroborates = false;
            this._valveCyl[cyl - 1] = true;
        } else if (cyl !== null && this._valveCyl[cyl - 1]) {
            level = 'NO-GO'; corroborates = true;
        } else {
            level = 'CAUTION'; corroborates = false;
        }
        const f = { type: 'finding', t, rule, level, cyl, detail, corroborates };
        this._findings.push(f);
        ev.push(f);
    }

    _addContext(t, note, detail, ev) {
        if (this._contextSeen.has(note)) return;
        this._contextSeen.add(note);
        const e = { type: 'context', t, note, detail };
        this._context.push(e);
        ev.push(e);
    }

    _groundContext(s, dt, ev) {
        const cx = this.cfg.context;
        // Cumulative ground seconds at steady idle; time across a hole is not counted.
        if (this.cfg.run.stop_rpm <= s.rpm && s.rpm < this.cfg.phase.runup_rpm
                && dt !== null && 0 < dt && dt <= this.cfg.run.gap_sec) {
            this._idleSec += dt;
            if (this._idleSec >= cx.long_idle_min * 60) {
                this._addContext(s.t, 'long_ground_idle', { idleSec: this._idleSec }, ev);
            }
        }
        if (svFinite(s.carb) && s.carb >= cx.heat_soak_carb_f) {
            this._addContext(s.t, 'heat_soak', { carb: s.carb }, ev);
        }
    }

    _evaluated() {
        return {
            cold_cylinder: this._r1JudgedSec >= this.cfg.verdict.min_evaluated_sec,
            slow_heatup: this._r2.state === 'run',   // only possible on a cold settle
            cht_lag: this._r3.state === 'run',
            roughness: this._r4Evaluated,
        };
    }

    /** Recompute; the shown verdict only rises by VERDICT_RANK. */
    _updateVerdict(t, ev) {
        const next = this._computeVerdict();
        if (this._verdict === null || STICKY_VALVE_VERDICT_RANK[next] > STICKY_VALVE_VERDICT_RANK[this._verdict]) {
            ev.push({ type: 'verdict', t, verdict: next, prev: this._verdict });
            this._verdict = next;
        }
    }

    _computeVerdict() {
        const levels = this._findings.map(f => f.level);
        if (levels.includes('NO-GO')) return 'NO-GO';
        if (levels.includes('CAUTION')) return 'CAUTION';
        const evaluated = this._evaluated();
        if (STICKY_VALVE_GROUND_RULES.every(r => evaluated[r])) return 'VALVES OK';
        if (this._cold === true && (this._r2.state === 'open' || this._r3.state === 'open')) return 'CHECKING';
        if (STICKY_VALVE_GROUND_RULES.some(r => evaluated[r])) return 'PARTIAL';
        return 'NOT CHECKED';
    }
}

StickyValveDetector.VERDICT_RANK = STICKY_VALVE_VERDICT_RANK;

// TEMPORARY until Task 9 replaces StickyValveMonitor:
// today's hard-coded Pi thresholds and cockpit-config overrides, kept private so
// the old monitor keeps working after StickyValve.DEFAULTS / config() were removed.
const LEGACY_DEFAULTS = {
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
};

// TEMPORARY until Task 9 replaces StickyValveMonitor
function legacyStickyValveConfig() {
    const cfg = { ...LEGACY_DEFAULTS };
    let ep = null;
    try {
        ep = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get) ? CockpitConfig.get('enginePage') : null;
    } catch (_) { /* defaults */ }
    const pct = Number(ep?.stickyValveThresholdPct);
    if (pct > 0 && pct < 100) cfg.egtRatio = pct / 100;
    const min = Number(ep?.stickyValveWindowMinutes);
    if (min > 0) cfg.warmupMin = min;
    return cfg;
}

// TEMPORARY until Task 9: the pre-Task-7 Pi-rule detector, renamed and kept
// private for StickyValveMonitor only. Do not use it for anything new.
class LegacyStickyValveDetector {
    constructor(cfg = LEGACY_DEFAULTS) {
        this.cfg = { ...LEGACY_DEFAULTS, ...cfg };
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
        // TEMPORARY until Task 9 rewrites the monitor on StickyValveDetector
        this.detector = new LegacyStickyValveDetector(opts.cfg || legacyStickyValveConfig());
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
