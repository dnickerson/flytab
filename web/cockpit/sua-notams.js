/**
 * SuaNotams — fetches active NOTAM status for Special Use Airspace.
 *
 * Calls flywhere.app/api/notams when online; returns a Map of
 * normalized SUA names → NOTAM info for polygons currently in view.
 *
 * Entirely silent when offline — callers check .hasActiveNotam(sua).
 */
class SuaNotams {
    static NOTAM_API = 'https://flywhere.app/api/notams';
    static CACHE_MS  = 5 * 60 * 1000;   // 5 min

    constructor() {
        this._cache     = null;   // { bbox, items: Map<normalizedKey, notam>, fetchedAt }
        this._fetching  = null;   // in-flight Promise
    }

    /**
     * Returns true if a given SUA area has an active NOTAM.
     * @param {Object} sua - SUA object from IndexedDB { id, name, type }
     */
    hasActiveNotam(sua) {
        if (!this._cache) return false;
        const key = SuaNotams._normalize(sua.name || sua.id);
        return this._cache.items.has(key);
    }

    /**
     * Get the NOTAM object for a given SUA area, or null.
     */
    getNotam(sua) {
        if (!this._cache) return null;
        const key = SuaNotams._normalize(sua.name || sua.id);
        return this._cache.items.get(key) ?? null;
    }

    /**
     * Fetch NOTAMs for the given bounding box (called when SUA layer updates).
     * Caches for 5 min; concurrent calls share one in-flight request.
     * Silently returns empty when offline or on error.
     *
     * @param {number} south
     * @param {number} west
     * @param {number} north
     * @param {number} east
     */
    async fetchForBounds(south, west, north, east) {
        // Return cached if bounds roughly match and not stale
        if (this._cache && !this._isCacheStale() && this._bboxCovers(south, west, north, east)) {
            return;
        }

        // If already fetching, wait for it
        if (this._fetching) {
            await this._fetching;
            return;
        }

        this._fetching = this._doFetch(south, west, north, east);
        try {
            await this._fetching;
        } finally {
            this._fetching = null;
        }
    }

    async _doFetch(south, west, north, east) {
        // Expand bbox slightly so edge polygons get covered
        const pad = 1.0;
        const params = new URLSearchParams({
            south: String(Math.max(-90,  south - pad)),
            west:  String(Math.max(-180, west  - pad)),
            north: String(Math.min(90,   north + pad)),
            east:  String(Math.min(180,  east  + pad)),
        });

        try {
            const resp = await fetch(`${SuaNotams.NOTAM_API}?${params}`, {
                signal: AbortSignal.timeout(8000),
                cache:  'no-store',
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._buildCache(data.items ?? [], south, west, north, east);
        } catch (err) {
            // Offline or API unavailable — leave existing cache in place (or empty)
            if (this._cache) {
                // Extend stale cache rather than clearing it
                this._cache.fetchedAt = Date.now() - SuaNotams.CACHE_MS + 30_000; // retry in 30s
            }
            console.debug('[SuaNotams] fetch skipped (offline or error):', err?.message);
        }
    }

    _buildCache(items, south, west, north, east) {
        const map = new Map();
        for (const notam of items) {
            // Extract SUA designator from NOTAM text
            // e.g. "ADA EAST MOA ACT 1200-2359" → key "ADA EAST MOA"
            const keys = SuaNotams._extractKeys(notam.text, notam.plain);
            for (const key of keys) {
                if (!map.has(key)) map.set(key, notam);
            }
        }
        this._cache = { bbox: { south, west, north, east }, items: map, fetchedAt: Date.now() };
        console.debug(`[SuaNotams] cached ${items.length} NOTAMs → ${map.size} SUA matches`);
    }

    _isCacheStale() {
        return !this._cache || (Date.now() - this._cache.fetchedAt) > SuaNotams.CACHE_MS;
    }

    _bboxCovers(south, west, north, east) {
        if (!this._cache?.bbox) return false;
        const b = this._cache.bbox;
        return south >= b.south && north <= b.north && west >= b.west && east <= b.east;
    }

    /** Normalize a name for matching: uppercase, remove punctuation, collapse spaces */
    static _normalize(str) {
        return (str || '').toUpperCase()
            .replace(/[^A-Z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Extract SUA name keys from NOTAM text.
     * Handles patterns like:
     *   "ADA EAST MOA ACT 1200-2359"
     *   "R-2501A ACT SFC-FL180"
     *   "RESTRICTED AREA R-2501 ACTIVE"
     *   "FORT RILEY MOA ACTIVE 0800-2200"
     */
    static _extractKeys(text, plain) {
        const keys = new Set();
        const src = [text || '', plain || ''].join(' ').toUpperCase();

        // MOA pattern: "WORD(S) MOA"
        const moaMatches = src.matchAll(/([A-Z][A-Z0-9\s]{1,30}?)\s+MOA\b/g);
        for (const m of moaMatches) {
            keys.add(SuaNotams._normalize(m[1] + ' MOA'));
        }

        // Restricted/Prohibited/Warning: "R-2501A", "P-73", "W-497A"
        const rMatches = src.matchAll(/\b([RPW]-[\d]+[A-Z]*)\b/g);
        for (const m of rMatches) {
            keys.add(SuaNotams._normalize(m[1]));
        }

        // Also try "RESTRICTED AREA RXXXXXX"
        const raMatches = src.matchAll(/RESTRICTED\s+AREA\s+([A-Z0-9\-]+)/g);
        for (const m of raMatches) {
            keys.add(SuaNotams._normalize(m[1]));
        }

        return keys;
    }

    /** Clear the cache (call when SUA layer is hidden) */
    clearCache() {
        this._cache = null;
    }
}

// Singleton
window.SuaNotams = window.SuaNotams || new SuaNotams();
