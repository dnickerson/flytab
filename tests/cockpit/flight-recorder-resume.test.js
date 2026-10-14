/**
 * A restart doesn't split or orphan the flight recording (fix 1, 2026-10-14).
 *
 * 12:11:53 EDT in flight: the WebView renderer crashed and took FlyTab with it.
 * The pilot relaunched 10 s later; the recorder started a NEW file, and the
 * first part (20261014_1555Z.csv, 1,000 rows) was never closed out: no rename,
 * no logbook entry. Now the recorder keeps a marker in localStorage while it
 * records; the next launch carries on in the same file if the marker is recent,
 * else closes that recording out (rename + flightsync:stopped -> logbook).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({ rpmStopThreshold: 0, stopDelaySeconds: 60 }) };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const BASE = 'http://localhost:9090/flights/';
const KEY = FlightRecorder.ACTIVE_KEY;
const T0 = Date.parse('2026-10-14T15:55:00Z');

function server(files = {}) {
    const store = new Map(Object.entries(files));
    const fetch = vi.fn(async (url, opts = {}) => {
        const name = url.replace(BASE, '');
        const m = opts.method || 'GET';
        if (m === 'GET') return store.has(name) ? { ok: true, status: 200, text: async () => store.get(name) } : { ok: false, status: 404, text: async () => '' };
        if (m === 'PUT') { store.set(name, (opts.headers?.['X-Append'] === 'true' ? (store.get(name) || '') : '') + opts.body); return { ok: true, status: 201 }; }
        if (m === 'DELETE') { store.delete(name); return { ok: true, status: 200 }; }
    });
    return { store, fetch };
}

function makeRecorder() {
    const engine = { lastData: { data: { RPM: 2400 } }, get dataAge() { return 500; } };
    const stratux = { situation: null, traffic: new Map() };
    const rec = new FlightRecorder(engine, stratux, null);
    rec._renameWithRoute = vi.fn(async () => null);
    return rec;
}

const marker = (over = {}) => ({
    fileName: '20261014_1555Z.csv', trafficFileName: '20261014_1555Z_traffic.ndjson',
    startTime: T0, firstGps: { lat: 34.7, lon: -80.8, alt: 600 }, lastGps: { lat: 34.9, lon: -80.6, alt: 3500 },
    rowCount: 1000, savedAt: T0 + 16 * 60 * 1000 + 50 * 1000, ...over,
});
const CSV = FlightRecorder.CSV_HEADER + '\n' + 'row\n'.repeat(1000);

describe('FlightRecorder after a restart', () => {
    let events;
    const onEvt = (e) => events.push({ type: e.type, detail: e.detail });
    beforeEach(() => {
        vi.useFakeTimers();
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

    it('start() leaves a marker naming the file, start time and first fix', async () => {
        vi.setSystemTime(T0);
        global.fetch = server().fetch;
        const rec = makeRecorder();
        await rec.start();
        const m = JSON.parse(localStorage.getItem(KEY));
        expect(m.fileName).toBe(rec.fileName);
        expect(m.startTime).toBe(T0);
        expect(m.savedAt).toBe(T0);
        await rec.stop();
    });

    it('the marker is refreshed every 5 s while recording and removed by stop()', async () => {
        vi.setSystemTime(T0);
        const srv = server(); global.fetch = srv.fetch;
        const rec = makeRecorder();
        await rec.start();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(JSON.parse(localStorage.getItem(KEY)).savedAt).toBe(T0 + 10_000);
        await rec.stop();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('replay of 10-14: relaunch 10 s after the crash carries on in 20261014_1555Z.csv', async () => {
        const m = marker();
        localStorage.setItem(KEY, JSON.stringify(m));
        vi.setSystemTime(m.savedAt + 10_000);
        const srv = server({ '20261014_1555Z.csv': CSV }); global.fetch = srv.fetch;
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBe('resumed');
        expect(rec.recording).toBe(true);
        expect(rec.fileName).toBe('20261014_1555Z.csv');
        expect(events.map((e) => e.type)).toEqual(['flightsync:started']);
        expect(events[0].detail).toMatchObject({ resumed: true });

        await vi.advanceTimersByTimeAsync(5_000);            // rows recorded and saved
        const csv = srv.store.get('20261014_1555Z.csv');
        expect(csv.startsWith(CSV)).toBe(true);              // appended, nothing overwritten
        expect(csv.slice(CSV.length)).not.toContain('Zulu_Time');   // no second header
        expect(csv.slice(CSV.length).split('\n').filter(Boolean).length).toBeGreaterThan(0);

        await rec.stop();
        const stopped = events.find((e) => e.type === 'flightsync:stopped').detail;
        expect(stopped.startTime).toBe(new Date(T0).toISOString());   // the whole flight, one entry
    });

    it('an old marker is closed out: stopped event ending at its last save, then cleared', async () => {
        const m = marker();
        localStorage.setItem(KEY, JSON.stringify(m));
        vi.setSystemTime(m.savedAt + FlightRecorder.RESUME_WINDOW_MS + 1);
        global.fetch = server({ '20261014_1555Z.csv': CSV }).fetch;
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBe('closed');
        expect(rec.recording).toBe(false);
        expect(rec._renameWithRoute).toHaveBeenCalled();
        const stopped = events.filter((e) => e.type === 'flightsync:stopped');
        expect(stopped).toHaveLength(1);
        expect(stopped[0].detail).toMatchObject({
            csvFilename: '20261014_1555Z.csv',
            startTime: new Date(T0).toISOString(),
            endTime: new Date(m.savedAt).toISOString(),
        });
        expect(events.some((e) => e.type === 'flightsync:started')).toBe(false);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('the marked file is gone: nothing resumed or logged, marker cleared', async () => {
        localStorage.setItem(KEY, JSON.stringify(marker()));
        vi.setSystemTime(marker().savedAt + 10_000);
        global.fetch = server({}).fetch;
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBeNull();
        expect(rec.recording).toBe(false);
        expect(events).toEqual([]);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('the file server can\'t say: marker kept for the next launch, nothing logged', async () => {
        localStorage.setItem(KEY, JSON.stringify(marker()));
        vi.setSystemTime(marker().savedAt + 10_000);
        global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBeNull();
        expect(rec.recording).toBe(false);
        expect(events).toEqual([]);
        expect(localStorage.getItem(KEY)).not.toBeNull();
    });

    it('a damaged or unsafe marker is ignored and cleared (the name goes into a URL)', async () => {
        global.fetch = server({ '20261014_1555Z.csv': CSV }).fetch;
        for (const bad of ['{not json', JSON.stringify(marker({ fileName: '../tiles/x.csv' })),
            JSON.stringify(marker({ fileName: 'a/b.csv' })), JSON.stringify(marker({ savedAt: 'soon' })),
            JSON.stringify(marker({ trafficFileName: '../../x.ndjson' }))]) {
            localStorage.setItem(KEY, bad);
            const rec = makeRecorder();
            expect(await rec.recoverUnfinished()).toBeNull();
            expect(localStorage.getItem(KEY)).toBeNull();
        }
        expect(events).toEqual([]);
    });

    it('no marker: nothing happens', async () => {
        global.fetch = vi.fn();
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('auto-start can\'t open a second file while recovery is checking the old one', async () => {
        localStorage.setItem(KEY, JSON.stringify(marker()));
        vi.setSystemTime(marker().savedAt + 10_000);
        let release;
        global.fetch = vi.fn(() => new Promise((r) => { release = () => r({ ok: true, status: 200, text: async () => CSV }); }));
        const rec = makeRecorder();
        const p = rec.recoverUnfinished();
        await rec.start();                                   // e.g. _autoMonitor firing meanwhile
        expect(events).toEqual([]);
        release();
        expect(await p).toBe('resumed');
        expect(rec.fileName).toBe('20261014_1555Z.csv');
        expect(events.filter((e) => e.type === 'flightsync:started')).toHaveLength(1);
        await rec.stop();
    });
});
