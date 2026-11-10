/**
 * Logbook server pull, 1,000-row cap (11-07-2026). The server returns at most 1,000 rows per request
 * whatever `limit` asks (PostgREST), oldest seq first. A full pull (cursor 0: after Clear Data or a
 * reinstall) took one request — seq 2..2002, entries up to 2026-01-30 of 1,212 rows — and its
 * reconciliation then deleted every synced local entry newer than that: ~197 flights incl. the
 * 10/27 KORL-KTBR and KTBR-KLKR legs. The pull now pages by `since` until a page comes back empty,
 * and only a complete full pull may delete local entries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

global.DiagLog = { log: vi.fn() };
const src = readFileSync('web/cockpit/logbook.js', 'utf8');
const Logbook = new Function(src + '\nreturn Logbook;')();

const SERVER_CAP = 1000;           // what the real server returns at most, whatever is asked

/** n server rows with ascending seq starting at `seq0`. */
function rows(n, seq0 = 2) {
    return Array.from({ length: n }, (_, i) => ({ id: `id-${seq0 + i}`, seq: seq0 + i, date: '2026-01-01', from_airport: 'KLKR', to_airport: 'KLKR' }));
}

let server, store, fetchMock, pageFail;
function serverFetch(url) {
    const u = new URL(url);
    const since = Number(u.searchParams.get('since'));
    if (pageFail && pageFail(since)) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    const page = server.filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).slice(0, SERVER_CAP);
    const max_seq = page.length ? Math.max(...page.map((r) => r.seq)) : since;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ entries: page.map((r) => ({ ...r })), max_seq }) });
}

function makeLogbook() {
    const lb = Object.create(Logbook.prototype);
    lb.getEntries = vi.fn(async () => [...store.values()].map((e) => ({ ...e })));
    lb._saveEntry = vi.fn(async (e) => { store.set(e.id, { ...e }); });
    lb._deleteEntry = vi.fn(async (id) => { store.delete(id); });
    return lb;
}

beforeEach(() => {
    globalThis.Settings = { workerBase: 'https://example.test/api', apiHeaders: {} };
    Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
    localStorage.clear();
    pageFail = null;
    fetchMock = vi.fn(serverFetch);
    globalThis.fetch = fetchMock;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

/** The 11-07 shape: 1,212 rows on the server (seq 2..1213), the tablet holds all of them synced. */
function realShape() {
    server = rows(1212);
    store = new Map(server.map((r) => [r.id, { ...r, synced: true }]));
}

describe('full pull (cursor 0) pages past the server\'s 1,000-row cap', () => {
    it('keeps every newer local entry: pages 1,000 + 212 + an empty page, nothing deleted', async () => {
        realShape();
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const sinces = fetchMock.mock.calls.map(([u]) => Number(new URL(u).searchParams.get('since')));
        expect(sinces).toEqual([0, 1001, 1213]);
        expect(lb._deleteEntry).not.toHaveBeenCalled();
        expect(store.size).toBe(1212);
        expect(store.has('id-1213')).toBe(true);           // the newest row survives
        expect(localStorage.getItem('flypi_logbook_seq')).toBe('1213');
    });

    it('still removes a synced local entry the server no longer has (hard-deleted), after a complete pull', async () => {
        realShape();
        store.set('gone', { id: 'gone', seq: 5000, synced: true, date: '2026-02-02' });
        store.set('pending', { id: 'pending', synced: false, date: '2026-02-03' });   // unsynced: kept
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(lb._deleteEntry.mock.calls.map(([id]) => id)).toEqual(['gone']);
        expect(store.has('pending')).toBe(true);
        expect(store.size).toBe(1213);
    });

    it('a page that fails part-way: nothing is deleted, the cursor stays at the last page applied', async () => {
        realShape();
        store.set('gone', { id: 'gone', seq: 5000, synced: true });
        pageFail = (since) => since > 0;                    // the second page fails
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(lb._deleteEntry).not.toHaveBeenCalled();
        expect(store.size).toBe(1213);
        expect(localStorage.getItem('flypi_logbook_seq')).toBe('1001');
    });

    it('a network error part-way: nothing is deleted', async () => {
        realShape();
        let n = 0;
        globalThis.fetch = vi.fn((u) => (++n === 2 ? Promise.reject(new Error('offline')) : serverFetch(u)));
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(lb._deleteEntry).not.toHaveBeenCalled();
        expect(store.size).toBe(1212);
    });

    it('a server whose max_seq does not move forward ends the pull (no loop, no deletion)', async () => {
        realShape();
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: rows(10), max_seq: 0 }) }));
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(lb._deleteEntry).not.toHaveBeenCalled();
    });

    it('stops at PULL_MAX_PAGES and treats the pull as incomplete', async () => {
        server = rows(Logbook.PULL_MAX_PAGES * SERVER_CAP + 5);
        store = new Map([['local-only', { id: 'local-only', synced: true }]]);
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(fetchMock).toHaveBeenCalledTimes(Logbook.PULL_MAX_PAGES);
        expect(lb._deleteEntry).not.toHaveBeenCalled();
        expect(store.has('local-only')).toBe(true);
    });

    it('an empty full pull (auth error / server bug) deletes nothing, as before', async () => {
        server = [];
        store = new Map([['a', { id: 'a', synced: true }]]);
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lb._deleteEntry).not.toHaveBeenCalled();
    });
});

describe('incremental pull (cursor set)', () => {
    it('nothing new: one request, nothing changes', async () => {
        realShape();
        localStorage.setItem('flypi_logbook_seq', '1213');
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lb._saveEntry).not.toHaveBeenCalled();
        expect(lb._deleteEntry).not.toHaveBeenCalled();
    });

    it('applies new rows and tombstones across pages, never reconciles', async () => {
        realShape();
        localStorage.setItem('flypi_logbook_seq', '1213');
        server = server.concat(rows(1500, 1214));                       // 1,500 new rows: two pages
        server.push({ id: 'id-50', seq: 2714, deleted_at: '2026-11-07T00:00:00Z' });   // a tombstone
        store.set('local-only', { id: 'local-only', synced: true });
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(store.has('id-2713')).toBe(true);                         // the newest new row
        expect(store.has('id-50')).toBe(false);                          // the tombstone applied
        expect(store.has('local-only')).toBe(true);                      // no reconciliation
        expect(localStorage.getItem('flypi_logbook_seq')).toBe('2714');
    });

    it('a server row never overwrites a local entry with pending edits', async () => {
        realShape();
        localStorage.setItem('flypi_logbook_seq', '1213');
        store.set('id-2000x', { id: 'id-2000x', synced: false, route: 'LOCAL EDIT' });
        server.push({ id: 'id-2000x', seq: 1214, route: 'SERVER' });
        const lb = makeLogbook();
        await lb._fetchFromServer();
        expect(store.get('id-2000x').route).toBe('LOCAL EDIT');
    });
});
