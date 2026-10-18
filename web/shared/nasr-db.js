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
    static DB_VERSION = 11;
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
        return rows.map((r) => structuredClone(r));
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

            request.onblocked = () => log('IndexedDB upgrade blocked by another open connection — waiting');

            request.onupgradeneeded = (event) => {
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

                // Key-value metadata store
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }

                // General-purpose app cache (geo context, plate index, etc.)
                if (!db.objectStoreNames.contains('app_cache')) {
                    db.createObjectStore('app_cache', { keyPath: 'key' });
                }
            };

            request.onsuccess = (event) => {
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

            request.onerror = (event) => {
                clearTimeout(timer);
                done();
                if (settled) return;
                settled = true;
                reject(new Error('IndexedDB open failed: ' + event.target.error));
            };
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
        // The in-memory copies: dropped now, and again when the write is done
        // (a load started while it runs read the old data).
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

        if (bundle.cycle_info) {
            // Always persist sua_count so staleness check can detect missing SUA on next startup
            const cycleToStore = { ...bundle.cycle_info, sua_count: bundle.sua?.length ?? 0 };
            await this.setMeta('nasr_cycle_info', cycleToStore);
        }
        await this.setMeta('nasr_last_import', new Date().toISOString());
        return count;
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
