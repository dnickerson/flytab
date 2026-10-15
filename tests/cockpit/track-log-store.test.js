/**
 * PR B / B4: the track log is appended to IndexedDB, not rewritten to
 * localStorage, and the map line is extended, not rebuilt.
 *
 * Before: every 10 s TrackLog rewrote all its points (up to 4,320, ~400 KB) to
 * localStorage key flypi_track, and the map removed and rebuilt the whole
 * polyline. Now one small IndexedDB put per point (database flytab-track), old
 * points pruned occasionally, and polyline.addLatLng for each new point.
 *
 * flypi_track holds real pilots' tracks (CLAUDE.md: never drop flypi_* keys):
 * it is copied into IndexedDB once (flag flytab_track_migrated) and never
 * modified or removed. If IndexedDB can't be opened, the old localStorage
 * behaviour carries on, so nothing is lost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
const TrackLog = new Function(read('web/cockpit/track-log.js') + '\nreturn TrackLog;')();

const OLD_KEY = 'flypi_track';
const T0 = Date.parse('2026-10-15T14:00:00Z');
const pt = (i) => ({ ts: T0 + i * 10_000, lat: 35 + i * 0.001, lon: -80, alt: 3000, gs: 120, trk: 90 });

function fakeMap() {
    return { setTrackLog: vi.fn(), appendTrackPoint: vi.fn() };
}
const fix = () => ({ lat: 35.5, lon: -80.1, alt_msl: 3500, ground_speed: 130, true_course: 80, gps_fix_quality: 2, timestamp: Date.now() });

async function started(stratux = { situation: null }, map = fakeMap()) {
    const t = new TrackLog(stratux, map);
    t.init();
    await t.ready;
    return t;
}

describe('TrackLog storage (B4)', () => {
    beforeEach(() => {
        indexedDB = new IDBFactory();
        localStorage.clear();
        vi.useRealTimers();
    });
    afterEach(() => vi.restoreAllMocks());

    it('first start: the old flypi_track points are copied in, and the old key is left exactly as it was', async () => {
        const old = JSON.stringify([pt(0), pt(1), pt(2)]);
        localStorage.setItem(OLD_KEY, old);
        const map = fakeMap();
        const t = await started({ situation: null }, map);
        expect(t.points.map((p) => p.ts)).toEqual([pt(0).ts, pt(1).ts, pt(2).ts]);
        expect(localStorage.getItem(OLD_KEY)).toBe(old);
        expect(localStorage.getItem('flytab_track_migrated')).toBe('1');
        expect(map.setTrackLog).toHaveBeenLastCalledWith(t.points);
        // and they are really in IndexedDB: a fresh instance with the old key gone still has them
        localStorage.removeItem(OLD_KEY);
        const again = await started();
        expect(again.points).toHaveLength(3);
    });

    it('later starts read IndexedDB and never re-import the old key', async () => {
        localStorage.setItem(OLD_KEY, JSON.stringify([pt(0)]));
        const first = await started();
        first.reset();                                       // pilot cleared the track
        await first.idle();
        const second = await started();
        expect(second.points).toEqual([]);                    // flypi_track not brought back
    });

    it('a new point is one IndexedDB write; localStorage is not rewritten', async () => {
        const stratux = { situation: fix() };
        const map = fakeMap();
        const t = await started(stratux, map);
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        t._record();
        await t.idle();
        expect(t.points).toHaveLength(1);
        expect(setItem.mock.calls.filter(([k]) => k === OLD_KEY)).toEqual([]);
        expect(map.appendTrackPoint).toHaveBeenCalledWith(t.points[0], t.points);
        const again = await started();                        // survives a restart
        expect(again.points).toHaveLength(1);
        expect(again.points[0].lat).toBe(35.5);
    });

    it('the 12 h window (MAX_POINTS) still applies, in memory and in IndexedDB', async () => {
        const many = Array.from({ length: TrackLog.MAX_POINTS + 50 }, (_, i) => pt(i));
        localStorage.setItem(OLD_KEY, JSON.stringify(many));
        const t = await started();
        expect(t.points).toHaveLength(TrackLog.MAX_POINTS);
        expect(t.points[0].ts).toBe(pt(50).ts);
        await t.prune();
        const again = await started();
        expect(again.points).toHaveLength(TrackLog.MAX_POINTS);
        expect(again.points[0].ts).toBe(pt(50).ts);
    });

    it('IndexedDB will not open: the old localStorage behaviour carries on, nothing lost', async () => {
        localStorage.setItem(OLD_KEY, JSON.stringify([pt(0)]));
        vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('denied'); });
        const stratux = { situation: fix() };
        const t = await started(stratux);
        expect(t.points).toHaveLength(1);
        t._record();
        await t.idle();
        expect(JSON.parse(localStorage.getItem(OLD_KEY))).toHaveLength(2);
        expect(localStorage.getItem('flytab_track_migrated')).toBeNull();
    });

    it('IndexedDB opens but reading it fails: falls back to localStorage, later points still saved', async () => {
        localStorage.setItem(OLD_KEY, JSON.stringify([pt(0)]));
        const realTx = TrackLog._tx;
        vi.spyOn(TrackLog, '_tx').mockImplementation((db, mode, fn) => (mode === 'readonly' ? Promise.reject(new Error('read failed')) : realTx(db, mode, fn)));
        const stratux = { situation: fix() };
        const t = await started(stratux);
        expect(t.points).toHaveLength(1);
        t._record();
        await t.idle();
        expect(t.points).toHaveLength(2);
        expect(JSON.parse(localStorage.getItem(OLD_KEY))).toHaveLength(2);
    });

    it('a point recorded before the stored track has loaded is kept, after the stored ones', async () => {
        localStorage.setItem(OLD_KEY, JSON.stringify([pt(0)]));
        const stratux = { situation: fix() };
        const t = new TrackLog(stratux, fakeMap());
        t.init();
        t._record();                                          // before ready
        await t.ready;
        await t.idle();
        expect(t.points.map((p) => p.lat)).toEqual([pt(0).lat, 35.5]);
    });
});

// PR B critical review (2026-10-15), track-log findings 1-4.
describe('TrackLog failure paths (PR B review)', () => {
    beforeEach(() => { indexedDB = new IDBFactory(); localStorage.clear(); });
    afterEach(() => vi.restoreAllMocks());

    it('#1 a fallback session after the migration: its points are merged back once IndexedDB works again', async () => {
        localStorage.setItem(OLD_KEY, JSON.stringify([pt(0)]));
        const s1 = await started();                           // migrates
        expect(s1.points).toHaveLength(1);
        // session 2: IndexedDB won't open -> localStorage, records two points
        const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('denied'); });
        const stratux = { situation: fix() };
        const s2 = await started(stratux);
        s2._record();
        stratux.situation = { ...fix(), lat: 35.6 };
        await new Promise((r) => setTimeout(r, 2));
        s2._record();
        expect(localStorage.getItem('flytab_track_fallback')).toBe('1');
        openSpy.mockRestore();
        // session 3: IndexedDB back -> all three points, marker cleared
        const s3 = await started();
        expect(s3.points.map((p) => p.lat).sort()).toEqual([pt(0).lat, 35.5, 35.6].sort());   // stored in ts order
        expect(localStorage.getItem('flytab_track_fallback')).toBeNull();
        const s4 = await started();                            // and they are in IndexedDB now
        expect(s4.points).toHaveLength(3);
    });

    it('#2 writes keep failing after a good open: switch to localStorage, nothing lost', async () => {
        const stratux = { situation: fix() };
        const t = await started(stratux);
        const realTx = TrackLog._tx;
        vi.spyOn(TrackLog, '_tx').mockImplementation((db, mode, fn) => (mode === 'readwrite' ? Promise.reject(new Error('QuotaExceeded')) : realTx(db, mode, fn)));
        for (let i = 0; i < TrackLog.MAX_WRITE_FAILURES; i++) {
            stratux.situation = { ...fix(), lat: 35.5 + i * 0.01 };
            t._record();
            await t.idle();
        }
        expect(t._useLocal).toBe(true);
        expect(JSON.parse(localStorage.getItem(OLD_KEY))).toHaveLength(TrackLog.MAX_WRITE_FAILURES);
        stratux.situation = { ...fix(), lat: 36 };
        t._record();
        expect(JSON.parse(localStorage.getItem(OLD_KEY))).toHaveLength(TrackLog.MAX_WRITE_FAILURES + 1);
    });

    it('#3 the first read never answers: the load gives up after the timeout and falls back', async () => {
        localStorage.setItem(OLD_KEY, JSON.stringify([pt(0)]));
        const saved = TrackLog.OPEN_TIMEOUT_MS;
        TrackLog.OPEN_TIMEOUT_MS = 150;                       // open succeeds well within this
        const realTx = TrackLog._tx;
        vi.spyOn(TrackLog, '_tx').mockImplementation((db, mode, fn) => (mode === 'readonly' ? new Promise(() => {}) : realTx(db, mode, fn)));
        try {
            const t = new TrackLog({ situation: null }, fakeMap());
            t.init();
            await t.ready;                                     // hangs without a read timeout
            expect(t._useLocal).toBe(true);
            expect(t.points).toHaveLength(1);
        } finally {
            TrackLog.OPEN_TIMEOUT_MS = saved;
        }
    }, 3000);

    it('#4 the clock set back: pruning keeps the newest points', async () => {
        const t = await started();
        for (const ts of [9_000_000, 9_010_000, 1_000, 2_000]) t._append({ ts, lat: 35, lon: -80, alt: 0, gs: 0, trk: 0 });
        await t.prune();
        await t.idle();
        const again = await started();
        expect(again.points.map((p) => p.ts).sort((a, b) => a - b)).toEqual([1_000, 2_000, 9_000_000, 9_010_000]);
    });
});

describe('map track line (B4)', () => {
    const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();
    beforeEach(() => {
        global.Settings = { showTrackLog: true };
        global.L = { polyline: vi.fn((ll) => ({ ll: [...ll], addTo() { return this; }, addLatLng: vi.fn(function (p) { this.ll.push(p); }) })) };
    });

    it('a new point extends the existing line instead of rebuilding it', () => {
        const c = Object.create(CockpitMap.prototype);
        c.map = { hasLayer: () => true, removeLayer: vi.fn() };
        c.setTrackLog([pt(0), pt(1)]);
        expect(L.polyline).toHaveBeenCalledTimes(1);
        c.appendTrackPoint(pt(2));
        expect(L.polyline).toHaveBeenCalledTimes(1);
        expect(c.trackLogLine.addLatLng).toHaveBeenCalledWith([pt(2).lat, pt(2).lon]);
        expect(c.map.removeLayer).not.toHaveBeenCalled();
    });

    it('the first two points create the line; the track toggle off draws nothing', () => {
        const c = Object.create(CockpitMap.prototype);
        c.map = { hasLayer: () => true, removeLayer: vi.fn() };
        c.setTrackLog([pt(0)]);
        expect(c.trackLogLine).toBeFalsy();
        c.appendTrackPoint(pt(1), [pt(0), pt(1)]);
        expect(L.polyline).toHaveBeenCalledTimes(1);
        Settings.showTrackLog = false;
        const d = Object.create(CockpitMap.prototype);
        d.map = c.map;
        d.appendTrackPoint(pt(2), [pt(0), pt(1), pt(2)]);
        expect(L.polyline).toHaveBeenCalledTimes(1);
    });
});
