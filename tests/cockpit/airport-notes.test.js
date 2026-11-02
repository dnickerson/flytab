/**
 * Airport notes: a NOTES tab right after INFO on every airport panel.
 *
 * Dana's example: SC76 (Unity Aerodrome), private 2,600 ft grass strip, uphill to
 * the NE, owners' arrival/departure, "land 3, take off 21". One UTF-8 text file per
 * airport at Documents/FlyTab/notes/<ID>.txt through TileServer (GET / PUT / DELETE
 * /notes/<ID>.txt), so it survives Clear Data and reinstall.
 *
 * Safety: the box is read-only until the note has been read (200) or confirmed
 * absent (404); any other read result locks it with a message and nothing is ever
 * written. Writes are one at a time per airport, latest text wins; a failed write
 * shows an error and keeps the text. Text is shown via textarea.value only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
globalThis.wireTap = wireTap;
const { AirportNotes, AirportNoteEditor } = new Function(
    read('web/cockpit/airport-notes.js') + '\nreturn { AirportNotes, AirportNoteEditor };')();
globalThis.AirportNotes = AirportNotes;
globalThis.AirportNoteEditor = AirportNoteEditor;
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();

const BASE = 'http://localhost:9090/notes/';
const SC76 = { icao: 'SC76', name: 'UNITY AERODROME', city: 'LANCASTER', state: 'SC', lat: 34.8, lon: -80.7,
    elev_ft: 560, runways: [{ id: '03/21', length_ft: 2600, width_ft: 100, surface: 'TURF' }], frequencies: [] };
const KLKR = { icao: 'KLKR', name: 'LANCASTER CO', lat: 34.72, lon: -80.85, elev_ft: 486, runways: [], frequencies: [] };

let files, requests, mode, deferred, failBodies;

/** A Response-like object as fetch returns it. */
const resp = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

function installFetch() {
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        requests.push({ method, url, body: opts.body });
        if (!String(url).startsWith(BASE)) return resp(404);
        const name = decodeURIComponent(String(url).slice(BASE.length));
        if (deferred[method]) { const d = deferred[method]; delete deferred[method]; await d.promise; }
        if (method === 'GET') {
            if (mode.read === 'throw') throw new TypeError('Failed to fetch');
            if (mode.read) return resp(mode.read.status, mode.read.body);
            return files.has(name) ? resp(200, files.get(name)) : resp(404, 'No note');
        }
        if (method === 'PUT') {
            if (mode.put === 'throw') throw new TypeError('Failed to fetch');
            if (mode.put) return resp(mode.put.status, mode.put.body);
            if (failBodies.has(opts.body)) return resp(500, 'Write failed: rename failed');
            files.set(name, opts.body);
            return resp(201, 'OK');
        }
        if (method === 'DELETE') {
            if (!files.has(name)) return resp(404, 'No note');
            files.delete(name);
            return resp(200, 'Deleted');
        }
        return resp(405);
    });
}

function defer(method) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    deferred[method] = { promise };
    return resolve;
}

function newPopup() {
    const p = new AirportPopup({ closePopup() {} }, { getWeather: async () => null });
    p.initPanel(document.body);
    return p;
}

/** Let the read (and any queued write) settle. */
async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

const ta = () => document.querySelector('.apt-notes-text');
const status = () => document.querySelector('.apt-notes-status');
const notesTab = () => document.querySelector('.apt-tab[data-tab="notes"]');
const label = () => notesTab().textContent.replace('●', ' ●').replace(/\s+/g, ' ').trim();
const writes = () => requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE');
function type(text) {
    const el = ta();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
    document.body.innerHTML = '';
    files = new Map();
    requests = [];
    mode = {};
    deferred = {};
    failBodies = new Set();
    AirportNotes._chains.clear();
    AirportNoteEditor._loops.clear();
    AirportNotes._unsaved.clear();
    installFetch();
    globalThis.NasrDB = { haversineNm: () => 5 };
    globalThis.CockpitConfig = { get: () => null };
    globalThis.window.app = { showToast: vi.fn() };
});
afterEach(() => {
    vi.useRealTimers();
    delete globalThis.NasrDB;
    delete globalThis.CockpitConfig;
});

describe('NOTES tab', () => {
    it('comes right after INFO', () => {
        newPopup()._showPanel(SC76, null);
        expect([...document.querySelectorAll('.apt-tab')].map((t) => t.dataset.tab))
            .toEqual(['info', 'notes', 'wx', 'rwy', 'wind', 'diag', 'afd']);
        expect(notesTab().textContent.trim()).toBe('NOTES');
        expect(document.querySelector('.apt-tab-pane[data-pane="notes"]')).not.toBeNull();
    });

    it('shows ● when the airport has a non-empty note, and not otherwise', async () => {
        files.set('SC76.txt', 'Land 3, take off 21.');
        files.set('KLKR.txt', '   \n');
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        expect(label()).toBe('NOTES ●');
        p._showPanel(KLKR, null);
        await settle();
        expect(label()).toBe('NOTES');
        p._showPanel({ ...KLKR, icao: 'KCLT' }, null);
        await settle();
        expect(label()).toBe('NOTES');
    });

    it('the ● follows what is saved: appears after the first save, goes when the note is cleared', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        type('Owners: arrive left downwind 3');
        await p._notes.flush();
        expect(label()).toBe('NOTES ●');
        type('');
        await p._notes.flush();
        expect(label()).toBe('NOTES');
    });

    it('the ● sits in a fixed slot that is always there, so adding it does not shift the tabs', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        const slot = notesTab().querySelector('.apt-tab-dot');
        expect(slot).not.toBeNull();
        expect(slot.getAttribute('aria-hidden')).toBe('true');
        expect(slot.textContent).toBe('');
        await settle();
        type('x');
        await p._notes.flush();
        expect(notesTab().querySelector('.apt-tab-dot')).toBe(slot);   // same element, only its text changes
        expect(slot.textContent).toBe('●');
        expect(notesTab().getAttribute('aria-label')).toBe('Notes (has a note)');
    });

    it('a tapped tab is scrolled into view in the tab row', () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        const bar = document.querySelector('.apt-tabs');
        const afd = document.querySelector('.apt-tab[data-tab="afd"]');
        // jsdom has no layout: give the row and the tab boxes
        bar.getBoundingClientRect = () => ({ left: 0, right: 300, width: 300 });
        afd.getBoundingClientRect = () => ({ left: 280, right: 330, width: 50 });
        bar.scrollLeft = 0;
        afd.click();
        expect(bar.scrollLeft).toBe(30);
        const info = document.querySelector('.apt-tab[data-tab="info"]');
        info.getBoundingClientRect = () => ({ left: -30, right: 10, width: 40 });
        info.click();
        expect(bar.scrollLeft).toBe(0);
    });

    it('reads Documents/FlyTab/notes/<ID>.txt through TileServer', async () => {
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(requests[0]).toMatchObject({ method: 'GET', url: 'http://localhost:9090/notes/SC76.txt' });
    });
});

describe('reading', () => {
    it('no note yet (404): the box is empty and editable', async () => {
        newPopup()._showPanel(SC76, null);
        expect(ta().readOnly).toBe(true);            // locked until the read answers
        await settle();
        expect(ta().readOnly).toBe(false);
        expect(ta().value).toBe('');
        expect(status().classList.contains('is-error')).toBe(false);
    });

    it('an existing note fills the box', async () => {
        files.set('SC76.txt', 'Uphill to the NE.\nLand 3, take off 21.');
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(ta().value).toBe('Uphill to the NE.\nLand 3, take off 21.');
        expect(ta().readOnly).toBe(false);
    });

    for (const [label, read] of [
        ['no storage permission (503 storage-permission)', { status: 503, body: 'storage-permission' }],
        ['a server error (500)', { status: 500, body: 'Read failed' }],
        ['a link refused (403)', { status: 403, body: 'Not a plain file' }],
        ['the file server not answering', 'throw'],
    ]) {
        it(`read fails with ${label}: locked with a message, and NO write is ever sent even if the pilot types`, async () => {
            vi.useFakeTimers();
            files.set('SC76.txt', 'the real note');
            mode.read = read;
            const p = newPopup();
            p._showPanel(SC76, null);
            await vi.advanceTimersByTimeAsync(10);
            expect(ta().readOnly).toBe(true);
            expect(status().classList.contains('is-error')).toBe(true);
            expect(status().textContent).toMatch(/can.t be read/i);
            // The pilot types anyway (or something sets the value): nothing is saved.
            type('');
            type('oops');
            await vi.advanceTimersByTimeAsync(5000);
            document.querySelector('.apt-tab[data-tab="wx"]').click();
            p.close();
            await vi.advanceTimersByTimeAsync(5000);
            expect(writes()).toEqual([]);
            expect(files.get('SC76.txt')).toBe('the real note');
        });
    }

    it('names the storage permission when that is the cause', async () => {
        mode.read = { status: 503, body: 'storage-permission' };
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(status().textContent).toMatch(/storage permission needed/i);
    });

    it('nothing is written before the read has completed', async () => {
        vi.useFakeTimers();
        const release = defer('GET');
        const p = newPopup();
        p._showPanel(SC76, null);
        type('typed before the read');
        await vi.advanceTimersByTimeAsync(3000);
        p.close();
        await vi.advanceTimersByTimeAsync(3000);
        expect(writes()).toEqual([]);
        release();
        await vi.advanceTimersByTimeAsync(3000);
        expect(writes()).toEqual([]);
    });

    it('note text is shown as text, never as HTML', async () => {
        const evil = '<img src=x onerror="window.__notesXss=1"><b>bold</b>';
        files.set('SC76.txt', evil);
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(ta().value).toBe(evil);
        const pane = document.querySelector('.apt-tab-pane[data-pane="notes"]');
        expect(pane.querySelector('img')).toBeNull();
        expect(pane.querySelector('b')).toBeNull();
        expect(window.__notesXss).toBeUndefined();
    });
});

describe('autosave', () => {
    it('one PUT with the latest text ~1 s after typing stops', async () => {
        vi.useFakeTimers();
        newPopup()._showPanel(SC76, null);
        await vi.advanceTimersByTimeAsync(10);
        type('L');
        await vi.advanceTimersByTimeAsync(300);
        type('Land');
        await vi.advanceTimersByTimeAsync(300);
        type('Land 3, take off 21');
        await vi.advanceTimersByTimeAsync(999);
        expect(writes()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(10);
        expect(writes()).toEqual([{ method: 'PUT', url: 'http://localhost:9090/notes/SC76.txt', body: 'Land 3, take off 21' }]);
        expect(files.get('SC76.txt')).toBe('Land 3, take off 21');
        expect(status().textContent).toMatch(/saved/i);
    });

    it('saves at once on a tab switch', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        type('switching tabs');
        document.querySelector('.apt-tab[data-tab="wx"]').click();
        await settle();
        expect(files.get('SC76.txt')).toBe('switching tabs');
    });

    it('saves at once when the panel is closed', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        type('closing');
        p.close();
        await settle();
        expect(files.get('SC76.txt')).toBe('closing');
    });

    it('saves at once when the panel is replaced by another airport (and the new one reads its own note)', async () => {
        files.set('KLKR.txt', 'home');
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        type('replaced');
        p._showPanel(KLKR, null);
        await settle();
        expect(files.get('SC76.txt')).toBe('replaced');
        expect(ta().value).toBe('home');
    });

    it('saves when the search panel replaces it', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        type('then search');
        p._showSearchPanel();
        await settle();
        expect(files.get('SC76.txt')).toBe('then search');
    });

    it('no change, no write', async () => {
        files.set('SC76.txt', 'same');
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        document.querySelector('.apt-tab[data-tab="wx"]').click();
        p.close();
        await settle();
        expect(writes()).toEqual([]);
    });

    it('deleting all the text removes the file (DELETE)', async () => {
        files.set('SC76.txt', 'old note');
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        type('');
        await p._notes.flush();
        expect(writes()).toEqual([{ method: 'DELETE', url: 'http://localhost:9090/notes/SC76.txt', body: undefined }]);
        expect(files.has('SC76.txt')).toBe(false);
    });

    it('a failed PUT shows an error, keeps the text, and the next change retries', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        mode.put = { status: 500, body: 'Write failed: disk full' };
        type('do not lose me');
        await p._notes.flush();
        expect(status().classList.contains('is-error')).toBe(true);
        expect(status().textContent).toMatch(/not saved/i);
        expect(ta().value).toBe('do not lose me');
        expect(files.has('SC76.txt')).toBe(false);
        mode.put = null;
        type('do not lose me!');
        await p._notes.flush();
        expect(files.get('SC76.txt')).toBe('do not lose me!');
        expect(status().classList.contains('is-error')).toBe(false);
    });

    it('a failed PUT is retried on close', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        mode.put = 'throw';
        type('retry on close');
        await p._notes.flush();
        expect(files.has('SC76.txt')).toBe(false);
        mode.put = null;
        p.close();
        await settle();
        expect(files.get('SC76.txt')).toBe('retry on close');
    });

    it('a save that fails after the panel closed tells the pilot and the text comes back on reopen', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        mode.put = { status: 503, body: 'storage-permission' };
        type('Land 3, take off 21');
        p.close();
        await settle();
        expect(window.app.showToast).toHaveBeenCalled();
        expect(String(window.app.showToast.mock.calls[0][0])).toMatch(/SC76.*not saved/i);
        mode.put = null;
        p._showPanel(SC76, null);
        await settle();
        expect(ta().value).toBe('Land 3, take off 21');
        await p._notes.flush();
        expect(files.get('SC76.txt')).toBe('Land 3, take off 21');
    });

    it('writes are one at a time per airport, and the latest text wins', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const release = defer('PUT');
        type('a');
        const first = p._notes.flush();
        await settle();
        type('ab');
        p._notes.flush();
        type('abc');
        p._notes.flush();
        await settle();
        expect(writes().map((w) => w.body)).toEqual(['a']);       // the second waits for the first
        release();
        await first;
        await settle();
        expect(writes().map((w) => w.body)).toEqual(['a', 'abc']);
        expect(files.get('SC76.txt')).toBe('abc');
    });

    it('reopening the SAME airport while its save loop runs: the new box gets the final text, and it stays on disk', async () => {
        // Review 2026-11-01: W1 in flight, more typing, panel replaced by the same airport ->
        // the new box's read was queued between W1 and W2, showed stale text, and its next save
        // overwrote the newer note (GET, PUT W1, GET(B), PUT W2, PUT(B)).
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const release = defer('PUT');
        type('Pattern 1500. CTAF 123.0');
        p._notes.flush();                                 // W1 held (slow storage)
        await settle();
        type('Pattern 1500. CTAF 123.0. Avoid town to the N');
        p._showPanel(SC76, null);                         // same airport tapped again
        await settle();
        expect(ta().readOnly).toBe(true);
        release();
        await settle();
        expect(ta().value).toBe('Pattern 1500. CTAF 123.0. Avoid town to the N');
        expect(ta().readOnly).toBe(false);
        expect(files.get('SC76.txt')).toBe('Pattern 1500. CTAF 123.0. Avoid town to the N');
        type(ta().value + ' RWY 6 pref');
        await p._notes.flush();
        expect(files.get('SC76.txt')).toBe('Pattern 1500. CTAF 123.0. Avoid town to the N RWY 6 pref');
        expect(requests.map((r) => r.method)).toEqual(['GET', 'PUT', 'PUT', 'GET', 'PUT']);
    });

    it('a last write that fails after the panel was replaced by the same airport comes back in the new box', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const release = defer('PUT');
        type('first');
        p._notes.flush();                                 // W1 held, will succeed
        await settle();
        type('first and second');
        failBodies.add('first and second');               // W2 fails
        p._showPanel(SC76, null);
        await settle();
        release();
        await settle();
        expect(files.get('SC76.txt')).toBe('first');
        expect(ta().value).toBe('first and second');      // not lost: offered again ...
        failBodies.clear();
        await p._notes.flush();
        await settle();
        expect(files.get('SC76.txt')).toBe('first and second');   // ... and saved
        expect(AirportNotes._unsaved.has('SC76')).toBe(false);
    });

    it('reopening the airport while its save is in flight reads after the save', async () => {
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const release = defer('PUT');
        type('newest');
        p.close();
        await settle();
        p._showPanel(SC76, null);
        await settle();
        expect(requests.filter((r) => r.method === 'GET').length).toBe(1);   // the reopen's GET waits
        expect(ta().readOnly).toBe(true);
        release();
        await settle();
        expect(ta().value).toBe('newest');
        expect(ta().readOnly).toBe(false);
    });
});

describe('airport ID', () => {
    it('only [A-Z0-9]{2,7} after upper-casing', () => {
        expect(AirportNotes.normId('SC76')).toBe('SC76');
        expect(AirportNotes.normId('klkr')).toBe('KLKR');
        expect(AirportNotes.normId('ABCDEFG')).toBe('ABCDEFG');
        for (const bad of ['../x', 'SC76/../K', 'SC76/', '..', 'S', 'ABCDEFGH', 'SC 76', 'SC76.txt', 'SC76\n',
            '%2e%2e', 'SC-76', '', null, undefined, 42, {}]) {
            expect(AirportNotes.normId(bad)).toBeNull();
        }
    });

    for (const icao of ['../x', 'SC76/../K', '..%2Fflights', 'TOOLONG1', '', undefined]) {
        it(`"${icao}": no request, and the tab says notes are not available`, async () => {
            const p = newPopup();
            p._showPanel({ ...SC76, icao }, null);
            await settle();
            expect(requests).toEqual([]);
            expect(ta()).toBeNull();
            expect(document.querySelector('.apt-tab-pane[data-pane="notes"]').textContent)
                .toMatch(/notes not available for this airport/i);
        });
    }

    it('the store refuses a bad ID without a request too', async () => {
        expect((await AirportNotes.read('../x')).ok).toBe(false);
        expect((await AirportNotes.write('SC76/../K', 'x')).ok).toBe(false);
        expect(requests).toEqual([]);
    });
});

describe('panel safety', () => {
    it('a notes failure never stops the panel from opening', () => {
        const saved = globalThis.AirportNoteEditor;
        globalThis.AirportNoteEditor = function () { throw new Error('boom'); };
        try {
            const p = newPopup();
            expect(() => p._showPanel(SC76, null)).not.toThrow();
            expect(document.querySelector('.airport-panel.open')).not.toBeNull();
            expect(document.querySelectorAll('.apt-tab').length).toBe(7);
        } finally {
            globalThis.AirportNoteEditor = saved;
        }
    });
});
