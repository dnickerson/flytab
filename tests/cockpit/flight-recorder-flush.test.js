/**
 * Flight recorder saves (A3, flight-safety plan).
 *
 * Every 5 s the recorder appends its buffered rows to the CSV (and traffic
 * snapshots to the .ndjson) with PUT X-Append on TileServer (NanoHTTPD 2.3.1,
 * one thread per request). Before A3:
 *  - a PUT that never answered hung forever, and stop()'s final save with it,
 *    so the flight never got its stopped event / logbook entry;
 *  - a second save could start while the first was still in flight: two appends
 *    to one file at once, and a failed earlier save put its rows back AFTER rows
 *    a later save had already written -> rows out of order in the file;
 *  - stop() reported flushOk=true even when the final save failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({ rpmStopThreshold: 0, stopDelaySeconds: 60 }) };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const BASE = 'http://localhost:9090/flights/';

/**
 * Stand-in for TileServer's flights/ directory. PUT X-Append appends.
 * mode(name, n) picks how the n-th PUT (1-based) answers: 'ok', 'fail' (500),
 * 'stall' (never answers until aborted), or a { release } hook to answer later.
 */
function server(mode = () => 'ok') {
    const files = new Map();
    let puts = 0;
    const held = [];
    const fetch = vi.fn((url, opts = {}) => {
        const name = url.replace(BASE, '');
        const method = opts.method || 'GET';
        if (method === 'GET') {
            return Promise.resolve(files.has(name) ? { ok: true, status: 200, text: async () => files.get(name) }
                : { ok: false, status: 404, text: async () => 'Not found' });
        }
        if (method !== 'PUT') return Promise.resolve({ ok: true, status: 200 });
        const n = ++puts;
        const m = mode(name, n);
        const write = () => { files.set(name, (opts.headers?.['X-Append'] === 'true' ? (files.get(name) || '') : '') + opts.body); };
        if (m === 'ok') { write(); return Promise.resolve({ ok: true, status: 201 }); }
        if (m === 'fail') return Promise.resolve({ ok: false, status: 500 });
        // 'stall' / 'hold': pending until released or aborted
        return new Promise((resolve, reject) => {
            const h = { name, release: (ok = true) => { if (ok) write(); resolve({ ok, status: ok ? 201 : 500 }); } };
            held.push(h);
            opts.signal?.addEventListener('abort', () => {
                const e = new Error('The user aborted a request.'); e.name = 'AbortError'; reject(e);
            });
        });
    });
    return { files, fetch, held, putCount: () => puts };
}

function recorder() {
    const rec = new FlightRecorder({ lastData: null, dataAge: Infinity }, { situation: null }, null);
    rec._recording = true;
    rec._fileName = '20261013_1550Z.csv';
    rec._trafficFileName = '20261013_1550Z_traffic.ndjson';
    rec._csvBuffer = [];
    rec._trafficBuffer = [];
    rec._renameWithRoute = vi.fn(async () => null);
    return rec;
}
const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);
const csvLines = (s) => (s || '').split('\n').filter(Boolean);
const puts = (srv) => srv.fetch.mock.calls.filter(([, o]) => o?.method === 'PUT');

describe('FlightRecorder saves (A3)', () => {
    beforeEach(() => { vi.useFakeTimers(); DiagLog.log.mockClear(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a PUT that never answers is abandoned after LOCAL_TIMEOUT_MS; its rows are kept and saved next time', async () => {
        const srv = server((_, n) => (n === 1 ? 'stall' : 'ok')); global.fetch = srv.fetch;
        const rec = recorder();
        rec._csvBuffer.push(...rows(1, 5));
        let done = false;
        const p = rec._flush().then((ok) => { done = true; return ok; });
        await vi.advanceTimersByTimeAsync(FlightRecorder.LOCAL_TIMEOUT_MS - 1);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await p).toBe(false);
        expect(rec._csvBuffer).toEqual(rows(1, 5));
        expect(DiagLog.log).toHaveBeenCalledWith('recorder', expect.stringMatching(/timed out/i));

        rec._csvBuffer.push(...rows(6, 8));
        expect(await rec._flush()).toBe(true);
        expect(csvLines(srv.files.get('20261013_1550Z.csv'))).toEqual(rows(1, 8));
    });

    it('only one save in flight per file: a save requested meanwhile waits for it', async () => {
        const srv = server(() => 'hold'); global.fetch = srv.fetch;
        const rec = recorder();
        rec._csvBuffer.push(...rows(1, 5));
        const a = rec._flush();
        rec._csvBuffer.push(...rows(6, 10));
        const b = rec._flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(puts(srv)).toHaveLength(1);
        srv.held[0].release();
        await vi.advanceTimersByTimeAsync(0);
        expect(puts(srv)).toHaveLength(2);
        srv.held[1].release();
        expect(await a).toBe(true);
        expect(await b).toBe(true);
        expect(csvLines(srv.files.get('20261013_1550Z.csv'))).toEqual(rows(1, 10));
    });

    it('rows stay in order when an earlier save fails while later rows were recorded', async () => {
        const srv = server((_, n) => (n === 1 ? 'hold' : 'ok')); global.fetch = srv.fetch;
        const rec = recorder();
        rec._csvBuffer.push(...rows(1, 5));
        const a = rec._flush();
        rec._csvBuffer.push(...rows(6, 10));         // recorded while save 1 is in flight
        const b = rec._flush();
        await vi.advanceTimersByTimeAsync(0);
        srv.held[0].release(false);                  // save 1 fails (500)
        expect(await a).toBe(false);
        expect(await b).toBe(true);
        expect(csvLines(srv.files.get('20261013_1550Z.csv'))).toEqual(rows(1, 10));
        expect(rec._csvBuffer).toEqual([]);
    });

    it('saves requested every 5 s during a stall do not pile up', async () => {
        const srv = server(() => 'stall'); global.fetch = srv.fetch;
        const rec = recorder();
        for (let i = 0; i < 10; i++) { rec._csvBuffer.push(`r${i}`); rec._flush(); }
        await vi.advanceTimersByTimeAsync(0);
        expect(puts(srv)).toHaveLength(1);           // one in flight, one follow-up queued, none started
        await vi.advanceTimersByTimeAsync(FlightRecorder.LOCAL_TIMEOUT_MS);
        expect(puts(srv)).toHaveLength(2);           // the single follow-up
        await vi.advanceTimersByTimeAsync(FlightRecorder.LOCAL_TIMEOUT_MS);
        expect(puts(srv)).toHaveLength(2);
        expect(rec._csvBuffer).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
    });

    it('traffic saves get the same timeout, one-at-a-time and order guarantees', async () => {
        const srv = server((_, n) => (n === 1 ? 'stall' : 'ok')); global.fetch = srv.fetch;
        const rec = recorder();
        rec._trafficBuffer.push('{"t":1}', '{"t":2}');
        const a = rec._flushTraffic();
        rec._trafficBuffer.push('{"t":3}');
        const b = rec._flushTraffic();
        await vi.advanceTimersByTimeAsync(0);
        expect(puts(srv)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(FlightRecorder.LOCAL_TIMEOUT_MS);
        expect(await a).toBe(false);
        expect(await b).toBe(true);
        expect(csvLines(srv.files.get('20261013_1550Z_traffic.ndjson'))).toEqual(['{"t":1}', '{"t":2}', '{"t":3}']);
    });

    it('stop() finishes even if the server never answers, and reports flushOk=false', async () => {
        const srv = server(() => 'stall'); global.fetch = srv.fetch;
        const rec = recorder();
        rec._csvBuffer.push(...rows(1, 3));
        rec._trafficBuffer.push('{"t":1}');
        const events = [];
        const onStop = (e) => events.push(e.detail);
        window.addEventListener('flightsync:stopped', onStop);
        const p = rec.stop();
        // The final save is retried (FINAL_SAVE_RETRIES), each try timing out.
        await vi.advanceTimersByTimeAsync((FlightRecorder.FINAL_SAVE_RETRIES + 1) * (FlightRecorder.LOCAL_TIMEOUT_MS + FlightRecorder.FINAL_SAVE_RETRY_MS));
        await p;
        window.removeEventListener('flightsync:stopped', onStop);
        expect(events).toHaveLength(1);
        expect(events[0].flushOk).toBe(false);
        expect(DiagLog.log).toHaveBeenCalledWith('recorder', expect.stringMatching(/Stopped: .*flushOk=false/));
    });

    it('stop() reports flushOk=true when the final save is written', async () => {
        const srv = server(); global.fetch = srv.fetch;
        const rec = recorder();
        rec._csvBuffer.push(...rows(1, 3));
        const events = [];
        const onStop = (e) => events.push(e.detail);
        window.addEventListener('flightsync:stopped', onStop);
        await rec.stop();
        window.removeEventListener('flightsync:stopped', onStop);
        expect(events[0].flushOk).toBe(true);
        expect(csvLines(srv.files.get('20261013_1550Z.csv'))).toEqual(rows(1, 3));
    });

    it('stop() waits for a save already in flight before the rename reads the file', async () => {
        const srv = server((_, n) => (n === 1 ? 'hold' : 'ok')); global.fetch = srv.fetch;
        const rec = recorder();
        rec._csvBuffer.push(...rows(1, 5));
        rec._flush();                                 // the 5 s save, in flight
        rec._csvBuffer.push(...rows(6, 7));
        let seenAtRename = null;
        rec._renameWithRoute = vi.fn(async () => { seenAtRename = csvLines(srv.files.get('20261013_1550Z.csv')); return null; });
        const p = rec.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(rec._renameWithRoute).not.toHaveBeenCalled();
        srv.held[0].release();
        await p;
        expect(seenAtRename).toEqual(rows(1, 7));
    });
});
