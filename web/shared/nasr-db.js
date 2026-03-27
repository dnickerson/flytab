/**
 * FlyPi — NASR Database (IndexedDB)
 * Wraps IndexedDB for structured data storage: airports, navaids, airways,
 * weather cache, flight plans, W&B scenarios, fuel prices, aircraft profiles.
 */

class NasrDB {
    static DB_NAME = 'flypi';
    static DB_VERSION = 7;

    constructor() {
        this._db = null;
    }

    async open() {
        if (this._db) return this._db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(NasrDB.DB_NAME, NasrDB.DB_VERSION);

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
                this._db = event.target.result;
                // Reset cached connection if it closes unexpectedly
                this._db.onclose = () => { this._db = null; };
                this._db.onversionchange = () => { this._db.close(); this._db = null; };
                resolve(this._db);
            };

            request.onerror = (event) => {
                reject(new Error('IndexedDB open failed: ' + event.target.error));
            };
        });
    }

    // ========== Generic CRUD Helpers ==========

    async _get(storeName, key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async _put(storeName, value) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async _delete(storeName, key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
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
     * Get navaids within a lat/lon bounding box.
     * Uses cursor scan with in-memory filtering — fast enough for ~2,300 records.
     */
    async getNavaidsinBounds(south, west, north, east, limit = 200) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('navaids', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('navaids').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                if (v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east) {
                    results.push(v);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Get fixes within a lat/lon bounding box.
     * Uses cursor scan with in-memory filtering — ~70K records in <50ms.
     */
    async getFixesInBounds(south, west, north, east, limit = 500) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('fixes', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('fixes').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                if (v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east) {
                    results.push(v);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    // ========== Spatial Queries (Bounding Box) — Airports, Airspace, Airways ==========

    /**
     * Get airports within a lat/lon bounding box.
     * Uses cursor scan with in-memory filtering — fast enough for ~19K records.
     */
    async getAirportsInBounds(south, west, north, east, limit = 300) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airports', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('airports').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                if (v.lat >= south && v.lat <= north && v.lon >= west && v.lon <= east) {
                    results.push(v);
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Get airspace polygons that overlap a bounding box.
     * Checks if any boundary vertex falls within bounds.
     */
    async getAirspaceInBounds(south, west, north, east, limit = 500) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airspace', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('airspace').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                const boundary = v.boundary || v.points || [];
                const inBounds = boundary.some(pt => {
                    const lat = pt[0] || pt.lat;
                    const lon = pt[1] || pt.lon;
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
                if (inBounds) results.push(v);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Get airways that have at least one waypoint within bounds.
     */
    async getAirwaysInBounds(south, west, north, east, limit = 100) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('airways', 'readonly');
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
            const results = [];
            const req = tx.objectStore('airways').openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor || results.length >= limit) { resolve(results); return; }
                const v = cursor.value;
                const waypoints = v.waypoints || v.fixes || [];
                const inBounds = waypoints.some(wp => {
                    const lat = wp.lat;
                    const lon = wp.lon;
                    return lat >= south && lat <= north && lon >= west && lon <= east;
                });
                if (inBounds) results.push(v);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    // ========== Airway Operations ==========

    async getAirway(name) {
        return this._get('airways', name.toUpperCase());
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
        // Bundle is an object with { airports, navaids, airways, airspace, fixes, cycle_info }
        // All stores are written in a single transaction so that a mid-import failure
        // never leaves the DB in a partially-cleared state.
        const db = await this.open();
        const storeNames = ['airports', 'navaids', 'airways', 'airspace', 'fixes'];
        let count = 0;

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
            write('fixes', bundle.fixes);
        });

        if (bundle.cycle_info) {
            await this.setMeta('nasr_cycle_info', bundle.cycle_info);
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
        const R = 3440.065; // Earth radius in nautical miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
