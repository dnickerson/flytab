/**
 * Flight Upload sends the FIS-B weather log (<stem>_weather.ndjson) next to the CSV
 * and the traffic log, and "Upload All Pending" backfills companions for flights
 * whose CSV was already marked uploaded.
 *
 * SftpPlugin.upload() rejects the call with "File not found: <name>" when the local
 * file is missing (before any network use); the stub reproduces that. The
 * on-tablet server's /flights/list returns CSVs only, so existence of a companion is
 * probed with HEAD /flights/<name> (200 / 404).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const FlightUpload = new Function(
    readFileSync('web/cockpit/flight-upload.js', 'utf8') + '\nreturn FlightUpload;'
)();

const FLIGHTS_KEY = 'flytab_uploaded_flights';
const COMP_KEY = 'flytab_uploaded_companions';
const CFG = { host: 'h', username: 'u', port: 22, remotePath: '~/flights' };

let local;       // Set of file names present in the tablet's flights/ dir
let remote;      // Array of file names uploaded, in order
let uploadFails; // Set of file names whose SFTP upload returns {ok:false}
let flights;     // /flights/list payload

function setup({ files, list, uploaded = [], companions = null } = {}) {
    local = new Set(files);
    remote = [];
    uploadFails = new Set();
    flights = (list ?? files.filter(f => f.endsWith('.csv'))).map(name => ({ name, size_bytes: 10, modified_ms: 1 }));
    localStorage.clear();
    if (uploaded.length) localStorage.setItem(FLIGHTS_KEY, JSON.stringify(uploaded));
    if (companions) localStorage.setItem(COMP_KEY, JSON.stringify(companions));
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
        if (url.endsWith('/flights/list')) return { ok: true, status: 200, json: async () => flights };
        const name = url.split('/flights/')[1];
        expect(opts.method).toBe('HEAD');
        return local.has(name) ? { ok: true, status: 200 } : { ok: false, status: 404 };
    });
    globalThis.Capacitor = { Plugins: { Sftp: {
        getPassword: async () => ({ password: 'pw' }),
        upload: vi.fn(async ({ filename }) => {
            if (!local.has(filename)) throw new Error('File not found: ' + filename);
            if (uploadFails.has(filename)) return { ok: false, error: 'boom' };
            remote.push(filename);
            return { ok: true };
        }),
    } } };
    globalThis.CockpitConfig = { get: (k) => (k === 'flightUpload' ? CFG : undefined) };
    globalThis.DiagLog = { log: vi.fn() };
    globalThis.wireTap = (el, fn) => el.addEventListener('click', fn);
    globalThis.window.app = { showToast: vi.fn() };
    return new FlightUpload();
}
const stored = (k) => JSON.parse(localStorage.getItem(k) || '[]');
const rowFor = (fu, name) => { fu._render(); return fu._el.querySelector(`[data-filename="${name}"]`).closest('.fu-row'); };

describe('FlightUpload companions', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('single upload sends CSV, traffic and weather companions and records the companions', async () => {
        const fu = setup({ files: ['A.csv', 'A_traffic.ndjson', 'A_weather.ndjson'] });
        await fu._loadFlights();
        await fu._uploadOne('A.csv', rowFor(fu, 'A.csv'));
        expect(remote).toEqual(['A.csv', 'A_traffic.ndjson', 'A_weather.ndjson']);
        expect(stored(FLIGHTS_KEY)).toEqual(['A.csv']);
        expect(stored(COMP_KEY).sort()).toEqual(['A_traffic.ndjson', 'A_weather.ndjson']);
    });

    it('missing weather file is non-fatal, silent (no toast) and not recorded', async () => {
        const fu = setup({ files: ['A.csv', 'A_traffic.ndjson'] });
        await fu._loadFlights();
        await fu._uploadOne('A.csv', rowFor(fu, 'A.csv'));
        expect(remote).toEqual(['A.csv', 'A_traffic.ndjson']);
        expect(stored(FLIGHTS_KEY)).toEqual(['A.csv']);
        expect(stored(COMP_KEY)).toEqual(['A_traffic.ndjson']);
        expect(window.app.showToast).not.toHaveBeenCalled();
    });

    it('a failed companion upload is non-fatal, toast-free and not recorded', async () => {
        const fu = setup({ files: ['A.csv', 'A_weather.ndjson'] });
        uploadFails.add('A_weather.ndjson');
        await fu._loadFlights();
        await fu._uploadOne('A.csv', rowFor(fu, 'A.csv'));
        expect(stored(FLIGHTS_KEY)).toEqual(['A.csv']);
        expect(stored(COMP_KEY)).toEqual([]);
        expect(window.app.showToast).not.toHaveBeenCalled();
    });

    it('Upload All Pending uploads weather for pending flights', async () => {
        const fu = setup({ files: ['A.csv', 'A_weather.ndjson', 'B.csv'] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote.sort()).toEqual(['A.csv', 'A_weather.ndjson', 'B.csv']);
        expect(stored(FLIGHTS_KEY).sort()).toEqual(['A.csv', 'B.csv']);
        expect(stored(COMP_KEY)).toEqual(['A_weather.ndjson']);
    });

    it('Upload All Pending backfills an already-uploaded flight, once', async () => {
        const fu = setup({
            files: ['OLD.csv', 'OLD_weather.ndjson'],
            uploaded: ['OLD.csv'],
            companions: ['OLD_traffic.ndjson'],
        });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['OLD_weather.ndjson']);          // CSV is not re-sent
        expect(stored(FLIGHTS_KEY)).toEqual(['OLD.csv']);        // shape unchanged
        expect(stored(COMP_KEY).sort()).toEqual(['OLD_traffic.ndjson', 'OLD_weather.ndjson']);

        remote.length = 0;
        const fu2 = new FlightUpload();                           // fresh instance reads storage
        await fu2._loadFlights();
        await fu2._uploadAllPending();
        expect(remote).toEqual([]);
        expect(window.app.showToast).toHaveBeenLastCalledWith('No pending flights.', null, 2000);
    });

    it('does not send companions that do not exist locally and does not record them', async () => {
        const fu = setup({ files: ['OLD.csv'], uploaded: ['OLD.csv'] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(Capacitor.Plugins.Sftp.upload).not.toHaveBeenCalled();
        expect(stored(COMP_KEY)).toEqual([]);
    });

    it('a failed backfill upload is retried next time (not recorded)', async () => {
        const fu = setup({ files: ['OLD.csv', 'OLD_weather.ndjson'], uploaded: ['OLD.csv'] });
        uploadFails.add('OLD_weather.ndjson');
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(stored(COMP_KEY)).toEqual([]);
        uploadFails.clear();
        await fu._uploadAllPending();
        expect(remote).toEqual(['OLD_weather.ndjson']);
        expect(stored(COMP_KEY)).toEqual(['OLD_weather.ndjson']);
    });

    it('a CSV failure stops the run and its companions are not sent', async () => {
        const fu = setup({ files: ['A.csv', 'A_weather.ndjson'] });
        uploadFails.add('A.csv');
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual([]);
        expect(stored(FLIGHTS_KEY)).toEqual([]);
        expect(stored(COMP_KEY)).toEqual([]);
    });
});
