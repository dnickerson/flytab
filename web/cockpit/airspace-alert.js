/**
 * FlyTab — Airspace Frequency Alert
 * Watches aircraft position and predicts approach into Class B/C/D/E
 * airspace or SUA, firing onAlert(airspaceRecord) once per entry.
 * See docs/superpowers/specs/2026-09-14-airspace-frequency-alert-design.md
 */
class AirspaceAlert {
    // Frequency-type priority is decided pipeline-side (flytab-pipeline);
    // this module only consumes the resulting controlling_freq field.
    static LEAD_TIME_MARGIN_NM = 10; // fixed margin added to the query box

    constructor() {
        this._stratux = null;
        this._nasrDb = null;
        this._states = new Map(); // airspace id -> 'alerted' | 'inside'
        this._cachedCandidates = null; // { box: {south,west,north,east}, airspace: [...], sua: [...] } -- Task 7 adds a trsa: [...] key
        this._tickInFlight = false; // re-entrancy guard, see tick()
        this.onAlert = null; // (record, kind: 'airspace'|'sua') => void, set by caller
    }

    init(stratuxClient, nasrDb) {
        this._stratux = stratuxClient;
        this._nasrDb = nasrDb;
    }

    destroy() {
        this._stratux = null;
        this._nasrDb = null;
        this._states.clear();
        this._cachedCandidates = null;
    }

    _altitudeMsl(sit) {
        // alt_msl (GPS geometric MSL) is preferred -- alt_baro is pressure
        // altitude referenced to standard 29.92", which disagrees with the
        // local-altimeter-setting altitudes airspace floors/ceilings are
        // published against by 100-300ft on an ordinary non-standard-
        // pressure day. See Task 3 header for the verified source.
        if (typeof sit.alt_msl === 'number' && !Number.isNaN(sit.alt_msl)) return sit.alt_msl;
        if (typeof sit.alt_baro === 'number' && !Number.isNaN(sit.alt_baro)) return sit.alt_baro;
        return null;
    }

    _nmToDegLat(nm) { return nm / 60; }
    _nmToDegLon(nm, lat) { return nm / (60 * Math.cos(lat * Math.PI / 180) || 1); }

    _boxFor(lat, lon, projLat, projLon, marginNm) {
        const south = Math.min(lat, projLat) - this._nmToDegLat(marginNm);
        const north = Math.max(lat, projLat) + this._nmToDegLat(marginNm);
        const west = Math.min(lon, projLon) - this._nmToDegLon(marginNm, lat);
        const east = Math.max(lon, projLon) + this._nmToDegLon(marginNm, lat);
        return { south, west, north, east };
    }

    _boxContains(box, lat, lon) {
        return lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;
    }

    async _getCandidates(lat, lon, projLat, projLon) {
        const box = this._boxFor(lat, lon, projLat, projLon, AirspaceAlert.LEAD_TIME_MARGIN_NM);
        const cached = this._cachedCandidates;
        // Re-query if either the current position or the projected position
        // has moved outside the box used for the previous query -- checking
        // current position alone misses a sharp turn that moves the
        // projected point outside stale coverage before current position does.
        if (cached && this._boxContains(cached.box, lat, lon) && this._boxContains(cached.box, projLat, projLon)) {
            return cached;
        }
        const [airspace, sua] = await Promise.all([
            this._nasrDb.getAirspaceInBounds(box.south, box.west, box.north, box.east),
            this._nasrDb.getSuaInBounds(box.south, box.west, box.north, box.east),
        ]);
        this._cachedCandidates = { box, airspace, sua };
        return this._cachedCandidates;
    }
}
