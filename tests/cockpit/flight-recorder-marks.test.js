/**
 * Run-up / magneto marks in the flight recording (Dana, 2026-10-31).
 *
 * The 10-30 run-up (20261030_KLKR-KLKR.csv) has eight RPM dips that can't be told
 * apart (left mag / right mag / carb heat) from the data, and the ML phase
 * 'runup' starts ~20 s late. The checklist now has buttons that mark the moment;
 * FlightRecorder.markEvent() queues the mark and the next row written carries it
 * in a new last CSV column, `event`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({ rpmStopThreshold: 0, stopDelaySeconds: 60 }) };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const BASE = 'http://localhost:9090/flights/';
const KEY = FlightRecorder.ACTIVE_KEY;
const T0 = Date.parse('2026-10-30T20:56:00Z');
const HEADER_COLS = FlightRecorder.CSV_HEADER.split(',').length;

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
    const engine = { lastData: { data: { RPM: 1800, EGT1: 1200 } }, get dataAge() { return 500; } };
    const stratux = { situation: null, traffic: new Map() };
    const rec = new FlightRecorder(engine, stratux, null);
    rec._renameWithRoute = vi.fn(async () => null);
    return rec;
}

/** Rows (header excluded) buffered so far, as field arrays. */
const rows = (rec) => rec._csvBuffer.slice(1).map((r) => r.split(','));
const EVENT = HEADER_COLS - 1;

describe('CSV header', () => {
    it('ends with ,event and a written row has exactly as many fields as the header', async () => {
        vi.useFakeTimers(); vi.setSystemTime(T0); localStorage.clear();
        global.fetch = server().fetch;
        try {
            expect(FlightRecorder.CSV_HEADER.endsWith(',event')).toBe(true);
            const rec = makeRecorder();
            await rec.start();
            rec._recordRow();
            expect(rows(rec)).toHaveLength(1);
            expect(rows(rec)[0]).toHaveLength(HEADER_COLS);
            expect(rows(rec)[0][EVENT]).toBe('');
            await rec.stop();
        } finally { vi.useRealTimers(); }
    });
});

describe('FlightRecorder.markEvent', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        localStorage.clear();
        DiagLog.log.mockClear();
        global.fetch = server().fetch;
    });
    afterEach(() => { vi.useRealTimers(); });

    it('the mark lands on exactly one row (the next one written), later rows are empty', async () => {
        const rec = makeRecorder();
        await rec.start();
        rec._recordRow();                                   // before the tap
        vi.setSystemTime(T0 + 14000);
        const r = rec.markEvent('mag_L');
        expect(r).toEqual({ saved: true, at: '2026-10-30T20:56:14.000Z' });
        rec._recordRow();                                   // the row the mark rides on
        rec._recordRow();                                   // the engine data repeats every 2 s: same values again
        rec._recordRow();
        const ev = rows(rec).map((c) => c[EVENT]);
        expect(ev).toEqual(['', 'mag_L', '', '']);
        expect(rows(rec).every((c) => c.length === HEADER_COLS)).toBe(true);
        await rec.stop();
    });

    it('two taps before the next row are joined with | in tap order, then the queue clears', async () => {
        const rec = makeRecorder();
        await rec.start();
        rec.markEvent('mag_L');
        rec.markEvent('mag_R');
        rec._recordRow();
        rec._recordRow();
        expect(rows(rec).map((c) => c[EVENT])).toEqual(['mag_L|mag_R', '']);
        await rec.stop();
    });

    it('accepts every mark code', async () => {
        const rec = makeRecorder();
        await rec.start();
        for (const code of ['runup_start', 'runup_end', 'mag_L', 'mag_R', 'mag_BOTH']) {
            expect(rec.markEvent(code).saved).toBe(true);
            rec._recordRow();
        }
        expect(rows(rec).map((c) => c[EVENT])).toEqual(['runup_start', 'runup_end', 'mag_L', 'mag_R', 'mag_BOTH']);
        await rec.stop();
    });

    it('rejects any other code: nothing queued, nothing written', async () => {
        const rec = makeRecorder();
        await rec.start();
        for (const bad of ['mag_X', 'MAG_L', '', null, undefined, 'mag_L,1', 'mag_L\nx', 42, {}]) {
            expect(rec.markEvent(bad).saved).toBe(false);
        }
        rec._recordRow();
        expect(rows(rec)[0][EVENT]).toBe('');
        expect(rows(rec)[0]).toHaveLength(HEADER_COLS);
        await rec.stop();
    });

    it('not recording: saved:false and nothing is written or queued', async () => {
        const rec = makeRecorder();
        const fetchBefore = global.fetch.mock.calls.length;
        const r = rec.markEvent('mag_L');
        expect(r.saved).toBe(false);
        expect(r.reason).toBe('not_recording');
        expect(typeof r.at).toBe('string');
        expect(rec._csvBuffer).toEqual([]);
        expect(global.fetch.mock.calls.length).toBe(fetchBefore);
        // and the stale tap must not leak into the NEXT recording
        await rec.start();
        rec._recordRow();
        expect(rows(rec)[0][EVENT]).toBe('');
        await rec.stop();
    });

    it('logs the mark with its time in Z', async () => {
        const rec = makeRecorder();
        await rec.start();
        vi.setSystemTime(T0 + 74000);                       // 20:57:14Z
        rec.markEvent('mag_R');
        expect(DiagLog.log).toHaveBeenCalledWith('recorder', 'Mark mag_R at 20:57:14Z');
        await rec.stop();
    });

    it('a mark pending when the recording stops does not carry into the next one', async () => {
        const rec = makeRecorder();
        await rec.start();
        rec.markEvent('runup_start');
        await rec.stop();
        await rec.start();
        rec._recordRow();
        expect(rows(rec)[0][EVENT]).toBe('');
        await rec.stop();
    });

    it('the saved file has the header and only full-width rows', async () => {
        const srv = server(); global.fetch = srv.fetch;
        const rec = makeRecorder();
        await rec.start();
        rec._recordRow();
        rec.markEvent('mag_BOTH');
        rec._recordRow();
        rec._recordRow();
        await rec._flush();
        const lines = srv.store.get(rec.fileName).trim().split('\n');
        expect(lines[0]).toBe(FlightRecorder.CSV_HEADER);
        expect(lines.every((l) => l.split(',').length === HEADER_COLS)).toBe(true);
        expect(lines.slice(1).map((l) => l.split(',')[EVENT])).toEqual(['', 'mag_BOTH', '']);
        await rec.stop();
    });
});

describe('FlightRecorder.currentMag', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); localStorage.clear(); global.fetch = server().fetch; });
    afterEach(() => { vi.useRealTimers(); });

    it('is null until a mag is marked, then the last mag code; run-up marks do not change it', async () => {
        const rec = makeRecorder();
        expect(rec.currentMag()).toBeNull();
        await rec.start();
        expect(rec.currentMag()).toBeNull();
        rec.markEvent('mag_BOTH');
        expect(rec.currentMag()).toBe('mag_BOTH');
        rec.markEvent('mag_L');
        rec.markEvent('mag_R');
        expect(rec.currentMag()).toBe('mag_R');
        rec.markEvent('runup_end');
        expect(rec.currentMag()).toBe('mag_R');
        await rec.stop();
        expect(rec.currentMag()).toBeNull();
    });

    it('a mark that was not saved never becomes the current mag', () => {
        const rec = makeRecorder();
        rec.markEvent('mag_L');
        expect(rec.currentMag()).toBeNull();
    });

    it('is reset when a new recording starts', async () => {
        const rec = makeRecorder();
        await rec.start();
        rec.markEvent('mag_L');
        await rec.stop();
        await rec.start();
        expect(rec.currentMag()).toBeNull();
        await rec.stop();
    });
});

describe('marks and a recording resumed after an app update', () => {
    const OLD_HEADER = FlightRecorder.CSV_HEADER.replace(/,event$/, '');
    const OLD_COLS = OLD_HEADER.split(',').length;
    const marker = (over = {}) => ({
        fileName: '20261030_2050Z.csv', trafficFileName: '20261030_2050Z_traffic.ndjson',
        startTime: T0 - 6 * 60 * 1000, firstGps: null, lastGps: null,
        rowCount: 100, savedAt: T0 - 5000, ...over,
    });
    const oldFile = () => ({
        '20261030_2050Z.csv': OLD_HEADER + '\n' + Array(100).fill('x').join('\n') + '\n',
    });
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); localStorage.clear(); DiagLog.log.mockClear(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a new recording\'s marker says eventColumn: true', async () => {
        global.fetch = server().fetch;
        const rec = makeRecorder();
        await rec.start();
        expect(JSON.parse(localStorage.getItem(KEY)).eventColumn).toBe(true);
        await rec.stop();
    });

    it('old marker (no eventColumn): rows keep the old field count and markEvent says so', async () => {
        const srv = server(oldFile()); global.fetch = srv.fetch;
        localStorage.setItem(KEY, JSON.stringify(marker()));
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBe('resumed');
        const r = rec.markEvent('mag_L');
        expect(r.saved).toBe(false);
        expect(r.reason).toBe('old_recording');
        rec._recordRow();
        rec._recordRow();
        const cols = rows({ _csvBuffer: ['', ...rec._csvBuffer] });
        expect(cols).toHaveLength(2);
        expect(cols.every((c) => c.length === OLD_COLS)).toBe(true);
        expect(rec.currentMag()).toBeNull();
        // the marker keeps saying so across further restarts
        rec._saveMarker();
        expect(JSON.parse(localStorage.getItem(KEY)).eventColumn).toBeFalsy();
        // and what lands in the file is old-width rows under the old header
        await rec._flush();
        const lines = srv.store.get('20261030_2050Z.csv').trim().split('\n');
        expect(lines.slice(101).every((l) => l.split(',').length === OLD_COLS)).toBe(true);
        await rec.stop();
    });

    it('marker with eventColumn: true resumes with the event column and marks work', async () => {
        const srv = server({ '20261030_2050Z.csv': FlightRecorder.CSV_HEADER + '\n' + 'x\n' }); global.fetch = srv.fetch;
        localStorage.setItem(KEY, JSON.stringify(marker({ eventColumn: true })));
        const rec = makeRecorder();
        expect(await rec.recoverUnfinished()).toBe('resumed');
        expect(rec.markEvent('mag_BOTH').saved).toBe(true);
        rec._recordRow();
        const cols = rec._csvBuffer.map((r) => r.split(','));
        expect(cols[0]).toHaveLength(HEADER_COLS);
        expect(cols[0][EVENT]).toBe('mag_BOTH');
        expect(JSON.parse(localStorage.getItem(KEY)).eventColumn).toBe(true);
        await rec.stop();
    });

    it('parseMarker only accepts eventColumn === true', () => {
        const base = JSON.stringify(marker());
        expect(FlightRecorder.parseMarker(base).eventColumn).toBe(false);
        expect(FlightRecorder.parseMarker(JSON.stringify(marker({ eventColumn: 'yes' }))).eventColumn).toBe(false);
        expect(FlightRecorder.parseMarker(JSON.stringify(marker({ eventColumn: true }))).eventColumn).toBe(true);
    });
});
