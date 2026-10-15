/**
 * FlyTab — Track Log
 * Records GPS position every 10s and draws it on the map as a grey dashed line
 * (the last MAX_POINTS points, 12 h at 10 s).
 *
 * Storage (PR B / B4): IndexedDB database flytab-track, store `points`, one
 * record per point keyed by its timestamp. Each new point is one small put,
 * and old points are pruned about hourly. It used to rewrite the whole array
 * (up to ~400 KB) to localStorage every 10 s, and the map rebuilt the whole
 * line each time; now the map line is extended (CockpitMap.appendTrackPoint).
 *
 * flypi_track (the old localStorage key) holds real pilots' tracks: it is
 * copied into IndexedDB once (then flytab_track_migrated = '1') and is never
 * modified or removed. If IndexedDB can't be opened, the old localStorage
 * behaviour carries on, so nothing is lost.
 */

class TrackLog {
    static MAX_POINTS = 4320; // 12 hours at 10s intervals
    static RECORD_INTERVAL = 10000;
    static FRESH_MS = 5000;
    static STORAGE_KEY = 'flypi_track';            // pre-B4 store: read once, written only if IDB fails
    static MIGRATED_KEY = 'flytab_track_migrated';
    static DB_NAME = 'flytab-track';
    static STORE = 'points';
    static OPEN_TIMEOUT_MS = 5000;
    // In memory the window may run this many points over MAX_POINTS before it is
    // trimmed (and the map line rebuilt): about once an hour, not every point.
    static TRIM_SLACK = 360;
    static PRUNE_EVERY = 360;                      // appends between IndexedDB prunes (~1 h)

    constructor(stratuxClient, cockpitMap) {
        this.stratux = stratuxClient;
        this.map = cockpitMap;
        this._timer = null;
        this._points = [];
        this._db = null;
        this._useLocal = false;        // IndexedDB unavailable: old localStorage behaviour
        this._pending = null;          // while loading (init): points recorded meanwhile
        this._writes = Promise.resolve();
        this._sincePrune = 0;
        this.ready = Promise.resolve();
    }

    init() {
        // Start recording at once; points recorded before the stored track has
        // loaded are kept and added after it.
        this._pending = [];
        this._timer = setInterval(() => this._record(), TrackLog.RECORD_INTERVAL);
        this.ready = this._load()
            .catch((err) => {
                // Anything failed after the database opened: carry on the old way,
                // with the old track, and keep the points recorded meanwhile.
                if (typeof DiagLog !== 'undefined') DiagLog.log('error', `Track log load failed (${err?.message || err}); using localStorage`);
                this._db = null;
                this._useLocal = true;
                this._points = TrackLog._readLocal().slice(-TrackLog.MAX_POINTS);
                const early = this._pending || [];
                this._pending = null;
                for (const p of early) this._append(p);
            })
            .then(() => this._renderOnMap());
        return this.ready;
    }

    destroy() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    reset() {
        this._points = [];
        if (this._useLocal) this._saveLocal();
        else this._queue((db) => TrackLog._tx(db, 'readwrite', (s) => s.clear()));
        this._renderOnMap();
    }

    /** Re-render the track on the map (used when visibility toggle changes). */
    redraw() {
        this._renderOnMap();
    }

    get points() { return this._points; }

    /** Resolves when all queued IndexedDB writes have finished. */
    idle() { return this._writes; }

    _record() {
        const sit = this.stratux.situation;
        if (!sit || sit.gps_fix_quality === 0 || !sit.lat || !sit.lon) return;
        // Only a position received in the last few seconds. The situation keeps
        // its last values when the feed stops, and FlyTab now keeps running in
        // the background: without this it appended the same stale point every
        // 10 s until the 12 h ring was full of it.
        if (sit._stale || !(Date.now() - sit.timestamp < TrackLog.FRESH_MS)) return;

        const pt = {
            ts: Date.now(),
            lat: sit.lat,
            lon: sit.lon,
            alt: sit.alt_msl || 0,
            gs: sit.ground_speed || 0,
            trk: sit.true_course || 0,
        };
        if (this._pending) { this._pending.push(pt); return; }
        this._append(pt);
    }

    _append(pt) {
        this._points.push(pt);
        let trimmed = false;
        if (this._points.length > TrackLog.MAX_POINTS + TrackLog.TRIM_SLACK) {
            this._points = this._points.slice(-TrackLog.MAX_POINTS);
            trimmed = true;
        }

        if (this._useLocal) {
            this._saveLocal();
        } else {
            this._queue((db) => TrackLog._tx(db, 'readwrite', (s) => s.put(pt)));
            if (++this._sincePrune >= TrackLog.PRUNE_EVERY) { this._sincePrune = 0; this.prune(); }
        }

        if (trimmed || !this.map?.appendTrackPoint) this._renderOnMap();
        else this.map.appendTrackPoint(pt, this._points);
    }

    /** Delete stored points older than the oldest one kept in memory. */
    prune() {
        if (this._useLocal || !this._points.length) return this._writes;
        const oldest = this._points[0].ts;
        return this._queue((db) => TrackLog._tx(db, 'readwrite', (s) => s.delete(IDBKeyRange.upperBound(oldest, true))));
    }

    async _load() {
        let db = null;
        try {
            db = await TrackLog._openDb();
        } catch (err) {
            if (typeof DiagLog !== 'undefined') DiagLog.log('error', `Track log: IndexedDB unavailable (${err?.message || err}); using localStorage`);
        }

        let points;
        if (!db) {
            this._useLocal = true;
            points = TrackLog._readLocal();
        } else {
            this._db = db;
            points = await TrackLog._tx(db, 'readonly', (s) => s.getAll());
            if (TrackLog._migrated() !== '1') {
                // First start with IndexedDB: copy the old localStorage track in,
                // in one transaction. flypi_track itself is left exactly as it is.
                if (points.length === 0) {
                    points = TrackLog._readLocal();
                    if (points.length) {
                        await TrackLog._tx(db, 'readwrite', (s) => { for (const p of points) s.put(p); });
                    }
                }
                // Only after the copy has committed.
                try { localStorage.setItem(TrackLog.MIGRATED_KEY, '1'); } catch { /* ignore */ }
            }
        }

        this._points = points.slice(-TrackLog.MAX_POINTS);
        if (!this._useLocal && points.length > TrackLog.MAX_POINTS) this.prune();
        const early = this._pending || [];
        this._pending = null;
        for (const p of early) this._append(p);
    }

    static _migrated() {
        try { return localStorage.getItem(TrackLog.MIGRATED_KEY); } catch { return null; }
    }

    _queue(op) {
        if (!this._db) return this._writes;
        const db = this._db;
        this._writes = this._writes.then(() => op(db)).catch((err) => {
            if (typeof DiagLog !== 'undefined') DiagLog.log('error', `Track log write failed: ${err?.message || err}`);
        });
        return this._writes;
    }

    _saveLocal() {
        try {
            localStorage.setItem(TrackLog.STORAGE_KEY, JSON.stringify(this._points));
        } catch { /* storage full — trim more aggressively */
            this._points = this._points.slice(-Math.floor(TrackLog.MAX_POINTS / 2));
            try { localStorage.setItem(TrackLog.STORAGE_KEY, JSON.stringify(this._points)); } catch { /* give up */ }
        }
    }

    static _readLocal() {
        try {
            const raw = localStorage.getItem(TrackLog.STORAGE_KEY);
            const pts = raw ? JSON.parse(raw) : [];
            return Array.isArray(pts) ? pts.filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon)) : [];
        } catch { return []; }
    }

    /** Open flytab-track, or reject (thrown, error, or OPEN_TIMEOUT_MS with no answer). */
    static _openDb() {
        return new Promise((resolve, reject) => {
            let settled = false;
            let req;
            try {
                req = indexedDB.open(TrackLog.DB_NAME, 1);
            } catch (err) {
                reject(err);
                return;
            }
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`open timed out after ${TrackLog.OPEN_TIMEOUT_MS / 1000} s`));
            }, TrackLog.OPEN_TIMEOUT_MS);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(TrackLog.STORE)) db.createObjectStore(TrackLog.STORE, { keyPath: 'ts' });
            };
            req.onsuccess = () => {
                clearTimeout(timer);
                if (settled) { req.result.close(); return; }   // answered after we gave up
                settled = true;
                resolve(req.result);
            };
            req.onerror = () => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                reject(req.error || new Error('open failed'));
            };
        });
    }

    /** Run fn(store) in one transaction; resolves with fn's request result when it commits. */
    static _tx(db, mode, fn) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(TrackLog.STORE, mode);
            const req = fn(tx.objectStore(TrackLog.STORE));
            tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
        });
    }

    _renderOnMap() {
        if (this.map) {
            this.map.setTrackLog(this._points);
        }
    }

}
