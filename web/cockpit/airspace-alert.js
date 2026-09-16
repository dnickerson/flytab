/**
 * FlyTab — Airspace Frequency Alert
 * Watches aircraft position and predicts approach into Class B/C/D/E
 * airspace, SUA, or a TRSA, firing onAlert(record, kind) once per entry.
 * See docs/superpowers/specs/2026-09-14-airspace-frequency-alert-design.md
 */
class AirspaceAlert {
    // Frequency-type priority is decided pipeline-side (flytab-pipeline);
    // this module only consumes the resulting controlling_freq field.
    static LEAD_TIME_MARGIN_NM = 10; // fixed margin added to the query box

    constructor() {
        this._stratux = null;
        this._nasrDb = null;
        this._states = new Map(); // airspace id -> 'alerted' | 'inside' | 'not-alerted'
        this._cachedCandidates = null; // { box: {south,west,north,east}, airspace: [...], sua: [...], trsa: [...] }
        this._tickInFlight = false; // re-entrancy guard, see tick()
        this.onAlert = null; // (record, kind: 'airspace'|'sua'|'trsa') => void, set by caller
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
        const [airspace, sua, trsa] = await Promise.all([
            this._nasrDb.getAirspaceInBounds(box.south, box.west, box.north, box.east),
            this._nasrDb.getSuaInBounds(box.south, box.west, box.north, box.east),
            this._nasrDb.getTrsaInBounds(box.south, box.west, box.north, box.east),
        ]);
        this._cachedCandidates = { box, airspace, sua, trsa };
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
        // _parse_altitude() sentinel for an AIXM UNLIMITED/UNL ceiling. SUA
        // records use it for this reason; Class E records also carry this
        // same -9998-style negative sentinel on the vast majority of records
        // (4282/4325 in a real bundle) for "no upper limit." Either way the
        // fail-open behavior below handles both cases identically. Do not
        // "simplify" this away as redundant with the NaN check above -- doing
        // so would silently suppress alerts for any unlimited-ceiling area.
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
            // Check entry before abort. segmentIntersectsPolygon's first
            // sample point (k=0) IS the current position and is gated by
            // the same altitude test actuallyInside uses, so
            // actuallyInside === true mathematically implies the "still
            // approaching" segment test below is also true in this tick --
            // they can never disagree. Checking entry first just means
            // that when both are (necessarily) true together, the record
            // is classified as a genuine entry ('inside'), not as an abort.
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

        // state is 'not-alerted' (evaluated before, no match at that time)
        // or undefined (never evaluated this session -- module just
        // started, or this record just entered the candidate box).
        const neverEvaluated = state === undefined;
        if (actuallyInside) {
            if (neverEvaluated) {
                // Already inside on first-ever classification (e.g. module
                // just initialized while on the ground at a towered field,
                // or app restarted mid-flight) -- seed straight to
                // 'inside', never fire.
                this._states.set(rec.id, 'inside');
                return null;
            }
            // Genuine new entry while state was explicitly 'not-alerted':
            // either a lateral approach that wasn't caught as "approaching"
            // last tick, or a vertical climb/descent into the altitude band
            // while the aircraft stayed laterally inside the whole time
            // (that case never sets 'approaching', since altitude fails the
            // bounds check the entire time it's outside the band -- this is
            // the only place such an entry can be detected). Must fire.
            this._states.set(rec.id, 'inside');
            return rec;
        }
        const approaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
            && this._altitudeInBounds(altMsl, rec);
        if (approaching) {
            this._states.set(rec.id, 'alerted');
            return rec;
        }
        // Evaluated, no match this tick -- record explicit 'not-alerted' so
        // a later tick can tell "evaluated, no match" apart from "never
        // evaluated" (see neverEvaluated above).
        this._states.set(rec.id, 'not-alerted');
        return null;
    }

    tick() {
        if (!this._stratux || !this._nasrDb) return;
        if (this._tickInFlight) return; // guard against overlapping async ticks (see below)
        if (!CockpitConfig.get('airspace_alerts.enabled')) {
            // Live master kill switch, not just a startup gate. Clear state
            // so a record frozen in 'alerted' while the feature was off
            // can't suppress a genuinely new approach after re-enabling --
            // always start re-enabling from a clean slate.
            this._states.clear();
            return;
        }
        const sit = this._stratux.situation;
        if (!sit || typeof sit.lat !== 'number' || typeof sit.lon !== 'number') return;

        const altMsl = this._altitudeMsl(sit);
        if (altMsl === null) return;

        const leadTimeMin = CockpitConfig.get('airspace_alerts.lead_time_min') ?? 2;
        const groundSpeedKt = sit.ground_speed || 0;
        const trueCourseDeg = sit.true_course || 0;
        const distNm = groundSpeedKt * (leadTimeMin / 60);
        const rad = trueCourseDeg * Math.PI / 180;
        const projLat = sit.lat + this._nmToDegLat(distNm) * Math.cos(rad);
        const projLon = sit.lon + this._nmToDegLon(distNm, sit.lat) * Math.sin(rad);

        // IDB queries inside _getCandidates could in principle take longer
        // than the 1000ms tick interval under device contention -- without
        // this guard, a second tick() could start a second query before the
        // first's .then() resolves, letting two callbacks interleave state
        // machine updates with inconsistent position snapshots.
        this._tickInFlight = true;
        this._getCandidates(sit.lat, sit.lon, projLat, projLon).then(({ airspace, sua, trsa }) => {
            // Read each leaf individually rather than destructuring the whole
            // 'airspace_alerts.types' object. CockpitConfig._mergeUserOverrides
            // only deep-merges two levels of nesting -- 'types.<key>' is a
            // three-level patch path, so a saved override touching only one
            // leaf (e.g. {types: {sua: true}}) would make CockpitConfig.get
            // ('airspace_alerts.types') return just that one key post-restart,
            // silently losing the other five leaves' defaults. Reading each
            // leaf through the dot-path resolver falls back to its own
            // per-leaf default correctly, same as layer-panel.js already does.
            const t = (key) => CockpitConfig.get(`airspace_alerts.types.${key}`);
            const classEnabled = { B: t('class_b'), C: t('class_c'), D: t('class_d'), E: t('class_e_surface') };
            for (const rec of airspace) {
                if (!classEnabled[rec.class]) continue;
                // The "Class E surface" toggle/manual only promise surface
                // areas, but rec.class === 'E' also matches E5/E6 transition
                // areas (AGL floor, ~77% of all Class E records) whose floor
                // can't be meaningfully compared against the MSL altitude
                // this code checks it against. E2/E3/E4 are all genuine
                // surface areas (lower_ft: 0, verified against a real NASR
                // bundle) -- exclude only E5/E6 to match what's documented.
                if (rec.class === 'E' && /Class E[56]\b/.test(rec.name || '')) continue;
                const fired = this._evaluateOne(rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                if (fired && this.onAlert) this.onAlert(fired, 'airspace');
            }
            if (t('sua')) {
                for (const rec of sua) {
                    const fired = this._evaluateOne(rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                    if (fired && this.onAlert) this.onAlert(fired, 'sua');
                }
            }
            if (t('trsa')) {
                for (const rec of trsa) {
                    const fired = this._evaluateOne(rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                    if (fired && this.onAlert) this.onAlert(fired, 'trsa');
                }
            }
        }).catch((err) => {
            // NasrDB's underlying IDB calls can reject (tx.onabort,
            // req.onerror). Without this, that rejection skips .then()
            // silently -- this tick's whole evaluation is dropped -- and
            // then re-raises as an unhandled rejection with no diagnostic.
            if (typeof DiagLog !== 'undefined') {
                DiagLog.log('airspace', `tick() candidate evaluation failed: ${err && err.message}`);
            }
        }).finally(() => { this._tickInFlight = false; });
    }
}
