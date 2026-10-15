/**
 * PR A critical-review fixes for the flight recorder (A9, 2026-10-14).
 *  #1  start() during stop(): stop() awaits saves, NASR and the rename (10+ s);
 *      an auto-start meanwhile replaced _fileName/_csvBuffer/_lastGps and the old
 *      flight's rename and stopped event used the NEW recording.
 *  #2  a resumed recording with no data yet (engine and situation null after a
 *      restart) counted "0 kt" toward the 60 s GPS auto-stop and split the flight.
 *  #5  a recording whose last save already showed the engine stopped must be
 *      closed out, not resumed (else the downtime goes into flight time / Hobbs).
 * #13  a failed final save: retried, and the rename skipped if it still fails.
 * #14  recovery that can't check the old file retries before giving up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({ rpmStopThreshold: 0, stopDelaySeconds: 60 }) };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const BASE = 'http://localhost:9090/flights/';
const KEY = FlightRecorder.ACTIVE_KEY;

function server(files = {}, { failPut = () => false, holdGet = () => false, statusErrors = 0 } = {}) {
    const store = new Map(Object.entries(files));
    const held = [];
    let errorsLeft = statusErrors;
    const fetch = vi.fn((url, opts = {}) => {
        const name = url.replace(BASE, '');
        const m = opts.method || 'GET';
        if (m === 'GET') {
            if (errorsLeft > 0) { errorsLeft--; return Promise.resolve({ ok: false, status: 500, text: async () => 'err' }); }
            const answer = () => (store.has(name) ? { ok: true, status: 200, text: async () => store.get(name) } : { ok: false, status: 404, text: async () => '' });
            if (holdGet(name)) return new Promise((res) => held.push(() => res(answer())));
            return Promise.resolve(answer());
        }
        if (m === 'PUT') {
            if (failPut(name)) return Promise.resolve({ ok: false, status: 500 });
            store.set(name, (opts.headers?.['X-Append'] === 'true' ? (store.get(name) || '') : '') + opts.body);
            return Promise.resolve({ ok: true, status: 201 });
        }
        if (m === 'DELETE') { store.delete(name); return Promise.resolve({ ok: true, status: 200 }); }
    });
    return { store, fetch, held };
}

const T0 = Date.parse('2026-10-14T15:55:00Z');

describe('recorder review fixes', () => {
    let events;
    const onEvt = (e) => events.push({ type: e.type, detail: e.detail });
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        localStorage.clear();
        DiagLog.log.mockClear();
        events = [];
        window.addEventListener('flightsync:started', onEvt);
        window.addEventListener('flightsync:stopped', onEvt);
    });
    afterEach(() => {
        window.removeEventListener('flightsync:started', onEvt);
        window.removeEventListener('flightsync:stopped', onEvt);
        vi.useRealTimers();
    });

    it('#1 an auto-start while stop() is renaming waits; the old flight keeps its own name and route', async () => {
        // The rename's free-name check is slow (held); the engine is running.
        let heldOnce = false;    // only the free-name check; the copy's read-back must answer
        const srv = server({}, { holdGet: (n) => n === '20261014_KCDN-KLKR.csv' && !heldOnce && (heldOnce = true) });
        global.fetch = srv.fetch;
        let rpm = 2400;
        const engine = { get lastData() { return { data: { RPM: rpm } }; }, get dataAge() { return 200; } };
        const rec = new FlightRecorder(engine, { situation: null, traffic: new Map() }, {});
        rec._nearestAirport = vi.fn(async (lat) => (lat < 34.8 ? 'KCDN' : 'KLKR'));
        rec.init();
        await rec.start();
        rec._firstGps = { lat: 34.7, lon: -80.8 }; rec._lastGps = { lat: 34.9, lon: -80.6 };
        const oldName = rec.fileName;
        await vi.advanceTimersByTimeAsync(5000);

        const stopping = rec.stop();
        vi.setSystemTime(T0 + 60_000);                    // a minute later: a new start would get a new name
        await vi.advanceTimersByTimeAsync(15_000);        // auto-monitor sees RPM >= 500 for 10+ s
        expect(events.filter((e) => e.type === 'flightsync:started')).toHaveLength(1);   // no second start yet
        srv.held.forEach((f) => f());
        await stopping;

        const stopped = events.find((e) => e.type === 'flightsync:stopped').detail;
        expect(stopped.csvFilename).toBe('20261014_KCDN-KLKR.csv');
        expect(srv.store.has('20261014_KCDN-KLKR.csv')).toBe(true);
        expect(srv.store.has(oldName)).toBe(false);

        await vi.advanceTimersByTimeAsync(2000);          // auto-start goes ahead once stop() is done
        const started = events.filter((e) => e.type === 'flightsync:started');
        expect(started).toHaveLength(2);
        expect(rec.fileName).not.toBe('20261014_KCDN-KLKR.csv');
        expect(rec.recording).toBe(true);
        rec.destroy();
    });

    it('#1 recoverUnfinished() does nothing while a stop is in progress', async () => {
        const srv = server({}, { holdGet: () => true }); global.fetch = srv.fetch;
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null }, null);
        await rec.start();
        const stopping = rec.stop();
        localStorage.setItem(KEY, JSON.stringify({ fileName: 'x.csv', startTime: T0, savedAt: Date.now() }));
        expect(await rec.recoverUnfinished()).toBeNull();
        srv.held.forEach((f) => f());
        await vi.advanceTimersByTimeAsync(30_000);
        await stopping;
    });

    it('#2 a resumed recording is not auto-stopped while no data has arrived yet', async () => {
        const srv = server({ 'r.csv': FlightRecorder.CSV_HEADER + '\n' }); global.fetch = srv.fetch;
        localStorage.setItem(KEY, JSON.stringify({ fileName: 'r.csv', trafficFileName: null, startTime: T0 - 3600_000, savedAt: T0 - 5000, rowCount: 100 }));
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null, traffic: new Map() }, null);
        rec.init();
        expect(await rec.recoverUnfinished()).toBe('resumed');
        await vi.advanceTimersByTimeAsync(90_000);       // 90 s, still no engine or GPS data
        expect(rec.recording).toBe(true);                // the 2-min gap timer is the one that decides
        expect(events.some((e) => e.type === 'flightsync:stopped')).toBe(false);
        rec.destroy();
    });

    it('#2 fresh ground speed under 10 kt still ends a GPS-only recording', async () => {
        global.fetch = server().fetch;
        const sit = { lat: 34.7, lon: -80.8, gps_fix_quality: 2, ground_speed: 3, get timestamp() { return Date.now(); } };
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: sit, traffic: new Map() }, null);
        rec.init();
        await rec.start();
        await vi.advanceTimersByTimeAsync(62_000);
        expect(rec.recording).toBe(false);
        rec.destroy();
    });

    it('#5 the last save showed the engine stopped: close out at that save, do not resume', async () => {
        global.fetch = server({ 'r.csv': FlightRecorder.CSV_HEADER + '\nrow\n' }).fetch;
        const savedAt = T0 - 120_000;                      // 2 min ago: inside the resume window
        localStorage.setItem(KEY, JSON.stringify({ fileName: 'r.csv', trafficFileName: null, startTime: T0 - 3600_000, savedAt, rowCount: 1, shutdown: true }));
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null }, null);
        rec._renameWithRoute = vi.fn(async () => null);
        expect(await rec.recoverUnfinished()).toBe('closed');
        expect(rec.recording).toBe(false);
        expect(events.find((e) => e.type === 'flightsync:stopped').detail.endTime).toBe(new Date(savedAt).toISOString());
    });

    it('#5 the marker records shutdown evidence: fresh 0 RPM -> true, cruise -> false', async () => {
        global.fetch = server().fetch;
        let rpm = 2400;
        const engine = { get lastData() { return { data: { RPM: rpm } }; }, get dataAge() { return 300; } };
        const rec = new FlightRecorder(engine, { situation: null, traffic: new Map() }, null);
        await rec.start();
        await vi.advanceTimersByTimeAsync(5000);
        expect(JSON.parse(localStorage.getItem(KEY)).shutdown).toBe(false);
        rpm = 0;
        await vi.advanceTimersByTimeAsync(5000);
        expect(JSON.parse(localStorage.getItem(KEY)).shutdown).toBe(true);
        rec.destroy();
    });

    it('#13 a final save that fails is retried; still failing -> no rename, rows reported unsaved', async () => {
        let fails = 3;
        const srv = server({}, { failPut: () => fails-- > 0 }); global.fetch = srv.fetch;
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null }, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec._recording = true; rec._fileName = 'a.csv'; rec._csvBuffer = ['r1', 'r2'];
        const p = rec.stop();
        await vi.advanceTimersByTimeAsync(10_000);
        await p;
        expect(rec._renameWithRoute).not.toHaveBeenCalled();
        expect(events.find((e) => e.type === 'flightsync:stopped').detail.flushOk).toBe(false);
        expect(DiagLog.log).toHaveBeenCalledWith('recorder', expect.stringMatching(/2 rows could not be saved/));
    });

    it('#13 a final save that fails once then works: rows saved, rename goes ahead', async () => {
        let fails = 1;
        const srv = server({}, { failPut: () => fails-- > 0 }); global.fetch = srv.fetch;
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null }, null);
        rec._renameWithRoute = vi.fn(async () => null);
        rec._recording = true; rec._fileName = 'a.csv'; rec._csvBuffer = ['r1', 'r2'];
        const p = rec.stop();
        await vi.advanceTimersByTimeAsync(5000);
        await p;
        expect(srv.store.get('a.csv')).toBe('r1\nr2\n');
        expect(rec._renameWithRoute).toHaveBeenCalled();
        expect(events.find((e) => e.type === 'flightsync:stopped').detail.flushOk).toBe(true);
    });

    it('#14 the file server errors at first: recovery retries and resumes', async () => {
        global.fetch = server({ 'r.csv': FlightRecorder.CSV_HEADER + '\n' }, { statusErrors: 2 }).fetch;
        localStorage.setItem(KEY, JSON.stringify({ fileName: 'r.csv', trafficFileName: null, startTime: T0 - 600_000, savedAt: T0 - 5000, rowCount: 1 }));
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null, traffic: new Map() }, null);
        const p = rec.recoverUnfinished();
        await vi.advanceTimersByTimeAsync(5000);
        expect(await p).toBe('resumed');
        rec.destroy();
    });
});
