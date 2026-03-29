/**
 * FlyTab — In-Memory Terrain Grid  v1.0
 *
 * Loads terrain.bin (Int16 LE, 2600×6000 CONUS grid) from the on-device NanoHTTPD
 * server into an Int16Array, then answers elevation queries in microseconds with
 * bilinear interpolation — no network calls during flight.
 *
 * Usage:
 *   await window.terrainGrid.load();             // call once at startup
 *   const ft = window.terrainGrid.getElevationFt(35.2, -82.5);
 *   const profile = window.terrainGrid.buildProfile(coords, 1.0);
 */

class TerrainGrid {
    constructor() {
        this._data    = null;   // Int16Array (rows × cols)
        this._meta    = null;   // terrain.json object
        this._loading = false;
        this._loaded  = false;
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    /** Load the terrain grid from local NanoHTTPD (non-blocking — call and forget). */
    async load() {
        if (this._loaded || this._loading) return;
        this._loading = true;
        try {
            // Check existence first (fast probe)
            const status = await fetch('http://localhost:9090/terrain/grid/status',
                { signal: AbortSignal.timeout(2000) })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null);

            if (!status?.exists) {
                // NanoHTTPD may not be ready yet — retry once after 3s
                await new Promise(r => setTimeout(r, 3000));
                const retry = await fetch('http://localhost:9090/terrain/grid/status',
                    { signal: AbortSignal.timeout(3000) })
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null);
                if (!retry?.exists) {
                    console.log('[TerrainGrid] Not available on device');
                    this._loading = false;
                    return;
                }
            }

            // Load metadata
            this._meta = await fetch('http://localhost:9090/terrain/grid/terrain.json',
                { signal: AbortSignal.timeout(5000) })
                .then(r => r.json());

            // Load binary grid (~31 MB — allow 2 min)
            const buf = await fetch('http://localhost:9090/terrain/grid/terrain.bin',
                { signal: AbortSignal.timeout(120000) })
                .then(r => r.arrayBuffer());

            this._data   = new Int16Array(buf);
            this._loaded = true;
            console.log(`[TerrainGrid] Loaded: ${this._data.length.toLocaleString()} points`);
        } catch (err) {
            console.warn('[TerrainGrid] Load failed:', err.message);
        } finally {
            this._loading = false;
        }
    }

    get isLoaded() { return this._loaded; }

    // ── Elevation lookup ──────────────────────────────────────────────────────

    /**
     * Return elevation in feet at (lat, lon).
     * Returns 0 if grid not loaded or point is out of bounds.
     */
    getElevationFt(lat, lon) {
        if (!this._loaded || !this._data || !this._meta) return 0;
        const m = this._meta;
        if (lat < m.latMin || lat > m.latMax || lon < m.lonMin || lon > m.lonMax) return 0;

        // Grid indices (fractional)
        const rowF = (m.latMax - lat) / m.spacing;
        const colF = (lon - m.lonMin) / m.spacing;

        const r0 = Math.floor(rowF);
        const c0 = Math.floor(colF);
        const r1 = Math.min(r0 + 1, m.rows - 1);
        const c1 = Math.min(c0 + 1, m.cols - 1);
        const fr = rowF - r0;
        const fc = colF - c0;

        const cols = m.cols;
        const v00  = this._data[r0 * cols + c0];
        const v01  = this._data[r0 * cols + c1];
        const v10  = this._data[r1 * cols + c0];
        const v11  = this._data[r1 * cols + c1];

        // Bilinear interpolation, result in meters then convert to feet
        const elevM = v00*(1-fr)*(1-fc) + v01*(1-fr)*fc + v10*fr*(1-fc) + v11*fr*fc;
        return elevM * 3.28084;
    }

    // ── Profile builder ───────────────────────────────────────────────────────

    /**
     * Build a terrain profile along a route.
     * @param {Array<{lat:number, lon:number}>} coords - Waypoint array
     * @param {number} spacingNm - Sample interval in NM (default 1.0)
     * @returns {Array<{dist_nm:number, elev_ft:number}>}
     */
    buildProfile(coords, spacingNm = 1.0) {
        if (!this._loaded || coords.length < 2) return [];

        const profile = [];
        let cumDist = 0;
        profile.push({ dist_nm: 0, elev_ft: this.getElevationFt(coords[0].lat, coords[0].lon) });

        for (let i = 0; i < coords.length - 1; i++) {
            const from    = coords[i];
            const to      = coords[i + 1];
            const segDist = haversineNm(from.lat, from.lon, to.lat, to.lon);
            const steps   = Math.max(1, Math.ceil(segDist / spacingNm));

            for (let s = 1; s <= steps; s++) {
                const t   = s / steps;
                const lat = from.lat + (to.lat - from.lat) * t;
                const lon = from.lon + (to.lon - from.lon) * t;
                cumDist  += segDist / steps;
                profile.push({
                    dist_nm:  parseFloat(cumDist.toFixed(2)),
                    elev_ft:  this.getElevationFt(lat, lon),
                });
            }
        }
        return profile;
    }
}

// ── Haversine distance in NM ──────────────────────────────────────────────────

function haversineNm(lat1, lon1, lat2, lon2) {
    const R    = 3440.065; // Earth radius in NM
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat/2)**2
               + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Singleton ─────────────────────────────────────────────────────────────────

window.terrainGrid = new TerrainGrid();
