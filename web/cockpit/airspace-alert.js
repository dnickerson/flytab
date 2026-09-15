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

    _altitudeInBounds(altMsl, rec) {
        const lower = rec.lower_ft ?? rec.lower ?? 0;
        const upper = rec.upper_ft ?? rec.upper;
        // Fail-open: missing/malformed bounds must not suppress an
        // otherwise-valid lateral match -- an extra popup is a minor
        // nuisance, silently missing a required call is not acceptable.
        if (typeof lower !== 'number' || Number.isNaN(lower)) return true;
        // upper < 0 is not a malformed value -- it's the pipeline's
        // _parse_altitude() sentinel for an AIXM UNLIMITED/UNL ceiling
        // (SUA records only; Class B/C/D/E never emit it). Do not "simplify"
        // this away as redundant with the NaN check above -- doing so would
        // silently suppress alerts for any unlimited-ceiling restricted area.
        if (typeof upper !== 'number' || Number.isNaN(upper) || upper < 0) return altMsl >= lower;
        return altMsl >= lower && altMsl <= upper;
    }

    _evaluateOne(rec, lat, lon, projLat, projLon, altMsl) {
        const boundary = rec.boundary || rec.points || [];
        if (boundary.length < 3) return null;

        const state = this._states.get(rec.id);
        const actuallyInside = GeoUtils.pointInPolygon(lat, lon, boundary)
            && this._altitudeInBounds(altMsl, rec);

        if (state === 'alerted') {
            // Check entry before abort -- both could be true in the same
            // tick (e.g. actual position just entered while the forward
            // projection exits the far side of a narrow shelf); entry wins.
            if (actuallyInside) {
                this._states.set(rec.id, 'inside');
                return null;
            }
            const stillApproaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
                && this._altitudeInBounds(altMsl, rec);
            if (!stillApproaching) {
                this._states.set(rec.id, 'not-alerted');
            }
            return null;
        }

        if (state === 'inside') {
            if (!actuallyInside) this._states.set(rec.id, 'not-alerted'); // exited -> re-armed
            return null;
        }

        // state is 'not-alerted' or unset (first time seeing this airspace)
        if (actuallyInside) {
            // Already inside on first classification (e.g. module just
            // initialized while on the ground at a towered field, or app
            // restarted mid-flight) -- seed straight to 'inside', never fire.
            this._states.set(rec.id, 'inside');
            return null;
        }
        const approaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
            && this._altitudeInBounds(altMsl, rec);
        if (approaching) {
            this._states.set(rec.id, 'alerted');
            return rec;
        }
        return null;
    }
}
