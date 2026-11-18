/**
 * Oil log on the tablet (2026-11-17: "The oil log does not display on the tablet").
 *
 * flywhere's /flights/oil route did not allow the x-api-key header in its CORS
 * answer, so every FlyTab request was blocked: the Oil tab showed only the one
 * event entered on the tablet that day, never the oil-change history kept on
 * flywhere.app, and the tablet's event never reached the server. With the
 * server fixed, the old tab would have deleted its local copy of everything the
 * server has, leaving the tab empty with no internet (in flight). Now the local
 * copy is the whole log; the server only adds to it and receives what the
 * tablet logged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({}), aircraft: (k) => (k === 'tail' ? 'N194JT' : null) };
global.Settings = { workerBase: 'https://flywhere.test/api', apiHeaders: { 'Content-Type': 'application/json', 'x-api-key': 'k' } };
global.wireTap = (el, fn) => el.addEventListener('click', fn);
const Logbook = new Function(read('web/cockpit/logbook.js') + '\nreturn Logbook;')();

const KEY = 'flypi_oil_events';
const DELETES = 'flytab_oil_pending_deletes';
const OIL = 'https://flywhere.test/api/flights/oil';
const local = () => JSON.parse(localStorage.getItem(KEY) || '[]');
const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });

// The tablet's one event on 2026-11-17 (entered there, never sent)
const TABLET_EVENT = {
    id: '442cc811-f17c-4f32-aac5-ca085d0c23af', event_type: 'add', date: '2026-11-17', aircraft_id: 'N194JT',
    tach_time: 1134.7, oil_quarts: 1, oil_brand: 'Phillips 20W-50 Victory', oil_filter_changed: false, notes: null,
};
const ev = (id, over = {}) => ({ id, event_type: 'add', date: '2026-10-01', aircraft_id: 'N194JT', tach_time: null,
    oil_quarts: 1, oil_brand: null, oil_filter_changed: false, notes: null, ...over });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** flywhere's oil route, in memory. `fail`: method -> HTTP status, or 'cors' for a blocked request. */
function server(events = [], { fail = {} } = {}) {
    const store = new Map(events.map((e) => [e.id, { ...e }]));
    const calls = [];
    const fetch = vi.fn(async (url, opts = {}) => {
        const m = opts.method || 'GET';
        calls.push({ m, url, body: opts.body ? JSON.parse(opts.body) : undefined, key: opts.headers?.['x-api-key'] });
        if (fail[m] === 'cors') throw new TypeError('Failed to fetch');
        if (fail[m]) return { ok: false, status: fail[m], json: async () => ({ error: 'x' }) };
        const u = new URL(url);
        if (m === 'GET') return { ok: true, status: 200, json: async () => ({ events: [...store.values()] }) };
        if (m === 'POST' || m === 'PUT') {
            const b = JSON.parse(opts.body);
            const row = { ...b, owner_handle: 'dana' };
            store.set(row.id, row);
            return { ok: true, status: m === 'POST' ? 201 : 200, json: async () => ({ event: row }) };
        }
        if (m === 'DELETE') { store.delete(u.searchParams.get('id')); return { ok: true, status: 200, json: async () => ({ deleted: true }) }; }
    });
    return { store, calls, fetch };
}

function makeLogbook() {
    const lb = Object.create(Logbook.prototype);
    lb._body = document.createElement('div');
    lb._el = document.createElement('div');
    lb._activeTab = 'oil';
    return lb;
}
const text = (lb) => lb._body.textContent.replace(/\s+/g, ' ').trim();

beforeEach(() => { localStorage.clear(); setOnline(true); });

describe('Oil tab sync', () => {
    it('11-17 replay: the tablet event is sent, the server history comes down, both shown', async () => {
        localStorage.setItem(KEY, JSON.stringify([TABLET_EVENT]));
        const srv = server([
            ev(uuid(1), { event_type: 'change', date: '2026-09-20', tach_time: 1101.2, oil_quarts: 6, oil_filter_changed: true }),
            ev(uuid(2), { date: '2026-10-15', tach_time: 1120.0 }),
        ]);
        global.fetch = srv.fetch;
        const lb = makeLogbook();
        await lb._renderOil();

        const post = srv.calls.find((c) => c.m === 'POST');
        expect(post.body).toEqual(TABLET_EVENT);                         // no tablet-only fields sent
        expect(srv.calls.every((c) => c.key === 'k')).toBe(true);
        expect(local().map((e) => [e.id, e._synced])).toEqual(expect.arrayContaining([
            [TABLET_EVENT.id, true], [uuid(1), true], [uuid(2), true]]));
        expect(local()).toHaveLength(3);
        const t = text(lb);
        expect(t).toContain('Since Last Oil Change');
        expect(t).toContain('2026-09-20');
        expect(t).toContain('Oil Added Since2.0 qt');                    // 10-15 and 11-17
        expect(t).toContain('Phillips 20W-50 Victory');
        expect(lb._body.querySelector('.lb-oil-status')).toBeNull();      // up to date: no status line
    });

    it('then offline (in flight): the whole log is still shown, from the tablet', async () => {
        const srv = server([ev(uuid(1), { event_type: 'change', date: '2026-09-20' }), ev(uuid(2))]);
        global.fetch = srv.fetch;
        await makeLogbook()._renderOil();
        setOnline(false);
        global.fetch = vi.fn();
        const lb = makeLogbook();
        await lb._renderOil();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(lb._body.querySelectorAll('.logbook-entry')).toHaveLength(2);
        expect(text(lb)).toContain('Offline — oil log saved on this tablet (last updated');
    });

    it('request blocked (the old CORS failure): saved log shown, says so and what is unsent', async () => {
        localStorage.setItem(KEY, JSON.stringify([TABLET_EVENT]));
        global.fetch = server([], { fail: { GET: 'cors', POST: 'cors' } }).fetch;
        const lb = makeLogbook();
        await lb._renderOil();
        expect(local()).toEqual([TABLET_EVENT]);
        const t = text(lb);
        expect(t).toContain('Not updated from flywhere.app (Failed to fetch)');
        expect(t).toContain('never updated from flywhere.app');
        expect(t).toContain('1 not sent to flywhere.app yet');
        expect(t).toContain('OIL ADDED');
    });

    it('a failed upload is kept and sent next time', async () => {
        localStorage.setItem(KEY, JSON.stringify([TABLET_EVENT]));
        const bad = server([], { fail: { POST: 500 } });
        global.fetch = bad.fetch;
        await makeLogbook()._renderOil();
        expect(local()[0]._synced).toBeUndefined();
        const good = server();
        global.fetch = good.fetch;
        await makeLogbook()._renderOil();
        expect(good.store.has(TABLET_EVENT.id)).toBe(true);
        expect(local()[0]._synced).toBe(true);
    });

    it('deleted on flywhere.app: dropped here, unless the server list may be cut short (200)', () => {
        const mine = [{ ...ev(uuid(5)), _synced: true }, ev(uuid(6))];      // synced, and one not sent yet
        expect(Logbook.mergeOil(mine, [], { complete: true }).map((e) => e.id)).toEqual([uuid(6)]);
        expect(Logbook.mergeOil(mine, [], { complete: false }).map((e) => e.id)).toEqual([uuid(5), uuid(6)]);
    });

    it('an old duplicate (same date, type and tach, different id) is not shown twice', () => {
        const legacy = ev('oil-1700000000000', { date: '2026-03-18', tach_time: 1000 });
        const srvCopy = ev(uuid(9), { date: '2026-03-18', tach_time: 1000 });
        expect(Logbook.mergeOil([legacy], [srvCopy], { complete: true }).map((e) => e.id)).toEqual([uuid(9)]);
    });

    it('delete a synced event offline -> gone here at once, deleted on the server at the next sync', async () => {
        const srv = server([ev(uuid(1)), ev(uuid(2))]);
        global.fetch = srv.fetch;
        const lb = makeLogbook();
        await lb._renderOil();
        setOnline(false);
        await lb._deleteOilEvent(uuid(1));
        expect(local().map((e) => e.id)).toEqual([uuid(2)]);
        expect(JSON.parse(localStorage.getItem(DELETES))).toEqual([uuid(1)]);
        setOnline(true);
        await lb._renderOil();
        expect(srv.calls.filter((c) => c.m === 'DELETE').map((c) => c.url)).toEqual([`${OIL}?id=${uuid(1)}`]);
        expect(srv.store.has(uuid(1))).toBe(false);
        expect(JSON.parse(localStorage.getItem(DELETES))).toEqual([]);
        expect(local().map((e) => e.id)).toEqual([uuid(2)]);
    });

    it('server DELETE fails -> the event stays deleted here and is tried again', async () => {
        const srv = server([ev(uuid(1))], { fail: { DELETE: 500 } });
        global.fetch = srv.fetch;
        const lb = makeLogbook();
        await lb._renderOil();
        await lb._deleteOilEvent(uuid(1));
        await lb._renderOil();
        expect(local()).toEqual([]);                                     // not brought back by the download
        expect(JSON.parse(localStorage.getItem(DELETES))).toEqual([uuid(1)]);
    });

    it('delete an event never sent -> no server delete', async () => {
        localStorage.setItem(KEY, JSON.stringify([ev('oil-1700000000000')]));
        setOnline(false);
        const lb = makeLogbook();
        await lb._deleteOilEvent('oil-1700000000000');
        expect(local()).toEqual([]);
        expect(localStorage.getItem(DELETES)).toBeNull();
    });

    it('delete while that event is being sent -> it does not come back with the download', async () => {
        localStorage.setItem(KEY, JSON.stringify([TABLET_EVENT]));
        const srv = server();
        let release;
        const gate = new Promise((r) => { release = r; });
        global.fetch = vi.fn(async (url, opts = {}) => {
            if ((opts.method || 'GET') === 'POST') await gate;
            return srv.fetch(url, opts);
        });
        const lb = makeLogbook();
        const run = lb._renderOil();
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await lb._deleteOilEvent(TABLET_EVENT.id);
        release();
        await run;
        await lb._renderOil();
        expect(local()).toEqual([]);
        expect(srv.store.has(TABLET_EVENT.id)).toBe(false);
    });

    it('server text is escaped', async () => {
        global.fetch = server([ev(uuid(1), { oil_brand: '<img src=x onerror=alert(1)>', date: '<b>d</b>' })]).fetch;
        const lb = makeLogbook();
        await lb._renderOil();
        expect(lb._body.querySelector('img')).toBeNull();
        expect(lb._body.querySelector('.logbook-date b')).toBeNull();
        expect(text(lb)).toContain('<img src=x onerror=alert(1)>');
    });

    it('pilot leaves the Oil tab during the sync -> the other tab is not overwritten', async () => {
        let release;
        global.fetch = vi.fn(() => new Promise((r) => { release = r; }));
        const lb = makeLogbook();
        const run = lb._renderOil();
        lb._activeTab = 'flights';
        lb._body.innerHTML = '<div>FLIGHTS</div>';
        release({ ok: true, status: 200, json: async () => ({ events: [ev(uuid(1))] }) });
        await run;
        expect(lb._body.textContent).toBe('FLIGHTS');
    });

    it('+ OIL form: saved here at once, then sent', async () => {
        const srv = server();
        global.fetch = srv.fetch;
        const lb = makeLogbook();
        lb._showOilForm(null);
        const f = lb._el.querySelector('#logbookForm');
        f.querySelector('[name="event_type"]').value = 'change';
        f.querySelector('[name="tach_time"]').value = '1140.3';
        f.querySelector('[name="oil_quarts"]').value = '6';
        f.querySelector('[name="oil_filter_changed"]').value = 'true';
        f.querySelector('.logbook-form-save').click();
        expect(local()).toHaveLength(1);                                  // before any network answer
        await vi.waitFor(() => expect(local()[0]?._synced).toBe(true));
        const saved = [...srv.store.values()][0];
        expect(saved).toMatchObject({ event_type: 'change', tach_time: 1140.3, oil_quarts: 6, oil_filter_changed: true });
        expect(Object.keys(saved).some((k) => k.startsWith('_'))).toBe(false);
    });

    it('a damaged local copy does not break the tab', async () => {
        localStorage.setItem(KEY, '{not json');
        setOnline(false);
        const lb = makeLogbook();
        await lb._renderOil();
        expect(text(lb)).toContain('No oil events recorded');
    });
});
