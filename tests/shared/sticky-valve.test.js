/**
 * Sticky valve detection on the tablet (web/shared/sticky-valve.js).
 *
 * Two parts:
 *  - StickyValveDetector: a line-for-line port of the Python reference
 *    engine_analysis/sticky_valve.py. Its tests below are ports of
 *    engine_analysis/tests/test_sticky_valve.py (same names in camelCase, same
 *    synthetic inputs, same assertions and guard asserts), run on the real spec
 *    (web/sticky_valve_spec.json + web/phase_spec.json through StickyValve.buildConfig).
 *  - StickyValveMonitor (at the end of this file): spec loading and buffering,
 *    frame normalisation, Stratux ground speed, the verdict state and the
 *    latch/dismiss policy. Frames are fed the way engine-client.js dispatches
 *    them: the Pi's /api/status with the EDM row nested under `data`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const { StickyValve, StickyValveDetector, StickyValveMonitor } = new Function(
    read('web/shared/sticky-valve.js') + '\nreturn { StickyValve, StickyValveDetector, StickyValveMonitor };')();

// ============================================================================
// StickyValveDetector -- ports of engine_analysis/tests/test_sticky_valve.py
// ============================================================================

const NAN = NaN;
const CFG = StickyValve.buildConfig(
    StickyValve.validateSpec(JSON.parse(read('web/sticky_valve_spec.json'))),
    JSON.parse(read('web/phase_spec.json')));

// Synthetic fault factors (see the Python module docstring).
const COLD_FACTOR = 0.4;      // cold_cylinder.egt_ratio is 0.5
const SLOW_FACTOR = 0.5;      // slow_heatup.rise_ratio is 0.7
const CHT_LAG_FACTOR = 0.4;   // cht_lag.rise_ratio is 0.7
const RPM_JITTER = 250.0;     // ± about idle -> population std 250; roughness.rpm_std_max is 198
const EGT_JITTER = 60.0;      // ± on the rough cylinder; roughness.egt_std_min_f is 15
const EGT_QUIET = 3.0;        // ± on the others -> ratio 20; roughness.egt_std_ratio_max is 8.26
const DIV_FALL = 250.0;       // divergence.fall_f is 150
const DIV_RISE = 100.0;       // divergence.rise_f is 65
const DIV_MP_DROP = 7.0;      // 25 -> 18 inHg; divergence.mp_drop_inhg is 3
const CHT_RATE = 0.75;        // °F/s healthy cold-start CHT rise -> 135 °F over cht_lag.window_sec 180;
                              // cht_lag.min_others_rise_f is 90

// ---- helpers ---------------------------------------------------------------

/** pytest.approx(expected) with its defaults: rel 1e-6, abs 1e-12. */
function expectApprox(actual, expected) {
    expect(typeof actual).toBe('number');
    const tol = Math.max(1e-6 * Math.abs(expected), 1e-12);
    expect(Math.abs(actual - expected), `${actual} ≈ ${expected}`).toBeLessThanOrEqual(tol);
}

/** Population standard deviation, independent of the detector's algorithm
 *  (stands in for Python's statistics.pstdev; compared with expectApprox). */
function pstdev(vals) {
    let s = 0, s2 = 0;
    for (const v of vals) { s += v; s2 += v * v; }
    const m = s / vals.length;
    return Math.sqrt(Math.max(s2 / vals.length - m * m, 0));
}

const range = (a, b, step = 1) => { const out = []; for (let x = a; x < b; x += step) out.push(x); return out; };
const pyInt = (t) => Math.trunc(t);

/** Even cold-start EGT ramp: 300 °F rising 5 °F/s for 120 s, then flat 900. */
const baseEgt = (t) => 300.0 + 5.0 * Math.min(t, 120);
/** Even cold-start CHT ramp from 70 °F, CHT_RATE °F/s for 300 s. */
const baseCht = (t) => 70.0 + CHT_RATE * Math.min(t, 300);
const even = (f) => (t) => [f(t), f(t), f(t), f(t)];

/** n samples at t = start, start+step, ...; each field is a function of t. */
function makeSamples(n, {
    rpm = () => 1000.0, mp = () => 12.0, ff = () => 3.0, egt = even(baseEgt), cht = even(baseCht),
    carb = () => 50.0, gs = () => 0.0, start = 0, step = 1,
} = {}) {
    const out = [];
    for (let k = 0; k < n; k++) {
        const t = start + k * step;
        out.push({
            t, rpm: Number(rpm(t)), mp: Number(mp(t)), ff: Number(ff(t)),
            egt: egt(t).map(Number), cht: cht(t).map(Number),
            carb: Number(carb(t)), gs: Number(gs(t)),
        });
    }
    return out;
}

function runDetector(samples, cfg = CFG, daysSinceFlight = null) {
    const det = new StickyValveDetector(cfg, { daysSinceFlight });
    const events = [];
    for (const s of samples) events.push(...det.sample(s));
    return [det, events];
}

const ofType = (events, typ) => events.filter(e => e.type === typ);
const findings = (events, rule = null) => ofType(events, 'finding').filter(e => rule === null || e.rule === rule);
const verdicts = (events) => ofType(events, 'verdict').map(e => e.verdict);
const idleThenRunup = (t) => (t < 200 ? 1000.0 : 1700.0);
/** rpmFn until stopAt, then 0 RPM (engine stopped). */
const withStop = (rpmFn, stopAt) => (t) => (t < stopAt ? rpmFn(t) : 0.0);

/** Even f(t) on all cylinders except `cyl` (1-based) = factor * f(t) in [fromT, untilT). */
function cylScaled(cyl, factor, fromT = 0, untilT = Infinity, f = baseEgt) {
    return (t) => {
        const vals = [f(t), f(t), f(t), f(t)];
        if (fromT <= t && t < untilT) vals[cyl - 1] = factor * f(t);
        return vals;
    };
}

/** All cylinders rise from f0 at `rate`/s for `cap` s; `cyl` rises at factor × rate. */
function cylSlowRise(cyl, factor, f0, rate, cap) {
    return (t) => {
        const v = f0 + rate * Math.min(t, cap);
        const vals = [v, v, v, v];
        vals[cyl - 1] = f0 + factor * rate * Math.min(t, cap);
        return vals;
    };
}

describe('StickyValveDetector — Task 2: lifecycle, rules 1-3, verdict', () => {
    it('syntheticFaultsCrossThresholdsClearly', () => {
        expect(COLD_FACTOR).toBeLessThanOrEqual(0.85 * CFG.cold_cylinder.egt_ratio);
        expect(SLOW_FACTOR).toBeLessThanOrEqual(0.75 * CFG.slow_heatup.rise_ratio);
        expect(CHT_LAG_FACTOR).toBeLessThanOrEqual(0.75 * CFG.cht_lag.rise_ratio);
        const r = CFG.roughness, d = CFG.divergence;
        expect(RPM_JITTER).toBeGreaterThanOrEqual(1.25 * r.rpm_std_max);
        expect(EGT_JITTER).toBeGreaterThanOrEqual(1.25 * r.egt_std_min_f);
        expect(EGT_JITTER / Math.max(EGT_QUIET, r.egt_std_floor_f)).toBeGreaterThanOrEqual(1.25 * r.egt_std_ratio_max);
        expect(DIV_FALL).toBeGreaterThanOrEqual(1.25 * d.fall_f);
        expect(DIV_RISE).toBeGreaterThanOrEqual(1.25 * d.rise_f);
        expect(DIV_MP_DROP).toBeGreaterThanOrEqual(1.25 * d.mp_drop_inhg);
        const c = CFG.cht_lag;
        expect(CHT_RATE * c.window_sec).toBeGreaterThanOrEqual(1.25 * c.min_others_rise_f);
    });

    it('constants', () => {
        expect(StickyValve.REFERENCES).toBe('Advisory — inspect per Lycoming SB 388C; see SI 1425A / SL L197A.');
        expect(StickyValveDetector.VERDICT_RANK).toEqual({
            'CHECKING': 0, 'NOT CHECKED': 1, 'PARTIAL': 2, 'VALVES OK': 3, 'CAUTION': 4, 'NO-GO': 5,
        });
    });

    it('healthyColdStartValvesOk', () => {
        const [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup }));
        expect(findings(ev)).toEqual([]);
        expect(verdicts(ev).at(-1)).toBe('VALVES OK');
    });

    it('coldCylinderNoGoAfterTrigger', () => {
        const [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup, egt: cylScaled(3, COLD_FACTOR, 40) }));
        const r1 = findings(ev, 'cold_cylinder');
        expect(r1.map(f => [f.cyl, f.level])).toEqual([[3, 'NO-GO']]);
        expect(r1[0].t).toBe(40 + CFG.cold_cylinder.persist_sec);
        const v = ofType(ev, 'verdict');
        expect(v.length, 'a verdict must be issued at the trigger').toBeGreaterThan(0);
        expect(v.every(e => e.t >= 200), 'no verdict event before the trigger').toBe(true);
        expect(v[0].t).toBe(200);
        expect(v[0].verdict).toBe('NO-GO');
        expect(v[0].prev).toBeNull();
    });

    it('slowHeatupNoGo', () => {
        const egt = cylSlowRise(2, SLOW_FACTOR, 300.0, 5.0, 120);
        const [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup, egt }));
        const r2 = findings(ev, 'slow_heatup');
        expect(r2.map(f => [f.cyl, f.level])).toEqual([[2, 'NO-GO']]);
        expect(r2[0].t).toBe(CFG.slow_heatup.window_sec);
        expectApprox(r2[0].detail.ratio, SLOW_FACTOR);
        expect(findings(ev, 'cold_cylinder'), 'R1 must not be what fired here').toEqual([]);
        expect(verdicts(ev).at(-1)).toBe('NO-GO');
    });

    it('chtLagAloneIsCaution', () => {
        const cht = cylSlowRise(4, CHT_LAG_FACTOR, 70.0, CHT_RATE, 300);
        const [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup, cht }));
        const r3 = findings(ev, 'cht_lag');
        expect(r3.map(f => [f.cyl, f.level, f.corroborates])).toEqual([[4, 'CAUTION', false]]);
        expect(r3[0].t).toBe(CFG.cht_lag.window_sec);
        expect(findings(ev).map(f => f.rule)).toEqual(['cht_lag']);
        expect(verdicts(ev)).toEqual(['CAUTION']);
    });

    it('chtLagOnColdCylinderCorroborates', () => {
        const samples = makeSamples(260, {
            rpm: idleThenRunup,
            egt: cylScaled(3, COLD_FACTOR, 40),
            cht: cylSlowRise(3, CHT_LAG_FACTOR, 70.0, CHT_RATE, 300),
        });
        const [, ev] = runDetector(samples);
        const r3 = findings(ev, 'cht_lag');
        expect(r3.length).toBe(1);
        expect(r3[0].cyl).toBe(3);
        expect(r3[0].level).toBe('NO-GO');
        expect(r3[0].corroborates).toBe(true);
    });

    it('verdictNeverDowngrades', () => {
        // Early taxi so the verdict is showing; cyl 3 low 40-100 s, then recovers.
        const samples = makeSamples(450, {
            rpm: withStop(() => 1000.0, 400),
            egt: cylScaled(3, COLD_FACTOR, 40, 100),
            gs: (t) => (t >= 40 ? 5.0 : 0.0),
        });
        const [det, ev] = runDetector(samples);
        expect(findings(ev, 'cold_cylinder').map(f => f.cyl)).toEqual([3]);
        const vs = verdicts(ev);
        expect(vs.at(-1)).toBe('NO-GO');
        const ranks = vs.map(v => StickyValveDetector.VERDICT_RANK[v]);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(new Set(vs).size).toBe(vs.length);
        const ends = ofType(ev, 'run_end');
        expect(ends.length).toBe(1);
        expect(ends[0].reason).toBe('rpm');
        // Every verdict event precedes the run end; nothing after NO-GO.
        expect(ofType(ev, 'verdict').at(-1).t).toBeLessThan(ends[0].t);
        expect(ends[0].result.verdict).toBe('NO-GO');
        expect(det.verdict).toBe('NO-GO');
    });

    it('hotRestartIsPartial', () => {
        const samples = makeSamples(300, {
            rpm: withStop(idleThenRunup, 260),
            egt: even(() => 1200.0), cht: even((t) => 300.0 + 0.1 * t),
        });
        const [, ev] = runDetector(samples);
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.coldSettle).toBe(false);
        expect(res.verdict).toBe('PARTIAL');
        expect(res.rulesNotRun).toEqual(expect.arrayContaining(['slow_heatup', 'cht_lag']));
        expect(res.rulesRun).toContain('cold_cylinder');
        expect(verdicts(ev)).not.toContain('VALVES OK');
    });

    it('earlyTaxiShowsChecking', () => {
        // Ruling R-1 (tightened in Task 3): taxi at t=40 shows CHECKING while the
        // R2/R3 windows are open; every ground rule then runs -> VALVES OK.
        const samples = makeSamples(300, { rpm: withStop(() => 1000.0, 260), gs: (t) => (t >= 40 ? 5.0 : 0.0) });
        const [, ev] = runDetector(samples);
        const v = ofType(ev, 'verdict');
        expect(v[0].t).toBe(40);
        expect(v[0].verdict).toBe('CHECKING');
        expect(v.map(e => [e.t, e.verdict])).toEqual([[40, 'CHECKING'], [CFG.cht_lag.window_sec, 'VALVES OK']]);
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.verdict).toBe('VALVES OK');
        expect(res.rulesNotRun).toEqual([]);
        expect(res.rulesRun).toEqual(['cold_cylinder', 'slow_heatup', 'cht_lag', 'roughness']);
        expect(res.verdictT).toBe(40);
    });

    it('noGpsTriggersByRunupOrFallback', () => {
        const noGps = () => NAN;
        // (a) run-up RPM at t=300
        let [, ev] = runDetector(makeSamples(400, { rpm: (t) => (t < 300 ? 1000.0 : 1700.0), gs: noGps }));
        let v = ofType(ev, 'verdict');
        expect(v.length).toBeGreaterThan(0);
        expect(v[0].t).toBe(300);
        // (b) idle only: the fallback deadline, measured from run start (t=0)
        [, ev] = runDetector(makeSamples(700, { gs: noGps }));
        v = ofType(ev, 'verdict');
        expect(v.length).toBeGreaterThan(0);
        expect(v[0].t).toBe(CFG.verdict.fallback_min * 60);
    });

    it('rpmDropoutIsNotAStop', () => {
        const rpm = (t) => (250 <= t && t < 260 ? 0.0 : idleThenRunup(t));
        const [det, ev] = runDetector(makeSamples(320, { rpm }));
        expect(ofType(ev, 'run_end')).toEqual([]);
        expect(ofType(ev, 'run_start').length).toBe(1);
        expect(det.runActive).toBe(true);
    });

    it('longGapEndsRunAsGap', () => {
        const samples = [...makeSamples(100), ...makeSamples(60, { start: 140 })];
        const [det, ev] = runDetector(samples);
        const ends = ofType(ev, 'run_end');
        expect(ends.length).toBe(1);
        expect(ends[0].reason).toBe('gap');
        expect(ends[0].t).toBe(140);
        expect(ends[0].result.endReason).toBe('gap');
        expect(ends[0].result.endT).toBe(99);   // last sample the run actually had
        expect(ofType(ev, 'run_start').map(s => s.t)).toEqual([0, 140]);
        expect(det.runActive).toBe(true);
    });

    it('egtZeroIsAReading', () => {
        const egt = (t) => [0.0, baseEgt(t), baseEgt(t), baseEgt(t)];
        const [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup, egt }));
        const r1 = findings(ev, 'cold_cylinder');
        expect(r1.map(f => [f.cyl, f.level])).toEqual([[1, 'NO-GO']]);
        expect(verdicts(ev).at(-1)).toBe('NO-GO');
    });

    it('missingChtIsNotACrash', () => {
        const samples = makeSamples(300, { rpm: withStop(idleThenRunup, 260), cht: () => [NAN, NAN, NAN, NAN] });
        const [, ev] = runDetector(samples);
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.rulesNotRun).toContain('cht_lag');
        expect(res.coldSettle).toBeNull();
        expect(res.verdict).toBe('PARTIAL');
        expect(verdicts(ev).at(-1)).toBe('PARTIAL');
    });

    it('twoSecondFramesKeepPersistence', () => {
        const samples = makeSamples(130, { step: 2, rpm: idleThenRunup, egt: cylScaled(3, COLD_FACTOR, 40) });
        const [, ev] = runDetector(samples);
        const r1 = findings(ev, 'cold_cylinder');
        expect(r1.map(f => f.cyl)).toEqual([3]);
        expect(r1[0].t).toBe(40 + CFG.cold_cylinder.persist_sec);
    });

    // ---- extra coverage for Step 3 behaviour (settle, context, result shape) ----

    it('seenStartSettlesAfterHold', () => {
        // Engine seen stopped first: the run settles once RPM > start_rpm held settle_sec.
        const samples = makeSamples(400, {
            rpm: (t) => (t < 5 || t >= 350 ? 0.0 : 1000.0),
            egt: (t) => { const v = baseEgt(Math.max(t - 5, 0)); return [v, v, v, v]; },
            cht: (t) => { const v = baseCht(Math.max(t - 5, 0)); return [v, v, v, v]; },
            gs: (t) => (t >= 300 ? 5.0 : 0.0),
        });
        const [, ev] = runDetector(samples);
        expect(ofType(ev, 'run_start').map(s => s.t)).toEqual([5]);
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.startT).toBe(5);
        expect(res.settleT).toBe(5 + CFG.run.settle_sec);
        expect(res.coldSettle).toBe(true);
        expect(res.rulesRun).toEqual(['cold_cylinder', 'slow_heatup', 'cht_lag', 'roughness']);
        expect(ofType(ev, 'verdict')[0].t).toBe(300);
        expect(findings(ev)).toEqual([]);
    });

    it('contextNotes', () => {
        const idleMin = CFG.context.long_idle_min;
        const n = pyInt(idleMin * 60) + 20;
        const samples = makeSamples(n, {
            carb: (t) => (t >= 50 ? CFG.context.heat_soak_carb_f + 5 : 40.0),
            gs: (t) => (t >= 100 ? 5.0 : 0.0),
        });
        const [, ev] = runDetector(samples, CFG, CFG.context.days_since_flight + 10);
        const notes = Object.fromEntries(ofType(ev, 'context').map(e => [e.note, e]));
        expect(Object.keys(notes).sort()).toEqual(['days_since_flight', 'heat_soak', 'long_ground_idle']);
        expect(notes.heat_soak.t).toBe(50);
        expect(notes.days_since_flight.t).toBe(100);   // emitted with the verdict trigger
        expect(notes.long_ground_idle.t).toBe(idleMin * 60);
        // Context never moves the verdict.
        expect(verdicts(ev)).not.toContain('NO-GO');
        expect(verdicts(ev)).not.toContain('CAUTION');
    });

    it('recentFlightGivesNoDaysNote', () => {
        let [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup }), CFG, 1);
        expect(ofType(ev, 'context').filter(e => e.note === 'days_since_flight')).toEqual([]);
        [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup }), CFG, null);
        expect(ofType(ev, 'context').filter(e => e.note === 'days_since_flight')).toEqual([]);
    });

    it('runResultShapeAndMargins', () => {
        const samples = makeSamples(300, {
            rpm: withStop(idleThenRunup, 260),
            egt: cylSlowRise(2, SLOW_FACTOR, 300.0, 5.0, 120),
        });
        const [, ev] = runDetector(samples);
        const res = ofType(ev, 'run_end')[0].result;
        expect(Object.keys(res).sort()).toEqual(['coldSettle', 'context', 'endReason', 'endT', 'findings',
            'inflight', 'margins', 'rulesNotRun', 'rulesRun', 'settleT', 'startT', 'verdict', 'verdictT']);
        expect(Object.keys(res.margins).sort()).toEqual(['chtLagMinRatio', 'coldCylinderMinRatio',
            'divergenceClosest', 'roughnessMaxEgtRatio', 'roughnessMaxRpmStd', 'slowHeatupMinRatio']);
        expect(res.startT).toBe(0);
        expect(res.settleT).toBe(0);
        expect(res.coldSettle).toBe(true);
        expectApprox(res.margins.slowHeatupMinRatio, SLOW_FACTOR);
        expectApprox(res.margins.chtLagMinRatio, 1.0);
        expect(res.margins.coldCylinderMinRatio).toBeGreaterThan(0.5);
        expect(res.margins.coldCylinderMinRatio).toBeLessThan(1.0);
        // Steady idle RPM; cyl 2's slower ramp only lowers its EGT std, so no
        // cylinder's std stands above the others' median.
        expect(res.margins.roughnessMaxRpmStd).toBe(0.0);
        expectApprox(res.margins.roughnessMaxEgtRatio, 1.0);
        expect(res.margins.divergenceClosest).toBeNull();   // never airborne
        expect(res.inflight).toEqual([]);
        expect(res.rulesRun).toContain('roughness');
        expect(res.findings.map(f => f.rule)).toEqual(['slow_heatup']);
    });

    it('takeoffPowerEndsGroundWatch', () => {
        // Takeoff power at t=150 abandons the open R3 window; a cold cylinder that
        // appears only once airborne is not a ground finding.
        const rpm = (t) => (t < 100 ? 1000.0 : (t < 150 ? 1700.0 : 2500.0));
        const mp = (t) => (t >= 150 ? 26.0 : 12.0);
        const [, ev] = runDetector(makeSamples(300, { rpm, mp, egt: cylScaled(3, COLD_FACTOR, 160) }));
        expect(findings(ev)).toEqual([]);
        expect(verdicts(ev)).toEqual(['CHECKING', 'PARTIAL']);   // trigger at 100 (run-up), R3 abandoned at 150
    });

    it('nanEgtBreaksSlowHeatupWindow', () => {
        const egt = (t) => (t === 60 ? [NAN, NAN, NAN, NAN] : even(baseEgt)(t));
        const [, ev] = runDetector(makeSamples(300, { rpm: withStop(idleThenRunup, 260), egt }));
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.rulesNotRun).toContain('slow_heatup');
        expect(res.rulesRun).toContain('cht_lag');
    });

    it('shortHoleBreaksHeatupWindowsButNotTheRun', () => {
        // A 10 s hole (> gap_sec, < stop_sec) inside the R2/R3 windows: both are not
        // run, the run itself continues.
        const gap = CFG.run.gap_sec, stop = CFG.run.stop_sec;
        const hole = 10;
        expect(gap < hole && hole < stop).toBe(true);
        let samples = [...makeSamples(60, { rpm: idleThenRunup }),
            ...makeSamples(230, { start: 60 + hole, rpm: idleThenRunup })];
        samples = [...samples.filter(s => s.t < 260), ...makeSamples(40, { start: 260, rpm: () => 0.0 })];
        const [, ev] = runDetector(samples);
        const ends = ofType(ev, 'run_end');
        expect(ends.length).toBe(1);
        expect(ends[0].reason).toBe('rpm');
        const res = ends[0].result;
        expect(res.rulesNotRun).toEqual(expect.arrayContaining(['slow_heatup', 'cht_lag']));
        expect(res.verdict).toBe('PARTIAL');
    });

    it('triggerBeforeR1EvaluatedIsNotChecked', () => {
        // Hot settle, taxi at t=20: R1 has fewer than min_evaluated_sec judged
        // samples and R2/R3 cannot run -> NOT CHECKED, then PARTIAL once R1 counts.
        // MP swings 2 inHg (> roughness.mp_band_inhg) so R4 never gets a steady
        // window and cannot be what moves the verdict.
        const minEval = CFG.verdict.min_evaluated_sec;
        expect(2.0).toBeGreaterThan(CFG.roughness.mp_band_inhg);
        const samples = makeSamples(200, {
            egt: even(() => 1200.0), cht: even(() => 300.0),
            mp: (t) => (pyInt(t) % 2 ? 14.0 : 12.0),
            gs: (t) => (t >= 20 ? 5.0 : 0.0),
        });
        const [, ev] = runDetector(samples);
        const v = ofType(ev, 'verdict').map(e => [e.t, e.verdict]);
        expect(v).toEqual([[20, 'NOT CHECKED'], [minEval, 'PARTIAL']]);   // judged time reaches min_eval s at t = min_eval
    });

    it('heatupWindowWithoutOthersRiseIsNotRun', () => {
        // Cold CHT but EGTs already flat at settle: no cylinder's others-mean EGT
        // rise reaches min_others_rise_f, so no comparison is made -> slow_heatup
        // is not run (never counted toward VALVES OK); cht_lag still runs.
        const [, ev] = runDetector(makeSamples(300, { rpm: withStop(idleThenRunup, 260), egt: even(() => 900.0) }));
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.coldSettle).toBe(true);
        expect(res.rulesNotRun).toContain('slow_heatup');
        expect(res.rulesRun).toContain('cht_lag');
        expect(res.margins.slowHeatupMinRatio).toBeNull();
    });

    it('fallbackIsTimedFromRunStartNotSettle', () => {
        // Seen start at t=5 (settles at t=15), no GPS, idle only -> verdict at 5 + 600.
        const [, ev] = runDetector(makeSamples(700, { rpm: (t) => (t < 5 ? 0.0 : 1000.0), gs: () => NAN }));
        const v = ofType(ev, 'verdict');
        expect(v.length).toBeGreaterThan(0);
        expect(v[0].t).toBe(5 + CFG.verdict.fallback_min * 60);
    });

    it('runEndingDuringWindowsResolvesChecking', () => {
        // The stop (RPM 0 from t=100, confirmed at 100 + stop_sec) lands while the
        // R3 window is still open: ending the run closes it, so the verdict must
        // resolve CHECKING -> PARTIAL, with the verdict event before run_end.
        const samples = makeSamples(200, { rpm: withStop(() => 1000.0, 100), gs: (t) => (t >= 40 ? 5.0 : 0.0) });
        const [det, ev] = runDetector(samples);
        const endT = 100 + CFG.run.stop_sec;
        expect(endT).toBeLessThan(CFG.cht_lag.window_sec);   // the stop really is inside the R3 window
        const v = ofType(ev, 'verdict').map(e => [e.t, e.verdict]);
        expect(v).toEqual([[40, 'CHECKING'], [endT, 'PARTIAL']]);
        const types = ev.map(e => e.type);
        expect(types.indexOf('run_end')).toBe(types.indexOf('verdict', types.indexOf('verdict') + 1) + 1);
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.verdict).toBe('PARTIAL');
        expect(res.rulesNotRun).toEqual(['cht_lag']);   // R4 had full idle windows from t = window_sec
        expect(det.verdict).toBe('PARTIAL');
    });
});

// ---- Task 3: R4 roughness at steady idle -----------------------------------

/** +1 / -1 on alternate seconds. */
const alternating = (t) => (pyInt(t) % 2 ? 1.0 : -1.0);

describe('StickyValveDetector — Task 3: R4 roughness at steady idle', () => {
    it('rpmJitterAtIdleIsCaution', () => {
        const rpm = (t) => (t < 200 ? 1000.0 + RPM_JITTER * alternating(t) : 1700.0);
        const [, ev] = runDetector(makeSamples(300, { rpm: withStop(rpm, 260) }));
        const r4 = findings(ev, 'roughness');
        expect(r4.map(f => [f.cyl, f.level, f.corroborates])).toEqual([[null, 'CAUTION', false]]);
        const w = CFG.roughness.window_sec;
        expect(r4[0].t).toBe(w);   // first full window: t = 0..w inclusive (w + 1 samples at 1 Hz)
        // An odd-length window of +-RPM_JITTER has std a hair under RPM_JITTER; compute it exactly.
        const expected = pstdev(range(0, w + 1).map(rpm));
        expect(expected).toBeGreaterThanOrEqual(1.25 * CFG.roughness.rpm_std_max);
        expectApprox(r4[0].detail.rpmStd, expected);
        expect(findings(ev).map(f => f.rule)).toEqual(['roughness']);
        expect(verdicts(ev)).toEqual(['CAUTION']);
        const res = ofType(ev, 'run_end')[0].result;
        expectApprox(res.margins.roughnessMaxRpmStd, expected);
    });

    it('oneCylinderEgtUnsteadyIsCaution', () => {
        const egt = (t) => {
            const a = alternating(t);
            return [900.0 + EGT_QUIET * a, 900.0 + EGT_JITTER * a, 900.0 - EGT_QUIET * a, 900.0 + EGT_QUIET * a];
        };
        const [, ev] = runDetector(makeSamples(300, { rpm: withStop(idleThenRunup, 260), egt }));
        const r4 = findings(ev, 'roughness');
        expect(r4.map(f => [f.cyl, f.level, f.corroborates])).toEqual([[2, 'CAUTION', false]]);
        const d = r4[0].detail;
        const win = range(0, CFG.roughness.window_sec + 1);   // first full window, inclusive
        expectApprox(d.egtStd, pstdev(win.map(t => egt(t)[1])));
        expectApprox(d.othersMedian, pstdev(win.map(t => egt(t)[0])));
        expectApprox(d.ratio, EGT_JITTER / EGT_QUIET);
        expect(verdicts(ev).at(-1)).toBe('CAUTION');
        const res = ofType(ev, 'run_end')[0].result;
        expectApprox(res.margins.roughnessMaxEgtRatio, EGT_JITTER / EGT_QUIET);
        expect(res.margins.roughnessMaxRpmStd).toBe(0.0);
    });

    it('roughnessOnColdCylinderCorroborates', () => {
        // Cyl 3 cold from the start (R1 NO-GO at t=30), then unsteady from t=150:
        // the R4 finding on the same cylinder is NO-GO with corroborates=True.
        const egt = (t) => {
            const e = baseEgt(t);
            const c3 = COLD_FACTOR * e + (t >= 150 ? EGT_JITTER * alternating(t) : 0.0);
            return [e, e, c3, e];
        };
        const [, ev] = runDetector(makeSamples(260, { rpm: idleThenRunup, egt }));
        expect(findings(ev, 'cold_cylinder').map(f => f.cyl)).toEqual([3]);
        const r4 = findings(ev, 'roughness');
        expect(r4.map(f => [f.cyl, f.level, f.corroborates])).toEqual([[3, 'NO-GO', true]]);
        expect(r4[0].t).toBeGreaterThanOrEqual(150);
        expect(verdicts(ev).at(-1)).toBe('NO-GO');
    });

    it('runupMagCheckIsNotRoughness', () => {
        // Idle to t=200, run-up at 1700 with two 8 s mag checks (150 RPM drop to
        // 1550, i.e. below phase.runup_rpm, and cyl 1 EGT +50), back to idle at 290.
        const inCheck = (t) => (220 <= t && t < 228) || (240 <= t && t < 248);
        const rpm = (t) => {
            if (t < 200 || t >= 290) return 1000.0;
            return inCheck(t) ? 1550.0 : 1700.0;
        };
        const egt = (t) => { const e = baseEgt(t); return [inCheck(t) ? e + 50.0 : e, e, e, e]; };
        expect(1550.0).toBeLessThan(CFG.phase.runup_rpm);   // the drop lands in the idle band
        const samples = makeSamples(400, {
            rpm: withStop(rpm, 360), egt, mp: (t) => (200 <= t && t < 290 ? 18.0 : 12.0),
        });
        const [, ev] = runDetector(samples);
        expect(findings(ev, 'roughness')).toEqual([]);
        const res = ofType(ev, 'run_end')[0].result;
        expect(res.rulesRun).toContain('roughness');   // R4 was judged, so the test is not vacuous
        // No evaluated window ever held a mag-check sample: every one was steady.
        expect(res.margins.roughnessMaxRpmStd).toBe(0.0);
        expect(res.verdict).toBe('VALVES OK');
    });
});

// ---- Task 3: R5 divergence after an in-flight power reduction ---------------

const CRUISE_EGT = 1350.0;

/** Starts at takeoff power (fresh, so settled at once, airborne at t=0), then n
 *  seconds of the given profile, then a 40 s stop to end the run. */
function flight(n, rpm, mp, egt, ff = () => 9.0, step = 1) {
    return makeSamples(pyInt((n + 40) / step), {
        rpm: withStop(rpm, n), mp, ff, egt, cht: even(() => 350.0), gs: () => 120.0, step,
    });
}

/** 0 before t0, 1 after t0 + dur, linear between. */
const ramp = (t, t0, dur) => Math.min(Math.max((t - t0) / dur, 0.0), 1.0);
/** 25 inHg, then down to 18 over 5 s from t=100. */
const reductionMp = (t) => 25.0 - DIV_MP_DROP * ramp(t, 100, 5);

function inflightEvents(samples) {
    const [, ev] = runDetector(samples);
    const ends = ofType(ev, 'run_end');
    expect(ends.length).toBe(1);
    return [ev, ends[0].result];
}

/** Takeoff power 26 inHg to t=30, then a gentle 60 s reduction to 22
 *  (0.67 inHg per 10 s, never an MP drop), then 22. */
const cruiseMp = (t) => 26.0 - 4.0 * ramp(t, 30, 60);

describe('StickyValveDetector — Task 3: R5 divergence after an in-flight power reduction', () => {
    it('divergenceWithMissingEgtReportsNone', () => {
        // Cyl 4 EGT probe lost after the MP drop: its delta is None (JSON null),
        // and the other cylinders still diverge.
        const egt = (t) => {
            const k = ramp(t, 100, 30);
            return [CRUISE_EGT - DIV_FALL * k, CRUISE_EGT + DIV_RISE * k, CRUISE_EGT, t >= 105 ? NAN : CRUISE_EGT];
        };
        const [ev] = inflightEvents(flight(200, () => 2500.0, reductionMp, egt));
        const inf = ofType(ev, 'inflight');
        expect(inf.length).toBe(1);
        expect(inf[0].falling).toEqual([1]);
        expect(inf[0].rising).toEqual([2]);
        expect(inf[0].deltas[3]).toBeNull();
    });

    it('divergenceAfterPowerReduction', () => {
        const egt = (t) => {
            const k = ramp(t, 100, 30);
            return [CRUISE_EGT - DIV_FALL * k, CRUISE_EGT + DIV_RISE * k, CRUISE_EGT, CRUISE_EGT];
        };
        const [ev, res] = inflightEvents(flight(200, () => 2500.0, reductionMp, egt));
        const inf = ofType(ev, 'inflight');
        expect(inf.length).toBe(1);
        const e = inf[0];
        expect(e.falling).toEqual([1]);
        expect(e.rising).toContain(2);
        expect(e.t > 100 && e.t <= 130).toBe(true);
        expect(e.deltas[0]).toBeLessThanOrEqual(-CFG.divergence.fall_f);
        expect(e.deltas[1]).toBeGreaterThanOrEqual(CFG.divergence.rise_f);
        expect(e.deltas[2] === 0.0 && e.deltas[3] === 0.0).toBe(true);
        // Event opened at the first sample >= mp_drop_inhg below the 25 inHg max.
        expect(e.mpDrop).toBeGreaterThanOrEqual(CFG.divergence.mp_drop_inhg);
        expect(Object.keys(e).sort()).toEqual(['deltas', 'falling', 'mpDrop', 'rising', 't', 'type']);
        expect(res.inflight).toEqual(inf);
        const m = res.margins.divergenceClosest;
        expect(m.fallCyl).toBe(1);
        expect(m.riseCyl).toBe(2);
        expect(m.score).toBeGreaterThanOrEqual(1.0);
        // In-flight events never move the (ground) verdict or add findings.
        expect(findings(ev)).toEqual([]);
        expect(verdicts(ev)).not.toContain('NO-GO');
        expect(verdicts(ev)).not.toContain('CAUTION');
    });

    it('uniformFallIsNotDivergence', () => {
        // All four fall together after the MP drop: -120 (the plan's case), and
        // -250 (every cylinder past fall_f) -- with no riser, neither qualifies.
        for (const fall of [120.0, DIV_FALL]) {
            const egt = (t) => { const v = CRUISE_EGT - fall * ramp(t, 100, 30); return [v, v, v, v]; };
            const [ev, res] = inflightEvents(flight(200, () => 2500.0, reductionMp, egt));
            expect(ofType(ev, 'inflight'), String(fall)).toEqual([]);
            // The MP drop did open an event; it was rejected for having no riser.
            const m = res.margins.divergenceClosest;
            expect(m).not.toBeNull();
            expect(m.score).toBeLessThan(1.0);
        }
    });

    it('propChangeIsNotDivergence', () => {
        // At t=200 the prop is pulled back: RPM 2500 -> 2300, MP 22 -> 23.5 (MP
        // rises on a constant-speed prop). The EGT shifts are made big enough to
        // match the divergence pattern, so only the MP-drop gate keeps R5 quiet.
        const rpm = (t) => (t < 30 ? 2600.0 : 2500.0 - 200.0 * ramp(t, 200, 3));
        const mp = (t) => cruiseMp(t) + 1.5 * ramp(t, 200, 3);
        const egt = (t) => {
            const k = ramp(t, 200, 20);
            return [CRUISE_EGT - DIV_FALL * k, CRUISE_EGT + 30.0 * k, CRUISE_EGT + DIV_RISE * k, CRUISE_EGT];
        };
        const [ev, res] = inflightEvents(flight(300, rpm, mp, egt));
        expect(ofType(ev, 'inflight')).toEqual([]);
        expect(res.margins.divergenceClosest).toBeNull();   // no event ever opened
    });

    it('leaningIsNotDivergence', () => {
        // MP steady at 22, fuel flow 9 -> 7 GPH from t=200: cyl 1 -40, cyl 3 +70.
        // A second, deeper lean (cyl 1 past peak, -250) has the divergence shape
        // too; fuel flow plays no part, so neither may raise R5.
        const rpm = (t) => (t < 30 ? 2600.0 : 2450.0);
        const ff = (t) => 9.0 - 2.0 * ramp(t, 200, 10);
        for (const fall of [40.0, DIV_FALL]) {
            const egt = (t) => {
                const k = ramp(t, 200, 20);
                return [CRUISE_EGT - fall * k, CRUISE_EGT, CRUISE_EGT + 70.0 * k, CRUISE_EGT];
            };
            const [ev, res] = inflightEvents(flight(300, rpm, cruiseMp, egt, ff));
            expect(ofType(ev, 'inflight'), String(fall)).toEqual([]);
            expect(res.margins.divergenceClosest).toBeNull();
        }
    });
});

// ---- Task 4b: every window in seconds of sample time --------------------------

/** +1 / -1 flipping every 2 s: alternates sample by sample at 2 s cadence (and in
 *  pairs at 1 Hz), so a jitter signal is jittery at both cadences. */
const altPairs = (t) => (pyInt(t) % 4 < 2 ? 1.0 : -1.0);

/** Hot settle (R2/R3 cannot run), MP swinging 2 inHg every 2 s sample (R4 never
 *  gets a steady window), taxi at t=20: only R1 can move the verdict. */
function hotIdle(kw = {}) {
    expect(2.0).toBeGreaterThan(CFG.roughness.mp_band_inhg);
    return {
        egt: even(() => 1200.0), cht: even(() => 300.0),
        mp: (t) => (altPairs(t) > 0 ? 14.0 : 12.0),
        gs: (t) => (t >= 20 ? 5.0 : 0.0),
        ...kw,
    };
}

/** Insert `extra` just before the sample that shares its timestamp. */
function withExtraSample(samples, extra) {
    const out = [];
    for (const x of samples) {
        if (x.t === extra.t) out.push(extra);
        out.push(x);
    }
    return out;
}

describe('StickyValveDetector — Task 4b: every window in seconds of sample time', () => {
    it('r1MinEvaluatedCountsSeconds', () => {
        // 2 s frames: R1 counts as evaluated once its contiguous judged samples
        // span min_evaluated_sec of sample time (t = min_eval), not after
        // min_eval judged samples (t = 2 * (min_eval - 1)).
        const minEval = CFG.verdict.min_evaluated_sec;
        expect(minEval % 2).toBe(0);   // lands on a 2 s sample
        // (a) Cold start (EGT ramp from 300 F, all judged from t=0); end of data
        // one sample before / at min_eval.
        for (const [lastT, counted] of [[minEval - 2, false], [minEval, true]]) {
            const [det] = runDetector(makeSamples(Math.floor(lastT / 2) + 1, { step: 2 }));
            const res = ofType(det.finish(lastT), 'run_end')[0].result;
            expect(res.coldSettle).toBe(true);
            expect(res.rulesRun.includes('cold_cylinder'), String(lastT)).toBe(counted);
        }
        // (b) The verdict sequence (the model: triggerBeforeR1EvaluatedIsNotChecked).
        let [, ev] = runDetector(makeSamples(100, { step: 2, ...hotIdle() }));
        expect(ofType(ev, 'verdict').map(e => [e.t, e.verdict])).toEqual([[20, 'NOT CHECKED'], [minEval, 'PARTIAL']]);
        // (c) A short hole adds no judged time, and the first judged sample after
        // it adds 0: judged 0..40 (40 s), then from 50 on.
        const gap = CFG.run.gap_sec, stop = CFG.run.stop_sec;
        const holeAt = 40, hole = 10;
        expect(gap < hole && hole < stop && holeAt < minEval).toBe(true);
        const samples = makeSamples(100, { step: 2, ...hotIdle() }).filter(s => !(holeAt < s.t && s.t < holeAt + hole));
        [, ev] = runDetector(samples);
        expect(ofType(ev, 'verdict').map(e => [e.t, e.verdict])).toEqual([[20, 'NOT CHECKED'], [minEval + hole, 'PARTIAL']]);
        // (d) An unjudged sample (mean EGT below cold_cylinder.min_egt) breaks the
        // accumulation the same way: judged 0..28 (28 s), then from 32 on.
        const low = 100.0;
        expect(low).toBeLessThan(CFG.cold_cylinder.min_egt);
        const egt = (t) => (t === 30 ? [low, low, low, low] : [1200.0, 1200.0, 1200.0, 1200.0]);
        [, ev] = runDetector(makeSamples(100, { step: 2, ...hotIdle({ egt }) }));
        expect(ofType(ev, 'verdict').map(e => [e.t, e.verdict])).toEqual([[20, 'NOT CHECKED'], [minEval + 4, 'PARTIAL']]);
    });

    it('r4WindowIsWallClockAt1HzAnd2s', () => {
        // The same +-RPM_JITTER idle jitter at 1 Hz and at 2 s: both first judge (and
        // fire) at settle (t=0, the first sample) + window_sec, and the judged
        // window is exactly the samples with t in [t_now - window_sec, t_now].
        const w = CFG.roughness.window_sec;
        expect(w % 2).toBe(0);   // settle + window_sec is a sample at both cadences
        const rpm = (t) => 1000.0 + RPM_JITTER * altPairs(t);
        for (const step of [1, 2]) {
            const [det, ev] = runDetector(makeSamples(pyInt(120 / step), { step, rpm }));
            const r4 = findings(ev, 'roughness');
            expect(r4.map(f => [f.cyl, f.level]), String(step)).toEqual([[null, 'CAUTION']]);
            expect(r4[0].t, String(step)).toBe(w);
            const win = range(0, Math.floor(w / step) + 1).map(k => rpm(k * step));
            expectApprox(r4[0].detail.rpmStd, pstdev(win));
            const res = ofType(det.finish(120 - step), 'run_end')[0].result;
            expect(res.rulesRun, String(step)).toContain('roughness');
        }
    });

    it('r5LookbackIsWallClockAt2s', () => {
        // 2 s cadence: an MP drop of mp_drop_inhg + 1 spread over 8 s (inside the
        // 10 s look-back) opens an event; spread over 14 s it never does. With
        // flat EGTs an opened event scores 0 at once, so divergence_closest is set
        // (at the opening sample) iff an event opened.
        const d = CFG.divergence;
        const drop = d.mp_drop_inhg + 1.0;
        const flat = even(() => CRUISE_EGT);
        for (const [spread, opens] of [[8, true], [14, false]]) {
            expect(spread * d.mp_drop_inhg / drop <= d.mp_drop_window_sec).toBe(opens);
            const mp = (t) => 25.0 - drop * ramp(t, 100, spread);
            const [ev, res] = inflightEvents(flight(200, () => 2500.0, mp, flat, () => 9.0, 2));
            expect(ofType(ev, 'inflight')).toEqual([]);
            const m = res.margins.divergenceClosest;
            if (opens) {
                const tOpen = range(100, 200, 2).find(t => mp(t) <= 25.0 - d.mp_drop_inhg);
                expect(m, String(spread)).not.toBeNull();
                expect(m.t, String(spread)).toBe(tOpen);
            } else {
                expect(m, String(spread)).toBeNull();
            }
        }
    });

    it('r5NoNewEventUntilWatchEnds', () => {
        // Three MP drops (25 -> 18 over 5 s) at t=100, 130 and 200; cyl 1 / cyl 2
        // diverge three times, at 105-115, 150-160 and 205-215. Drop 1 opens an
        // event that fires on divergence 1. Drop 2 lands inside drop 1's watch and
        // is ignored, so divergence 2 (after that watch ends, but inside the watch
        // a drop-2 event would have had) fires nothing. Drop 3 opens a new event.
        const d = CFG.divergence;
        const mp = (t) => 25.0 - DIV_MP_DROP * (ramp(t, 100, 5) - ramp(t, 115, 5)
                                                + ramp(t, 130, 5) - ramp(t, 170, 5) + ramp(t, 200, 5));
        const k = (t) => ramp(t, 105, 10) + ramp(t, 150, 10) + ramp(t, 205, 10);
        const egt = (t) => [CRUISE_EGT - DIV_FALL * k(t), CRUISE_EGT + DIV_RISE * k(t), CRUISE_EGT, CRUISE_EGT];
        // first sample >= mp_drop_inhg below the 25 inHg max
        const opensAt = (t0) => range(t0, t0 + 10).find(t => mp(t) <= 25.0 - d.mp_drop_inhg);
        // first sample of a 10 s divergence ramp past both thresholds
        const firesAt = (t0) => range(t0, t0 + 11).find(
            t => DIV_FALL * ramp(t, t0, 10) >= d.fall_f && DIV_RISE * ramp(t, t0, 10) >= d.rise_f);
        const e1End = opensAt(100) + d.watch_sec;
        expect(135 < e1End && e1End < 150 && 160 < opensAt(130) + d.watch_sec).toBe(true);   // the scenario holds
        const [ev] = inflightEvents(flight(260, () => 2500.0, mp, egt));
        expect(ofType(ev, 'inflight').map(e => e.t)).toEqual([firesAt(105), firesAt(205)]);
    });

    it('r4RejectedByMpBandAlone', () => {
        // Idle with RPM jitter and one jittery EGT: MP swinging past mp_band_inhg
        // keeps R4 from ever judging a window; the same run with steady MP fires.
        const band = CFG.roughness.mp_band_inhg;
        const rpm = (t) => 1000.0 + RPM_JITTER * alternating(t);
        const egt = (t) => {
            const a = alternating(t);
            return [900.0 + EGT_QUIET * a, 900.0 + EGT_JITTER * a, 900.0 - EGT_QUIET * a, 900.0 + EGT_QUIET * a];
        };
        const swing = (t) => 12.0 + (band + 0.5) * (pyInt(t) % 2 ? 1.0 : 0.0);
        for (const [mp, judged] of [[swing, false], [() => 12.0, true]]) {
            const [, ev] = runDetector(makeSamples(300, { rpm: withStop(rpm, 260), mp, egt }));
            const res = ofType(ev, 'run_end')[0].result;
            expect(res.rulesRun.includes('roughness')).toBe(judged);
            expect(findings(ev, 'roughness').length > 0).toBe(judged);
            expect(res.margins.roughnessMaxRpmStd !== null).toBe(judged);
        }
    });

    it('r4StreakBrokenByNonfiniteEgt', () => {
        // One NaN EGT sample (cyl 2) at t=20 resets the steady-idle streak: the
        // first full window comes window_sec after the next sample, not at window_sec.
        const w = CFG.roughness.window_sec;
        const nanT = 20;
        expect(nanT).toBeLessThan(w);
        const rpm = (t) => 1000.0 + RPM_JITTER * alternating(t);
        const dropout = (t) => { const e = baseEgt(t); return t === nanT ? [e, NAN, e, e] : [e, e, e, e]; };
        for (const [egt, first] of [[even(baseEgt), w], [dropout, nanT + 1 + w]]) {
            const [, ev] = runDetector(makeSamples(120, { rpm, egt }));
            const r4 = findings(ev, 'roughness');
            expect(r4.map(f => f.cyl)).toEqual([null]);
            expect(r4[0].t).toBe(first);
        }
    });

    it('historyIsBoundedByTimeNotCount', () => {
        // At 4 Hz a cap of max(window_sec, mp_drop_window_sec) + 1 *samples* would
        // hold only ~7.5 s: too short for R4's 30 s window and R5's 10 s look-back.
        const step = 0.25;
        const w = CFG.roughness.window_sec, d = CFG.divergence;
        // R4: first judged at t = window_sec over all window_sec / step + 1 samples.
        const rpm = (t) => 1000.0 + RPM_JITTER * altPairs(t);
        let [, ev] = runDetector(makeSamples(pyInt(120 / step), { step, rpm }));
        const r4 = findings(ev, 'roughness');
        expect(r4.map(f => f.cyl)).toEqual([null]);
        expect(r4[0].t).toBe(w);
        const win = range(0, pyInt(w / step) + 1).map(k => rpm(k * step));
        expectApprox(r4[0].detail.rpmStd, pstdev(win));
        // R5: an MP drop reaching mp_drop_inhg in 9 s opens an event.
        const drop = d.mp_drop_inhg + 1.0, spread = 12.0;
        const tDrop = spread * d.mp_drop_inhg / drop;
        expect(Math.max(w, d.mp_drop_window_sec) * step < tDrop && tDrop < d.mp_drop_window_sec).toBe(true);
        const mp = (t) => 25.0 - drop * ramp(t, 100, spread);
        let res;
        [ev, res] = inflightEvents(flight(200, () => 2500.0, mp, even(() => CRUISE_EGT), () => 9.0, step));
        const m = res.margins.divergenceClosest;
        const tOpen = range(pyInt(100 / step), pyInt(200 / step)).map(k => k * step)
            .find(t => mp(t) <= 25.0 - d.mp_drop_inhg);
        expect(m).not.toBeNull();
        expect(m.t).toBe(tOpen);
    });

    it('r4WindowIgnoresNonstreakSampleWithEqualTimestamp', () => {
        // dt == 0 is not a hole. A non-qualifying sample X followed by an idle
        // sample Y at the same t: the streak starts at Y, and X must never enter a
        // window, even the one at t_now = t_X + window_sec whose bound t >= lo
        // it meets.
        const w = CFG.roughness.window_sec;
        const tX = 10.0;
        // (a) X at run-up RPM (non-qualifying) in otherwise steady idle.
        const steady = makeSamples(120);
        let [, ev] = runDetector(steady);
        expect(findings(ev, 'roughness')).toEqual([]);   // control
        let x = steady[pyInt(tX)];
        expect(x.t).toBe(tX);
        const xRpm = 1700.0;
        expect(xRpm).toBeGreaterThanOrEqual(CFG.phase.runup_rpm);
        [, ev] = runDetector(withExtraSample(steady, { ...x, rpm: xRpm }));
        expect(findings(ev, 'roughness')).toEqual([]);
        // (b) X with NaN MP (non-qualifying), first in the t_now = t_X + window_sec
        // window: it must not turn the MP range into NaN and slip past the band
        // check. Rough RPM with MP swinging past the band: R4 must never judge.
        const band = CFG.roughness.mp_band_inhg;
        const rough = makeSamples(120, {
            rpm: (t) => 1000.0 + RPM_JITTER * alternating(t),
            mp: (t) => 12.0 + (band + 0.5) * (pyInt(t) % 2 ? 1.0 : 0.0),
        });
        x = rough[pyInt(tX)];
        const samples = withExtraSample(rough, { ...x, mp: NAN });
        let det;
        [det, ev] = runDetector(samples);
        expect(findings(ev, 'roughness')).toEqual([]);
        const res = ofType(det.finish(samples.at(-1).t), 'run_end')[0].result;
        expect(res.rulesNotRun).toContain('roughness');
        expect(res.margins.roughnessMaxRpmStd).toBeNull();
        expect(tX + w).toBeLessThan(samples.at(-1).t);   // the window that would hold X was reached
    });
});


// ============================================================================
// StickyValveMonitor -- live wiring, verdict state, latch and dismiss policy
// ============================================================================

const M_HOT = [1200, 1180, 1210, 1190];
const M_COLD3 = [1200, 1180, 300, 1190];   // cyl 3 at 25% of the others
const COOL_CHT = [100, 100, 100, 100];      // a cold settle (<= verdict.cold_cht_max_f)
const HOT_CHT = [300, 300, 300, 300];
const RUNUP = 1700;                         // >= phase.runup_rpm: fires the verdict trigger

/** A Pi /api/status frame. */
function piFrame(rpm, egt, { cht = COOL_CHT, mp = 12, extra = {}, data = {} } = {}) {
    return {
        api_contract: 2, serial_connected: true, serial_warning: null,
        data: {
            RPM: rpm, MP: mp, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3],
            CHT1: cht[0], CHT2: cht[1], CHT3: cht[2], CHT4: cht[3], ...data,
        },
        ...extra,
    };
}

function makeTarget() {
    const c = new EventTarget();
    c.emit = (type, detail) => c.dispatchEvent(new CustomEvent(type, { detail }));
    return c;
}

/** What loadSpec() gives the app: the detector config plus the monitor section. */
const CFG_M = { ...CFG, monitor: StickyValve.monitorConfig(JSON.parse(read('web/phase_spec.json'))) };

/** A monitor on a fake engine client and Stratux client, clock in seconds. */
function harness(opts = {}) {
    const h = { clock: 0, client: makeTarget(), stratux: makeTarget(), findings: [], advisories: [], inflight: [], changes: [] };
    h.mon = new StickyValveMonitor(h.client, { now: () => h.clock * 1000, cfg: CFG_M, stratuxClient: h.stratux, ...opts });
    h.mon.addEventListener('finding', (e) => h.findings.push(e.detail));
    h.mon.addEventListener('advisory', (e) => h.advisories.push(e.detail));
    h.mon.addEventListener('inflight', (e) => h.inflight.push(e.detail));
    h.mon.addEventListener('change', (e) => h.changes.push(e.detail));
    /** `secs` 1 Hz frames; egt / frame options may be functions of k (0-based). */
    h.run = (secs, rpm, egt, o) => {
        for (let k = 0; k < secs; k++) {
            h.client.emit('engine:data', piFrame(
                typeof rpm === 'function' ? rpm(k) : rpm,
                typeof egt === 'function' ? egt(k) : egt,
                typeof o === 'function' ? o(k) : o));
            h.clock += 1;
        }
    };
    /** Like run(), with a fresh GPS situation (ground speed gs) before every frame. */
    h.runGs = (secs, gs, rpm, egt, o) => {
        for (let k = 0; k < secs; k++) {
            h.stratux.emit('stratux:situation', { ground_speed: gs, gps_fix_quality: 1 });
            h.run(1, rpm, egt, o);
        }
    };
    /** Wrap the detector's sample() to see what the monitor feeds it. */
    h.spy = () => {
        const seen = [];
        const det = h.mon.detector;
        const orig = det.sample.bind(det);
        det.sample = (s) => { seen.push({ s, egt: s.egt, cht: s.cht, json: JSON.stringify(s) }); return orig(s); };
        return seen;
    };
    return h;
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Cylinder 3 cold from start, then one run-up frame: NO-GO at t = 40. */
function noGo(h) {
    h.run(40, 1000, M_COLD3);   // t = 0..39; R1 fires at t = 30, no verdict yet
    h.run(1, RUNUP, M_COLD3);   // t = 40: verdict trigger
}

/** A seen engine stop: RPM 0 held for run.stop_sec. */
function seenStop(h) { h.run(CFG.run.stop_sec + 1, 0, M_HOT); }

// Healthy cold start: even EGT ramp, even CHT ramp (cht_lag needs >= 90 °F of
// others' rise in 180 s); lagCht makes cylinder 4's CHT rise at 40%.
const egtRamp = (k) => even((t) => 300 + 5 * Math.min(t, 120))(k);
const chtEven = (k) => ({ cht: even((t) => 70 + 0.75 * Math.min(t, 300))(k) });
const chtLag4 = (k) => {
    const v = 70 + 0.75 * Math.min(k, 300);
    return { cht: [v, v, v, 70 + 0.3 * Math.min(k, 300)] };
};

describe('StickyValveMonitor — verdict state', () => {
    it('noGoShowsAtTheVerdictTriggerNotBefore', () => {
        const h = harness();
        h.run(40, 1000, M_COLD3);
        expect(h.findings.map(f => [f.rule, f.level, f.cyl, f.t])).toEqual([['cold_cylinder', 'NO-GO', 3, 30]]);
        expect(h.mon.state).toMatchObject({ verdict: null, visible: false });
        h.run(1, RUNUP, M_COLD3);
        expect(h.mon.state).toMatchObject({
            verdict: 'NO-GO', visible: true, verdictVisible: true, dismissable: false, reason: null, phase: 'ground',
        });
        expect(h.mon.state.findings.map(f => f.rule)).toEqual(['cold_cylinder']);
        expect(h.changes.at(-1)).toEqual(h.mon.state);
    });

    it('cautionFromChtLagIsDismissable', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtLag4);
        h.run(1, RUNUP, egtRamp(200), chtLag4(200));
        expect(h.mon.state).toMatchObject({ verdict: 'CAUTION', visible: true, dismissable: true });
        expect(h.mon.state.findings.map(f => [f.rule, f.cyl, f.level])).toEqual([['cht_lag', 4, 'CAUTION']]);
        h.mon.dismiss();
        expect(h.mon.state).toMatchObject({ verdict: 'CAUTION', visible: false, verdictVisible: false });
    });

    it('valvesOkNeedsEveryGroundRuleAndIsDismissable', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtEven);
        h.run(1, RUNUP, egtRamp(200), chtEven(200));
        expect(h.mon.state).toMatchObject({ verdict: 'VALVES OK', visible: true, dismissable: true, rulesNotRun: [] });
        h.mon.dismiss();
        expect(h.mon.state.visible).toBe(false);
    });

    it('checkingResolvesByItselfToValvesOk', () => {
        const h = harness();
        h.run(40, 1000, egtRamp, chtEven);
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 1 });
        h.run(1, 1000, egtRamp(40), chtEven(40));                          // taxi at t = 40: trigger
        expect(h.mon.state).toMatchObject({ verdict: 'CHECKING', visible: true });
        h.run(150, 1000, (k) => egtRamp(41 + k), (k) => chtEven(41 + k)); // to t = 190: R3 completes at 180
        expect(h.mon.state.verdict).toBe('VALVES OK');
        expect(h.changes.map(c => c.verdict).filter((v, i, a) => v !== a[i - 1])).toEqual([null, 'CHECKING', 'VALVES OK']);
    });

    it('partialOnAHotStartNamesTheRulesNotRun', () => {
        const h = harness();
        h.run(70, 1000, M_HOT, { cht: HOT_CHT });
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'PARTIAL', visible: true, dismissable: true, rulesNotRun: ['slow_heatup', 'cht_lag'] });
    });

    it('notCheckedWhenNoRuleCouldRunHasNoReasonButRulesNotRun', () => {
        const h = harness();
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({
            verdict: 'NOT CHECKED', reason: null, dismissable: true,
            rulesNotRun: ['cold_cylinder', 'slow_heatup', 'cht_lag', 'roughness'],
        });
    });

    it('an EGT of 0 is a reading: a dead cylinder may well read 0', () => {
        const h = harness();
        h.run(31, 1000, [1200, 1180, 0, 1190]);
        expect(h.findings).toMatchObject([{ rule: 'cold_cylinder', cyl: 3, detail: { egt: 0, othersAvg: 1190 } }]);
    });

    it('a missing EGT is skipped: the other three are still compared', () => {
        const h = harness();
        h.run(31, 1000, [1200, 400, null, 1190]);
        expect(h.findings).toMatchObject([{ rule: 'cold_cylinder', cyl: 2, detail: { egt: 400, othersAvg: 1195 } }]);
    });
});

describe('StickyValveMonitor — NO-GO latch and dismiss', () => {
    it('noGoCannotBeDismissedBeforeASeenStop', () => {
        const h = harness();
        noGo(h);
        h.mon.dismiss();
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
        seenStop(h);
        // The tap before the stop does not count: it stays up until tapped now.
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: true });
        h.mon.dismiss();
        expect(h.mon.state.visible).toBe(false);
    });

    it('aNewRunAfterASeenStopStartsClean', () => {
        const h = harness();
        noGo(h);
        seenStop(h);
        h.run(1, 1000, M_HOT);
        expect(h.mon.state).toMatchObject({ verdict: null, findings: [], context: [], inflight: [], visible: false, dismissable: true });
        // ...and is watched again (a start after a seen stop settles after settle_sec).
        h.run(CFG.run.settle_sec + 31, 1000, M_COLD3);
        h.run(1, RUNUP, M_COLD3);
        expect(h.mon.state.verdict).toBe('NO-GO');
    });

    it('noGoStaysWhenTheCylinderRecovers', () => {
        const h = harness();
        noGo(h);
        h.run(120, RUNUP, M_HOT);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
    });

    it('aRunUpRpmDropoutIsNotAStop', () => {
        const h = harness();
        noGo(h);
        h.run(13, 0, M_HOT);
        h.run(30, RUNUP, M_HOT);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
    });

    it('gapEndKeepsNoGoLatchedIntoTheNextRun', () => {
        const h = harness();
        noGo(h);
        h.clock += 60;                     // Pi dropout longer than stop_sec
        h.run(5, 2400, M_HOT, { cht: HOT_CHT });
        expect(h.mon.detector.runActive).toBe(true);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
        expect(h.mon.state.findings.map(f => [f.rule, f.cyl])).toEqual([['cold_cylinder', 3]]);
        // Only a seen stop releases it; the next run is then clean.
        seenStop(h);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', dismissable: true });
        h.run(1, 1000, M_HOT);
        expect(h.mon.state.verdict).toBe(null);
    });

    it('aNoGoFoundBeforeTheTriggerIsLatchedByAGapToo', () => {
        const h = harness();
        h.run(40, 1000, M_COLD3);           // finding, no verdict yet
        h.clock += 60;
        h.run(5, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
    });

    it('aClockSteppingBackwardsIsAGapNotAStop', () => {
        const h = harness();
        noGo(h);
        h.clock -= 100;
        h.run(5, 1000, M_HOT);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', dismissable: false });
    });

    it('aFrameWithNoRpmIsAHoleNotAStop', () => {
        const h = harness();
        noGo(h);
        h.client.emit('engine:data', { api_contract: 2, data: {} });
        expect(h.mon.detector.runActive).toBe(true);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', dismissable: false });
    });

    it('aDismissedCautionComesBackOnANewFindingAndOnARise', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtLag4);
        h.run(1, RUNUP, egtRamp(200), chtLag4(200));
        h.mon.dismiss();
        expect(h.mon.state.visible).toBe(false);
        // A rough cylinder 2 at idle: a second CAUTION finding, no rise.
        const alt = (k) => (k % 2 ? 1 : -1);
        h.run(40, 1000, (k) => [900 + 3 * alt(k), 900 + 60 * alt(k), 900 + 3 * alt(k), 900 + 3 * alt(k)]);
        expect(h.findings.map(f => [f.rule, f.cyl])).toEqual([['cht_lag', 4], ['roughness', 2]]);
        expect(h.mon.state).toMatchObject({ verdict: 'CAUTION', visible: true });
        h.mon.dismiss();
        // Cylinder 3 goes cold: NO-GO, a rise.
        h.run(31, 1000, M_COLD3);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
    });
});

describe('StickyValveMonitor — in-flight warning', () => {
    const CRUISE = [1350, 1350, 1350, 1350];
    const split = (fall, rise) => {
        const e = CRUISE.slice();
        e[fall - 1] -= 250;
        e[rise - 1] += 100;
        return e;
    };
    function flightToInflight(h) {
        h.run(1, 2500, CRUISE, { mp: 26, cht: HOT_CHT });               // t = 0: takeoff power
        h.run(19, 2400, CRUISE, { mp: 24, cht: HOT_CHT });              // t = 1..19
        h.run(2, 2300, CRUISE, { mp: 18, cht: HOT_CHT });               // t = 20..21: power reduction
        h.run(5, 2300, split(3, 1), { mp: 18, cht: HOT_CHT });          // t = 22..26: 3 falls, 1 rises
    }

    it('isItsOwnDismissableBlockAndComesBackOnANewEvent', () => {
        const h = harness();
        flightToInflight(h);
        expect(h.inflight.map(e => [e.falling, e.rising])).toEqual([[[3], [1]]]);
        expect(h.mon.state).toMatchObject({ phase: 'airborne', inflightVisible: true, visible: true });
        expect(h.mon.state.inflight).toHaveLength(1);
        const verdictVisible = h.mon.state.verdictVisible;
        h.mon.dismiss('inflight');
        expect(h.mon.state.inflightVisible).toBe(false);
        expect(h.mon.state.verdictVisible).toBe(verdictVisible);
        h.run(43, 2300, split(3, 1), { mp: 18, cht: HOT_CHT });         // t = 27..69: watch ends
        h.run(15, 2400, CRUISE, { mp: 24, cht: HOT_CHT });              // t = 70..84
        h.run(2, 2300, CRUISE, { mp: 18, cht: HOT_CHT });               // t = 85..86
        h.run(3, 2300, split(2, 4), { mp: 18, cht: HOT_CHT });          // t = 87..89
        expect(h.inflight.map(e => [e.falling, e.rising])).toEqual([[[3], [1]], [[2], [4]]]);
        expect(h.mon.state.inflightVisible).toBe(true);
    });

    it('dismissing the verdict block leaves the in-flight block up', () => {
        const h = harness();
        flightToInflight(h);
        h.mon.dismiss('verdict');
        expect(h.mon.state).toMatchObject({ verdictVisible: false, inflightVisible: true, visible: true });
    });

    it('phase is airborne only while the running run has seen takeoff power', () => {
        const h = harness();
        expect(h.mon.state.phase).toBe('ground');
        h.run(5, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state.phase).toBe('ground');
        h.run(1, 2500, M_HOT, { mp: 26, cht: HOT_CHT });
        expect(h.mon.state.phase).toBe('airborne');
        seenStop(h);
        expect(h.mon.state.phase).toBe('ground');
    });
});

describe('StickyValveMonitor — spec loading', () => {
    it('bufferedFramesReplayAfterSpecLoads', async () => {
        let resolve;
        const specPromise = new Promise((r) => { resolve = r; });
        const h = harness({ cfg: undefined, specPromise });
        noGo(h);
        expect(h.mon.detector).toBeNull();
        expect(h.findings).toEqual([]);
        expect(h.mon.state).toMatchObject({ verdict: null, visible: false });
        resolve(CFG);
        await flush();
        // Replayed in order, at their arrival times.
        expect(h.findings.map(f => [f.rule, f.cyl, f.t])).toEqual([['cold_cylinder', 3, 30]]);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true });
        expect(h.changes.at(-1).verdict).toBe('NO-GO');
        // Live frames carry on from there.
        h.run(1, RUNUP, M_COLD3);
        expect(h.mon.detector.runActive).toBe(true);
    });

    it('specLoadFailureIsNotChecked', async () => {
        globalThis.DiagLog = { log: vi.fn() };
        try {
            const h = harness({ cfg: undefined, specPromise: Promise.reject(new Error('Failed to load sticky_valve_spec.json: HTTP 404')) });
            h.run(5, 1000, M_HOT);
            await flush();
            expect(h.mon.state).toMatchObject({ verdict: 'NOT CHECKED', visible: true, dismissable: true, findings: [] });
            expect(h.mon.state.reason).toMatch(/threshold file/);
            expect(h.mon.state.reason).toMatch(/HTTP 404/);
            expect(globalThis.DiagLog.log).toHaveBeenCalledTimes(1);
            expect(globalThis.DiagLog.log.mock.calls[0][0]).toBe('error');
            expect(h.changes.at(-1).verdict).toBe('NOT CHECKED');
            h.run(5, 1000, M_COLD3);                 // later frames are ignored, nothing throws
            expect(h.mon.detector).toBeNull();
            h.mon.dismiss();
            expect(h.mon.state.visible).toBe(false);
        } finally {
            delete globalThis.DiagLog;
        }
    });

    it('withNeitherCfgNorSpecPromiseItCallsLoadSpec', async () => {
        delete globalThis.CockpitConfig;
        const realFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (name) => ({ ok: true, status: 200, json: async () => JSON.parse(read(`web/${name}`)) }));
        try {
            const h = harness({ cfg: undefined });
            await vi.waitFor(() => expect(h.mon.detector).not.toBeNull());
            expect(globalThis.fetch).toHaveBeenCalledWith('sticky_valve_spec.json');
            expect(globalThis.fetch).toHaveBeenCalledWith('phase_spec.json');
            // The detector config plus the monitor-only section from phase_spec.json.
            expect(h.mon.detector.cfg).toEqual({ ...CFG, monitor: { speed_landing_max_kts: 30 } });
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('bufferOverflowKeepsNewest', async () => {
        let resolve;
        const specPromise = new Promise((r) => { resolve = r; });
        const h = harness({ cfg: undefined, specPromise, bufferMax: 20 });
        h.run(40, 1000, M_COLD3);   // t = 0..39: only t = 20..39 are kept
        resolve(CFG);
        await flush();
        // Unbuffered, R1 would have fired at t = 30; the kept 20 s are short of persist_sec.
        expect(h.findings).toEqual([]);
        h.run(11, 1000, M_COLD3);   // t = 40..50
        expect(h.findings.map(f => f.t)).toEqual([50]);   // 30 s after the oldest kept frame
    });
});

describe('StickyValveMonitor — data gaps (ruling R-16: an outage is a gap in sample time)', () => {
    // engine-client fires engine:stale after >= 5 s without data; the monitor feeds
    // nothing for it (no synthetic samples): the next current frame arrives more
    // than gap_sec after the last one, and the detector sees the hole by time.
    it('engine:stale after 5 s without data: the 30 s restarts at the next frame', () => {
        const h = harness();
        h.run(20, 1000, M_COLD3);                      // t = 0..19
        h.clock += 5;
        h.client.emit('engine:stale', { stale: true, ageMs: 5000 });
        h.client.emit('engine:stale', { stale: false });
        h.run(20, 1000, M_COLD3);                      // t = 25..44
        expect(h.findings).toEqual([]);
        h.run(11, 1000, M_COLD3);                      // t = 45..55
        expect(h.findings.map(f => f.t)).toEqual([55]);
    });

    it('a stale or disconnect event alone feeds nothing and changes nothing', () => {
        const h = harness();
        h.run(20, 1000, M_COLD3);
        const seen = h.spy();
        h.client.emit('engine:stale', { stale: true });
        h.client.emit('engine:disconnect');
        expect(seen).toEqual([]);
        h.run(11, 1000, M_COLD3);                      // no time lost: persistence continues
        expect(seen.every(x => Number.isFinite(x.s.rpm))).toBe(true);
        expect(h.findings.map(f => f.t)).toEqual([30]);
    });

    it('engine:disconnect and data back after more than gap_sec: a hole', () => {
        const h = harness();
        h.run(20, 1000, M_COLD3);
        h.client.emit('engine:disconnect');
        h.clock += CFG.run.gap_sec + 1;
        h.run(20, 1000, M_COLD3);
        expect(h.findings).toEqual([]);
    });

    it('frames whose EDM row is not current are not fed; the hole is their sample time', () => {
        const h = harness();
        h.run(20, 1000, M_COLD3);                      // t = 0..19
        const seen = h.spy();
        h.run(5, 1000, M_COLD3, { extra: { serial_warning: 'No data from EDM for 6s' } });   // t = 20..24
        h.run(1, 1000, M_COLD3, { extra: { serial_connected: false } });                     // t = 25
        h.mon.feed(null);
        expect(seen).toEqual([]);
        h.run(20, 1000, M_COLD3);                      // t = 26..45: 7 s after t=19, > gap_sec
        expect(seen[0].s).toMatchObject({ t: 26, rpm: 1000 });   // the real frame, no synthetic one
        expect(seen.every(x => Number.isFinite(x.s.rpm))).toBe(true);
        expect(h.findings).toEqual([]);
        h.run(11, 1000, M_COLD3);
        expect(h.findings.map(f => f.t)).toEqual([56]);
    });

    it('a single non-current frame at 1 Hz (2 s <= gap_sec) is not a hole', () => {
        const h = harness();
        h.run(20, 1000, M_COLD3);
        h.run(1, 1000, M_COLD3, { extra: { serial_warning: 'blip' } });
        h.run(10, 1000, M_COLD3);
        expect(h.findings.map(f => f.t)).toEqual([30]);
    });

    it('a few seconds with no frames at all break the 30 s', () => {
        const h = harness();
        h.run(20, 1000, M_COLD3);
        h.clock += 6;
        h.run(20, 1000, M_COLD3);
        expect(h.findings).toEqual([]);
    });

    it('no synthetic hole samples exist in the monitor', () => {
        expect(read('web/shared/sticky-valve.js')).not.toMatch(/_holeAt/);
    });
});

describe('StickyValveMonitor — frames', () => {
    it('freshSampleObjectsEveryFrame', () => {
        const h = harness();
        const seen = h.spy();
        const raw = piFrame(1000, M_HOT);
        h.mon.feed(raw);
        h.clock += 1;
        h.mon.feed(raw);                              // the same raw object twice
        h.run(5, 1000, M_HOT);
        h.clock += 6;
        h.client.emit('engine:stale', { stale: true });
        h.run(2, 1000, M_HOT);
        expect(seen.length).toBe(9);                  // 9 frames, nothing synthesized
        for (const key of ['s', 'egt', 'cht']) {
            expect(new Set(seen.map(x => x[key])).size).toBe(seen.length);
        }
        for (const x of seen) expect(JSON.stringify(x.s)).toBe(x.json);   // never mutated afterwards
    });

    it('frameNormalisation', () => {
        const h = harness();
        const seen = h.spy();
        h.clock = 12.5;
        h.mon.feed({ data: { RPM: '1000', MAP: 14.2, Fuel_Flow: 3.1, EGT1: 1, egt2: 2, EGT3: '', CHT1: 101, cht2: 102, CHT3: null, Carb_Temp: 55 } });
        h.mon.feed({ rpm: 900, MP: 13, fuel_flow: 2.9, egt1: 5, cht4: 7, carb_temp: 60 });            // flat frame
        h.mon.feed({ data: { RPM: 800, mp: 11, FF: 2.5 } });
        h.mon.feed({ data: { RPM: 800, ff: 2.4 } });
        expect(seen.map(x => x.s)).toEqual([
            { t: 12.5, rpm: 1000, mp: 14.2, ff: 3.1, egt: [1, 2, NaN, NaN], cht: [101, 102, NaN, NaN], carb: 55, gs: NaN },
            { t: 12.5, rpm: 900, mp: 13, ff: 2.9, egt: [5, NaN, NaN, NaN], cht: [NaN, NaN, NaN, 7], carb: 60, gs: NaN },
            { t: 12.5, rpm: 800, mp: 11, ff: 2.5, egt: [NaN, NaN, NaN, NaN], cht: [NaN, NaN, NaN, NaN], carb: NaN, gs: NaN },
            { t: 12.5, rpm: 800, mp: NaN, ff: 2.4, egt: [NaN, NaN, NaN, NaN], cht: [NaN, NaN, NaN, NaN], carb: NaN, gs: NaN },
        ]);
    });

    it('groundSpeedFromStratux', () => {
        const h = harness();
        h.run(70, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state.verdict).toBe(null);
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 1 });
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state.verdict).toBe('PARTIAL');
    });

    it('a situation older than 5 s gives no ground speed; 5 s is still fresh', () => {
        const h = harness();
        const seen = h.spy();
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 1 });
        h.clock += 6;
        h.run(1, 1000, M_HOT);
        h.stratux.emit('stratux:situation', { ground_speed: 7, gps_fix_quality: 1 });
        h.clock += 5;
        h.run(1, 1000, M_HOT);
        expect(seen.map(x => x.s.gs)).toEqual([NaN, 7]);
    });

    it('a degraded (feed stopped) or no-fix situation clears the ground speed', () => {
        const h = harness();
        const seen = h.spy();
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 1 });
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 0, _stale: true });
        h.run(1, 1000, M_HOT);
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 1 });
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 0 });
        h.run(1, 1000, M_HOT);
        h.stratux.emit('stratux:situation', { ground_speed: null, gps_fix_quality: 1 });
        h.run(1, 1000, M_HOT);
        h.stratux.emit('stratux:situation', { ground_speed: 4, gps_fix_quality: 1, _source: 'engine' });  // engine-GPS bridge
        h.run(1, 1000, M_HOT);
        expect(seen.map(x => x.s.gs)).toEqual([NaN, NaN, NaN, 4]);
    });

    it('destroy stops listening to both clients', () => {
        const h = harness();
        const seen = h.spy();
        h.mon.destroy();
        h.stratux.emit('stratux:situation', { ground_speed: 6, gps_fix_quality: 1 });
        h.run(3, 1000, M_HOT);
        expect(seen).toEqual([]);
        h.mon.feed(piFrame(1000, M_HOT));
        expect(seen[0].s.gs).toBeNaN();
    });
});

describe('StickyValveMonitor — days since flight', () => {
    const noteDays = (h) => h.mon.state.context.filter(c => c.note === 'days_since_flight').map(c => c.detail.days);

    it('from the constructor: a note at the verdict trigger', () => {
        const h = harness({ daysSinceFlight: 45 });
        h.run(1, RUNUP, M_HOT);
        expect(noteDays(h)).toEqual([45]);
    });

    it('set before the verdict: this run; set after it: the next run', () => {
        const h = harness();
        h.run(5, 1000, M_HOT);
        h.mon.setDaysSinceFlight(40);
        h.run(1, RUNUP, M_HOT);
        expect(noteDays(h)).toEqual([40]);

        const g = harness();
        g.run(1, RUNUP, M_HOT);                     // verdict issued
        g.mon.setDaysSinceFlight(40);
        g.run(5, RUNUP, M_HOT);
        expect(noteDays(g)).toEqual([]);
        seenStop(g);
        g.run(CFG.run.settle_sec + 1, RUNUP, M_HOT);   // the restart settles, then triggers
        expect(noteDays(g)).toEqual([40]);
    });

    it('set before the spec loads, it reaches the detector', async () => {
        let resolve;
        const h = harness({ cfg: undefined, specPromise: new Promise((r) => { resolve = r; }) });
        h.mon.setDaysSinceFlight(31);
        resolve(CFG);
        await flush();
        expect(h.mon.detector.daysSinceFlight).toBe(31);
    });

    it('below the spec threshold, unknown or invalid: no note', () => {
        for (const d of [CFG.context.days_since_flight - 1, null, undefined, -1, NaN, '40']) {
            const h = harness();
            h.mon.setDaysSinceFlight(d);
            h.run(1, RUNUP, M_HOT);
            expect(noteDays(h)).toEqual([]);
        }
    });

    it('daysSinceLastFlight: this aircraft\'s latest dated logbook entry, UTC days', () => {
        const now = Date.UTC(2026, 10, 6, 15, 0);   // 2026-11-06 15:00Z
        const d = StickyValveMonitor.daysSinceLastFlight;
        const e = (date, tail, key = 'aircraft_tail') => ({ date, [key]: tail });
        expect(d([e('2026-10-01', 'N194JT'), e('2026-11-01', 'N999XX'), e('2026-09-20', 'N194JT')], 'N194JT', now)).toBe(36);
        expect(d([e('2026-10-31', 'N194JT', 'aircraft_id')], 'N194JT', now)).toBe(6);
        expect(d([e('2026-11-06', 'N194JT')], 'N194JT', now)).toBe(0);
        expect(d([e('2026-11-07', 'N194JT')], 'N194JT', now)).toBe(null);           // clock or entry wrong
        expect(d([e('11/01/2026', 'N194JT'), e('', 'N194JT'), null], 'N194JT', now)).toBe(null);
        expect(d([e('2026-10-01', 'N999XX')], 'N194JT', now)).toBe(null);
        expect(d([e('2026-10-01', 'N194JT')], '', now)).toBe(null);
        expect(d(null, 'N194JT', now)).toBe(null);
    });
});

describe('StickyValveMonitor — text', () => {
    it('describe() names the cylinder, the signal and the numbers', () => {
        const D = StickyValveMonitor.describe;
        expect(D({ rule: 'cold_cylinder', cyl: 3, level: 'NO-GO', corroborates: false, detail: { egt: 412.2, othersAvg: 1030.4, ratio: 0.4 } }))
            .toBe('CYL 3 EGT 412°F vs 1030°F others (cold cylinder)');
        expect(D({ rule: 'slow_heatup', cyl: 2, detail: { rise: 150, othersRise: 420.6, ratio: 0.36 } }))
            .toBe('CYL 2 EGT rose 150°F vs 421°F others (slow EGT heat-up)');
        expect(D({ rule: 'cht_lag', cyl: 4, corroborates: true, detail: { rise: 40, othersRise: 120, ratio: 0.33 } }))
            .toBe('CYL 4 CHT rose 40°F vs 120°F others (CHT lag, same cylinder as the EGT finding)');
        expect(D({ rule: 'roughness', cyl: null, detail: { rpmStd: 250.4 } }))
            .toBe('ENGINE RPM unsteady at idle, std dev 250 RPM (roughness)');
        expect(D({ rule: 'roughness', cyl: 2, detail: { egtStd: 60, othersMedian: 3, ratio: 20 } }))
            .toBe('CYL 2 EGT unsteady at idle, std dev 60°F vs 3°F others (roughness)');
        expect(D({ rule: 'cold_cylinder', cyl: 1, detail: { egt: null, othersAvg: NaN } }))
            .toBe('CYL 1 EGT —°F vs —°F others (cold cylinder)');
    });

    it('context, in-flight and rule-name text', () => {
        expect(StickyValveMonitor.describeContext({ note: 'days_since_flight', detail: { days: 45 } })).toBe('45 days since the last flight');
        expect(StickyValveMonitor.describeContext({ note: 'long_ground_idle', detail: { idleSec: 960 } }))
            .toBe('Long ground idle: 16 min at idle before takeoff');
        expect(StickyValveMonitor.describeContext({ note: 'heat_soak', detail: { carb: 104.6 } }))
            .toBe('Carb temp 105°F on the ground (heat-soak sign; carb temp stands in for OAT)');
        expect(StickyValveMonitor.describeInflight({ falling: [3], rising: [1], deltas: [101.2, 0, -251, 2], mpDrop: 6 }))
            .toBe('IN-FLIGHT: CYL 3 EGT fell 251°F while CYL 1 rose 101°F after a power reduction');
        expect(['cold_cylinder', 'slow_heatup', 'cht_lag', 'roughness', 'divergence'].map(StickyValveMonitor.ruleName))
            .toEqual(['cold cylinder (EGT)', 'slow EGT heat-up', 'CHT lag', 'roughness', 'in-flight EGT divergence']);
    });

    it('no legacy detector or config is left in the file', () => {
        const src = read('web/shared/sticky-valve.js');
        expect(src).not.toMatch(/LegacyStickyValveDetector|LEGACY_DEFAULTS|legacyStickyValveConfig/);
    });
});


// ---- Fix round 1: rulings R-14 / R-15 and review minors ----------------------

describe('StickyValveMonitor — R-14: findings made before the verdict trigger', () => {
    it('aNoGoFoundBeforeTheTriggerThenASeenStopIsShownAndSurvivesTheRestart', () => {
        const h = harness();
        h.run(40, 1000, M_COLD3);                      // NO-GO finding at t=30, no trigger yet
        expect(h.mon.state).toMatchObject({ verdict: null, visible: false });
        seenStop(h);                                   // shut down before taxi / run-up
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: true });
        expect(h.mon.state.findings.map(f => [f.rule, f.cyl])).toEqual([['cold_cylinder', 3]]);
        // A clean warm restart does not clear it...
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: true });
        h.run(CFG.run.settle_sec + 70, 1000, M_HOT, { cht: HOT_CHT });
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });     // the new run's own verdict: PARTIAL
        expect(h.mon.state.verdict).toBe('NO-GO');
        // ...nor a further gap, nor another seen stop without a dismiss.
        h.clock += 60;
        h.run(5, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true });
        seenStop(h);
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true });
        // Dismissed after it was shown: gone at the next start.
        h.mon.dismiss();
        expect(h.mon.state.visible).toBe(false);
        seenStop(h);
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: null, findings: [], visible: false });
    });

    it('aNoGoFoundBeforeTheTriggerThenAGapStaysUndismissable', () => {
        const h = harness();
        h.run(40, 1000, M_COLD3);
        h.clock += 60;
        h.run(5, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
        seenStop(h);
        expect(h.mon.state.dismissable).toBe(true);
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });     // not dismissed: still there (R-14)
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true });
    });

    it('aCautionFoundBeforeTheTriggerThenASeenStopIsShownAndSurvivesTheRestart', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtLag4);            // CHT lag CAUTION at t=180, no trigger
        expect(h.mon.state.verdict).toBe(null);
        seenStop(h);
        expect(h.mon.state).toMatchObject({ verdict: 'CAUTION', visible: true, dismissable: true });
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'CAUTION', visible: true });
        expect(h.mon.state.findings.map(f => [f.rule, f.cyl])).toEqual([['cht_lag', 4]]);
        h.mon.dismiss();
        seenStop(h);
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: null, findings: [] });
    });

    it('a dismiss before anything was shown does not acknowledge a pre-trigger finding', () => {
        const h = harness();
        h.run(40, 1000, M_COLD3);
        h.mon.dismiss();                               // nothing on the banner
        seenStop(h);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true });
    });

    it('cautionCarriesAcrossAGap', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtLag4);
        h.run(1, RUNUP, egtRamp(200), chtLag4(200));   // CAUTION shown
        h.clock += 60;
        h.run(5, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.detector.runActive).toBe(true);
        expect(h.mon.state).toMatchObject({ verdict: 'CAUTION', visible: true, dismissable: true });
        expect(h.mon.state.findings.map(f => [f.rule, f.cyl])).toEqual([['cht_lag', 4]]);
        // Released by the next seen stop (it was shown in its own run): clean after.
        seenStop(h);
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: null, findings: [] });
    });

    it('a CAUTION dismissed while shown does not carry across a gap', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtLag4);
        h.run(1, RUNUP, egtRamp(200), chtLag4(200));
        h.mon.dismiss();
        h.clock += 60;
        h.run(5, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: null, findings: [], visible: false });
    });

    it('specFailureNotCheckedReshowsAtNextStart', async () => {
        const h = harness({ cfg: undefined, specPromise: Promise.reject(new Error('HTTP 404')) });
        await flush();
        h.run(5, 1000, M_HOT);
        h.mon.dismiss();
        h.run(30, 1000, M_HOT);
        expect(h.mon.state.visible).toBe(false);       // stays dismissed while the engine runs
        h.run(40, 0, M_HOT);                           // shutdown
        expect(h.mon.state.visible).toBe(false);
        h.run(1, 1000, M_HOT);                         // the next start
        expect(h.mon.state).toMatchObject({ verdict: 'NOT CHECKED', visible: true });
        h.mon.dismiss();
        h.client.emit('engine:disconnect');            // Pi off at shutdown, back with the engine running
        h.run(1, 1000, M_HOT);
        expect(h.mon.state.visible).toBe(true);
        h.mon.dismiss();
        h.mon.feed(null);                              // a non-current frame, then running
        h.run(1, 1000, M_HOT);
        expect(h.mon.state.visible).toBe(true);
    });
});

describe('StickyValveMonitor — R-15: data gap and restart in flight', () => {
    const CRUISE = [1350, 1350, 1350, 1350];
    const CRUISE_COLD3 = [1350, 1350, 300, 1350];
    const cruise = { mp: 22, cht: HOT_CHT };          // MP below takeoff_mp: the restart never goes airborne
    const GS = 110;                                    // > speed_landing_max_kts (30)
    /** Hot start, PARTIAL dismissed, takeoff power, 30 s cruise: an airborne run. */
    function airborne(h) {
        h.run(70, 1000, M_HOT, { cht: HOT_CHT });
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state.verdict).toBe('PARTIAL');
        h.mon.dismiss();
        h.run(1, 2500, CRUISE, { mp: 26, cht: HOT_CHT });
        h.run(30, 2400, CRUISE, cruise);
        expect(h.mon.state).toMatchObject({ phase: 'airborne', visible: false });
    }

    it('flightGapRestartWithGpsSuppressesNeutralBanner', () => {
        const h = harness({ daysSinceFlight: 45 });
        airborne(h);
        h.clock += 60;                                 // Pi dropout > stop_sec in flight
        const from = h.changes.length;
        h.runGs(120, GS, 2400, CRUISE, cruise);
        expect(h.mon.detector.runActive).toBe(true);
        expect(h.mon.detector.verdict).not.toBeNull();   // the detector did issue a verdict...
        expect(h.changes.slice(from).every(c => !c.visible)).toBe(true);   // ...never shown
        expect(h.mon.state).toMatchObject({ verdict: null, visible: false, context: [], phase: 'airborne' });
    });

    it('flightGapRestartWithoutGpsStillShowsBanner', () => {
        const h = harness();
        airborne(h);
        h.clock += 60;
        h.run(1, 2400, CRUISE, cruise);                // no GPS: fail visible
        expect(h.mon.state).toMatchObject({ verdict: 'NOT CHECKED', visible: true });
    });

    it('a stale GPS speed (> 5 s old) does not suppress either', () => {
        const h = harness();
        airborne(h);
        h.stratux.emit('stratux:situation', { ground_speed: GS, gps_fix_quality: 1 });
        h.clock += 60;
        h.run(1, 2400, CRUISE, cruise);
        expect(h.mon.state).toMatchObject({ verdict: 'NOT CHECKED', visible: true });
    });

    it('groundGapRestartStillShowsPartial', () => {
        for (const gs of [null, 0, GS]) {             // GPS or not: the ended run never flew
            const h = harness();
            h.run(20, 1000, M_HOT, { cht: HOT_CHT });  // warm-up, then master off / tablet asleep
            h.clock += 60;
            if (gs === null) h.run(70, 1000, M_HOT, { cht: HOT_CHT });
            else h.runGs(70, gs, 1000, M_HOT, { cht: HOT_CHT });
            h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
            expect(h.mon.state).toMatchObject({ verdict: 'PARTIAL', visible: true });
        }
    });

    it('masterOnAfterStartOnLeg2ShowsVerdict', () => {
        const h = harness();
        airborne(h);
        h.clock += 3600;                               // landed, master off before a seen stop
        h.runGs(70, 0, 1000, M_HOT, { cht: HOT_CHT }); // leg 2: data back with the engine running, gs 0
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'PARTIAL', visible: true, phase: 'ground' });
    });

    it('groundRuleFindingInFlightGapRunIsAmberAdvisory', () => {
        const h = harness();
        airborne(h);
        h.clock += 60;
        h.runGs(40, GS, 2400, CRUISE_COLD3, cruise);   // R1 judges in flight and fires
        expect(h.findings).toEqual([]);                // not a ground finding...
        expect(h.advisories.map(f => [f.rule, f.cyl, f.level])).toEqual([['cold_cylinder', 3, 'NO-GO']]);
        expect(h.mon.state).toMatchObject({ verdict: null, verdictVisible: false, inflightVisible: true, visible: true });
        expect(StickyValveMonitor.describeAdvisory(h.mon.state.advisories[0]))
            .toBe('IN-FLIGHT: CYL 3 cold cylinder (EGT) — EGT 300°F vs 1350°F others');
        h.mon.dismiss('inflight');                     // ...and dismissable
        expect(h.mon.state.visible).toBe(false);
        // Landing and a seen stop: nothing of it is carried into the next start.
        seenStop(h);
        h.run(1, 1000, M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: null, findings: [], advisories: [], visible: false });
    });

    it('a NO-GO latched before the gap still shows as today', () => {
        const h = harness();
        noGo(h);                                       // pilot takes off anyway
        h.run(1, 2500, M_HOT, { mp: 26, cht: HOT_CHT });
        h.run(20, 2400, M_HOT, cruise);
        h.clock += 60;
        h.runGs(30, GS, 2400, M_HOT, cruise);
        expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
    });

    it('a second dropout in the same flight is suppressed too', () => {
        const h = harness();
        airborne(h);
        h.clock += 60;
        h.runGs(30, GS, 2400, CRUISE, cruise);
        h.clock += 60;
        h.runGs(90, GS, 2400, CRUISE, cruise);
        expect(h.mon.state).toMatchObject({ verdict: null, visible: false, phase: 'airborne' });
    });

    it('an in-flight warning from before the gap stays up across the restart', () => {
        const h = harness();
        airborne(h);
        h.run(2, 2300, CRUISE, { mp: 16, cht: HOT_CHT });                     // power reduction
        h.run(5, 2300, [1450, 1350, 1100, 1350], { mp: 16, cht: HOT_CHT });  // 3 falls, 1 rises
        expect(h.mon.state.inflight).toHaveLength(1);
        h.clock += 60;
        h.runGs(5, GS, 2300, CRUISE, { mp: 16, cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ inflightVisible: true, visible: true });
        expect(h.mon.state.inflight).toHaveLength(1);
    });

    it('monitorConfig reads speed_landing_max_kts from phase_spec.json; missing is null', () => {
        expect(StickyValve.monitorConfig(JSON.parse(read('web/phase_spec.json')))).toEqual({ speed_landing_max_kts: 30 });
        expect(StickyValve.monitorConfig({ thresholds: {} })).toEqual({ speed_landing_max_kts: null });
        expect(StickyValve.monitorConfig(null)).toEqual({ speed_landing_max_kts: null });
    });

    it('without the monitor section (no threshold) nothing is suppressed', () => {
        const h = harness({ cfg: CFG });
        airborne(h);
        h.clock += 60;
        h.runGs(1, GS, 2400, CRUISE, cruise);
        expect(h.mon.state).toMatchObject({ verdict: 'NOT CHECKED', visible: true });
    });
});

describe('StickyValveMonitor — review minors', () => {
    it('a dismissed VALVES OK stays hidden over later frames with nothing new', () => {
        const h = harness();
        h.run(200, 1000, egtRamp, chtEven);
        h.run(1, RUNUP, egtRamp(200), chtEven(200));
        expect(h.mon.state.verdict).toBe('VALVES OK');
        h.mon.dismiss();
        const from = h.changes.length;                 // 'change' fires only when something changed
        h.run(300, (k) => (k < 150 ? 1000 : RUNUP), egtRamp(200), chtEven(200));
        expect(h.mon.state).toMatchObject({ verdict: 'VALVES OK', visible: false });
        expect(h.changes.slice(from).every(c => !c.visible)).toBe(true);
    });

    it('a dismissed PARTIAL stays hidden over later frames with nothing new', () => {
        const h = harness();
        h.run(70, 1000, M_HOT, { cht: HOT_CHT });
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
        h.mon.dismiss();
        h.run(300, (k) => (k % 60 < 30 ? 1000 : RUNUP), M_HOT, { cht: HOT_CHT });
        expect(h.mon.state).toMatchObject({ verdict: 'PARTIAL', visible: false });
    });

    it('a NO-GO carried over a gap and found again is listed once', () => {
        const h = harness();
        noGo(h);
        h.clock += 60;
        h.run(40, 1000, M_COLD3);                      // the gap run finds cylinder 3 again
        h.run(1, RUNUP, M_COLD3);
        expect(h.findings.filter(f => f.rule === 'cold_cylinder' && f.cyl === 3)).toHaveLength(2);
        expect(h.mon.state.findings.map(f => [f.rule, f.cyl, f.level])).toEqual([['cold_cylinder', 3, 'NO-GO']]);
    });
});

// ---- Fix round 2: ruling R-16 -- the real Pi-dropout signals -----------------
// engine-client signals an outage with engine:stale (>= 5 s without data, then
// stale:false when data resumes), engine:disconnect, or the Pi keeps sending
// frames whose EDM row is not current (serial_warning / serial_connected false).
// Each must reach the detector exactly like a plain time jump.

describe('StickyValveMonitor — R-16: R-15 and R-14 through every dropout signal', () => {
    const CRUISE = [1350, 1350, 1350, 1350];
    const CRUISE_COLD3 = [1350, 1350, 300, 1350];
    const cruise = { mp: 22, cht: HOT_CHT };
    const GS = 110;
    const KINDS = ['time', 'stale', 'disconnect', 'noncurrent'];

    /** An outage of `secs` seconds; non-current frames carry rpm / egt / o. */
    function dropout(h, kind, secs, rpm, egt, o = {}) {
        if (kind === 'time') {
            h.clock += secs;
        } else if (kind === 'stale') {
            h.clock += 5;
            h.client.emit('engine:stale', { stale: true, ageMs: 5000 });
            h.clock += secs - 5;
            h.client.emit('engine:stale', { stale: false });     // engine-client, as data resumes
        } else if (kind === 'disconnect') {
            h.client.emit('engine:disconnect');
            h.clock += secs;
        } else {
            h.run(secs, rpm, egt, { ...o, extra: { serial_warning: 'No data from EDM for 6s' } });
        }
    }

    function airborne(h) {
        h.run(70, 1000, M_HOT, { cht: HOT_CHT });
        h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
        h.mon.dismiss();                               // PARTIAL
        h.run(1, 2500, CRUISE, { mp: 26, cht: HOT_CHT });
        h.run(30, 2400, CRUISE, cruise);
        expect(h.mon.state).toMatchObject({ phase: 'airborne', visible: false });
    }

    for (const kind of KINDS) {
        describe(`via ${kind}`, () => {
            it('flightGapRestartWithGpsSuppressesNeutralBanner', () => {
                const h = harness();
                airborne(h);
                dropout(h, kind, 60, 2400, CRUISE, cruise);
                const from = h.changes.length;
                h.runGs(120, GS, 2400, CRUISE, cruise);
                expect(h.mon.detector.verdict).not.toBeNull();
                expect(h.changes.slice(from).every(c => !c.visible)).toBe(true);
                expect(h.mon.state).toMatchObject({ verdict: null, visible: false, phase: 'airborne' });
            });

            it('flightGapRestartWithoutGpsStillShowsBanner', () => {
                const h = harness();
                airborne(h);
                dropout(h, kind, 60, 2400, CRUISE, cruise);
                h.run(1, 2400, CRUISE, cruise);
                expect(h.mon.state).toMatchObject({ verdict: 'NOT CHECKED', visible: true });
            });

            it('groundGapRestartStillShowsPartial', () => {
                for (const gs of [null, 0, GS]) {
                    const h = harness();
                    h.run(20, 1000, M_HOT, { cht: HOT_CHT });
                    dropout(h, kind, 60, 1000, M_HOT, { cht: HOT_CHT });
                    if (gs === null) h.run(70, 1000, M_HOT, { cht: HOT_CHT });
                    else h.runGs(70, gs, 1000, M_HOT, { cht: HOT_CHT });
                    h.run(1, RUNUP, M_HOT, { cht: HOT_CHT });
                    expect(h.mon.state).toMatchObject({ verdict: 'PARTIAL', visible: true });
                }
            });

            it('groundRuleFindingInFlightGapRunIsAmberAdvisory', () => {
                const h = harness();
                airborne(h);
                dropout(h, kind, 60, 2400, CRUISE, cruise);
                h.runGs(40, GS, 2400, CRUISE_COLD3, cruise);
                expect(h.findings).toEqual([]);
                expect(h.advisories.map(f => [f.rule, f.cyl, f.level])).toEqual([['cold_cylinder', 3, 'NO-GO']]);
                expect(h.mon.state).toMatchObject({ verdict: null, verdictVisible: false, inflightVisible: true });
                h.mon.dismiss('inflight');
                expect(h.mon.state.visible).toBe(false);
            });

            it('R-14: a pre-trigger NO-GO, data back with the engine off, is shown and survives the restart', () => {
                const h = harness();
                h.run(40, 1000, M_COLD3);              // finding at t=30, no trigger
                dropout(h, kind, 60, 0, M_HOT);
                h.run(5, 0, M_HOT);                    // data back, engine off
                expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true, dismissable: false });
                h.run(1, 1000, M_HOT, { cht: HOT_CHT });
                expect(h.mon.state).toMatchObject({ verdict: 'NO-GO', visible: true });
            });

            it('a restart after the gap settles at once, as in the Python replay', () => {
                const h = harness();
                h.run(20, 1000, M_HOT);
                dropout(h, kind, 60, 1000, M_HOT);
                const resumeT = h.clock;
                h.run(CFG.cold_cylinder.persist_sec + 15, 1000, M_COLD3);
                // Settled on the first sample after the gap: R1 judges from there.
                expect(h.findings.map(f => f.t)).toEqual([resumeT + CFG.cold_cylinder.persist_sec]);
            });
        });
    }

    it('the live monitor and the bare detector (replay) give the same events across a stale gap', () => {
        const h = harness();
        const seen = h.spy();
        h.run(20, 1000, M_HOT);
        dropout(h, 'stale', 60, 1000, M_HOT);
        h.run(45, 1000, M_COLD3);
        // Replay the exact samples the monitor fed through a fresh detector.
        const det = new StickyValveDetector(CFG_M);
        const replayed = [];
        for (const x of seen) replayed.push(...det.sample(JSON.parse(JSON.stringify(x.s), (k, v) => (v === null ? NaN : v))));
        expect(replayed.filter(e => e.type === 'finding').map(e => e.t)).toEqual(h.findings.map(f => f.t));
        expect(replayed.map(e => e.type)).toContain('run_end');
        expect(seen.every(x => Number.isFinite(x.s.rpm))).toBe(true);
    });
});
