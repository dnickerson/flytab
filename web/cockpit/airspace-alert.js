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

    // Single source of truth for the six airspace_alerts.types.* config
    // leaves, mapping each to the typeKey _evaluateOne/clearStatesForType
    // namespace _states by (FAA class letter for airspace records, kind
    // name for sua/trsa). layer-panel.js's toggle wiring reads this same
    // map rather than keeping its own independent copy in sync by hand.
    static TYPE_KEYS = { class_b: 'B', class_c: 'C', class_d: 'D', class_e_surface: 'E', sua: 'sua', trsa: 'trsa' };

    constructor() {
        this._stratux = null;
        this._nasrDb = null;
        this._states = new Map(); // "kind:id" -> 'alerted' | 'inside' | 'not-alerted'
        this._cachedCandidates = null; // { box: {south,west,north,east}, airspace: [...], sua: [...], trsa: [...], fetched: {airspace,sua,trsa} }
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

    /**
     * Clear cached state for one sub-type only -- call this instead of
     * reaching into _states.clear() when the pilot toggles a single
     * airspace_alerts.types.* checkbox, so an unrelated in-progress
     * approach elsewhere doesn't get a spurious duplicate alert from being
     * wiped along with the toggled type. typeKey matches _evaluateOne's
     * per-record prefix: 'B'|'C'|'D'|'E' for airspace classes, 'sua', or
     * 'trsa'.
     */
    clearStatesForType(typeKey) {
        const prefix = `${typeKey}:`;
        for (const key of this._states.keys()) {
            if (key.startsWith(prefix)) this._states.delete(key);
        }
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

    async _getCandidates(lat, lon, projLat, projLon, typesEnabled) {
        // Class B/C/D/E-surface all live in one IDB store (airspace), so
        // the only skippable granularity for that store is "all four off";
        // sua/trsa each have their own store and can be skipped individually.
        const needAirspace = !!(typesEnabled.class_b || typesEnabled.class_c || typesEnabled.class_d || typesEnabled.class_e_surface);
        const needSua = !!typesEnabled.sua;
        const needTrsa = !!typesEnabled.trsa;

        const box = this._boxFor(lat, lon, projLat, projLon, AirspaceAlert.LEAD_TIME_MARGIN_NM);
        const cached = this._cachedCandidates;
        // Re-query if either the current position or the projected position
        // has moved outside the box used for the previous query -- checking
        // current position alone misses a sharp turn that moves the
        // projected point outside stale coverage before current position does.
        // Also re-query (even with an unchanged box) if a type this tick
        // needs wasn't actually fetched last time -- e.g. the pilot just
        // flipped SUA on after a stretch of it being off, during which this
        // method never queried getSuaInBounds at all. Without this check the
        // box-containment test alone would keep "hitting" a cache that was
        // never given real sua data, silently withholding alerts for the
        // newly-enabled type until the aircraft happens to cross the box edge.
        if (cached && this._boxContains(cached.box, lat, lon) && this._boxContains(cached.box, projLat, projLon)
            && (!needAirspace || cached.fetched.airspace) && (!needSua || cached.fetched.sua) && (!needTrsa || cached.fetched.trsa)) {
            return cached;
        }
        // Shipped defaults have sua:false -- without these guards, every ~1s
        // tick ran a full IDB cursor scan + geometry test of the whole sua
        // store (and trsa's) for output that tick()'s per-type checks below
        // discard entirely. Skip the query outright when nothing needs it.
        const [airspace, sua, trsa] = await Promise.all([
            needAirspace ? this._nasrDb.getAirspaceInBounds(box.south, box.west, box.north, box.east) : Promise.resolve([]),
            needSua ? this._nasrDb.getSuaInBounds(box.south, box.west, box.north, box.east) : Promise.resolve([]),
            needTrsa ? this._nasrDb.getTrsaInBounds(box.south, box.west, box.north, box.east) : Promise.resolve([]),
        ]);
        this._cachedCandidates = { box, airspace, sua, trsa, fetched: { airspace: needAirspace, sua: needSua, trsa: needTrsa } };
        return this._cachedCandidates;
    }

    _altitudeInBounds(altMsl, rec) {
        const lower = rec.lower_ft ?? rec.lower ?? 0;
        const upper = rec.upper_ft ?? rec.upper;
        // Fail-open: missing/malformed bounds must not suppress an
        // otherwise-valid lateral match -- an extra popup is a minor
        // nuisance, silently missing a required call is not acceptable.
        if (typeof lower !== 'number' || Number.isNaN(lower)) return true;
        // upper <= 0 is not a malformed value -- it's an "unlimited ceiling"
        // case, from two different sources for two different reasons:
        //  - Negative (the pipeline's _parse_altitude() sentinel, e.g. -1 or
        //    -9998-style): SUA and Class E's AIXM-derived records use this
        //    for a genuine UNLIMITED/UNL ceiling (4282/4325 Class E records
        //    in a real bundle).
        //  - Exactly 0: parse_class_airspace() -- the separate code path
        //    that builds Class B/C/D/E from the FAA Class_Airspace
        //    shapefile, not AIXM -- has no sentinel of its own and does
        //    "upper_ft": int(upper) if upper else 0, so a blank/missing
        //    shapefile UPPER_VAL becomes 0, not negative. A real ceiling of
        //    0ft MSL never legitimately occurs for this layer: LOWER_VAL/
        //    UPPER_VAL are MSL, confirmed both by the FAA's AIS Open Data
        //    Dictionary (Class Airspace's UPPER_CODE/LOWER_CODE domain is
        //    MSL/SFC/STD/UNLTD/BYNOTAM -- no AGL option exists in the
        //    schema) and by cross-checking real shapefile data (e.g.
        //    Aspen's Class D ceiling is 10300 while sea-level fields' are
        //    ~2500, tracking field elevation + the standard 2500ft AGL
        //    Class D shelf height -- only possible if the stored value is
        //    MSL, not AGL). So 0 here only ever means "value missing,"
        //    never "ceiling at the ground" -- must be treated the same as
        //    the negative sentinel, or a record with a blank shapefile
        //    UPPER_VAL would silently defeat the fail-open design for
        //    exactly the records it exists to protect. Do not "simplify"
        //    this away as redundant with the NaN check above -- doing so
        //    would silently suppress alerts for any unlimited-ceiling area.
        if (typeof upper !== 'number' || Number.isNaN(upper) || upper <= 0) return altMsl >= lower;
        return altMsl >= lower && altMsl <= upper;
    }

    _evaluateOne(kind, rec, lat, lon, projLat, projLon, altMsl) {
        const boundary = rec.boundary || rec.points || [];
        if (boundary.length < 3) return null;

        // Namespaced, not just rec.id: airspace/sua/trsa are three separate
        // NASR object stores, each only guaranteed unique ids *within* its
        // own store -- nothing in this repo (ids are pipeline-generated)
        // guarantees uniqueness *across* stores, and a collision would
        // silently corrupt one record's state transitions with another's.
        // Verified no collision exists in the current real bundle (5638
        // airspace + 1236 sua ids, zero overlap), but that's pipeline data,
        // not a structural guarantee -- namespacing costs nothing and
        // removes the question entirely. Airspace records use their FAA
        // class letter (B/C/D/E) rather than the generic 'airspace' kind
        // specifically so clearStatesForType() (below) can clear e.g. just
        // class_b state when the pilot toggles that one sub-type, without
        // also wiping class_c/d/e/sua/trsa state for unrelated airspace the
        // aircraft may already be mid-approach to.
        const typeKey = kind === 'airspace' ? rec.class : kind;
        const key = `${typeKey}:${rec.id}`;
        const state = this._states.get(key);
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
                this._states.set(key, 'inside');
                return null;
            }
            const stillApproaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
                && this._altitudeInBounds(altMsl, rec);
            if (!stillApproaching) {
                this._states.set(key, 'not-alerted');
            }
            return null;
        }

        if (state === 'inside') {
            if (!actuallyInside) this._states.set(key, 'not-alerted'); // exited -> re-armed
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
                this._states.set(key, 'inside');
                return null;
            }
            // Genuine new entry while state was explicitly 'not-alerted':
            // either a lateral approach that wasn't caught as "approaching"
            // last tick, or a vertical climb/descent into the altitude band
            // while the aircraft stayed laterally inside the whole time
            // (that case never sets 'approaching', since altitude fails the
            // bounds check the entire time it's outside the band -- this is
            // the only place such an entry can be detected). Must fire.
            this._states.set(key, 'inside');
            return rec;
        }
        const approaching = GeoUtils.segmentIntersectsPolygon(lat, lon, projLat, projLon, boundary)
            && this._altitudeInBounds(altMsl, rec);
        if (approaching) {
            this._states.set(key, 'alerted');
            return rec;
        }
        // Evaluated, no match this tick -- record explicit 'not-alerted' so
        // a later tick can tell "evaluated, no match" apart from "never
        // evaluated" (see neverEvaluated above).
        this._states.set(key, 'not-alerted');
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

        // Read all six sub-toggles up front so a fully-disabled feature (master
        // switch on, every type off -- a real, reachable state via the layer
        // panel) can skip the IDB query below entirely, rather than paying for
        // three cursor scans plus polygon-overlap geometry every second for
        // output that's guaranteed to be discarded.
        const typesEnabled = {};
        for (const key of Object.keys(AirspaceAlert.TYPE_KEYS)) {
            typesEnabled[key] = CockpitConfig.get(`airspace_alerts.types.${key}`);
        }
        if (!Object.values(typesEnabled).some(Boolean)) return;

        const leadTimeMin = CockpitConfig.get('airspace_alerts.lead_time_min') ?? 2;
        const groundSpeedKt = sit.ground_speed || 0;
        // A missing/unparseable true_course (e.g. right after GPS fix
        // acquisition) must not fabricate a due-north heading -- that would
        // test the wrong projected path and could miss a real approach from
        // any direction other than north, or falsely flag one to the north.
        // Skipping the lead-time projection for this tick (distNm=0 collapses
        // projLat/projLon to the current position) is safe: the record is
        // still evaluated for "actually inside," and picks up its "approaching"
        // projection again as soon as a later tick has a valid course.
        const hasCourse = typeof sit.true_course === 'number' && isFinite(sit.true_course);
        const trueCourseDeg = hasCourse ? sit.true_course : 0;
        const distNm = hasCourse ? groundSpeedKt * (leadTimeMin / 60) : 0;
        const rad = trueCourseDeg * Math.PI / 180;
        const projLat = sit.lat + this._nmToDegLat(distNm) * Math.cos(rad);
        const projLon = sit.lon + this._nmToDegLon(distNm, sit.lat) * Math.sin(rad);

        // IDB queries inside _getCandidates could in principle take longer
        // than the 1000ms tick interval under device contention -- without
        // this guard, a second tick() could start a second query before the
        // first's .then() resolves, letting two callbacks interleave state
        // machine updates with inconsistent position snapshots.
        this._tickInFlight = true;
        this._getCandidates(sit.lat, sit.lon, projLat, projLon, typesEnabled).then(({ airspace, sua, trsa }) => {
            // typesEnabled was read once above, before the query, specifically
            // per-leaf (not by destructuring the whole 'airspace_alerts.types'
            // object) because CockpitConfig._mergeUserOverrides only
            // deep-merges two levels of nesting -- 'types.<key>' is a
            // three-level patch path, so a saved override touching only one
            // leaf (e.g. {types: {sua: true}}) would make CockpitConfig.get
            // ('airspace_alerts.types') return just that one key post-restart,
            // silently losing the other five leaves' defaults. Reading each
            // leaf through the dot-path resolver falls back to its own
            // per-leaf default correctly, same as layer-panel.js already does.
            const classEnabled = { B: typesEnabled.class_b, C: typesEnabled.class_c, D: typesEnabled.class_d, E: typesEnabled.class_e_surface };
            for (const rec of airspace) {
                if (!classEnabled[rec.class]) continue;
                // The "Class E surface" toggle/manual only promise surface
                // areas. A name-based E5/E6 regex was tried here but doesn't
                // hold: verified against the real NASR bundle, 90 Class E
                // records (e.g. "Woody Island Low", "Atlantic Low", and even
                // one literally named "Aurora Class E2") have a nonzero
                // lower_ft (700-14500) with no "Class E5/E6" in the name at
                // all -- the regex let them through. Checking lower_ft
                // directly is the actual definition of "surface" this code
                // needs (0 = surface, >0 = AGL floor that can't be compared
                // to the MSL altitude this code checks it against) and
                // covers every case, not just the ones that happen to be
                // named a certain way.
                if (rec.class === 'E' && rec.lower_ft > 0) continue;
                const fired = this._evaluateOne('airspace', rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                if (fired && this.onAlert) this.onAlert(fired, 'airspace');
            }
            if (typesEnabled.sua) {
                for (const rec of sua) {
                    const fired = this._evaluateOne('sua', rec, sit.lat, sit.lon, projLat, projLon, altMsl);
                    if (fired && this.onAlert) this.onAlert(fired, 'sua');
                }
            }
            if (typesEnabled.trsa) {
                for (const rec of trsa) {
                    const fired = this._evaluateOne('trsa', rec, sit.lat, sit.lon, projLat, projLon, altMsl);
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
