/**
 * Flight Upload copies airport notes to the home machine.
 *
 * Upload All Pending (and a single flight upload) sends every note in
 * Documents/FlyTab/notes/ (TileServer GET /notes/list) whose size or modified time
 * differs from what was last uploaded, to <remotePath>/notes/<ID>.txt (SftpPlugin
 * upload with dir 'notes'), through the shared server host-key check SftpHostKey.run.
 * What was sent is kept in localStorage flytab_uploaded_notes: { "SC76.txt": "<size>:<mtime>" },
 * updated only on a confirmed ok. Deleted notes are not deleted remotely.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

const FlightUpload = new Function(
    readFileSync('web/cockpit/flight-upload.js', 'utf8') + '\nreturn FlightUpload;'
)();

const NOTES_KEY = 'flytab_uploaded_notes';
const CFG = { host: 'h', username: 'u', port: 22, remotePath: '~/flights' };

let local, remote, uploads, notesList, notesMode, failNotes;

function setup({ files = [], notes = [], uploadedNotes = null, uploaded = [], mode = 'ok', hostKey = true } = {}) {
    document.body.innerHTML = '';
    localStorage.clear();
    local = new Set(files);
    remote = [];
    uploads = [];
    notesList = notes;                 // [{ name, size_bytes, modified_ms }]
    notesMode = mode;
    failNotes = new Map();             // name -> result | Error
    if (uploaded.length) localStorage.setItem('flytab_uploaded_flights', JSON.stringify(uploaded));
    if (uploadedNotes) localStorage.setItem(NOTES_KEY, JSON.stringify(uploadedNotes));
    globalThis.fetch = vi.fn(async (url) => {
        if (url.endsWith('/flights/list')) {
            return { ok: true, status: 200, json: async () => files.filter(f => f.endsWith('.csv')).map(name => ({ name, size_bytes: 1, modified_ms: 1 })) };
        }
        if (url.endsWith('/flights/logs')) return { ok: true, status: 200, json: async () => [] };
        if (url.endsWith('/notes/list')) {
            if (notesMode === '503') return { ok: false, status: 503, text: async () => 'storage-permission', json: async () => ({}) };
            if (notesMode === '404') return { ok: false, status: 404, text: async () => 'Not found', json: async () => ({}) };
            if (notesMode === 'throw') throw new TypeError('Failed to fetch');
            if (notesMode === 'garbage') return { ok: true, status: 200, json: async () => ({ not: 'a list' }) };
            return { ok: true, status: 200, json: async () => notesList };
        }
        const name = decodeURIComponent(url.split('/flights/')[1] || '');
        return local.has(name) ? { ok: true, status: 200 } : { ok: false, status: 404 };
    });
    globalThis.Capacitor = { Plugins: { Sftp: {
        getPassword: async () => ({ password: 'pw' }),
        upload: vi.fn(async (args) => {
            uploads.push(args);
            const { filename, dir } = args;
            if (dir === 'notes') {
                const f = failNotes.get(filename);
                if (f instanceof Error) throw f;
                if (f) return f;
                if (!notesList.some(n => n?.name === filename)) throw new Error('File not found: ' + filename);
                remote.push('notes/' + filename);
                return { ok: true };
            }
            if (!local.has(filename)) throw new Error('File not found: ' + filename);
            remote.push(filename);
            return { ok: true };
        }),
    } } };
    if (hostKey) globalThis.SftpHostKey = { run: vi.fn((op) => op()) };
    else delete globalThis.SftpHostKey;
    globalThis.CockpitConfig = { get: (k) => (k === 'flightUpload' ? CFG : undefined) };
    globalThis.DiagLog = { log: vi.fn() };
    globalThis.wireTap = (el, fn) => el.addEventListener('click', fn);
    globalThis.window.app = { showToast: vi.fn() };
    return new FlightUpload();
}
const storedNotes = () => JSON.parse(localStorage.getItem(NOTES_KEY) || '{}');
const lastToast = () => String(window.app.showToast.mock.calls.at(-1)?.[0] ?? '');
const note = (name, size, mtime) => ({ name, size_bytes: size, modified_ms: mtime });

describe('Upload All Pending: airport notes', () => {
    it('uploads new and changed notes to notes/ through SftpHostKey, skips unchanged ones', async () => {
        const fu = setup({
            notes: [note('KLKR.txt', 10, 200), note('SC76.txt', 3, 100), note('KCLT.txt', 7, 50)],
            uploadedNotes: { 'SC76.txt': '3:100', 'KLKR.txt': '10:150' },
        });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote.sort()).toEqual(['notes/KCLT.txt', 'notes/KLKR.txt']);
        for (const u of uploads) {
            expect(u).toMatchObject({ dir: 'notes', host: 'h', username: 'u', port: 22, remotePath: '~/flights', password: 'pw' });
        }
        expect(SftpHostKey.run).toHaveBeenCalledTimes(2);
        expect(SftpHostKey.run.mock.calls[0][1]).toEqual({ action: 'Upload' });
        expect(storedNotes()).toEqual({ 'SC76.txt': '3:100', 'KLKR.txt': '10:200', 'KCLT.txt': '7:50' });
        expect(lastToast()).toMatch(/2 notes/);
    });

    it('a note with the same mtime but a different size is changed', async () => {
        const fu = setup({ notes: [note('SC76.txt', 4, 100)], uploadedNotes: { 'SC76.txt': '3:100' } });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['notes/SC76.txt']);
    });

    it('nothing changed: nothing sent, the usual "No pending flights." toast', async () => {
        const fu = setup({ notes: [note('SC76.txt', 3, 100)], uploadedNotes: { 'SC76.txt': '3:100' } });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(uploads).toEqual([]);
        expect(window.app.showToast).toHaveBeenLastCalledWith('No pending flights.', null, 2000);
    });

    it('records a note only on a confirmed ok; a failure is counted in the toast and retried next time', async () => {
        const fu = setup({ notes: [note('KLKR.txt', 2, 2), note('SC76.txt', 3, 3)] });
        failNotes.set('KLKR.txt', { ok: false, error: 'Permission denied' });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(storedNotes()).toEqual({ 'SC76.txt': '3:3' });
        expect(lastToast()).toMatch(/1 note/);
        expect(lastToast()).toMatch(/1 note failed/);
        failNotes.clear();
        await fu._uploadAllPending();
        expect(storedNotes()).toEqual({ 'SC76.txt': '3:3', 'KLKR.txt': '2:2' });
    });

    it('a thrown upload error is a failure too (not recorded)', async () => {
        const fu = setup({ notes: [note('SC76.txt', 3, 3)] });
        failNotes.set('SC76.txt', new Error('Auth fail'));
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(storedNotes()).toEqual({});
        expect(lastToast()).toMatch(/1 note failed/);
    });

    it('a note deleted since the listing is skipped quietly (not a failure, not recorded)', async () => {
        const fu = setup({ notes: [note('SC76.txt', 3, 3)] });
        failNotes.set('SC76.txt', new Error('File not found: SC76.txt'));
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(storedNotes()).toEqual({});
        expect(lastToast()).not.toMatch(/failed/);
    });

    it('a server host-key stop ends the run and records nothing more', async () => {
        const fu = setup({ notes: [note('KLKR.txt', 2, 2), note('SC76.txt', 3, 3)] });
        failNotes.set('KLKR.txt', { ok: false, error: 'Unknown server key', hostKeyHandled: true });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(uploads.map(u => u.filename)).toEqual(['KLKR.txt']);
        expect(storedNotes()).toEqual({});
    });

    it('ignores unsafe or non-note names from the listing', async () => {
        const bad = ['../x.txt', 'sc76.txt', 'SC76.TXT', 'SC76.txt.tmp', 'S.txt', 'TOOLONGX.txt', 'a/b.txt', '<img src=x>.txt'];
        const fu = setup({ notes: [...bad.map(n => note(n, 1, 1)), note('SC76.txt', 3, 3), null, 42, { name: 7 }] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(uploads.map(u => u.filename)).toEqual(['SC76.txt']);
    });

    it('flight files are still sent as before (no dir), then the notes', async () => {
        const fu = setup({ files: ['20261101_KLKR-SC76.csv'], notes: [note('SC76.txt', 3, 3)] });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(uploads[0]).not.toHaveProperty('dir');
        expect(uploads[0].filename).toBe('20261101_KLKR-SC76.csv');
        expect(uploads[1]).toMatchObject({ filename: 'SC76.txt', dir: 'notes' });
        expect(lastToast()).toMatch(/1 flight \+ 1 note/);
        expect(JSON.parse(localStorage.getItem('flytab_uploaded_flights'))).toEqual(['20261101_KLKR-SC76.csv']);
        expect(localStorage.getItem('flytab_uploaded_companions')).toBeNull();
    });

    it('notes that could not be listed (no storage permission) are reported, flights still go', async () => {
        const fu = setup({ files: ['A.csv'], mode: '503' });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['A.csv']);
        expect(lastToast()).toMatch(/notes could not be checked/i);
    });

    for (const mode of ['404', 'garbage']) {
        it(`a /notes/list that is missing (${mode}) means no notes, silently`, async () => {
            const fu = setup({ files: ['A.csv'], mode });
            await fu._loadFlights();
            await fu._uploadAllPending();
            expect(remote).toEqual(['A.csv']);
            expect(lastToast()).not.toMatch(/notes/i);
        });
    }

    it('a damaged flytab_uploaded_notes value is treated as empty (everything re-sent once)', async () => {
        const fu0 = setup({ notes: [note('SC76.txt', 3, 3)] });
        localStorage.setItem(NOTES_KEY, '["not","an","object"]');
        const fu = new FlightUpload();
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['notes/SC76.txt']);
        expect(storedNotes()).toEqual({ 'SC76.txt': '3:3' });
        void fu0;
    });

    it('no SftpHostKey loaded: the plugin is still called directly', async () => {
        const fu = setup({ notes: [note('SC76.txt', 3, 3)], hostKey: false });
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(remote).toEqual(['notes/SC76.txt']);
    });
});

describe('single flight upload: notes too', () => {
    it('after the flight, changed notes are sent', async () => {
        const fu = setup({ files: ['A.csv'], notes: [note('SC76.txt', 3, 3)] });
        await fu._loadFlights();
        fu._render();
        const row = fu._el.querySelector('.fu-row');
        await fu._uploadOne('A.csv', row);
        expect(remote).toEqual(['A.csv', 'notes/SC76.txt']);
        expect(storedNotes()).toEqual({ 'SC76.txt': '3:3' });
    });

    it('a failed note after a single flight upload is shown', async () => {
        const fu = setup({ files: ['A.csv'], notes: [note('SC76.txt', 3, 3)] });
        failNotes.set('SC76.txt', { ok: false, error: 'nope' });
        await fu._loadFlights();
        fu._render();
        await fu._uploadOne('A.csv', fu._el.querySelector('.fu-row'));
        expect(lastToast()).toMatch(/1 note failed/);
    });
});
