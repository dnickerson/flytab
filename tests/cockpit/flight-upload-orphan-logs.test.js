/**
 * Weather / traffic logs with no matching CSV are exported.
 *
 * After a mid-flight FlyTab restart or a failed rename a log keeps its start-time
 * name (<ymd>_<hm>Z_weather.ndjson) and no CSV matches it, so the CSV-driven
 * backfill never saw it. TileServer's GET /flights/logs lists the flights folder's
 * *.ndjson files (same shape as /flights/list, which still lists CSVs only), and
 * Upload All Pending sends every *_weather.ndjson / *_traffic.ndjson in it that is
 * not yet in flytab_uploaded_companions. The log being written right now is skipped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const FlightUpload = new Function(
    readFileSync('web/cockpit/flight-upload.js', 'utf8') + '\nreturn FlightUpload;'
)();

const COMP_KEY = 'flytab_uploaded_companions';
const CFG = { host: 'h', username: 'u', port: 22, remotePath: '~/flights' };

let local, remote, logsList, logsMode, fetched;

function setup({ files, uploaded = [], companions = null, logs = undefined, mode = 'ok' } = {}) {
    document.body.innerHTML = '';
    localStorage.clear();
    local = new Set(files);
    remote = [];
    fetched = [];
    logsMode = mode;
    // Default: what the endpoint would list for the folder
    logsList = logs ?? files.filter(f => f.endsWith('.ndjson'));
    if (uploaded.length) localStorage.setItem('flytab_uploaded_flights', JSON.stringify(uploaded));
    if (companions) localStorage.setItem(COMP_KEY, JSON.stringify(companions));
    globalThis.fetch = vi.fn(async (url) => {
        fetched.push(url);
        if (url.endsWith('/flights/list')) {
            return { ok: true, status: 200, json: async () => files.filter(f => f.endsWith('.csv')).map(name => ({ name, size_bytes: 1, modified_ms: 1 })) };
        }
        if (url.endsWith('/flights/logs')) {
            if (logsMode === 'throw') throw new TypeError('Failed to fetch');
            if (logsMode === '404') return { ok: false, status: 404, json: async () => ({}) };
            if (logsMode === 'garbage') return { ok: true, status: 200, json: async () => ({ not: 'an array' }) };
            return { ok: true, status: 200, json: async () => logsList.map(name => ({ name, size_bytes: 5, modified_ms: 2 })) };
        }
        const name = decodeURIComponent(url.split('/flights/')[1]);
        return local.has(name) ? { ok: true, status: 200 } : { ok: false, status: 404 };
    });
    globalThis.Capacitor = { Plugins: { Sftp: {
        getPassword: async () => ({ password: 'pw' }),
        upload: vi.fn(async ({ filename }) => {
            if (!local.has(filename)) throw new Error('File not found: ' + filename);
            remote.push(filename);
            return { ok: true };
        }),
    } } };
    delete globalThis.SftpHostKey;
    globalThis.CockpitConfig = { get: (k) => (k === 'flightUpload' ? CFG : undefined) };
    globalThis.DiagLog = { log: vi.fn() };
    globalThis.wireTap = (el, fn) => el.addEventListener('click', fn);
    globalThis.window.app = { showToast: vi.fn() };
    return new FlightUpload();
}
const stored = (k) => JSON.parse(localStorage.getItem(k) || '[]');

describe('Upload All Pending: weather / traffic logs with no matching CSV', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('uploads an orphan weather log and records it', async () => {
        const fu = setup({ files: ['20261101_KLKR-KFDK.csv', '20261101_1430Z_weather.ndjson'], uploaded: ['20261101_KLKR-KFDK.csv'] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['20261101_1430Z_weather.ndjson']);
        expect(stored(COMP_KEY)).toEqual(['20261101_1430Z_weather.ndjson']);
        expect(fetched.some(u => u.endsWith('/flights/logs'))).toBe(true);
    });

    it('uploads an orphan traffic log too, with no CSV at all in the folder', async () => {
        const fu = setup({ files: ['20261101_1430Z_traffic.ndjson', '20261101_1430Z_weather.ndjson'] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote.sort()).toEqual(['20261101_1430Z_traffic.ndjson', '20261101_1430Z_weather.ndjson']);
        expect(window.app.showToast).not.toHaveBeenCalledWith('No pending flights.', null, 2000);
    });

    it('does not re-send a log already recorded as uploaded', async () => {
        const fu = setup({ files: ['20261101_1430Z_weather.ndjson'], companions: ['20261101_1430Z_weather.ndjson'] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual([]);
        expect(window.app.showToast).toHaveBeenLastCalledWith('No pending flights.', null, 2000);
    });

    it('a companion of a CSV that is also listed is sent once', async () => {
        const fu = setup({ files: ['A.csv', 'A_weather.ndjson'] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['A.csv', 'A_weather.ndjson']);
    });

    it('ignores names that are not *_weather.ndjson / *_traffic.ndjson or are unsafe', async () => {
        const bad = ['../x_weather.ndjson', 'a/b_weather.ndjson', 'x_weather.ndjson.tmp', 'notes.ndjson',
            'a..b_traffic.ndjson', 'a b_weather.ndjson', '<img src=x>_weather.ndjson'];
        const fu = setup({ files: [...bad, 'ok_weather.ndjson'], logs: [...bad, 'ok_weather.ndjson', 42, null] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['ok_weather.ndjson']);
    });

    it('skips the weather and traffic logs being written right now', async () => {
        const fu = setup({ files: ['20261101_1500Z_weather.ndjson', '20261101_1500Z_traffic.ndjson', '20261101_1430Z_weather.ndjson'] });
        window.app.fisbLogger = { _fileName: '20261101_1500Z_weather.ndjson' };
        window.app.flightRecorder = { recording: true, _trafficFileName: '20261101_1500Z_traffic.ndjson' };
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['20261101_1430Z_weather.ndjson']);
    });

    it('a stopped recorder does not hide its (finished) traffic log', async () => {
        const fu = setup({ files: ['20261101_1500Z_traffic.ndjson'] });
        window.app.flightRecorder = { recording: false, _trafficFileName: '20261101_1500Z_traffic.ndjson' };
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['20261101_1500Z_traffic.ndjson']);
    });

    for (const mode of ['404', 'throw', 'garbage']) {
        it(`an unavailable /flights/logs (${mode}, e.g. an older APK) leaves the CSV backfill working`, async () => {
            const fu = setup({ files: ['A.csv', 'A_weather.ndjson', 'B_weather.ndjson'], mode });
            await fu._loadFlights();
            await fu._uploadAllPending();
            expect(remote).toEqual(['A.csv', 'A_weather.ndjson']);
        });
    }

    it('/flights/list is still what fills the flight list (CSV rows only)', async () => {
        const fu = setup({ files: ['A.csv', '20261101_1430Z_weather.ndjson'] });
        await fu._loadFlights();
        fu._render();
        expect([...fu._el.querySelectorAll('.fu-filename')].map(e => e.textContent)).toEqual(['A.csv']);
    });
});
