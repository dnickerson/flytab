/**
 * Sticky valve detection on the tablet (web/shared/sticky-valve.js).
 *
 * Two parts:
 *  - StickyValveDetector: a line-for-line port of the Python reference
 *    engine_analysis/sticky_valve.py. Its tests below are ports of
 *    engine_analysis/tests/test_sticky_valve.py (same names in camelCase, same
 *    synthetic inputs, same assertions and guard asserts), run on the real spec
 *    (web/sticky_valve_spec.json + web/phase_spec.json through StickyValve.buildConfig).
 *  - StickyValveMonitor: TEMPORARY until Task 9 rewrites it -- still the Pi rule
 *    (during the first 10 minutes after start, a cylinder whose EGT stays below
 *    50% of the other three's average for 30 s alerts, once the engine is making
 *    heat, >= 200°F), on the private LegacyStickyValveDetector. Frames are fed the
 *    way engine-client.js dispatches them: the Pi's /api/status with the EDM row
 *    nested under `data`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const { StickyValve, StickyValveDetector, StickyValveMonitor } = new Function(
    read('web/shared/sticky-valve.js') + '\nreturn { StickyValve, StickyValveDetector, StickyValveMonitor };')();

/** A Pi /api/status frame. */
const frame = (rpm, egt, extra = {}) => ({
    api_contract: 2, serial_connected: true, serial_warning: null,
    data: { RPM: rpm, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3] },
    ...extra,
});

function makeClient() {
    const c = new EventTarget();
    c.emit = (type, detail) => c.dispatchEvent(new CustomEvent(type, { detail }));
    return c;
}

let clock, client, mon, alerts, changes;
beforeEach(() => {
    delete globalThis.CockpitConfig;
    clock = 0;
    client = makeClient();
    mon = new StickyValveMonitor(client, { now: () => clock * 1000 });
    alerts = [];
    changes = 0;
    mon.addEventListener('alert', (e) => alerts.push(e.detail));
    mon.addEventListener('change', () => changes++);
});

/** Feed `secs` 1 Hz frames; egtAt(t) gives EGT1-4 at second t since the call. */
function run(secs, rpm, egtAt, extra) {
    for (let t = 0; t < secs; t++) {
        client.emit('engine:data', frame(rpm, typeof egtAt === 'function' ? egtAt(t) : egtAt, extra));
        clock += 1;
    }
}

const HOT = [1200, 1180, 1210, 1190];
const COLD3 = [1200, 1180, 300, 1190];   // cyl 3 at 25% of the others

/** Engine start: one frame at 1000 RPM with cold EGTs (detects the start). */
function start() { run(1, 1000, [80, 80, 80, 80]); }

describe('StickyValveMonitor — the Pi rule', () => {
    it('a normal start, all cylinders heating together, never alerts', () => {
        start();
        run(600, 1000, (t) => HOT.map(v => Math.min(v, 80 + t * 4)));
        expect(alerts).toEqual([]);
        expect(mon.state.visible).toBe(false);
    });

    it('a cylinder below 50% of the others alerts after 30 s, not before', () => {
        start();
        run(30, 1000, COLD3);          // low at t=0..29 -> 29 s elapsed
        expect(alerts).toEqual([]);
        run(1, 1000, COLD3);           // t=30 -> 30 s
        expect(alerts.map(a => a.cyl)).toEqual([3]);
        expect(alerts[0]).toMatchObject({ egt: 300, othersAvg: 1190, recovered: false });
        expect(mon.state).toMatchObject({ visible: true, cylinders: [{ cyl: 3 }] });
    });

    it('fires the alert event once per cylinder, not every frame', () => {
        start();
        run(120, 1000, COLD3);
        expect(alerts.length).toBe(1);
    });

    it('the low time must be continuous: 25 s low, back up, 25 s low does not alert', () => {
        start();
        run(25, 1000, COLD3);
        run(1, 1000, HOT);
        run(25, 1000, COLD3);
        expect(alerts).toEqual([]);
    });

    it('exactly 50% is not low', () => {
        start();
        run(60, 1000, [1000, 1000, 500, 1000]);
        expect(alerts).toEqual([]);
    });

    it('does nothing until the others average 200°F', () => {
        start();
        run(60, 1000, [190, 190, 20, 190]);
        expect(alerts).toEqual([]);
    });

    it('does not look after the 10-minute warm-up window', () => {
        start();
        run(10 * 60, 1000, HOT);
        run(120, 1000, COLD3);
        expect(alerts).toEqual([]);
    });

    it('an alert found in warm-up stays after the window closes', () => {
        start();
        run(9 * 60 + 20, 1000, HOT);
        run(60, 1000, COLD3);          // alerts at ~9:50, still low when the window closes at 10:00
        expect(alerts.map(a => a.cyl)).toEqual([3]);
        run(300, 2400, HOT);           // back up after the window: not a warm-up recovery
        expect(mon.state.visible).toBe(true);
        expect(mon.state.cylinders[0].recovered).toBe(false);
    });

    it('a cylinder that recovers in warm-up stays on the banner, marked recovered', () => {
        start();
        run(40, 1000, COLD3);
        run(5, 1000, HOT);
        expect(mon.state).toMatchObject({ visible: true, cylinders: [{ cyl: 3, recovered: true }] });
        expect(StickyValveMonitor.describe(mon.state.cylinders[0])).toMatch(/CYL 3 .*recovered/);
    });

    it('two cylinders low are both reported', () => {
        start();
        run(40, 1000, [1200, 300, 300, 1190]);
        expect(alerts.map(a => a.cyl).sort()).toEqual([2, 3]);
        expect(mon.state.cylinders.map(c => c.cyl)).toEqual([2, 3]);
    });
});

describe('StickyValveMonitor — dismiss and restart', () => {
    it('DISMISS hides it; the same cylinder staying low does not bring it back', () => {
        start();
        run(40, 1000, COLD3);
        mon.dismiss();
        expect(mon.state.visible).toBe(false);
        run(60, 1000, COLD3);
        expect(mon.state.visible).toBe(false);
        expect(alerts.length).toBe(1);
    });

    it('a cylinder that recovered and goes low again shows it again, with a new alert', () => {
        start();
        run(40, 1000, COLD3);
        mon.dismiss();
        run(5, 1000, HOT);
        expect(mon.state.cylinders[0].recovered).toBe(true);
        run(31, 1000, COLD3);
        expect(mon.state).toMatchObject({ visible: true, cylinders: [{ cyl: 3, recovered: false }] });
        expect(alerts.map(a => a.cyl)).toEqual([3, 3]);
    });

    it('a different cylinder alerting after DISMISS shows it again', () => {
        start();
        run(40, 1000, COLD3);
        mon.dismiss();
        run(40, 1000, [300, 1180, 1200, 1190]);
        expect(mon.state.visible).toBe(true);
        expect(alerts.map(a => a.cyl)).toEqual([3, 1]);
    });

    it('stopping the engine keeps the alert; the next start clears it and watches again', () => {
        start();
        run(40, 1000, COLD3);
        run(35, 0, [80, 80, 80, 80]);   // a real shutdown: RPM below 300 for 30 s+
        expect(mon.state.visible).toBe(true);
        start();
        expect(mon.state).toEqual({ visible: false, cylinders: [] });
        run(31, 1000, COLD3);
        expect(mon.state.visible).toBe(true);
    });

    it('a second start after a long first run is still watched (the Pi missed this one)', () => {
        start();
        run(30 * 60, 2400, HOT);       // past the warm-up window
        run(35, 0, [300, 300, 300, 300]);
        start();
        run(31, 1000, COLD3);
        expect(alerts.map(a => a.cyl)).toEqual([3]);
    });
});

describe('StickyValveMonitor — RPM dropouts with the engine running', () => {
    // Recorded EDM data on this airframe shows RPM reading 0 for 1-13 s while the
    // engine runs (EGTs stay hot), mostly around 1700 RPM -- likely the mag check.
    // The Pi treated each as stop + restart, which cleared an alert at run-up.
    const RUNUP = [1250, 1210, 1240, 1230];

    it('a 13 s RPM-0 dropout at run-up keeps the warning', () => {
        start();
        run(40, 1000, COLD3);
        run(13, 0, [1250, 1210, 400, 1230]);
        run(30, 1700, [1250, 1210, 400, 1230]);
        expect(mon.state).toMatchObject({ visible: true, cylinders: [{ cyl: 3 }] });
        expect(alerts.length).toBe(1);
    });

    it('a dismissed warning stays dismissed through the dropout', () => {
        start();
        run(40, 1000, COLD3);
        mon.dismiss();
        run(13, 0, [1250, 1210, 400, 1230]);   // still cold through the dropout
        run(60, 1700, [1250, 1210, 400, 1230]);
        expect(mon.state.visible).toBe(false);
    });

    it('a dropout does not restart the 10-minute window', () => {
        start();
        run(9 * 60, 1000, HOT);
        run(10, 0, RUNUP);
        run(2 * 60, 1700, [1250, 1210, 400, 1230]);   // cold from 9:10 to 11:10
        // Only 9:10-10:00 is inside the window: 50 s low -> alerts within it.
        expect(alerts.map(a => a.cyl)).toEqual([3]);
        // ...but a cylinder going cold only after 10:00 is not looked at.
        const late = new StickyValveMonitor(null, { now: () => clock * 1000 });
        late.feed(frame(1000, [80, 80, 80, 80]));
        for (let t = 0; t < 9 * 60 + 50; t++) { clock += 1; late.feed(frame(1000, HOT)); }
        for (let t = 0; t < 10; t++) { clock += 1; late.feed(frame(0, RUNUP)); }
        for (let t = 0; t < 90; t++) { clock += 1; late.feed(frame(1700, [1250, 1210, 400, 1230])); }
        expect(late.state.visible).toBe(false);
    });

    it('the dropout seconds still count toward the 30 s: the EGTs in them are real', () => {
        start();
        run(20, 1000, COLD3);
        run(5, 0, COLD3);
        run(5, 1700, COLD3);
        expect(alerts).toEqual([]);
        run(1, 1700, COLD3);            // 30 s since it went low
        expect(alerts.map(a => a.cyl)).toEqual([3]);
    });

    it('repeated mag-check dropouts every 20 s do not hold the alert off', () => {
        start();
        for (let k = 0; k < 3; k++) { run(17, 1700, COLD3); run(3, 0, COLD3); }
        expect(alerts.map(a => a.cyl)).toEqual([3]);
    });
});

describe('StickyValveMonitor — bad or missing data', () => {
    it('an EGT of 0 is a reading, as on the Pi: a dead cylinder may well read 0', () => {
        start();
        run(31, 1000, [1200, 1180, 0, 1190]);
        expect(alerts).toMatchObject([{ cyl: 3, egt: 0, othersAvg: 1190 }]);
    });

    it('a missing EGT value is skipped: the other three are still compared', () => {
        start();
        run(31, 1000, [1200, 400, null, 1190]);
        expect(alerts).toMatchObject([{ cyl: 2, egt: 400, othersAvg: 1195 }]);
    });

    it('with fewer than 3 EGT values it does not judge', () => {
        start();
        run(60, 1000, [1200, null, 300, null]);
        expect(alerts).toEqual([]);
    });

    it('time with the engine too cold to judge does not count toward the 30 s', () => {
        start();
        run(10, 1000, [400, 400, 100, 400]);   // low, judged
        run(40, 1000, [150, 150, 20, 150]);    // average under 200: not judged
        run(5, 1000, [400, 400, 100, 400]);
        expect(alerts).toEqual([]);
        run(26, 1000, [400, 400, 100, 400]);   // 30 s of judged low time
        expect(alerts.map(a => a.cyl)).toEqual([3]);
    });

    it('a few seconds with no frames at all break the 30 s', () => {
        start();
        run(20, 1000, COLD3);
        clock += 6;                            // nothing arrives for 6 s, no stale event yet
        run(20, 1000, COLD3);
        expect(alerts).toEqual([]);
    });

    it('frames whose EDM row is stale (serial_warning) break the 30 s', () => {
        start();
        run(20, 1000, COLD3);
        run(5, 1000, COLD3, { serial_warning: 'No data from EDM for 6s' });
        run(20, 1000, COLD3);
        expect(alerts).toEqual([]);
        run(11, 1000, COLD3);           // 30 s of current data since the gap
        expect(alerts.map(a => a.cyl)).toEqual([3]);
    });

    it('engine:stale and engine:disconnect break the 30 s', () => {
        start();
        run(20, 1000, COLD3);
        client.emit('engine:stale', { stale: true });
        run(20, 1000, COLD3);
        client.emit('engine:disconnect');
        run(20, 1000, COLD3);
        expect(alerts).toEqual([]);
    });

    it('Pi and EDM powered off at shutdown: the next start, already running when data returns, is watched', () => {
        start();
        run(40, 1000, COLD3);
        mon.dismiss();
        run(10, 1000, HOT);                    // recovered; then master off -- no frames
        clock += 40 * 60;
        run(32, 1000, COLD3);                  // first frame back (engine already running) is the start
        expect(alerts.map(a => a.cyl)).toEqual([3, 3]);
        expect(mon.state.visible).toBe(true);
    });

    it('a Pi dropout longer than 30 s does not clear an unacknowledged warning', () => {
        start();
        run(40, 1000, COLD3);
        clock += 60;                           // WiFi lost for a minute
        run(10, 2400, HOT);
        expect(mon.state).toMatchObject({ visible: true, cylinders: [{ cyl: 3 }] });
    });

    it('a clock stepping backwards is treated as a gap, not as time running', () => {
        start();
        run(20, 1000, COLD3);
        clock -= 100;
        run(20, 1000, COLD3);
        expect(alerts).toEqual([]);
    });

    it('a frame with no RPM is a gap, not an engine stop', () => {
        start();
        run(40, 1000, COLD3);
        client.emit('engine:data', { api_contract: 2, data: {} });
        expect(mon.detector.engineStart).not.toBeNull();
        expect(mon.state.visible).toBe(true);
    });
});

// TEMPORARY until Task 7/9 replace the old classes: the legacy config shim, seen through the monitor.
// StickyValve.config() itself is gone; the new override logic is tested in sticky-valve-spec.test.js.
describe('legacy monitor config (cockpit overrides)', () => {
    it('defaults are the Pi constants', () => {
        expect(new StickyValveMonitor().detector.cfg).toMatchObject({ warmupMin: 10, egtRatio: 0.5, minEgt: 200, persistSec: 30 });
    });

    it('reads cockpit-config.json enginePage.stickyValveThresholdPct / WindowMinutes', () => {
        globalThis.CockpitConfig = { get: (p) => (p === 'enginePage' ? { stickyValveThresholdPct: 40, stickyValveWindowMinutes: 15 } : undefined) };
        expect(new StickyValveMonitor().detector.cfg).toMatchObject({ egtRatio: 0.4, warmupMin: 15 });
    });

    it('the shipped config keeps the Pi values', () => {
        const ep = JSON.parse(read('web/cockpit-config.json')).enginePage;
        globalThis.CockpitConfig = { get: (p) => (p === 'enginePage' ? ep : undefined) };
        expect(new StickyValveMonitor().detector.cfg).toMatchObject({ egtRatio: 0.5, warmupMin: 10 });
    });
});


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
