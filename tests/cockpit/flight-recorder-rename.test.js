/**
 * Flight recorder rename can never destroy a flight file (A2, flight-safety plan).
 *
 * The rename is read -> PUT copy -> DELETE original over the on-device NanoHTTPD
 * server (TileServer.java). Two ways it could lose data:
 *  1. The PUT result was never checked, and TileServer.handlePut returns 201 "OK"
 *     even when it wrote nothing (no temp body file). The original was then
 *     deleted anyway.
 *  2. The new name YYYYMMDD_DEP-DEST.csv can already exist (two local KLKR-KLKR
 *     flights in a day). A non-append PUT truncates and overwrites it, destroying
 *     the earlier flight.
 * Rule: delete the original only after the copy reads back identical, and never
 * write over an existing file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const BASE = 'http://localhost:9090/flights/';

/** In-memory stand-in for TileServer's flights/ directory, with injectable faults. */
function fileStore(files, faults = {}) {
    const store = new Map(Object.entries(files));
    const fetch = vi.fn(async (url, opts = {}) => {
        const name = url.replace(BASE, '');
        const m = opts.method || 'GET';
        if (faults.down) throw new TypeError('Failed to fetch');
        if (m === 'GET') {
            if (faults.getFails?.(name)) return { ok: false, status: 500, text: async () => 'err' };
            return store.has(name) ? { ok: true, status: 200, text: async () => store.get(name) }
                : { ok: false, status: 404, text: async () => 'Not found' };
        }
        if (m === 'PUT') {
            if (faults.putStatus) return { ok: false, status: faults.putStatus, text: async () => 'Write failed' };
            if (faults.putSilentNoWrite) return { ok: true, status: 201, text: async () => 'OK' };   // handlePut with no temp file
            if (faults.putTruncates) { store.set(name, opts.body.slice(0, 10)); return { ok: true, status: 201, text: async () => 'OK' }; }
            store.set(name, opts.body); return { ok: true, status: 201, text: async () => 'OK' };
        }
        if (m === 'DELETE') {
            if (!store.has(name)) return { ok: false, status: 404, text: async () => 'Not found' };
            store.delete(name); return { ok: true, status: 200, text: async () => 'Deleted' };
        }
    });
    return { store, fetch };
}

function recorder({ fileName = '20261013_1550Z.csv', traffic = '20261013_1550Z_traffic.ndjson' } = {}) {
    const rec = Object.create(FlightRecorder.prototype);
    rec._nasrDb = {};
    rec._firstGps = { lat: 34.7, lon: -80.8 };
    rec._lastGps = { lat: 34.9, lon: -80.6 };
    rec._fileName = fileName;
    rec._trafficFileName = traffic;
    rec._nearestAirport = vi.fn(async (lat) => (lat < 34.8 ? 'KCDN' : 'KLKR'));
    return rec;
}

const CSV = 'Zulu_Time,MP\n' + '12:00:00,24.1\n'.repeat(500);
const TRAFFIC = '{"icao":"A00DF9"}\n'.repeat(50);

describe('FlightRecorder._renameWithRoute', () => {
    let fs, rec;
    beforeEach(() => { DiagLog.log.mockClear(); });

    it('normal case: renamed, original removed, contents identical, route returned', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV, '20261013_1550Z_traffic.ndjson': TRAFFIC }); global.fetch = fs.fetch;
        rec = recorder();
        const r = await rec._renameWithRoute();
        expect(r).toEqual({ depIcao: 'KCDN', destIcao: 'KLKR' });
        expect(rec._fileName).toBe('20261013_KCDN-KLKR.csv');
        expect(fs.store.get('20261013_KCDN-KLKR.csv')).toBe(CSV);
        expect(fs.store.has('20261013_1550Z.csv')).toBe(false);
        expect(fs.store.get('20261013_KCDN-KLKR_traffic.ndjson')).toBe(TRAFFIC);
        expect(fs.store.has('20261013_1550Z_traffic.ndjson')).toBe(false);
    });

    it('PUT fails (500): the original is kept and the name is unchanged', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV }, { putStatus: 500 }); global.fetch = fs.fetch;
        rec = recorder();
        await rec._renameWithRoute();
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
        expect(rec._fileName).toBe('20261013_1550Z.csv');
    });

    it('PUT answers 201 but wrote nothing (TileServer, no temp file): original kept', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV }, { putSilentNoWrite: true }); global.fetch = fs.fetch;
        rec = recorder();
        await rec._renameWithRoute();
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
        expect(rec._fileName).toBe('20261013_1550Z.csv');
    });

    it('copy written short (truncated): original kept, the bad copy removed', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV }, { putTruncates: true }); global.fetch = fs.fetch;
        rec = recorder();
        await rec._renameWithRoute();
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
        expect(fs.store.has('20261013_KCDN-KLKR.csv')).toBe(false);
        expect(rec._fileName).toBe('20261013_1550Z.csv');
    });

    it('a flight with the same route earlier that day is NOT overwritten: _2 suffix', async () => {
        const EARLIER = 'Zulu_Time,MP\nEARLIER FLIGHT\n';
        fs = fileStore({ '20261013_KCDN-KLKR.csv': EARLIER, '20261013_1550Z.csv': CSV, '20261013_1550Z_traffic.ndjson': TRAFFIC }); global.fetch = fs.fetch;
        rec = recorder();
        await rec._renameWithRoute();
        expect(fs.store.get('20261013_KCDN-KLKR.csv')).toBe(EARLIER);
        expect(rec._fileName).toBe('20261013_KCDN-KLKR_2.csv');
        expect(fs.store.get('20261013_KCDN-KLKR_2.csv')).toBe(CSV);
        expect(fs.store.get('20261013_KCDN-KLKR_2_traffic.ndjson')).toBe(TRAFFIC);
    });

    it('cannot tell whether the target exists (server error on the check): no rename', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV }, { getFails: (n) => n === '20261013_KCDN-KLKR.csv' }); global.fetch = fs.fetch;
        rec = recorder();
        await rec._renameWithRoute();
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
        expect(rec._fileName).toBe('20261013_1550Z.csv');
    });

    it('server unreachable: nothing changes, no throw', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV }, { down: true }); global.fetch = fs.fetch;
        rec = recorder();
        await expect(rec._renameWithRoute()).resolves.toBeNull();
        expect(rec._fileName).toBe('20261013_1550Z.csv');
    });

    it('never issues a DELETE before the copy has been read back identical', async () => {
        fs = fileStore({ '20261013_1550Z.csv': CSV }); global.fetch = fs.fetch;
        rec = recorder({ traffic: null });
        await rec._renameWithRoute();
        const calls = fs.fetch.mock.calls.map(([u, o]) => `${(o?.method || 'GET')} ${u.replace(BASE, '')}`);
        const del = calls.indexOf('DELETE 20261013_1550Z.csv');
        const verify = calls.lastIndexOf('GET 20261013_KCDN-KLKR.csv');
        expect(del).toBeGreaterThan(verify);
        expect(verify).toBeGreaterThan(calls.indexOf('PUT 20261013_KCDN-KLKR.csv'));
    });
});

/**
 * The rename runs inside stop(), before the flightsync:stopped event that closes
 * the flight out and makes its logbook entry. Nothing in it may hang (A3): every
 * TileServer request has a timeout and the NASR lookup has one too. A failure
 * after the CSV copy is verified must not throw the result away.
 */
describe('FlightRecorder rename can never hang stop() (A3)', () => {
    /** fileStore plus: stall(method, name) -> request never answers until aborted;
     *  stallBody(name) -> GET headers arrive but the body never does. */
    function stallingStore(files, { stall = () => false, stallBody = () => false, throwOn = () => false } = {}) {
        const store = new Map(Object.entries(files));
        const aborted = (opts) => new Promise((_, reject) => opts.signal?.addEventListener('abort', () => {
            const e = new Error('The user aborted a request.'); e.name = 'AbortError'; reject(e);
        }));
        const fetch = vi.fn(async (url, opts = {}) => {
            const name = url.replace(BASE, '');
            const m = opts.method || 'GET';
            if (throwOn(m, name)) throw new TypeError('Failed to fetch');
            if (stall(m, name)) return aborted(opts);
            if (m === 'GET') {
                if (!store.has(name)) return { ok: false, status: 404, text: async () => 'Not found' };
                const body = store.get(name);
                return { ok: true, status: 200, text: () => (stallBody(name) ? aborted(opts) : Promise.resolve(body)) };
            }
            if (m === 'PUT') { store.set(name, opts.body); return { ok: true, status: 201, text: async () => 'OK' }; }
            if (m === 'DELETE') { store.delete(name); return { ok: true, status: 200, text: async () => 'Deleted' }; }
        });
        return { store, fetch };
    }

    async function stopAndCollect(rec, ms = 10 * FlightRecorder.LOCAL_TIMEOUT_MS) {
        const events = [];
        const on = (e) => events.push(e.detail);
        window.addEventListener('flightsync:stopped', on);
        rec._recording = true;
        rec._csvBuffer = []; rec._trafficBuffer = [];
        rec._csvSave = { active: null, next: null }; rec._trafficSave = { active: null, next: null };
        const p = rec.stop();
        await vi.advanceTimersByTimeAsync(ms);
        await p;
        window.removeEventListener('flightsync:stopped', on);
        return events;
    }

    beforeEach(() => { vi.useFakeTimers(); DiagLog.log.mockClear(); });
    afterEach(() => { vi.useRealTimers(); });

    it('existence check never answers: stop() still finishes, original name kept', async () => {
        const fs = stallingStore({ '20261013_1550Z.csv': CSV }, { stall: (m, n) => m === 'GET' && n === '20261013_KCDN-KLKR.csv' });
        global.fetch = fs.fetch;
        const rec = recorder({ traffic: null });
        const events = await stopAndCollect(rec);
        expect(events).toHaveLength(1);
        expect(events[0].csvFilename).toBe('20261013_1550Z.csv');
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
    });

    it('NASR lookup never resolves (IDB hang): stop() still finishes, original name kept', async () => {
        const fs = stallingStore({ '20261013_1550Z.csv': CSV }); global.fetch = fs.fetch;
        const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null },
            { getAirportsNear: () => new Promise(() => {}) });
        Object.assign(rec, { _firstGps: { lat: 34.7, lon: -80.8 }, _lastGps: { lat: 34.9, lon: -80.6 },
            _fileName: '20261013_1550Z.csv', _trafficFileName: null });
        const events = await stopAndCollect(rec);
        expect(events).toHaveLength(1);
        expect(events[0].csvFilename).toBe('20261013_1550Z.csv');
        expect(events[0].depIcao).toBeNull();
    });

    it('reading the original stalls mid-body: original kept, nothing written', async () => {
        const fs = stallingStore({ '20261013_1550Z.csv': CSV }, { stallBody: (n) => n === '20261013_1550Z.csv' });
        global.fetch = fs.fetch;
        const rec = recorder({ traffic: null });
        const events = await stopAndCollect(rec);
        expect(events[0].csvFilename).toBe('20261013_1550Z.csv');
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
        expect(fs.store.has('20261013_KCDN-KLKR.csv')).toBe(false);
    });

    it('the copy PUT never answers: original kept and never deleted', async () => {
        const fs = stallingStore({ '20261013_1550Z.csv': CSV }, { stall: (m) => m === 'PUT' });
        global.fetch = fs.fetch;
        const rec = recorder({ traffic: null });
        const events = await stopAndCollect(rec);
        expect(events[0].csvFilename).toBe('20261013_1550Z.csv');
        expect(fs.store.get('20261013_1550Z.csv')).toBe(CSV);
        expect(fs.fetch.mock.calls.some(([u, o]) => o?.method === 'DELETE' && u.endsWith('20261013_1550Z.csv'))).toBe(false);
    });

    it('copy verified, then deleting the original never answers: the new name and route are reported', async () => {
        const fs = stallingStore({ '20261013_1550Z.csv': CSV }, { stall: (m, n) => m === 'DELETE' && n === '20261013_1550Z.csv' });
        global.fetch = fs.fetch;
        const rec = recorder({ traffic: null });
        const events = await stopAndCollect(rec);
        expect(events[0].csvFilename).toBe('20261013_KCDN-KLKR.csv');
        expect(events[0].depIcao).toBe('KCDN');
        expect(fs.store.get('20261013_KCDN-KLKR.csv')).toBe(CSV);
    });

    it('CSV renamed, then the traffic move fails outright: CSV rename and route still reported', async () => {
        const fs = stallingStore({ '20261013_1550Z.csv': CSV, '20261013_1550Z_traffic.ndjson': TRAFFIC },
            { throwOn: (m, n) => m === 'GET' && n === '20261013_1550Z_traffic.ndjson' });
        global.fetch = fs.fetch;
        const rec = recorder();
        const events = await stopAndCollect(rec);
        expect(events[0].csvFilename).toBe('20261013_KCDN-KLKR.csv');
        expect(events[0].destIcao).toBe('KLKR');
        expect(rec._trafficFileName).toBe('20261013_1550Z_traffic.ndjson');
        expect(fs.store.get('20261013_1550Z_traffic.ndjson')).toBe(TRAFFIC);
    });
});
