/**
 * #188 follow-up: flights since 2026-10-14 whose recording was closed out at the
 * next launch have no Engine ML summary or per-second log (10/22 KLKR-KORL), and
 * a resumed one kept only the part after the restart. The flight CSV's ml_*
 * columns hold the same data: the ML tab rebuilds them from it, into the ML log
 * store (never into the logbook entry, which would need syncing).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({}), aircraft: () => null };
global.wireTap = () => {};
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();
const EngineMLBridge = new Function(read('web/cockpit/engine-ml.js') + '\nreturn EngineMLBridge;')();
const Logbook = new Function(read('web/cockpit/logbook.js') + '\nreturn Logbook;')();
globalThis.EngineMLBridge = EngineMLBridge;          // a global in the app (index.html)

const BASE = 'http://localhost:9090/flights/';
const H = FlightRecorder.CSV_HEADER;
const COLS = H.split(',');
function row(time, { ph = 'cruise', sc = '0.0123', an = '0', lt = '2', date = '2026-10-22' } = {}) {
    const f = new Array(COLS.length).fill('0');
    f[COLS.indexOf('Zulu_Time')] = time;
    f[COLS.indexOf('date')] = date;
    f[COLS.indexOf('ml_phase')] = ph;
    f[COLS.indexOf('ml_score')] = sc;
    f[COLS.indexOf('ml_anomaly')] = an;
    f[COLS.indexOf('ml_latency_ms')] = lt;
    return f.join(',');
}
const CSV = [H, row('1:16:28 PM'), row('1:16:29 PM', { an: '1' })].join('\n');

function files(map) {
    return vi.fn(async (url) => {
        const name = url.replace(BASE, '');
        const v = map[name];
        if (v === undefined) return { ok: false, status: 404, text: async () => '' };
        if (typeof v === 'number') return { ok: false, status: v, text: async () => '' };
        return { ok: true, status: 200, text: async () => v };
    });
}
function makeLogbook() {
    const lb = Object.create(Logbook.prototype);
    Object.assign(lb, { _nasrDb: { getAirport: async () => null }, _syncQueue: [], _activeTab: 'ml' });
    lb._body = document.createElement('div');
    return lb;
}
const entry = (id, over = {}) => ({ id, date: '2026-10-22', csvFilename: `${id}.csv`, custom_fields: {}, synced: true, ...over });
async function put(lb, ...es) { for (const e of es) await lb._saveEntry(e); }
async function putLog(lb, rec) {
    const db = await lb._openIdb();
    await new Promise((r) => { const tx = db.transaction(Logbook.IDB_ML_STORE, 'readwrite'); tx.objectStore(Logbook.IDB_ML_STORE).put(rec); tx.oncomplete = r; });
    db.close();
}
async function logs(lb, ids) { return lb._getMLRecords(ids); }

beforeEach(() => {
    localStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    DiagLog.log.mockClear();
    window.engineML = undefined;
});

describe('Logbook.mlFromCsv', () => {
    it('counts each EDM second once, skips rows before ML ran, a repeated header and short rows', () => {
        const csv = [H, H,
            row('1:16:27 PM', { ph: '', sc: '', an: '', lt: '' }),
            row('1:16:28 PM', { ph: 'taxi_out', sc: '' }),
            row('1:16:28 PM', { ph: 'taxi_out', sc: '' }),               // the same second written twice
            row('1:16:29 PM', { an: '1', lt: '4' }),
            row('1:16:31 PM'),
            '1:16:32 PM,short,row', ''].join('\n');
        const ml = Logbook.mlFromCsv(csv);
        expect(ml.summary).toEqual({
            samples: 3, duration_s: 4, anomaly_count: 1, anomaly_pct: 33, avg_latency_ms: 3,
            phase_dist: { taxi_out: 33, cruise: 67 }, advisory_count: null, source: 'csv',
        });
        // t from the first row (the recording's start), as in engineML's log
        expect(ml.samples).toEqual([
            { t: 1, ph: 'taxi_out', sc: null, an: 0, lt: 2 },
            { t: 2, ph: 'cruise', sc: 0.012, an: 1, lt: 4 },
            { t: 4, ph: 'cruise', sc: 0.012, an: 0, lt: 2 },
        ]);
    });

    it('the summary is what engineML would give for the same samples', () => {
        const ml = Logbook.mlFromCsv([H, row('1:00:00 PM', { ph: 'climb' }), row('1:00:02 PM', { an: '1', lt: '3' })].join('\n'));
        const bridge = new EngineMLBridge();
        bridge._log = ml.samples;
        const { advisory_count: _a, ...live } = bridge.getFlightSummary();
        const { advisory_count: _b, source: _s, ...fromCsv } = ml.summary;
        expect(fromCsv).toEqual(live);
    });

    it('across 00:00Z with the tablet date lagging -> no 24 h jump', () => {
        const ml = Logbook.mlFromCsv([H, row('11:59:59 PM'), row('12:00:01 AM')].join('\n'));
        expect(ml.samples.map((s) => s.t)).toEqual([0, 2]);
    });

    it('no ML data -> null', () => {
        expect(Logbook.mlFromCsv(H + '\n')).toBeNull();
        expect(Logbook.mlFromCsv('')).toBeNull();
        expect(Logbook.mlFromCsv('Zulu_Time,RPM\n1:00:00 PM,2400\n')).toBeNull();
        expect(Logbook.mlFromCsv([H, row('1:00:00 PM', { ph: '' })].join('\n'))).toBeNull();
        expect(Logbook.mlFromCsv([H, row('1:00:00 PM', { ph: '<b>x</b>' })].join('\n'))).toBeNull();
    });
});

describe('Logbook: rebuild from the CSV', () => {
    it('10/22 replay: no summary, no log -> both rebuilt into the ML store; the entry is not touched', async () => {
        const lb = makeLogbook();
        const e = entry('a');
        await put(lb, e);
        global.fetch = files({ 'a.csv': CSV });
        expect(await lb._rebuildMissingMLSummaries(await lb.getEntries())).toBe(1);
        const [stored] = await lb.getEntries();
        expect(stored).toEqual(e);                                       // synced, custom_fields as they were
        const rec = (await logs(lb, ['a'])).get('a');
        expect(rec.summary).toMatchObject({ samples: 2, anomaly_count: 1, source: 'csv' });
        expect(rec.samples.length).toBe(2);
        expect((await lb._rebuiltMLSummaries(await lb.getEntries())).get('a')).toEqual(rec.summary);
    });

    it('closed out with marker counts (summary, no log) -> only the per-second log is added', async () => {
        const lb = makeLogbook();
        await put(lb, entry('b', { custom_fields: { engineml_summary: { samples: 2 } } }));
        global.fetch = files({ 'b.csv': CSV });
        expect(await lb._rebuildMissingMLSummaries(await lb.getEntries())).toBe(0);
        const rec = (await logs(lb, ['b'])).get('b');
        expect(rec.summary).toBeUndefined();
        expect(rec.samples.length).toBe(2);
        expect(rec.samples_source).toBe('csv');
    });

    it('resumed (log shorter than the summary) -> the CSV log replaces it; a complete log is left alone', async () => {
        const lb = makeLogbook();
        await put(lb, entry('r', { custom_fields: { engineml_summary: { samples: 5 } } }),
            entry('ok', { custom_fields: { engineml_summary: { samples: 1 } } }));
        await putLog(lb, { id: 'r', captured_at: 'then', samples: [{ t: 9 }] });
        await putLog(lb, { id: 'ok', captured_at: 'then', samples: [{ t: 0 }] });
        global.fetch = files({ 'r.csv': CSV, 'ok.csv': CSV });
        await lb._rebuildMissingMLSummaries(await lb.getEntries());
        expect(global.fetch.mock.calls.map((c) => c[0])).toEqual([BASE + 'r.csv']);
        const recs = await logs(lb, ['r', 'ok']);
        expect(recs.get('r')).toMatchObject({ captured_at: 'then', samples_source: 'csv' });
        expect(recs.get('r').samples.length).toBe(2);
        expect(recs.get('ok').samples).toEqual([{ t: 0 }]);
    });

    it('only entries since 10/14 with a safe CSV name are fetched', async () => {
        const lb = makeLogbook();
        await put(lb, entry('old', { date: '2026-10-13' }), entry('bad', { csvFilename: '../x.csv' }),
            entry('none', { csvFilename: null }));
        global.fetch = files({});
        await lb._rebuildMissingMLSummaries(await lb.getEntries());
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('CSV without ML data -> not fetched again; CSV missing or a file server error -> tried again', async () => {
        const lb = makeLogbook();
        await put(lb, entry('gone'), entry('noml'), entry('err'));
        global.fetch = files({ 'noml.csv': H + '\n', 'err.csv': 500 });
        expect(await lb._rebuildMissingMLSummaries(await lb.getEntries())).toBe(0);
        global.fetch.mockClear();
        await lb._rebuildMissingMLSummaries(await lb.getEntries());
        expect(global.fetch.mock.calls.map((c) => c[0]).sort()).toEqual([BASE + 'err.csv', BASE + 'gone.csv']);
    });

    it('done once: a second run fetches nothing', async () => {
        const lb = makeLogbook();
        await put(lb, entry('a'));
        global.fetch = files({ 'a.csv': CSV });
        await lb._rebuildMissingMLSummaries(await lb.getEntries());
        global.fetch.mockClear();
        expect(await lb._rebuildMissingMLSummaries(await lb.getEntries())).toBe(0);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('two calls at once share one run', async () => {
        const lb = makeLogbook();
        await put(lb, entry('a'));
        global.fetch = files({ 'a.csv': CSV });
        const es = await lb.getEntries();
        expect(await Promise.all([lb._rebuildMissingMLSummaries(es), lb._rebuildMissingMLSummaries(es)])).toEqual([1, 1]);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('Logbook ML tab', () => {
    it('renders at once, rebuilds in the background, then shows the rebuilt flight', async () => {
        const lb = makeLogbook();
        await put(lb, entry('a', { departure_icao: 'KLKR', destination_icao: 'KORL' }));
        let release;
        global.fetch = vi.fn(() => new Promise((r) => { release = r; }));    // the file server is slow
        await lb._renderML();
        expect(lb._body.textContent).toContain('No Engine ML data recorded yet');
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
        release({ ok: true, status: 200, text: async () => CSV });
        await vi.waitFor(() => expect(lb._body.textContent).toContain('2026-10-22 KLKR→KORL'));
        expect(lb._body.textContent).toContain('2 samples');
        expect(lb._body.querySelector('.lb-ml-export-btn')?.dataset.entryId).toBe('a');
    });

    it('no re-render when the pilot left the ML tab meanwhile', async () => {
        const lb = makeLogbook();
        await put(lb, entry('a'));
        let release;
        global.fetch = vi.fn(() => new Promise((r) => { release = r; }));
        await lb._renderML();
        const render = vi.spyOn(lb, '_renderML');
        lb._activeTab = 'flights';
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
        release({ ok: true, status: 200, text: async () => CSV });
        await vi.waitFor(async () => expect((await logs(lb, ['a'])).get('a')?.summary).toBeTruthy());
        await new Promise((r) => setTimeout(r, 20));
        expect(render).not.toHaveBeenCalled();
    });
});
