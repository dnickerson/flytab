/**
 * Sticky valve detection on the tablet (web/shared/sticky-valve.js).
 *
 * The rule is the Pi's old check_sticky_valve(): during the first 10 minutes
 * after start, a cylinder whose EGT stays below 50% of the other three's
 * average for 30 s alerts, once the engine is making heat (>= 200°F).
 * Frames are fed the way engine-client.js dispatches them: the Pi's
 * /api/status with the EDM row nested under `data`.
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

describe('StickyValve.config', () => {
    it('defaults are the Pi constants', () => {
        expect(StickyValve.config()).toMatchObject({ warmupMin: 10, egtRatio: 0.5, minEgt: 200, persistSec: 30 });
    });

    it('reads cockpit-config.json enginePage.stickyValveThresholdPct / WindowMinutes', () => {
        globalThis.CockpitConfig = { get: (p) => (p === 'enginePage' ? { stickyValveThresholdPct: 40, stickyValveWindowMinutes: 15 } : undefined) };
        expect(StickyValve.config()).toMatchObject({ egtRatio: 0.4, warmupMin: 15 });
    });

    it('the shipped config keeps the Pi values', () => {
        const ep = JSON.parse(read('web/cockpit-config.json')).enginePage;
        globalThis.CockpitConfig = { get: (p) => (p === 'enginePage' ? ep : undefined) };
        expect(StickyValve.config()).toMatchObject({ egtRatio: 0.5, warmupMin: 10 });
    });
});

describe('StickyValveDetector', () => {
    it('is usable on its own (no DOM, no clock)', () => {
        const d = new StickyValveDetector();
        d.sample(1000, [80, 80, 80, 80], 0);
        for (let t = 1; t <= 31; t++) d.sample(1000, COLD3, t);
        expect(d.alert).toBe(3);
    });
});
