/**
 * Extra logbook entries and missing Engine ML summaries (#188), seen on the
 * tablet 2026-10-28.
 *
 * 10-27 14:46:50Z, taxiing in at KTBR: the Pi and Stratux lost power with the
 * last engine sample at 890 RPM. lastData keeps that reading, so 10 s after the
 * 2-min data-gap stop the recorder "saw" 890 RPM again and started a new
 * recording: five empty ones (header only), 130 s apart, each a logbook entry.
 *
 * #188: since KeepAliveWebView the page never fires visibilitychange, so the
 * screen-off stop didn't run; a recording ended by a reboot (10-22, clearing
 * ExpressVPN) was closed out at the next launch, where the ML log is empty, and
 * the entry had no Engine ML summary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({ rpmStopThreshold: 0, stopDelaySeconds: 60 }), aircraft: () => null };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const EngineMLBridge = new Function(read('web/cockpit/engine-ml.js') + '\nreturn EngineMLBridge;')();
const Logbook = new Function(read('web/cockpit/logbook.js') + '\nreturn Logbook;')();
global.EngineMLBridge = EngineMLBridge;

const BASE = 'http://localhost:9090/flights/';
const KEY = FlightRecorder.ACTIVE_KEY;
const T0 = Date.parse('2026-10-27T14:40:00Z');

function server() {
    const store = new Map();
    const fetch = vi.fn(async (url, opts = {}) => {
        const name = url.replace(BASE, '');
        const m = opts.method || 'GET';
        if (m === 'GET') return store.has(name) ? { ok: true, status: 200, text: async () => store.get(name) } : { ok: false, status: 404, text: async () => '' };
        if (m === 'PUT') { store.set(name, (opts.headers?.['X-Append'] === 'true' ? (store.get(name) || '') : '') + opts.body); return { ok: true, status: 201, text: async () => 'OK' }; }
        if (m === 'DELETE') { store.delete(name); return { ok: true, status: 200, text: async () => '' }; }
    });
    return { store, fetch };
}

/** Engine monitor whose last reading is `rpm`, received `ageMs` ago (both changeable). */
function engine(rpm, ageMs) {
    const e = { rpm, ageMs };
    return {
        e,
        client: {
            get lastData() { return { data: { RPM: e.rpm } }; },
            get dataAge() { return e.ageMs; },
        },
    };
}

const counts = (over = {}) => ({
    samples: 600, duration_s: 600, anomaly_count: 6, latency_sum_ms: 840, latency_n: 600,
    phases: { taxi_in: 300, shutdown: 300 }, advisory_count: 1, ...over,
});

describe('auto-start needs fresh engine data', () => {
    let events;
    const onEvt = (ev) => events.push(ev.type);
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(T0);
        localStorage.clear(); events = [];
        global.fetch = server().fetch;
        window.addEventListener('flightsync:started', onEvt);
        window.addEventListener('flightsync:stopped', onEvt);
    });
    afterEach(() => {
        window.removeEventListener('flightsync:started', onEvt);
        window.removeEventListener('flightsync:stopped', onEvt);
        vi.useRealTimers();
    });

    it('a stale 890 RPM reading never starts a recording', async () => {
        const { client } = engine(890, 60_000);
        const rec = new FlightRecorder(client, { situation: null }, null);
        rec.init();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(rec.recording).toBe(false);
        expect(events).toEqual([]);
        rec.destroy();
    });

    it('10 s of fresh RPM >= 500 still starts one', async () => {
        const { client } = engine(1020, 500);
        const rec = new FlightRecorder(client, { situation: null }, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        await vi.advanceTimersByTimeAsync(9_000);
        expect(rec.recording).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('engine monitor silent but GPS fresh at 140 kt (in flight): ground speed starts the recording', async () => {
        const { client } = engine(2400, 60_000);
        const sit = { ground_speed: 140, lat: 34.7, lon: -80.8, gps_fix_quality: 2 };
        const stratux = { get situation() { return { ...sit, timestamp: Date.now() - 200 }; }, traffic: new Map() };
        const rec = new FlightRecorder(client, stratux, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    // Review 2026-10-29: the Pi sends its status every second whether or not the
    // EMS serial line delivers, so "fresh" has to mean the readings are moving.
    const frozen = (rpm) => ({ lastData: { data: { RPM: rpm } }, dataAge: 300, readingAge: 60_000 });
    const gpsAt = (gs) => {
        const sit = { ground_speed: gs, lat: 34.7, lon: -80.8, gps_fix_quality: 2 };
        return { get situation() { return { ...sit, timestamp: Date.now() - 200 }; }, traffic: new Map() };
    };

    it('EMS serial line dead, Pi up (RPM 0, not moving): ground speed 140 kt starts the recording', async () => {
        const rec = new FlightRecorder(frozen(0), gpsAt(140), null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('readings frozen at 2400 RPM after landing: ground speed stops the recording', async () => {
        const eng = { lastData: { data: { RPM: 2400 } }, dataAge: 300, readingAge: 300 };
        const stratux = gpsAt(140);
        const rec = new FlightRecorder(eng, stratux, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        eng.readingAge = 60_000;                              // serial line lost; Pi still sends 2400
        Object.defineProperty(stratux, 'situation', { get: () => ({ ground_speed: 0, lat: 34.7, lon: -80.8, gps_fix_quality: 2, timestamp: Date.now() - 200 }) });
        await vi.advanceTimersByTimeAsync(59_000);
        expect(rec.recording).toBe(true);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(rec.recording).toBe(false);
        rec.destroy();
    });

    it('readings moving at 2400 RPM, standing still (run-up): the recording goes on', async () => {
        const eng = { lastData: { data: { RPM: 2400 } }, dataAge: 300, readingAge: 300 };
        const rec = new FlightRecorder(eng, gpsAt(0), null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('replay of 10-27 14:46:50Z: link lost at 890 RPM -> one gap stop, no empty recordings after it', async () => {
        const { e, client } = engine(890, 500);
        const rec = new FlightRecorder(client, { situation: null }, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        await vi.advanceTimersByTimeAsync(11_000);          // taxiing in, recording
        expect(rec.recording).toBe(true);

        const lostAt = Date.now();                          // Pi and Stratux power off
        Object.defineProperty(e, 'ageMs', { get: () => Date.now() - lostAt + 500 });
        await vi.advanceTimersByTimeAsync(15 * 60_000);

        expect(rec.recording).toBe(false);
        expect(events).toEqual(['flightsync:started', 'flightsync:stopped']);
        rec.destroy();
    });
});

describe('screen-off stop counts 0 RPM through _autoMonitor (rpmStopThreshold 100, as configured)', () => {
    const screen = (onScreen) => { const ev = new Event('flytab:screen'); ev.onScreen = onScreen; window.dispatchEvent(ev); };
    let saved;
    beforeEach(() => { vi.useFakeTimers(); saved = global.CockpitConfig; global.CockpitConfig = { get: () => ({ rpmStopThreshold: 100, stopDelaySeconds: 60 }) }; });
    afterEach(() => { global.CockpitConfig = saved; vi.useRealTimers(); });
    function running(rpm) {
        const e = { lastData: { data: { RPM: rpm } }, get dataAge() { return 500; } };
        const rec = new FlightRecorder(e, { situation: null }, null);
        rec.init();
        rec._recording = true;
        rec._flush = vi.fn(async () => true);
        rec.stop = vi.fn(async () => { rec._recording = false; });
        return { rec, e };
    }

    it('13 s at 0 RPM (mag check) then screen off -> goes on; 30 s -> ends', () => {
        const { rec, e } = running(2400);
        vi.advanceTimersByTime(5000);
        e.lastData.data.RPM = 0;
        vi.advanceTimersByTime(13000);
        screen(false);
        expect(rec.stop).not.toHaveBeenCalled();
        e.lastData.data.RPM = 1700;                             // engine was running
        vi.advanceTimersByTime(2000);
        e.lastData.data.RPM = 40;                               // shut down (below the 100 threshold)
        vi.advanceTimersByTime(29000);
        screen(false);
        expect(rec.stop).not.toHaveBeenCalled();                // 29 s: the count restarted at 1700 RPM
        vi.advanceTimersByTime(1000);
        screen(false);
        expect(rec.stop).toHaveBeenCalledTimes(1);
        rec.destroy();
    });

    it('start() resets the count: a manual start with the engine off is not ended by the next screen-off', async () => {
        const { rec } = running(0);
        rec._recording = false;
        rec._rpmZeroCount = 45;
        rec._startIntervals = () => {};
        rec._saveMarker = () => {};
        await rec.start();
        expect(rec._rpmZeroCount).toBe(0);
        screen(false);
        expect(rec.stop).not.toHaveBeenCalled();
        rec.destroy();
    });
});

describe("'flytab:screen' off ends a recording on fresh shutdown evidence (#188)", () => {
    const screen = (onScreen) => {
        const ev = new Event('flytab:screen');
        ev.onScreen = onScreen;                             // as Capacitor's triggerWindowJSEvent sets it
        window.dispatchEvent(ev);
    };
    function make(rpm, ageMs) {
        const rec = new FlightRecorder(engine(rpm, ageMs).client, { situation: null }, null);
        rec.init();
        rec._recording = true;
        rec._flush = vi.fn(async () => true);
        rec.stop = vi.fn(async () => { rec._recording = false; });
        return rec;
    }
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('engine stopped (fresh 0 RPM for 30 s), screen off -> stop()', () => {
        const rec = make(0, 800);
        rec._rpmZeroCount = 30;
        screen(false);
        expect(rec._flush).toHaveBeenCalled();
        expect(rec.stop).toHaveBeenCalledTimes(1);
        rec.destroy();
    });

    it('EMS readings frozen (Pi up), landed (GPS 0 kt), screen off -> stop() by ground speed', () => {
        // Re-review 2026-10-29: _onHidden waited for 30 s of fresh 0 RPM that can't come.
        const eng = { lastData: { data: { RPM: 2400 } }, dataAge: 300, readingAge: 60_000 };
        const stx = { get situation() { return { ground_speed: 0, timestamp: Date.now() - 200 }; } };
        const rec = new FlightRecorder(eng, stx, null);
        rec.init();
        rec._recording = true;
        rec._flush = vi.fn(async () => true);
        rec.stop = vi.fn(async () => { rec._recording = false; });
        expect(rec._shutdownEvidenceNow()).toBe(true);           // the marker's shutdown flag too
        screen(false);
        expect(rec.stop).toHaveBeenCalledTimes(1);
        rec.destroy();
    });

    it('EMS readings frozen, still flying (GPS 140 kt), screen off -> recording goes on', () => {
        const eng = { lastData: { data: { RPM: 0 } }, dataAge: 300, readingAge: 60_000 };
        const stx = { get situation() { return { ground_speed: 140, timestamp: Date.now() - 200 }; } };
        const rec = new FlightRecorder(eng, stx, null);
        rec.init();
        rec._recording = true;
        rec._flush = vi.fn(async () => true);
        rec.stop = vi.fn(async () => { rec._recording = false; });
        screen(false);
        expect(rec.stop).not.toHaveBeenCalled();
        rec.destroy();
    });

    it('fresh 0 RPM for only 13 s (mag check), screen off -> recording goes on', () => {
        const rec = make(0, 800);
        rec._rpmZeroCount = 13;
        screen(false);
        expect(rec._flush).toHaveBeenCalled();
        expect(rec.stop).not.toHaveBeenCalled();
        rec.destroy();
    });

    it('in cruise, screen off -> rows saved, recording goes on', () => {
        const rec = make(2400, 800);
        screen(false);
        expect(rec._flush).toHaveBeenCalled();
        expect(rec.stop).not.toHaveBeenCalled();
        rec.destroy();
    });

    it('stale 0 RPM (link lost) is not evidence', () => {
        const rec = make(0, 30_000);
        screen(false);
        expect(rec.stop).not.toHaveBeenCalled();
        rec.destroy();
    });

    it('screen on does nothing; after destroy() the listener is gone', () => {
        const rec = make(0, 800);
        screen(true);
        expect(rec._flush).not.toHaveBeenCalled();
        rec.destroy();                                      // stops the recording itself
        rec.stop.mockClear();
        rec._recording = true;
        screen(false);
        expect(rec.stop).not.toHaveBeenCalled();
    });
});

describe('Engine ML counts travel with the recording (#188)', () => {
    let stopped;
    const onStop = (ev) => stopped.push(ev.detail);
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(T0);
        localStorage.clear(); stopped = [];
        window.addEventListener('flightsync:stopped', onStop);
    });
    afterEach(() => {
        window.removeEventListener('flightsync:stopped', onStop);
        vi.useRealTimers();
    });

    function make(srv) {
        global.fetch = srv.fetch;
        const rec = new FlightRecorder(engine(2400, 500).client, { situation: null, traffic: new Map() }, null);
        rec._renameWithRoute = vi.fn(async () => null);
        return rec;
    }

    it('the marker holds the counts so far; stop() sends them', async () => {
        const rec = make(server());
        let c = counts({ samples: 5 });
        rec.mlCounts = () => c;
        await rec.start();
        expect(JSON.parse(localStorage.getItem(KEY)).ml).toEqual(c);
        c = counts();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(JSON.parse(localStorage.getItem(KEY)).ml).toEqual(c);
        await rec.stop();
        expect(stopped[0].mlCounts).toEqual(c);
    });

    it('replay of 10-22: rebooted before the stop; next launch closes it out WITH the counts', async () => {
        const srv = server();
        srv.store.set('20261022_1316Z.csv', FlightRecorder.CSV_HEADER + '\nrow\n');
        localStorage.setItem(KEY, JSON.stringify({
            fileName: '20261022_1316Z.csv', trafficFileName: null, startTime: T0 - 3 * 3600_000,
            firstGps: null, lastGps: null, rowCount: 1, savedAt: T0 - 20 * 3600_000, shutdown: true, ml: counts(),
        }));
        const rec = make(srv);
        rec.mlCounts = () => counts({ samples: 3, phases: { startup: 3 } });   // this session's: not that flight's
        expect(await rec.recoverUnfinished()).toBe('closed');
        expect(stopped[0].mlCounts).toEqual(counts());
        expect(stopped[0].closedOut).toBe(true);
    });

    it('resumed after a restart: the two parts are added', async () => {
        const srv = server();
        srv.store.set('20261022_1316Z.csv', FlightRecorder.CSV_HEADER + '\nrow\n');
        localStorage.setItem(KEY, JSON.stringify({
            fileName: '20261022_1316Z.csv', trafficFileName: null, startTime: T0 - 3600_000,
            firstGps: null, lastGps: null, rowCount: 1, savedAt: T0 - 10_000, shutdown: false, ml: counts(),
        }));
        const rec = make(srv);
        rec.mlCounts = () => ({ samples: 100, duration_s: 100, anomaly_count: 1, latency_sum_ms: 150, latency_n: 100, phases: { cruise: 100 }, advisory_count: 0 });
        expect(await rec.recoverUnfinished()).toBe('resumed');
        await rec.stop();
        expect(stopped[0].mlCounts).toEqual({
            samples: 700, duration_s: 700, anomaly_count: 7, latency_sum_ms: 990, latency_n: 700,
            phases: { taxi_in: 300, shutdown: 300, cruise: 100 }, advisory_count: 1,
        });
    });

    it('bad counts in a marker are dropped, the marker itself still works', () => {
        const base = { fileName: 'a.csv', startTime: 1, savedAt: 2 };
        expect(FlightRecorder.parseMarker(JSON.stringify({ ...base, ml: counts() })).ml).toEqual(counts());
        expect(FlightRecorder.parseMarker(JSON.stringify(base)).ml).toBeNull();
        expect(FlightRecorder.parseMarker(JSON.stringify({ ...base, ml: { ...counts(), samples: 'x' } })).ml).toBeNull();
        expect(FlightRecorder.parseMarker(JSON.stringify({ ...base, ml: { ...counts(), samples: 0 } })).ml).toBeNull();
        expect(FlightRecorder.parseMarker(JSON.stringify({ ...base, ml: counts({ phases: { cruise: 5, '<img>': 1, climb: -1 } }) })).ml.phases)
            .toEqual({ cruise: 5 });
    });

    it('no ML at all: mlCounts null, nothing breaks', async () => {
        const rec = make(server());
        rec.mlCounts = () => { throw new Error('no plugin'); };
        await rec.start();
        await rec.stop();
        expect(stopped[0].mlCounts).toBeNull();
    });
});

describe('EngineMLBridge counts -> summary', () => {
    it('getFlightSummary() is summaryFromCounts(getFlightCounts()), same fields as before', () => {
        const b = new EngineMLBridge();
        b._log = [
            { t: 1, ph: 'taxi_out', sc: 0.01, an: 0, lt: 1 },
            { t: 2, ph: 'runup', sc: 0.2, an: 1, lt: 2 },
            { t: 3, ph: 'runup', sc: 0.3, an: 1, lt: null },
            { t: 4, ph: 'shutdown', sc: 0.01, an: 0, lt: 3 },
        ];
        b._advisoryLog = [{}, {}];
        expect(b.getFlightSummary()).toEqual({
            samples: 4, duration_s: 4, anomaly_count: 2, anomaly_pct: 50, avg_latency_ms: 2,
            phase_dist: { taxi_out: 25, runup: 50, shutdown: 25 }, advisory_count: 2,
        });
        b._log = [];
        expect(b.getFlightSummary()).toBeNull();
        expect(EngineMLBridge.summaryFromCounts(null)).toBeNull();
    });
});

describe('Logbook entry from the stopped event', () => {
    function fakeLogbook() {
        return {
            _nasrDb: { getAirport: async () => null },
            _getRouteString: async () => '',
            _trackHobbs: false,
            _defaultConditions: 'VFR',
            _saveEntry: vi.fn(async () => {}),
            _saveMLLog: vi.fn(async () => {}),
        };
    }
    afterEach(() => { delete window.engineML; });

    it('a closed-out recording gets its summary from the counts', async () => {
        window.engineML = { getFlightSummary: () => null, clearLog: () => {} };     // empty: new session
        const entry = await Logbook.prototype.createEntry.call(fakeLogbook(), '20261022_KLKR-KORL.csv', {
            depIcao: 'KLKR', destIcao: 'KORL', startTime: '2026-10-22T13:16:00Z', endTime: '2026-10-22T16:13:00Z',
            durationHours: 2.95, mlCounts: counts(),
        });
        expect(entry.custom_fields.engineml_summary).toEqual({
            samples: 600, duration_s: 600, anomaly_count: 6, anomaly_pct: 1, avg_latency_ms: 1,
            phase_dist: { taxi_in: 50, shutdown: 50 }, advisory_count: 1,
        });
    });

    it('closed out while the next flight is recording: its ML log is neither taken nor cleared', async () => {
        // Review 2026-10-29: relaunched in flight >10 min after a crash, the new
        // recording starts as the close-out ends; the old entry took its samples
        // and then cleared them.
        const live = { samples: 5 };
        const clearLog = vi.fn();
        window.engineML = { getFlightSummary: () => live, clearLog };
        const lb = fakeLogbook();
        const entry = await Logbook.prototype.createEntry.call(lb, '20261022_1316Z.csv', { closedOut: true, mlCounts: null });
        expect(entry.custom_fields.engineml_summary).toBeUndefined();     // rebuilt from the CSV later
        expect(lb._saveMLLog).not.toHaveBeenCalled();
        expect(clearLog).not.toHaveBeenCalled();
        const withCounts = await Logbook.prototype.createEntry.call(lb, '20261022_1316Z.csv', { closedOut: true, mlCounts: counts() });
        expect(withCounts.custom_fields.engineml_summary.samples).toBe(600);
        expect(clearLog).not.toHaveBeenCalled();
    });

    it('a normal stop saves and clears the live ML log', async () => {
        const clearLog = vi.fn();
        window.engineML = { getFlightSummary: () => null, clearLog };
        const lb = fakeLogbook();
        await Logbook.prototype.createEntry.call(lb, '20261027_1221Z.csv', { closedOut: false, mlCounts: counts() });
        expect(lb._saveMLLog).toHaveBeenCalledTimes(1);
        expect(clearLog).toHaveBeenCalledTimes(1);
    });

    it('no counts in the event: as before, from the live ML log', async () => {
        const live = { samples: 1 };
        window.engineML = { getFlightSummary: () => live, clearLog: () => {} };
        const entry = await Logbook.prototype.createEntry.call(fakeLogbook(), '20261027_1221Z.csv', { depIcao: 'KORL', destIcao: 'KTBR' });
        expect(entry.custom_fields.engineml_summary).toBe(live);
    });

    it('screen off: the entry is written at once, not after the 2 s delay', () => {
        vi.useFakeTimers();
        const lb = { _onScreen: false, createEntry: vi.fn(async () => ({})) };
        Logbook.prototype._onCaptureStopped.call(lb, { csvFilename: 'x.csv' });
        expect(lb.createEntry).toHaveBeenCalledTimes(1);
        lb._onScreen = true;
        Logbook.prototype._onCaptureStopped.call(lb, { csvFilename: 'y.csv' });
        expect(lb.createEntry).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2000);
        expect(lb.createEntry).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});

describe("home Stratux: no recording while connected to it (10-18 bench test)", () => {
    const HOME = '192.168.1.212';
    let started;
    const onStart = () => started++;
    /** Stratux at `ip`, its last situation `ageMs` old at `gs` kt (a moving fix like 10-18's). */
    function stratux(ip, gs, ageMs = 200) {
        return {
            ip,
            homeMode: ip === HOME ? 'home' : 'off',
            get situation() { return { ground_speed: gs, lat: 34.8927, lon: -80.8419, gps_fix_quality: 1, timestamp: Date.now() - ageMs }; },
            traffic: new Map(),
        };
    }
    function make(eng, strat) {
        const rec = new FlightRecorder(eng, strat, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec.init();
        return rec;
    }
    const noEngine = { lastData: null, get dataAge() { return Infinity; } };
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(T0);
        localStorage.clear(); started = 0; DiagLog.log.mockClear();
        global.fetch = server().fetch;
        global.Settings = { homeStratuxIp: HOME, homeStratuxNoRecord: true };
        window.addEventListener('flightsync:started', onStart);
    });
    afterEach(() => {
        window.removeEventListener('flightsync:started', onStart);
        delete global.Settings;
        vi.useRealTimers();
    });

    it('replay of 10-18: home Stratux reporting 90 kt standing still -> nothing recorded, logged once', async () => {
        const rec = make(noEngine, stratux(HOME, 92));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(started).toBe(0);
        expect(rec.recording).toBe(false);
        const lines = DiagLog.log.mock.calls.filter(([, m]) => /home Stratux/.test(m));
        expect(lines).toHaveLength(1);
        expect(lines[0][1]).toContain(HOME);
        rec.destroy();
    });

    it('setting off -> the GPS rule records as before', async () => {
        Settings.homeStratuxNoRecord = false;
        const rec = make(noEngine, stratux(HOME, 92));
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('in-flight Stratux address -> the GPS rule records as before', async () => {
        const rec = make(noEngine, stratux('192.168.10.1', 140));
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('an engine running (fresh RPM >= 500) is recorded even on the home Stratux', async () => {
        const rec = make(engine(1020, 500).client, stratux(HOME, 0));
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('home address left set in flight: nothing arrives from it, the engine starts the recording', async () => {
        const rec = make(engine(2400, 500).client, { ip: HOME, homeMode: 'home', situation: null, traffic: new Map() });
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('Home Stratux IP set to the in-flight address, switch off -> the GPS rule records', async () => {
        Settings.homeStratuxIp = '192.168.10.1';
        const rec = make(noEngine, stratux('192.168.10.1', 140));        // homeMode 'off'
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });

    it('blank home address -> the setting does nothing', async () => {
        Settings.homeStratuxIp = '';
        const rec = make(noEngine, stratux('', 92));
        await vi.advanceTimersByTimeAsync(11_000);
        expect(rec.recording).toBe(true);
        rec.destroy();
        await vi.advanceTimersByTimeAsync(0);
    });
});
