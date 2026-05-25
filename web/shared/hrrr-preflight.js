/**
 * FlyTab — HRRR Preflight Instability Store
 * Fetches CAPE/CIN/shear grid from AWC via flywhere proxy, stores in IndexedDB.
 * EXPERIMENTAL — ground use only (internet required).
 */

class HRRRPreflightStore {
    constructor() {
        this._db    = null;
        this._data  = null;  // in-memory cache of last loaded/fetched data
    }

    async open() {
        if (this._db) return;
        await new Promise((resolve, reject) => {
            const req = indexedDB.open('flytab_convective', 1);
            req.onupgradeneeded = e => {
                e.target.result.createObjectStore('preflight');
            };
            req.onsuccess  = e => { this._db = e.target.result; resolve(); };
            req.onerror    = () => reject(req.error);
        });
    }

    /** Load previously saved preflight data from IDB. Returns data or null. */
    async load() {
        await this.open();
        return new Promise(resolve => {
            const tx  = this._db.transaction('preflight', 'readonly');
            const req = tx.objectStore('preflight').get('data');
            req.onsuccess = () => { this._data = req.result ?? null; resolve(this._data); };
            req.onerror   = () => resolve(null);
        });
    }

    async _save(data) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction('preflight', 'readwrite');
            tx.objectStore('preflight').put(data, 'data');
            tx.oncomplete = () => { this._data = data; resolve(); };
            tx.onerror    = () => reject(tx.error);
        });
    }

    /**
     * Fetch HRRR instability grid for a route bbox and store to IDB.
     * @param {{ minLat, maxLat, minLon, maxLon }} routeBbox
     * @returns {Promise<object>} saved preflight data object
     */
    async fetchAndStore(routeBbox) {
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const { minLat, maxLat, minLon, maxLon } = routeBbox;
        const BUF  = 0.83;  // ~50nm buffer
        const bbox = `${(minLat - BUF).toFixed(2)},${(minLon - BUF).toFixed(2)},${(maxLat + BUF).toFixed(2)},${(maxLon + BUF).toFixed(2)}`;

        const url = `${base}/weather?type=griddata&bbox=${bbox}&fields=cape,cin,lcl,lfc,shear03&format=json`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) throw new Error(`HRRR fetch failed: ${resp.status} ${resp.statusText}`);
        const json = await resp.json();

        const grid = computeInstabilityGrid(json);
        const now  = new Date();

        const data = {
            fetchedAt:   now.toISOString(),
            validUntil:  new Date(now.getTime() + 3 * 3600000).toISOString(),
            routeBbox,
            instabilityGrid:    grid,
            nexradSiteLocations: findNexradSitesInBbox(routeBbox),
        };

        await this._save(data);
        return data;
    }

    /** In-memory grid (null if not loaded). */
    getGrid() { return this._data?.instabilityGrid ?? null; }

    /**
     * @returns {'none' | 'valid' | 'stale' | 'expired'}
     */
    getStaleness() {
        if (!this._data) return 'none';
        const ageMs = Date.now() - new Date(this._data.fetchedAt).getTime();
        if (ageMs > 6 * 3600000) return 'expired';
        if (ageMs > 3 * 3600000) return 'stale';
        return 'valid';
    }

    /** Human-readable age string, e.g. "2h 14m ago" */
    getAgeLabel() {
        if (!this._data) return 'No data';
        const ageMs  = Date.now() - new Date(this._data.fetchedAt).getTime();
        const hours  = Math.floor(ageMs / 3600000);
        const mins   = Math.floor((ageMs % 3600000) / 60000);
        return hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
    }
}
