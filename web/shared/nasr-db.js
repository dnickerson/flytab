/**
 * FlyTab — NASR Database (IndexedDB)
 * Wraps IndexedDB for structured data storage: airports, navaids, airways,
 * weather cache, flight plans, W&B scenarios, fuel prices, aircraft profiles.
 */

class NasrDB {
    // 'flypi' is a legacy name from the deprecated FlyPi/iPad predecessor
    // product (see CLAUDE.md) — NOT evidence of a current iPad or FlyPi
    // system. This is a real IndexedDB already holding airports, navaids,
    // flight plans, W&B scenarios, and more on installed tablets — do not
    // rename without a migration. tab-bar.js's "Reset NASR Data" action
    // independently hardcodes this same literal ('flypi') rather than
    // reading DB_NAME — a rename here must update that too, or the reset
    // button will silently delete a database that no longer exists.
    static DB_NAME = 'flypi';
    // DB_VERSION must never be lower than what's already on a physical device —
    // IndexedDB throws VersionError on open() if requested version < on-disk
    // version, with no downgrade path, breaking every NASR-backed query (2026-09-17,
    // this tablet had version 10 on disk from the unmerged feat/document-library
    // branch's extra 'flytab_documents' store; main was still declaring 8).
    // Bumped to 10 to match — verified feat/document-library's v10 schema is
    // additive-only (adds 'flytab_documents', changes nothing main uses), so this
    // is a safe no-op upgrade for this device, not a guess. When merging any
    // branch that bumps this, take the max of the two, never main's stale value.
    // 11 — added the 'trsa' object store (TRSA boundary rendering, 2026-09-18).
    //
    // 2026-09-21 three-way merge: main (uncommitted TRSA work, this file at v11),
    // airspace-frequency-alert-runtime (independently reached v9, no new store —
    // just rewrote getAirspaceInBounds/getSuaInBounds/getTrsaInBounds to use
    // GeoUtils.polygonOverlapsBox instead of the vertex-only test below, which
    // fixed a real bug: a TRSA vanished whenever the viewport sat entirely
    // inside its 20-60nm circle, since no boundary vertex was ever in view),
    // and feat/document-library (independently reached v10 for 'flytab_documents')
    // all bumped this from the same base (8) without knowing about each other.
    // Store creation below is existence-gated (`!objectStoreNames.contains(...)`),
    // not version-gated, so combining is safe — no version number was skipped
    // or double-assigned; 11 already covers both new stores once this file has
    // both store blocks, which it now does. Kept the alert branch's query-method
    // rewrite (below) since it's a strict superset of the old vertex-only test
    // and fixes the TRSA-visibility bug independently of this merge.
    // 12 — added the 'airport_remarks' object store (FAA airport remarks, bundle
    // v12, 2026-11-02). Additive only: existing stores and their data are untouched.
    static DB_VERSION = 12;
    // indexedDB.open() can stay pending forever: an upgrade blocked by a
    // connection that won't close, or the stuck IDB state in CLAUDE.md. Startup
    // awaits NASR, so open() gives up after this and callers fall through.
    static OPEN_TIMEOUT_MS = 10000;

    constructor() {
        this._db = null;
        this._opening = null;
        this._mem = new Map();      // store -> { gen, rows } or { gen, promise } (see _memRows)
        this._memGen = new Map();   // store -> generation, bumped by every write to the store
    }

    // ========== In-memory copies for the area queries ==========
    //
    // Profiled on main (v11.71, 2026-10-17, PR B harness): every map refresh
    // scanned whole stores through IndexedDB cursors, one task per record --
    // airports 1,205 ms for 51 rows, airspace 633 ms, navaids 240, airways 207,
    // 21 refreshes a minute. Each store below is now read once (getAll, 3-294 ms
    // on the tablet) and the *InBounds queries filter the array with the same
    // tests, limits, key order and sort as the cursors did. They return copies of
    // the matched rows, as the cursor did, so a caller can't change the copy.
    // Every write to these stores goes through NasrDB (importNasrBundle, _clear,
    // putAirport) and bumps the store's generation; a load still running from
    // before a write is not kept. About 19 MB of records on the tablet.
    static MEMORY_STORES = ['airports', 'airspace', 'sua', 'trsa', 'navaids', 'fixes', 'airways'];

    /** All rows of a store, in key order, read from IndexedDB once per generation. */
    _memRows(store) {
        const gen = this._memGen.get(store) || 0;
        const hit = this._mem.get(store);
        if (hit && hit.gen === gen) return hit.rows ? Promise.resolve(hit.rows) : hit.promise;
        const promise = this._getAll(store).then((rows) => {
            if ((this._memGen.get(store) || 0) === gen) this._mem.set(store, { gen, rows });
            return rows;
        }, (err) => {
            if (this._mem.get(store)?.promise === promise) this._mem.delete(store);   // the next query tries again
            throw err;
        });
        this._mem.set(store, { gen, promise });
        return promise;
    }

    /** The stores changed: drop their copies (and any load in flight). */
    _memInvalidate(stores) {
        for (const st of stores) {
            if (!NasrDB.MEMORY_STORES.includes(st)) continue;
            this._memGen.set(st, (this._memGen.get(st) || 0) + 1);
            this._mem.delete(st);
        }
    }

    static _copies(rows) {
        // structuredClone: Chromium 98+ (the tablet runs WebView 155); JSON for an
        // older WebView -- the records are plain JSON from the NASR bundle.
        const clone = typeof structuredClone === 'function' ? structuredClone : (r) => JSON.parse(JSON.stringify(r));
        return rows.map((r) => clone(r));
    }

    /** Point-in-box filter, stopping at limit -- the cursors' order and stop rule. */
    static _pointsInBox(rows, south, west, north, east, limit) {
        const out = [];
        for (const v of rows) {
            if (out.length >= limit) break;
            if (v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east) out.push(v);
        }
        return out;
    }

    /**
     * The shared connection. Callers at the same moment share one request.
     * Rejects after OPEN_TIMEOUT_MS; if that request still succeeds later, its
     * connection is kept for the next call. A request that failed or never
     * answered is retried on the next call.
     */
    async open() {
        if (this._db) return this._db;
        if (this._opening) return this._opening;

        const opening = new Promise((resolve, reject) => {
            const log = (msg) => { if (typeof DiagLog !== 'undefined') DiagLog.log('nasr', msg); };
            let settled = false;
            const done = () => { if (this._opening === opening) this._opening = null; };
            let request;
            try {
                request = indexedDB.open(NasrDB.DB_NAME, NasrDB.DB_VERSION);
            } catch (err) {
                reject(err);
                return;
            }
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                done();
                log(`IndexedDB open timed out after ${NasrDB.OPEN_TIMEOUT_MS / 1000} s`);
                reject(new Error(`IndexedDB open timed out after ${NasrDB.OPEN_TIMEOUT_MS / 1000} s`));
            }, NasrDB.OPEN_TIMEOUT_MS);

            const onBlocked = () => log('IndexedDB upgrade blocked by another open connection — waiting');
            request.onblocked = onBlocked;

            const onUpgrade = (event) => {
                const db = event.target.result;

                // Airports — keyed by ICAO, indexed for spatial queries
                if (!db.objectStoreNames.contains('airports')) {
                    const store = db.createObjectStore('airports', { keyPath: 'icao' });
                    store.createIndex('name', 'name', { unique: false });
                    store.createIndex('lat', 'lat', { unique: false });
                    store.createIndex('lon', 'lon', { unique: false });
                }

                // Navaids (VOR, NDB, DME)
                if (!db.objectStoreNames.contains('navaids')) {
                    const store = db.createObjectStore('navaids', { keyPath: 'id' });
                    store.createIndex('type', 'type', { unique: false });
                    store.createIndex('lat', 'lat', { unique: false });
                    store.createIndex('lon', 'lon', { unique: false });
                } else if (event.oldVersion < 4) {
                    const store = event.target.transaction.objectStore('navaids');
                    if (!store.indexNames.contains('lat')) store.createIndex('lat', 'lat', { unique: false });
                    if (!store.indexNames.contains('lon')) store.createIndex('lon', 'lon', { unique: false });
                }

                // Airways (V, J, T, Q routes)
                if (!db.objectStoreNames.contains('airways')) {
                    db.createObjectStore('airways', { keyPath: 'name' });
                }

                // Airspace boundaries
                if (!db.objectStoreNames.contains('airspace')) {
                    const store = db.createObjectStore('airspace', { keyPath: 'id' });
                    store.createIndex('class', 'class', { unique: false });
                }

                // Special Use Airspace (R/P/W/A/MOA)
                if (!db.objectStoreNames.contains('sua')) {
                    const store = db.createObjectStore('sua', { keyPath: 'id' });
                    store.createIndex('type', 'type', { unique: false });
                }

                // Terminal Radar Service Areas (approximate circular boundaries)
                if (!db.objectStoreNames.contains('trsa')) {
                    db.createObjectStore('trsa', { keyPath: 'id' });
                }

                // Named fixes/waypoints for route parsing
                if (!db.objectStoreNames.contains('fixes')) {
                    const store = db.createObjectStore('fixes', { keyPath: 'id' });
                    store.createIndex('lat', 'lat', { unique: false });
                    store.createIndex('lon', 'lon', { unique: false });
                } else if (event.oldVersion < 4) {
                    const store = event.target.transaction.objectStore('fixes');
                    if (!store.indexNames.contains('lat')) store.createIndex('lat', 'lat', { unique: false });
                    if (!store.indexNames.contains('lon')) store.createIndex('lon', 'lon', { unique: false });
                }

                // Weather cache — keyed by station ICAO
                if (!db.objectStoreNames.contains('weather_cache')) {
                    const store = db.createObjectStore('weather_cache', { keyPath: 'icao' });
                    store.createIndex('fetched_at', 'fetched_at', { unique: false });
                }

                // Flight plan packages
                if (!db.objectStoreNames.contains('flight_plans')) {
                    const store = db.createObjectStore('flight_plans', { keyPath: 'id' });
                    store.createIndex('created_at', 'created_at', { unique: false });
                    store.createIndex('active', 'active', { unique: false });
                }

                // Document library — imported/bundled PDFs (POHs, checklists, chart legends)
                if (!db.objectStoreNames.contains('flytab_documents')) {
                    const store = db.createObjectStore('flytab_documents', { keyPath: 'id' });
                    store.createIndex('type', 'type', { unique: false });
                    store.createIndex('importedAt', 'importedAt', { unique: false });
                }

                // W&B saved scenarios
                if (!db.objectStoreNames.contains('wb_scenarios')) {
                    const store = db.createObjectStore('wb_scenarios', { keyPath: 'id' });
                    store.createIndex('aircraft_id', 'aircraft_id', { unique: false });
                }

                // Fuel prices by airport
                if (!db.objectStoreNames.contains('fuel_prices')) {
                    db.createObjectStore('fuel_prices', { keyPath: 'icao' });
                }

                // Aircraft profiles
                if (!db.objectStoreNames.contains('aircraft_profiles')) {
                    db.createObjectStore('aircraft_profiles', { keyPath: 'id' });
                }

                // AI briefing cache
                if (!db.objectStoreNames.contains('ai_briefings')) {
                    const store = db.createObjectStore('ai_briefings', { keyPath: 'id' });
                    store.createIndex('flight_plan_id', 'flight_plan_id', { unique: false });
                }

                // Fuel measurements (tic mark readings, EDM comparisons)
                if (!db.objectStoreNames.contains('fuel_measurements')) {
                    const store = db.createObjectStore('fuel_measurements', { keyPath: 'id' });
                    store.createIndex('aircraft_id', 'aircraft_id', { unique: false });
                    store.createIndex('measured_at', 'measured_at', { unique: false });
                }

                // CIFP procedures — added in v5
                if (!db.objectStoreNames.contains('cifp')) {
                    db.createObjectStore('cifp', { keyPath: 'icao' });
                }

                // FAA airport remarks — added in v12. { icao, r: [[el, c, text, rwy], ...] }, one
                // record per airport, read only for the airport panel (getRemarks): NOT in
                // MEMORY_STORES. Written by importNasrBundle in its own transaction.
                if (!db.objectStoreNames.contains('airport_remarks')) {
                    db.createObjectStore('airport_remarks', { keyPath: 'icao' });
                }

                // Key-value metadata store
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }

                // General-purpose app cache (geo context, plate index, etc.)
                if (!db.objectStoreNames.contains('app_cache')) {
                    db.createObjectStore('app_cache', { keyPath: 'key' });
                }
            };

            request.onupgradeneeded = onUpgrade;

            const onSuccess = (event) => {
                clearTimeout(timer);
                done();
                const db = event.target.result;
                // Reset cached connection if it closes unexpectedly
                db.onclose = () => { if (this._db === db) this._db = null; };
                db.onversionchange = () => { db.close(); if (this._db === db) this._db = null; };
                // Also a late success after the timeout: keep it for the next call.
                if (!this._db) this._db = db;
                else if (this._db !== db) db.close();
                if (settled) { log('IndexedDB opened after the timeout — connection kept'); return; }
                settled = true;
                resolve(this._db);
            };

            // VersionError: the database on the tablet is NEWER than DB_VERSION (an older FlyTab
            // installed over a newer one). There is no downgrade, so asking for DB_VERSION would
            // fail every time and leave NASR unavailable. Open it as it is instead (no version: no
            // upgrade, stores as the newer build left them, which only ever added stores) - once.
            let retried = false;
            const onError = (event) => {
                const err = event.target.error;
                if (err?.name === 'VersionError' && !retried && !settled) {
                    retried = true;
                    log(`IndexedDB '${NasrDB.DB_NAME}' is newer than this FlyTab expects (v${NasrDB.DB_VERSION}): ${err.message} — opening it as it is`);
                    try {
                        const again = indexedDB.open(NasrDB.DB_NAME);
                        again.onblocked = onBlocked;
                        again.onupgradeneeded = onUpgrade;   // only if it vanished meanwhile (new, empty)
                        again.onsuccess = onSuccess;
                        again.onerror = onError;
                        return;
                    } catch (_) { /* reported below */ }
                }
                clearTimeout(timer);
                done();
                if (settled) return;
                settled = true;
                reject(new Error('IndexedDB open failed: ' + err));
            };
            request.onsuccess = onSuccess;
            request.onerror = onError;
        });
        this._opening = opening;
        // Whatever rejected it (including a throw above), the next call starts afresh.
        opening.catch(() => { if (this._opening === opening) this._opening = null; });
        return opening;
    }

    // ========== Generic CRUD Helpers ==========

    async _get(storeName, key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            tx.onabort = () => reject(tx.error || new Error(`Transaction aborted on ${storeName}`));
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async _put(storeName, value) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.onabort = () => reject(tx.error || new Error(`Transaction aborted on ${storeName}`));
            const req = tx.objectStore(storeName).put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async _delete(storeName, key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.onabort = () => reject(tx.error || new Error(`Transaction aborted on ${storeName}`));
            const req = tx.objectStore(storeName).delete(key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async _getAll(storeName) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Efficient key-range prefix search on a store's keyPath.
     * Returns records whose primary key starts with `prefix`.
     */
    async _getByKeyPrefix(storeName, prefix, limit = 20) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            const req = tx.objectStore(storeName).getAll(range, limit);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Efficient index-range prefix search.
     */
    async _getByIndexPrefix(storeName, indexName, prefix, limit = 20) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            const req = tx.objectStore(storeName).index(indexName).getAll(range, limit);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async _clear(storeName) {
        this._memInvalidate([storeName]);
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async _bulkPut(storeName, items) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            for (const item of items) {
                store.put(item);
            }
            tx.oncomplete = () => resolve(items.length);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    // ========== Airport Operations ==========

    async getAirport(icao) {
        return this._get('airports', icao.toUpperCase());
    }

    /** Write one airport record (e.g. runways filled in); the area queries see it next. */
    async putAirport(apt) {
        try {
            return await this._put('airports', apt);
        } finally {
            this._memInvalidate(['airports']);
        }
    }

    async searchAirports(query) {
        const q = query.toUpperCase();
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airports', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const store = tx.objectStore('airports');
            // ICAO prefix search (key range on primary key)
            const icaoRange = IDBKeyRange.bound(q, q + '\uffff');
            const req1 = store.getAll(icaoRange, 20);
            req1.onsuccess = () => {
                const byIcao = req1.result || [];
                // Name prefix search (key range on name index)
                const nameRange = IDBKeyRange.bound(q, q + '\uffff');
                const req2 = store.index('name').getAll(nameRange, 20);
                req2.onsuccess = () => {
                    const byName = req2.result || [];
                    const seen = new Set(byIcao.map(a => a.icao));
                    for (const a of byName) {
                        if (!seen.has(a.icao)) { byIcao.push(a); seen.add(a.icao); }
                    }
                    resolve(byIcao.slice(0, 20));
                };
                req2.onerror = () => resolve(byIcao.slice(0, 20)); // fallback to ICAO results only
            };
            req1.onerror = () => reject(req1.error);
        });
    }

    async getAirportsNear(lat, lon, radiusNm) {
        // Rough bounding box filter, then haversine refinement
        const degPerNm = 1 / 60;
        const latRange = radiusNm * degPerNm;
        const lonRange = radiusNm * degPerNm / Math.cos(lat * Math.PI / 180);

        const all = await this._getAll('airports');
        return all.filter(a => {
            if (!a.lat || !a.lon) return false;
            if (Math.abs(a.lat - lat) > latRange) return false;
            if (Math.abs(a.lon - lon) > lonRange) return false;
            return NasrDB.haversineNm(lat, lon, a.lat, a.lon) <= radiusNm;
        });
    }

    // ========== Navaid Operations ==========

    async getNavaid(id) {
        return this._get('navaids', id.toUpperCase());
    }

    async searchNavaids(query) {
        const q = query.toUpperCase();
        // Use key range for ID prefix (fast, indexed)
        return this._getByKeyPrefix('navaids', q, 20);
    }

    // ========== Spatial Queries (Bounding Box) ==========

    /**
     * Get navaids within a lat/lon bounding box (from the in-memory copy).
     */
    async getNavaidsinBounds(south, west, north, east, limit = 200) {
        const rows = await this._memRows('navaids');
        return NasrDB._copies(NasrDB._pointsInBox(rows, south, west, north, east, limit));
    }

    /**
     * Get fixes within a lat/lon bounding box (from the in-memory copy, ~70K records).
     */
    async getFixesInBounds(south, west, north, east, limit = 500) {
        const rows = await this._memRows('fixes');
        return NasrDB._copies(NasrDB._pointsInBox(rows, south, west, north, east, limit));
    }

    // ========== Spatial Queries (Bounding Box) — Airports, Airspace, Airways ==========

    /**
     * Get airports within a lat/lon bounding box (from the in-memory copy, ~19K records).
     */
    async getAirportsInBounds(south, west, north, east, limit = 500) {
        const rows = await this._memRows('airports');
        // All airports in the box -- do NOT stop early on count since private
        // strips (sorted before K-prefix ICAO airports) would fill the limit
        // first, hiding weather-capable airports like KMCO from the results.
        const all = NasrDB._pointsInBox(rows, south, west, north, east, Infinity);
        // Sort: K-prefix ICAO first (have weather data), then towered, then rest
        all.sort((a, b) => {
            const aK = a.icao?.startsWith('K') ? 0 : 1;
            const bK = b.icao?.startsWith('K') ? 0 : 1;
            if (aK !== bK) return aK - bK;
            return (b.tower ? 1 : 0) - (a.tower ? 1 : 0);
        });
        return NasrDB._copies(all.slice(0, limit));
    }

    /**
     * Get airspace polygons that overlap a bounding box.
     */
    // limit raised 500->3000 (here and on getSuaInBounds/getTrsaInBounds):
    // GeoUtils.polygonOverlapsBox's added edge-clip case matches more
    // candidates per query than the old vertex/center-only test, so the
    // cursor cap could now be reached earlier in store-iteration order and
    // silently truncate results a caller previously always received. Each
    // method queries a single store (airspace: ~5638 records nationwide,
    // sua: ~1236) — 3000 is comfortably above what any one geographic
    // bounding-box query could realistically match within a single store,
    // not a claim about the two stores' combined total.
    async getAirspaceInBounds(south, west, north, east, limit = 3000) {
        const rows = await this._memRows('airspace');
        const results = [];
        for (const v of rows) {
            if (results.length >= limit) break;
            const boundary = v.boundary || v.points || [];
            // A vertex inside the query box or the box's center inside
            // the polygon catches most overlaps, but neither catches a
            // polygon edge that clips through the box without either
            // shape's reference point landing inside the other (e.g. a
            // wide Class B shelf whose edge crosses a corner of the box)
            // — see GeoUtils.polygonOverlapsBox for the full 3-case test.
            const overlaps = typeof GeoUtils !== 'undefined'
                ? GeoUtils.polygonOverlapsBox(boundary, south, west, north, east)
                : boundary.some(pt => {
                    // Explicit format check, not `pt[0] || pt.lat`: that
                    // pattern drops a real vertex sitting exactly at 0.0
                    // latitude or longitude (falsy 0 falls through to the
                    // .lat/.lon read on an array, which is undefined).
                    // Not reachable for a CONUS-only app in practice, but
                    // cheap to get right.
                    const lat = Array.isArray(pt) ? pt[0] : pt.lat;
                    const lon = Array.isArray(pt) ? pt[1] : pt.lon;
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
            if (overlaps) results.push(v);
        }
        return NasrDB._copies(results);
    }

    /**
     * Get Special Use Airspace (R/P/W/A/MOA) that overlaps a bounding box.
     */
    async getSuaInBounds(south, west, north, east, limit = 3000) {
        const rows = await this._memRows('sua');
        const results = [];
        for (const v of rows) {
            if (results.length >= limit) break;
            const boundary = v.boundary || [];
            // See getAirspaceInBounds above for the full 3-case overlap test.
            const overlaps = typeof GeoUtils !== 'undefined'
                ? GeoUtils.polygonOverlapsBox(boundary, south, west, north, east)
                : boundary.some(pt => {
                    const lat = pt[0], lon = pt[1];
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
            if (overlaps) results.push(v);
        }
        return NasrDB._copies(results);
    }

    /**
     * Get Terminal Radar Service Areas whose approximate boundary overlaps a
     * bounding box. A TRSA record with no published radius has an empty
     * boundary array and will never match here -- that's correct, not a bug
     * (build_nasr.py's build_trsa_records() only builds a boundary when a
     * radius was actually published in the TWR4 remark text).
     */
    async getTrsaInBounds(south, west, north, east, limit = 3000) {
        const rows = await this._memRows('trsa');
        const results = [];
        for (const v of rows) {
            if (results.length >= limit) break;
            const boundary = v.boundary || [];
            // See getAirspaceInBounds above for the full 3-case overlap test.
            // TRSA circles are large (20-60nm radius) relative to typical
            // cockpit zoom, so the vertex-only fallback below would miss a
            // TRSA whenever the viewport sits entirely inside its circle —
            // GeoUtils.polygonOverlapsBox's center-in-polygon case (2) is
            // what actually catches that, not just the edge-clip case (3).
            const overlaps = typeof GeoUtils !== 'undefined'
                ? GeoUtils.polygonOverlapsBox(boundary, south, west, north, east)
                : boundary.some(pt => {
                    const lat = pt[0], lon = pt[1];
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
            if (overlaps) results.push(v);
        }
        return NasrDB._copies(results);
    }

    /**
     * Get airways that have at least one waypoint within bounds.
     */
    async getAirwaysInBounds(south, west, north, east, limit = 100) {
        const rows = await this._memRows('airways');
        const results = [];
        for (const v of rows) {
            if (results.length >= limit) break;
            const waypoints = v.waypoints || v.fixes || [];
            const inBounds = waypoints.some(wp => {
                const lat = wp.lat;
                const lon = wp.lon;
                return lat >= south && lat <= north && lon >= west && lon <= east;
            });
            if (inBounds) results.push(v);
        }
        return NasrDB._copies(results);
    }

    // ========== Airway Operations ==========

    async getAirway(name) {
        return this._get('airways', name.toUpperCase());
    }

    /** Return all airway records (for graph build). */
    async listAirways() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['airways'], 'readonly');
            const store = tx.objectStore('airways');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror   = () => reject(req.error);
        });
    }

    // ========== Weather Cache ==========

    async getWeather(icao) {
        return this._get('weather_cache', icao.toUpperCase());
    }

    async putWeather(icao, data) {
        return this._put('weather_cache', {
            icao: icao.toUpperCase(),
            ...data,
            fetched_at: data.fetched_at || new Date().toISOString(),
        });
    }

    async getAllWeather() {
        return this._getAll('weather_cache');
    }

    async clearOldWeather(maxAgeMs = 3 * 3600000) {
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        const all = await this._getAll('weather_cache');
        const old = all.filter(w => w.fetched_at < cutoff);
        for (const w of old) {
            await this._delete('weather_cache', w.icao);
        }
        return old.length;
    }

    // ========== Flight Plan Operations ==========

    async getActiveFlightPlan() {
        const all = await this._getAll('flight_plans');
        // Find the active one, or the most recent
        const active = all.find(p => p.active);
        if (active) return active;
        if (all.length === 0) return null;
        return all.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    }

    async saveFlightPlan(pkg) {
        if (!pkg.id) {
            pkg.id = crypto.randomUUID ? crypto.randomUUID() : `fp-${Date.now()}`;
        }
        pkg.created_at = pkg.created_at || new Date().toISOString();
        // Deactivate others
        const all = await this._getAll('flight_plans');
        for (const p of all) {
            if (p.id !== pkg.id && p.active) {
                p.active = false;
                await this._put('flight_plans', p);
            }
        }
        pkg.active = true;
        return this._put('flight_plans', pkg);
    }

    async getFlightPlan(id) {
        return this._get('flight_plans', id);
    }

    // ========== Documents ==========

    async saveDocument(doc) {
        if (!doc.id) doc.id = crypto.randomUUID ? crypto.randomUUID() : `doc-${Date.now()}`;
        doc.importedAt = doc.importedAt || new Date().toISOString();
        return this._put('flytab_documents', doc);
    }

    async getDocument(id) {
        return this._get('flytab_documents', id);
    }

    async getAllDocuments() {
        return this._getAll('flytab_documents');
    }

    async deleteDocument(id) {
        return this._delete('flytab_documents', id);
    }

    // ========== W&B Scenarios ==========

    async getWbScenarios(aircraftId) {
        const all = await this._getAll('wb_scenarios');
        return all.filter(s => s.aircraft_id === aircraftId);
    }

    async saveWbScenario(scenario) {
        if (!scenario.id) {
            scenario.id = crypto.randomUUID ? crypto.randomUUID() : `wb-${Date.now()}`;
        }
        scenario.created_at = scenario.created_at || new Date().toISOString();
        return this._put('wb_scenarios', scenario);
    }

    // ========== Fuel Prices ==========

    async getFuelPrice(icao) {
        return this._get('fuel_prices', icao.toUpperCase());
    }

    async putFuelPrices(prices) {
        return this._bulkPut('fuel_prices', prices);
    }

    // ========== Aircraft Profiles ==========

    async getAircraftProfiles() {
        return this._getAll('aircraft_profiles');
    }

    async getAircraftProfile(id) {
        return this._get('aircraft_profiles', id);
    }

    async saveAircraftProfile(profile) {
        return this._put('aircraft_profiles', profile);
    }

    async saveAircraftProfiles(profiles) {
        return this._bulkPut('aircraft_profiles', profiles);
    }

    // ========== Fuel Measurements ==========

    async saveFuelMeasurement(measurement) {
        if (!measurement.id) {
            measurement.id = crypto.randomUUID ? crypto.randomUUID() : `fm-${Date.now()}`;
        }
        measurement.measured_at = measurement.measured_at || new Date().toISOString();
        return this._put('fuel_measurements', measurement);
    }

    async getFuelMeasurements(aircraftId, limit = 100) {
        const all = await this._getAll('fuel_measurements');
        return all
            .filter(m => m.aircraft_id === aircraftId)
            .sort((a, b) => b.measured_at.localeCompare(a.measured_at))
            .slice(0, limit);
    }

    async getLatestEdmReading(aircraftId) {
        const measurements = await this.getFuelMeasurements(aircraftId, 1);
        return measurements.length > 0 ? measurements[0] : null;
    }

    // ========== AI Briefings ==========

    async getAiBriefing(flightPlanId) {
        const all = await this._getAll('ai_briefings');
        return all.find(b => b.flight_plan_id === flightPlanId) || null;
    }

    async saveAiBriefing(briefing) {
        if (!briefing.id) {
            briefing.id = crypto.randomUUID ? crypto.randomUUID() : `ai-${Date.now()}`;
        }
        return this._put('ai_briefings', briefing);
    }

    // ========== Metadata ==========

    async getMeta(key) {
        const result = await this._get('meta', key);
        return result ? result.value : null;
    }

    async setMeta(key, value) {
        return this._put('meta', { key, value, updated_at: new Date().toISOString() });
    }

    async getCycleInfo() {
        return this.getMeta('nasr_cycle_info');
    }

    // ========== App Cache (key-value, for geo context, plate index, etc.) ==========

    async getAppCache(key) {
        const record = await this._get('app_cache', key);
        return record ? record.data : null;
    }

    async putAppCache(key, data) {
        return this._put('app_cache', { key, data, fetched_at: new Date().toISOString() });
    }

    async getAppCacheMeta(key) {
        return this._get('app_cache', key);
    }

    // ========== NASR Data Import ==========

    async importNasrBundle(bundle) {
        // Bundle is an object with { airports, navaids, airways, airspace, sua, trsa, fixes, cycle_info }
        // All stores are written in a single transaction so that a mid-import failure
        // never leaves the DB in a partially-cleared state.
        const db = await this.open();
        const storeNames = ['airports', 'navaids', 'airways', 'airspace', 'sua', 'trsa', 'fixes'];
        let count = 0;
        // The in-memory copies: dropped now (a load already running read the old
        // data; its result is not kept), and again when the write is done (costs
        // one extra read after an import; cheap insurance, imports are rare).
        this._memInvalidate(storeNames);

        await new Promise((resolve, reject) => {
            const tx = db.transaction(storeNames, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('NASR import transaction aborted'));

            const write = (storeName, items) => {
                if (!items?.length) return;
                const store = tx.objectStore(storeName);
                store.clear();
                for (const item of items) {
                    count++;
                    store.put(item);
                }
            };

            write('airports', bundle.airports);
            write('navaids', bundle.navaids);
            write('airways', bundle.airways);
            write('airspace', bundle.airspace);
            write('sua', bundle.sua);
            write('trsa', bundle.trsa);
            write('fixes', bundle.fixes);
        }).finally(() => this._memInvalidate(storeNames));

        // FAA remarks: their own transaction, after the main one has committed, so a failure here
        // can never roll back or fail the import. Before the cycle meta below: an import cut short
        // here (app killed) still looks stale at the next startup and is redone.
        await this._importRemarks(db, bundle.remarks, bundle.cycle_info);

        if (bundle.cycle_info) {
            // Always persist sua_count so staleness check can detect missing SUA on next startup
            const cycleToStore = { ...bundle.cycle_info, sua_count: bundle.sua?.length ?? 0 };
            await this.setMeta('nasr_cycle_info', cycleToStore);
        }
        await this.setMeta('nasr_last_import', new Date().toISOString());
        return count;
    }

    // ========== FAA Airport Remarks ==========

    /** Puts per chunk in the remarks transaction; each chunk is one short JS task (_writeRemarks). */
    static REMARKS_CHUNK = 1000;
    /** importNasrBundle stops waiting for the remarks write after this (the write itself goes on). */
    static REMARKS_TIMEOUT_MS = 30000;

    /**
     * The FAA remarks of one airport in display order: [[el, c, text, rwy], ...] (bundle v12,
     * airport_remarks store). [] when it has none, or the store is missing or can't be read.
     */
    async getRemarks(icao) {
        const key = String(icao ?? '').trim().toUpperCase();
        if (!key) return [];
        try {
            const rec = await this._get('airport_remarks', key);
            return Array.isArray(rec?.r) ? rec.r : [];
        } catch (err) {
            console.warn('NasrDB: remarks read failed for', key, err);
            return [];
        }
    }

    /**
     * bundle.remarks ({ ICAO: [[el, c, text, rwy], ...] }) as store records { icao, r }. Every field
     * is forced to its contract type; a tuple without text, a non-array list and an airport left with
     * no remarks are skipped. Anything that is not a plain object gives no records.
     */
    static _remarkRecords(remarks) {
        const out = [];
        if (!remarks || typeof remarks !== 'object' || Array.isArray(remarks)) return out;
        const str = (v) => (typeof v === 'string' ? v : '');
        for (const [icao, list] of Object.entries(remarks)) {
            if (!icao || !Array.isArray(list)) continue;
            const r = [];
            for (const t of list) {
                if (!Array.isArray(t) || typeof t[2] !== 'string' || !t[2].trim()) continue;
                r.push([str(t[0]), str(t[1]), t[2], (typeof t[3] === 'string' && t[3]) ? t[3] : null]);
            }
            if (r.length) out.push({ icao, r });
        }
        return out;
    }

    /**
     * One readwrite transaction on airport_remarks: clear, then put the records in chunks of
     * REMARKS_CHUNK, each chunk queued from the previous chunk's last put. The transaction stays
     * open across the chunks (a request is always pending), so it is still all-or-nothing, but no
     * single JS task does ~18k puts (CLAUDE.md: very long JS runs during the NASR import have left
     * IndexedDB stuck). Resolves with the record count when the transaction has committed.
     */
    _writeRemarks(db, records) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airport_remarks', 'readwrite');
            const store = tx.objectStore('airport_remarks');
            tx.oncomplete = () => resolve(records.length);
            tx.onabort = () => reject(tx.error || new Error('remarks transaction aborted'));
            let i = 0;
            const next = () => {
                try {
                    const end = Math.min(i + NasrDB.REMARKS_CHUNK, records.length);
                    let last = null;
                    for (; i < end; i++) last = store.put(records[i]);
                    if (last && i < records.length) last.onsuccess = next;
                } catch (err) {
                    try { tx.abort(); } catch (_) { /* already finished */ }
                    reject(err);
                }
            };
            const cleared = store.clear();
            if (records.length) cleared.onsuccess = next;
        });
    }

    /**
     * meta key of the remarks import record { key, ok, attempts, written, expected } (tablet only:
     * FlyTab before v12.57 never writes it). It is how a NASR cycle that is loaded but whose remarks
     * are not (an older FlyTab imported the bundle, or the remarks write failed) is found and fixed.
     */
    static REMARKS_MARKER = 'nasr_remarks_import';
    /** Remarks imports tried per bundle (cycle + bundle version) before startup / sync stop retrying. */
    static REMARKS_MAX_ATTEMPTS = 2;

    /** The bundle a remarks import belongs to: "<effective_date>|<bundle_version>". */
    static _remarksKey(cycleInfo) {
        return `${cycleInfo?.effective_date ?? ''}|${cycleInfo?.bundle_version ?? ''}`;
    }

    /**
     * Whether the loaded NASR cycle should be imported again for its FAA remarks: the cycle has
     * remarks (cycle_info.remarks_count > 0) but no successful remarks import is recorded for it, and
     * fewer than REMARKS_MAX_ATTEMPTS were tried (the attempt is recorded before the write, so even a
     * write that kills the app is counted: a persistent failure can't make every start re-import).
     * @param {object} [cycleInfo] the loaded cycle (default: nasr_cycle_info in meta)
     */
    async remarksNeedImport(cycleInfo) {
        try {
            const ci = cycleInfo || await this.getCycleInfo();
            if (!(Number(ci?.remarks_count) > 0)) return false;
            const m = await this.getMeta(NasrDB.REMARKS_MARKER);
            const key = NasrDB._remarksKey(ci);
            if (m?.key === key && m.ok) return false;
            const attempts = m?.key === key ? (Number(m.attempts) || 0) : 0;
            return attempts < NasrDB.REMARKS_MAX_ATTEMPTS;
        } catch (err) {
            console.warn('NasrDB: remarks check failed', err);
            return false;
        }
    }

    /**
     * Write bundle.remarks into airport_remarks (a bundle without remarks clears it). Never throws:
     * a failed write is logged to DiagLog and the store is cleared, so remarks of an older cycle are
     * not shown beside the new data. Waits at most REMARKS_TIMEOUT_MS; a write still running then is
     * logged and left to finish on its own (not cleared now: that clear would run after it); if it
     * then fails, the store is cleared in a new transaction. The attempt and its result are recorded
     * in meta REMARKS_MARKER (remarksNeedImport).
     */
    async _importRemarks(db, remarks, cycleInfo) {
        const log = (msg) => { if (typeof DiagLog !== 'undefined') DiagLog.log('nasr', msg); };
        const t0 = Date.now();
        const TIMED_OUT = {};
        let timer = null;
        let marker = null;
        const clearStore = () => {
            try {
                this._clear('airport_remarks').catch((e) => log(`FAA remarks clear failed — ${e?.message || e}`));
            } catch (e) {
                log(`FAA remarks clear failed — ${e?.message || e}`);
            }
        };
        const record = async (fields) => {
            if (!marker) return;
            marker = { ...marker, ...fields };
            try { await this.setMeta(NasrDB.REMARKS_MARKER, marker); } catch (e) { log(`FAA remarks record not saved — ${e?.message || e}`); }
        };
        try {
            if (cycleInfo) {
                const key = NasrDB._remarksKey(cycleInfo);
                let prev = null;
                try { prev = await this.getMeta(NasrDB.REMARKS_MARKER); } catch (_) { /* none */ }
                const expected = Number(cycleInfo.remarks_count);
                marker = { key, ok: false, attempts: (prev?.key === key ? (Number(prev.attempts) || 0) : 0) + 1,
                    written: null, expected: Number.isFinite(expected) ? expected : null };
                await record({});                          // the attempt counts before the write runs
            }
            const records = NasrDB._remarkRecords(remarks);
            const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), NasrDB.REMARKS_TIMEOUT_MS); });
            const write = this._writeRemarks(db, records);
            let timedOut = false;
            write.then((n) => {                         // finished after the timeout: record it
                if (timedOut) { log(`FAA remarks: ${n} airports written late, after ${Date.now() - t0} ms`); record({ ok: true, written: n }); }
            }, (err) => {                               // failed after the timeout: clear, as below
                if (!timedOut) return;
                log(`FAA remarks write failed late — ${err?.message || err}; store cleared`);
                clearStore();
            });
            const n = await Promise.race([write, timeout]);
            if (n === TIMED_OUT) {
                timedOut = true;
                log(`FAA remarks write not done after ${NasrDB.REMARKS_TIMEOUT_MS / 1000} s — import goes on, write left running`);
                return;
            }
            log(remarks == null
                ? `FAA remarks: none in this bundle — store cleared (${Date.now() - t0} ms)`
                : `FAA remarks: ${n} airports written in ${Date.now() - t0} ms`);
            await record({ ok: true, written: n });
        } catch (err) {
            log(`FAA remarks write failed after ${Date.now() - t0} ms — ${err?.message || err}; NASR import kept, remarks not shown`);
            clearStore();
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Combined search across airports, navaids, and fixes.
     * Each store gets its own transaction with a timeout to avoid
     * being blocked by background sync writes.
     */
    async searchAll(query, limit = 20) {
        const q = query.toUpperCase();
        const range = IDBKeyRange.bound(q, q + '\uffff');
        const db = await this.open();

        const withTimeout = (promise, ms) => Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve([]), ms)),
        ]);

        // ID prefix search via key range (fast, indexed)
        const searchByKeyRange = (storeName, keyRange) => new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const req = tx.objectStore(storeName).getAll(keyRange, limit);
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
                tx.onabort = () => resolve([]);
            } catch { resolve([]); }
        });

        // Name contains search using cursor (IDB ranges are case-sensitive so we scan)
        const searchByName = (storeName, field) => new Promise((resolve) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const results = [];
                const req = tx.objectStore(storeName).openCursor();
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor || results.length >= limit) { resolve(results); return; }
                    const val = cursor.value;
                    if (val[field] && val[field].toUpperCase().includes(q)) {
                        results.push(val);
                    }
                    cursor.continue();
                };
                req.onerror = () => resolve([]);
                tx.onabort = () => resolve([]);
            } catch { resolve([]); }
        });

        // For airports: search both raw query (SPA*) and K-prefixed (KSPA*) since US ICAOs start with K
        const kRange = IDBKeyRange.bound('K' + q, 'K' + q + '\uffff');

        // Run ID searches (fast indexed lookups)
        const [airportById, airportByKId, navaidById, fixById] = await Promise.all([
            withTimeout(searchByKeyRange('airports', range), 3000),
            withTimeout(searchByKeyRange('airports', kRange), 3000),
            withTimeout(searchByKeyRange('navaids', range), 3000),
            withTimeout(searchByKeyRange('fixes', range), 3000),
        ]);

        // Then name scans
        const [airportByName, navaidByName] = await Promise.all([
            withTimeout(searchByName('airports', 'name'), 3000),
            withTimeout(searchByName('navaids', 'name'), 3000),
        ]);

        // Merge airport ID results (dedup between raw and K-prefixed)
        const allAirportById = [...airportById];
        const seenAptId = new Set(airportById.map(a => a.icao));
        for (const a of airportByKId) {
            if (!seenAptId.has(a.icao)) { allAirportById.push(a); seenAptId.add(a.icao); }
        }

        // Merge: ID matches first, then name-only matches (dedup by key)
        const airports = [
            ...allAirportById.map(a => ({ ...a, _matchType: 'id' })),
            ...airportByName.filter(a => !seenAptId.has(a.icao)).map(a => ({ ...a, _matchType: 'name' })),
        ].slice(0, limit);

        const seenNavaids = new Set(navaidById.map(n => n.id));
        const navaids = [
            ...navaidById.map(n => ({ ...n, _matchType: 'id' })),
            ...navaidByName.filter(n => !seenNavaids.has(n.id)).map(n => ({ ...n, _matchType: 'name' })),
        ].slice(0, limit);

        const fixes = fixById.map(f => ({ ...f, _matchType: 'id' }));

        return { airports, navaids, fixes };
    }

    async searchAllExtended(query, limit = 20) {
        const q = query.toUpperCase();
        const db = await this.open();

        const withTimeout = (promise, ms) => Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve([]), ms)),
        ]);

        const [base, airportsByCity, airways] = await Promise.all([
            this.searchAll(query, limit),
            withTimeout(new Promise((resolve) => {
                try {
                    const tx = db.transaction('airports', 'readonly');
                    const results = [];
                    const req = tx.objectStore('airports').openCursor();
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor || results.length >= limit) { resolve(results); return; }
                        const val = cursor.value;
                        if (val.city && val.city.toUpperCase().includes(q)) {
                            results.push({ ...val, _matchType: 'city' });
                        }
                        cursor.continue();
                    };
                    req.onerror = () => resolve([]);
                    tx.onabort = () => resolve([]);
                } catch { resolve([]); }
            }), 3000),
            withTimeout(new Promise((resolve) => {
                try {
                    const range = IDBKeyRange.bound(q, q + '￿');
                    const tx = db.transaction('airways', 'readonly');
                    const req = tx.objectStore('airways').getAll(range, limit);
                    req.onsuccess = () => resolve((req.result || []).map(a => ({ ...a, _matchType: 'id' })));
                    req.onerror = () => resolve([]);
                    tx.onabort = () => resolve([]);
                } catch { resolve([]); }
            }), 3000),
        ]);

        const seenApts = new Set(base.airports.map(a => a.icao));
        const extraApts = airportsByCity.filter(a => !seenApts.has(a.icao));

        return {
            airports: [...base.airports, ...extraApts].slice(0, limit),
            navaids: base.navaids,
            fixes: base.fixes,
            airways,
        };
    }

    // ========== Fix Operations ==========

    async getFix(id) {
        return this._get('fixes', id.toUpperCase());
    }

    async searchFixes(query) {
        const q = query.toUpperCase();
        // Use key range for ID prefix (fast, indexed)
        return this._getByKeyPrefix('fixes', q, 20);
    }

    // ========== Static Utility: Haversine ==========

    static haversineNm(lat1, lon1, lat2, lon2) {
        // Delegates to planning/math/route-math.js — prefer haversine() from FlyTabPlanning
        if (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.haversine) {
            return FlyTabPlanning.haversine(lat1, lon1, lat2, lon2);
        }
        // Fallback if planning lib not yet ready
        const R = 3440.065; // Earth radius in nautical miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }
}
