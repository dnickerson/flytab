/**
 * FlyTab - engine-out glide inputs (web/cockpit/glide-inputs.js).
 *
 * The adapter from app state to the inputs of GlideModel.plan() (web/shared/glide-model.js):
 *   settings()   aircraft performance + pilot section, validated, defaults from GlideModel.DEFAULTS
 *   airport()    NASR airport record -> model airport (candidate runways, per-end geometry)
 *   aircraft()   Stratux situation -> model aircraft state, or null (no block)
 *   aircraftStatus() why aircraft() gives none: 'nogps' | 'stale' | 'nofix' | 'nodata' | 'slow' | 'ok'
 *   glideWind()  winds aloft at the aircraft: FIS-B, else the route planner's downloaded winds
 *   runwayWind() the wind to land in: the airport's METAR (FIS-B, else the panel's internet one, else the cached
 *                one), else the nearest station
 *   glideWindFor() the wind the glide legs use, in two layers split at surfaceWindMaxAglFt above the field: winds
 *                aloft (else the assumed headwind) above, the runway (surface) wind below - spec 2026-11-06
 *
 * Only data already on the tablet is read; nothing here touches the network (no internet in flight).
 * Every missing or untrusted input takes the more conservative path: a missing wind is `null` / 'none'
 * (the model then assumes a headwind), a missing airport coordinate drops that end, a stale or
 * unfixed GPS situation gives no aircraft at all.
 *
 * Data shapes (verified 2026-10-31):
 *   NASR runway (airport.runways[]): length_ft, width_ft, surface, per end (base_ / recip_) id, lat, lon,
 *     thr_lat, thr_lon, true_hdg. Keys are ABSENT (or null) when the FAA gave nothing.
 *   FisbClient: metars Map(icao -> { raw, decoded, received_at }), decoded.observed_at (ISO),
 *     wind_dir (null for VRB), wind_speed, wind_gust (kt); getNearestWind(lat, lon, alt) ->
 *     { dir, spd, alt, lat, lon, station, received_at } or null.
 *   Stratux situation: alt_msl (ft), ground_speed (kt), true_course, vertical_speed, gps_fix_quality,
 *     timestamp (ms epoch at receipt).
 *   Route planner: _lastWinds { STN: { altFt: { dir, spd, variable? } } } stamped by _lastWindsAt (ms).
 *   Internet METARs (VectorMapLayers.fetchInternetMetars, app.vectorLayers._internetMetars): Map(icao ->
 *     { raw, _obsTime (s), decoded: { wind_dir (null for VRB), wind_variable, wind_speed, wind_gust, observed_at (ISO,
 *     the AWC obsTime) }, received_at, source: 'internet' }).
 *
 * Exposes the global GlideInputs.
 */
const GlideInputs = (() => {
    'use strict';

    // ---- Physical constants / plumbing (not model settings) ----------------
    const FT_PER_NM = 6076.12;
    const EARTH_RADIUS_NM = 3440.065;
    /** A situation older than this is not a position (the block must disappear, not freeze). */
    const SIT_MAX_AGE_MS = 5000;
    /** An observation time this far ahead of now (clock skew, a bad report) is not trusted. */
    const FUTURE_TOLERANCE_MS = 5 * 60000;
    const MS_PER_MIN = 60000;
    const KT_TO_FPM = 101.269;          // 1 kt in feet per minute
    /** No light piston airplane glides flatter than ~20:1 windmilling. */
    const MAX_GLIDE_RATIO = 20;

    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const isLL = (lat, lon) => isNum(lat) && isNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const norm360 = (d) => ((d % 360) + 360) % 360;
    const pad3 = (n) => String(Math.round(n)).padStart(3, '0');
    const pad2 = (n) => String(Math.round(n)).padStart(2, '0');
    const fmtFt = (n) => Math.round(n).toLocaleString('en-US');

    /** A finite number from a number or a finite numeric string; else undefined. */
    function toFinite(v) {
        if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
        if (typeof v === 'string' && v.trim() !== '') {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
    }

    function distNm(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180;
        const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
        return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ---- Settings -----------------------------------------------------------

    /**
     * Allowed [min, max, safer?] per setting. `safer` says which way errs high (a wrong "GLIDE OK" is the failure
     * to avoid): 'higher' (more sink, margin, assumed headwind) -> a value above max becomes max; 'lower' (nearer /
     * fresher wind and METAR limits) -> a value below min becomes min. Any other out-of-range
     * value, and every non-finite one, takes the default.
     */
    const RANGES = {
        aircraft: {
            glide_ias_kt: [30, 200],        // no safe side: a slower glide turns in less height (review R29)
            glide_sink_fpm: [100, 3000, 'higher'],
            glide_density_pct_per_kft: [0, 5],
        },
        pilot: {
            turnBankDeg: [10, 60],          // 90 or more would make 1 / cos(bank)^1.5 blow up
            marginFt: [0, 2000, 'higher'],
            // lineUpFtPerDeg, finalPoint*, planBHysteresisFt: still validated, no longer used by the model (spec 2026-11-06)
            lineUpFtPerDeg: [0, 10, 'higher'],
            finalPointFraction: [0, 1],
            finalPointMinFt: [0, 5000],
            finalPointMaxFt: [0, 5000],     // the Configuration input max; also >= finalPointMinFt, checked as a pair below
            noWindHeadwindKt: [0, 50, 'higher'],
            planBHysteresisFt: [0, 1000],
            onCourseDeg: [1, 30],
            windMaxStationNm: [1, 500, 'lower'],
            windMaxAgeMin: [10, 1440, 'lower'],
            metarMaxAgeMin: [10, 240, 'lower'],
            metarMaxStationNm: [0, 100, 'lower'],
            showAboveGsKt: [0, 200],
            surfaceWindMaxAglFt: [0, 3000, 'lower'],   // Dana 2026-11-06: the ground wind only up to 1,000 ft at most
        },
    };

    /**
     * Resolved settings: every GlideModel.DEFAULTS key, from `raw` when finite and within its range (numeric
     * strings accepted, always returned as numbers). Out of range: the edge on the key's safe side (RANGES
     * `safer`), else the default - always the more conservative of the two. Non-finite, null, blank or junk:
     * the default. Then finalPointMaxFt must be >= finalPointMinFt, else BOTH take their defaults; and the
     * still-air glide ratio glide_ias_kt x KT_TO_FPM / glide_sink_fpm must not exceed MAX_GLIDE_RATIO, else
     * glide_ias_kt and glide_sink_fpm BOTH take their defaults.
     * min_runway_ft (no range): a finite number >= 0, or null for "no length filter".
     */
    function validate(raw) {
        const D = GlideModel.DEFAULTS;
        const out = { aircraft: {}, pilot: {} };
        const a = (raw && raw.aircraft) || {}, p = (raw && raw.pilot) || {};
        const resolve = (v, r, def) => {
            if (v === undefined) return def;
            if (!r) return v >= 0 ? v : def;
            const [lo, hi, safer] = r;
            if (v < lo) return safer === 'lower' ? lo : def;
            if (v > hi) return safer === 'higher' ? hi : def;
            return v;
        };
        for (const k of Object.keys(D.aircraft)) out.aircraft[k] = resolve(toFinite(a[k]), RANGES.aircraft[k], D.aircraft[k]);
        for (const k of Object.keys(D.pilot)) out.pilot[k] = resolve(toFinite(p[k]), RANGES.pilot[k], D.pilot[k]);
        if (out.pilot.finalPointMaxFt < out.pilot.finalPointMinFt) {
            out.pilot.finalPointMinFt = D.pilot.finalPointMinFt;
            out.pilot.finalPointMaxFt = D.pilot.finalPointMaxFt;
        }
        // A still-air glide flatter than MAX_GLIDE_RATIO is a wrong speed or sink: BOTH take their defaults.
        if (out.aircraft.glide_ias_kt * KT_TO_FPM / out.aircraft.glide_sink_fpm > MAX_GLIDE_RATIO) {
            out.aircraft.glide_ias_kt = D.aircraft.glide_ias_kt;
            out.aircraft.glide_sink_fpm = D.aircraft.glide_sink_fpm;
        }
        return out;
    }

    /** Settings from the aircraft performance block (CockpitConfig.aircraft) and the engineOutGlide section. */
    function settings() {
        const raw = { aircraft: {}, pilot: {} };
        try {
            if (typeof CockpitConfig !== 'undefined' && CockpitConfig) {
                for (const k of Object.keys(GlideModel.DEFAULTS.aircraft)) {
                    raw.aircraft[k] = CockpitConfig.aircraft('performance.' + k);
                }
                raw.pilot = CockpitConfig.get('engineOutGlide') || {};
            }
        } catch (_) { /* defaults */ }
        return validate(raw);
    }

    // ---- Airport ------------------------------------------------------------

    const surfaceOf = (r) => String((r && r.surface) || '').toUpperCase();
    const isPaved = (r) => /ASPH|CONC/.test(surfaceOf(r));
    const isWater = (r) => /WATER/.test(surfaceOf(r));

    /**
     * -> { elevFt, ref, ends, refLatLon, excluded, noSuitable }
     * elevFt: field elevation (null when the record has none - the caller shows no block).
     * ref: {x:0, y:0}, the airport reference point; refLatLon: its { lat, lon } (null when unknown).
     * ends: model runway ends { id, runwayId, thr, phys, elevFt, hdgTrue, rwyLenFt, mid, widthFt, rwy: {a, b} } in local nm
 *   thr: the landing threshold (physical end when it cannot be right); phys: the end's physical end (base_/recip_
 *   lat, lon; the threshold when there is none) - the short-final target; elevFt: the end's NASR elevation
 *   (base_/recip_elev_ft, null when unknown: the model then uses the field elevation); widthFt: the runway's
 *   width_ft, DEFAULT_WIDTH_FT when unknown.
     * excluded: 'heliport' | 'seaplane' | null. noSuitable: the airport has runways but none qualifies.
     */
    function airport(rec, settings_) {
        const S = validate(settings_);
        const out = { elevFt: null, ref: { x: 0, y: 0 }, ends: [], refLatLon: null, excluded: null, noSuitable: false };
        if (!rec) return out;
        if (isNum(rec.elev_ft)) out.elevFt = rec.elev_ft;
        const fac = String(rec.fac_type || '').toUpperCase();
        if (fac === 'HELIPORT') { out.excluded = 'heliport'; return out; }
        if (fac === 'SEAPLANE BASE') { out.excluded = 'seaplane'; return out; }
        if (!isLL(rec.lat, rec.lon)) return out;
        out.refLatLon = { lat: rec.lat, lon: rec.lon };

        // Helipads listed on an airport record (id H1, H2, H) are not runways: not ends, and no block on the turf fallback.
        const runways = Array.isArray(rec.runways) ? rec.runways.filter((r) => r && !/^H\d*$/i.test(String(r.id || '').trim())) : [];
        const minLen = S.aircraft.min_runway_ft;
        const qualifies = (r) => !isWater(r) && isNum(r.length_ft) && r.length_ft > 0
            && (!isNum(minLen) || r.length_ft >= minLen);
        const qualifying = runways.filter(qualifies);
        const paved = qualifying.filter(isPaved);
        const chosen = paved.length ? paved : qualifying;      // turf / gravel only when no paved runway qualifies
        if (runways.length && !chosen.length) out.noSuitable = true;

        for (const r of chosen) out.ends.push(...runwayEnds(r, rec.lat, rec.lon));
        return out;
    }

    /**
     * The end's landing threshold, or its physical end when the threshold cannot be right: past mid-runway along
     * the landing heading, or farther than half the runway length from its own physical end. Bad data, not a
     * displaced threshold (the 2611 bundle's K2S5 07 threshold is the 25 end); the physical end puts the final
     * point earlier, the conservative way. An end with no physical coordinates keeps what it has.
     */
    function sensibleThreshold(me, hdg, mid, lenFt) {
        const thr = me.thr, phys = me.phys;
        if (!me.hasPhys || !thr || !phys || (thr.x === phys.x && thr.y === phys.y)) return thr;
        const h = hdg * Math.PI / 180;
        const pastMid = (thr.x - mid.x) * Math.sin(h) + (thr.y - mid.y) * Math.cos(h) > 0;
        const fromEndFt = Math.hypot(thr.x - phys.x, thr.y - phys.y) * FT_PER_NM;
        return pastMid || !(fromEndFt <= lenFt / 2) ? phys : thr;
    }

    /** Runway width (ft) when the NASR record has none: the model's "over the runway" gate uses it. */
    const DEFAULT_WIDTH_FT = 100;

    /** One runway -> its model ends (0, 1 or 2): an end needs a threshold (else physical end) and a heading. */
    function runwayEnds(r, refLat, refLon) {
        const sides = ['base', 'recip'];
        const info = sides.map((s) => {
            const pLat = r[s + '_lat'], pLon = r[s + '_lon'], tLat = r[s + '_thr_lat'], tLon = r[s + '_thr_lon'];
            const phys = isLL(pLat, pLon) ? { lat: pLat, lon: pLon } : null;
            const thr = isLL(tLat, tLon) ? { lat: tLat, lon: tLon } : phys;
            const loc = (p) => (p ? GlideModel.toLocal(refLat, refLon, p.lat, p.lon) : null);
            const hdg = r[s + '_true_hdg'];
            return {
                side: s, id: r[s + '_id'], phys: loc(phys || thr), thr: loc(thr), hasPhys: !!phys,
                hdg: isNum(hdg) ? norm360(hdg) : null, elev: isNum(r[s + '_elev_ft']) ? r[s + '_elev_ft'] : null,
            };
        });
        const bothKnown = !!(info[0].thr && info[1].thr);
        const widthFt = isNum(r.width_ft) && r.width_ft > 0 ? r.width_ft : DEFAULT_WIDTH_FT;
        const ends = [];
        for (let i = 0; i < 2; i++) {
            const me = info[i], other = info[1 - i];
            if (!me.thr) continue;
            // Landing heading: the FAA's, else the opposite end's reversed, else from this end toward the other
            // physical end; with none of those the end cannot be oriented, so it is not used.
            let hdg = me.hdg;
            if (hdg === null && other.hdg !== null) hdg = norm360(other.hdg + 180);
            if (hdg === null && bothKnown) {
                const dx = other.phys.x - me.phys.x, dy = other.phys.y - me.phys.y;
                if (Math.hypot(dx, dy) > 0) hdg = norm360(Math.atan2(dx, dy) * 180 / Math.PI);
            }
            if (hdg === null) continue;
            let a, b, mid, lenFt;
            if (bothKnown && Math.hypot(other.phys.x - me.phys.x, other.phys.y - me.phys.y) > 0) {
                a = info[0].phys; b = info[1].phys;
                mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                lenFt = Math.hypot(b.x - a.x, b.y - a.y) * FT_PER_NM;
            } else {
                // One end known: the far end lies one record-length along the landing heading.
                if (!isNum(r.length_ft) || !(r.length_ft > 0)) continue;
                const lenNm = r.length_ft / FT_PER_NM, h = hdg * Math.PI / 180;
                a = me.phys;
                b = { x: a.x + Math.sin(h) * lenNm, y: a.y + Math.cos(h) * lenNm };
                mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                lenFt = r.length_ft;
            }
            const fallbackId = typeof r.id === 'string' ? r.id.split('/')[i] : null;
            ends.push({
                id: me.id != null && me.id !== '' ? String(me.id) : (fallbackId || me.side),
                runwayId: r.id != null ? String(r.id) : null,
                thr: sensibleThreshold(me, hdg, mid, lenFt), phys: me.phys, elevFt: me.elev,
                hdgTrue: hdg, rwyLenFt: lenFt, mid, widthFt, rwy: { a, b },
            });
        }
        return ends;
    }

    // ---- Aircraft -----------------------------------------------------------

    /**
     * The Stratux situation as the model's aircraft state, relative to refLatLon ({ lat, lon } of the airport),
     * or null: no 3D fix, older than SIT_MAX_AGE_MS, below showAboveGsKt (not flying), or any needed value
     * missing. EmergencyGlide passes the configured showAboveGsKt; the airport-panel glide block passes 0
     * (GlidePanel.noGsGate: shown on the ground too, the pilot turns it off with ENGINE OUT).
     * Altitude is GPS MSL (alt_msl) only - never the barometric altitude.
     * vs: situation.vertical_speed (ft/min) passed through as-is. The glide panel does not use it: it replaces
     * ac.vs with MEASURED, the descent rate it derives from GPS altitude (GlidePanel._measuredVs).
     */
    function aircraft(sit, settings_, refLatLon, now = Date.now()) {
        if (!sit || !refLatLon || !isLL(refLatLon.lat, refLatLon.lon)) return null;
        if (aircraftStatus(sit, settings_, now) !== 'ok') return null;
        return {
            pos: GlideModel.toLocal(refLatLon.lat, refLatLon.lon, sit.lat, sit.lon),
            altMsl: sit.alt_msl,
            gs: sit.ground_speed,
            trkTrue: norm360(sit.true_course),
            vs: isNum(sit.vertical_speed) ? sit.vertical_speed : null,   // pass-through; the panel uses its GPS-altitude rate
        };
    }

    /**
     * Why aircraft() would give no state for this situation (the airport reference aside) - the same checks:
     *   'nogps'  no situation at all
     *   'stale'  no finite timestamp, or older than SIT_MAX_AGE_MS
     *   'nofix'  fresh, but not a 3D GPS solution (GpsFix.has3DFix)
     *   'nodata' a 3D fix, but ground_speed, alt_msl or true_course missing
     *   'slow'   below showAboveGsKt
     *   'ok'     aircraft() gives a state (with a valid refLatLon)
     * aircraft() returns null exactly when this is not 'ok' (or the reference point is unusable).
     */
    function aircraftStatus(sit, settings_, now = Date.now()) {
        if (!sit) return 'nogps';
        if (!isNum(sit.timestamp) || now - sit.timestamp > SIT_MAX_AGE_MS) return 'stale';
        if (!GpsFix.has3DFix(sit)) return 'nofix';
        if (!isNum(sit.ground_speed) || !isNum(sit.alt_msl) || !isNum(sit.true_course)) return 'nodata';
        const S = validate(settings_);
        if (sit.ground_speed < S.pilot.showAboveGsKt) return 'slow';
        return 'ok';
    }

    // ---- Winds aloft (the glide leg) ---------------------------------------

    const app = () => (typeof window !== 'undefined' ? window.app : undefined);

    /** Largest wind aloft taken as real; anything above (or a direction outside 0-360) is a decode error. */
    const MAX_WIND_ALOFT_KT = 250;
    /** A physically possible wind aloft: direction 0-360, speed 0-MAX_WIND_ALOFT_KT, both finite. */
    const plausibleWind = (dir, spd) => isNum(dir) && dir >= 0 && dir <= 360
        && isNum(spd) && spd >= 0 && spd <= MAX_WIND_ALOFT_KT;

    /**
     * Forecast winds the route planner downloaded, with their age; the fresher planner when two exist.
     * A planner that knows the forecast's FOR USE window (_windsInfo.useFrom / useTo, Dates - the new planner
     * keeps an expired forecast) only counts while useFrom <= now < useTo; one without (legacy) is judged by age.
     */
    function plannerWinds(now) {
        const a = app();
        let best = null;
        for (const p of [a && a.routePlannerPanel, a && a.routePlannerPreview]) {
            if (!p || !p._lastWinds || !isNum(p._lastWindsAt)) continue;
            const wi = p._windsInfo;
            if (wi && wi.useFrom instanceof Date && wi.useTo instanceof Date) {
                const from = wi.useFrom.getTime(), to = wi.useTo.getTime();
                if (!isNum(from) || !isNum(to) || now < from || now >= to) continue;
            }
            if (!best || p._lastWindsAt > best._lastWindsAt) best = p;
        }
        return best ? { winds: best._lastWinds, at: best._lastWindsAt } : null;
    }

    /** The label with no winds aloft and no surface wind (validated settings S). */
    const assumedLabel = (S) => `NO CURRENT WINDS ALOFT · ${S.pilot.noWindHeadwindKt} kt headwind assumed`;

    /**
     * -> { wind: { from, kt } | null, label }
     * FIS-B first (station within windMaxStationNm, received within windMaxAgeMin), else the route planner's
     * pre-flight winds (same limits), else null with the label the pilot sees ("NO CURRENT WINDS ALOFT ...").
     * A wind that is not physically possible (plausibleWind) from either source is treated as no wind.
     * The label names the level the wind is for; a level below the lowest reported is labelled with the level used.
     */
    function glideWind(lat, lon, altMsl, settings_, now = Date.now()) {
        const S = validate(settings_);
        const maxNm = S.pilot.windMaxStationNm, maxAgeMs = S.pilot.windMaxAgeMin * MS_PER_MIN;
        const none = { wind: null, label: assumedLabel(S) };
        if (!isLL(lat, lon) || !isNum(altMsl)) return none;
        const text = (dir, kt, level, src) => `${pad3(dir)}/${pad2(kt)} at ${fmtFt(level)} ft · ${src}`;

        try {
            const fisb = app() && app().fisbClient;
            const w = fisb && fisb.getNearestWind ? fisb.getNearestWind(lat, lon, altMsl) : null;
            if (w && isLL(w.lat, w.lon) && plausibleWind(w.dir, w.spd) && isNum(w.alt) && isNum(w.received_at)
                && now - w.received_at <= maxAgeMs && distNm(lat, lon, w.lat, w.lon) <= maxNm) {
                return { wind: { from: w.dir, kt: w.spd }, label: text(w.dir, w.spd, w.alt, 'FIS-B') };
            }
        } catch (_) { /* fall through */ }

        try {
            const pw = plannerWinds(now);
            const FP = typeof window !== 'undefined' ? window.FlyTabPlanning : undefined;
            const stations = typeof WeatherClient !== 'undefined' && WeatherClient ? WeatherClient.FD_STATIONS : null;
            if (pw && FP && FP.findNearestFdStation && FP.getWindAtAlt && stations && now - pw.at <= maxAgeMs) {
                const stn = FP.findNearestFdStation(pw.winds, lat, lon);
                const c = stn && stations[stn];
                const byAlt = stn && pw.winds[stn];
                if (c && byAlt && distNm(lat, lon, c[0], c[1]) <= maxNm) {
                    const e = FP.getWindAtAlt(byAlt, altMsl);
                    if (e && !e.variable && plausibleWind(e.dir, e.spd)) {
                        const level = Number(Object.keys(byAlt).find((k) => byAlt[k] === e));
                        if (isNum(level)) {
                            return { wind: { from: e.dir, kt: e.spd }, label: text(e.dir, e.spd, level, 'pre-flight winds') };
                        }
                    }
                }
            }
        } catch (_) { /* fall through */ }
        return none;
    }

    // ---- Runway wind (METAR) -----------------------------------------------

    const stationCoords = new Map();      // icao -> { lat, lon } (hits only; airports do not move)

    /**
     * A METAR's observation age in minutes if it is recent enough to use, else null. `rawObservedAt`
     * (the time read from the raw report) is also considered: the OLDER of the two is used (err high) -
     * the AWC decoder's observed_at is the report time (top of the hour), which understates the age.
     */
    function metarAgeMin(decoded, now, maxAgeMin, rawObservedAt) {
        // A time more than FUTURE_TOLERANCE_MS ahead of `now` (clock skew, a bad report) has an unknown age:
        // it is ignored, and a METAR with no usable time left is not used.
        const times = [decoded && Date.parse(decoded.observed_at), rawObservedAt && Date.parse(rawObservedAt)]
            .filter((t) => isNum(t) && t - now <= FUTURE_TOLERANCE_MS);
        if (!times.length) return null;
        const min = Math.max(0, now - Math.min(...times)) / MS_PER_MIN;
        return min <= maxAgeMin ? min : null;
    }

    /**
     * A decoded METAR's wind as a well-formed RunwayWind: calm | vrb (kt > 0, gustKt|null) | metar (from, kt > 0
     * finite, gustKt|null) | null when the report has no parseable wind.
     */
    function windOf(d) {
        if (!d || !isNum(d.wind_speed) || d.wind_speed < 0) return null;
        if (d.wind_speed === 0) return { kind: 'calm' };
        const gustKt = isNum(d.wind_gust) && d.wind_gust > 0 ? d.wind_gust : null;
        // FIS-B decodes VRB as wind_dir null; the AWC decoder (WeatherClient) as the string 'VRB' (+ wind_variable)
        if (d.wind_variable === true || d.wind_dir === null || d.wind_dir === undefined
            || (typeof d.wind_dir === 'string' && /^VRB$/i.test(d.wind_dir.trim()))) {
            return { kind: 'vrb', kt: d.wind_speed, gustKt };
        }
        if (!isNum(d.wind_dir) || d.wind_dir < 0 || d.wind_dir > 360) return null;
        return { kind: 'metar', from: d.wind_dir, kt: d.wind_speed, gustKt };
    }

    function windLabel(icao, w, speedKt, min) {
        let t;
        if (w.kind === 'calm') t = 'calm';
        else if (w.kind === 'vrb') t = 'VRB/' + pad2(speedKt) + (w.gustKt ? 'G' + pad2(w.gustKt) : '');
        else t = `${pad3(w.from)}/${pad2(w.kt)}${w.gustKt ? 'G' + pad2(w.gustKt) : ''}`;
        return `METAR ${icao} ${t} (${Math.round(min)} min)`;
    }

    /** { wind, label } for one METAR source, or null when it is not usable. `raw`: the report text, if known. */
    function fromMetar(icao, decoded, now, maxAgeMin, raw) {
        let rawObs = null;
        if (raw && typeof FisbClient !== 'undefined' && FisbClient && FisbClient.decodeMetar) {
            try { rawObs = FisbClient.decodeMetar(String(raw)).observed_at || null; } catch (_) { rawObs = null; }
        }
        const min = metarAgeMin(decoded, now, maxAgeMin, rawObs);
        if (min === null) return null;
        const w = windOf(decoded);
        if (!w) return null;
        return { wind: w, label: windLabel(icao, w, decoded.wind_speed, min) };
    }

    async function coordsOf(nasr, icao) {
        if (stationCoords.has(icao)) return stationCoords.get(icao);
        try {
            const a = nasr && nasr.getAirport ? await nasr.getAirport(icao) : null;
            if (a && isLL(a.lat, a.lon)) {
                const c = { lat: a.lat, lon: a.lon };
                stationCoords.set(icao, c);             // only hits are cached: a miss may be a failed read
                return c;
            }
        } catch (_) { /* not cached */ }
        return null;
    }

    /**
     * -> { wind: RunwayWind, label }   (RunwayWind: { kind:'metar', from, kt, gustKt|null } | { kind:'calm' }
     *                                   | { kind:'vrb', kt, gustKt|null } | { kind:'none' })
     * The airport's own METAR - FIS-B first, else the internet METAR the airport panel shows
     * (app.vectorLayers._internetMetars), else the one in the weather cache - when observed within metarMaxAgeMin;
     * else the nearest FIS-B METAR station within metarMaxStationNm under the same age rule; else none.
     */
    async function runwayWind(icao, refLatLon, settings_, now = Date.now()) {
        const S = validate(settings_);
        const maxAge = S.pilot.metarMaxAgeMin;
        const none = { wind: { kind: 'none' }, label: '' };
        const id = typeof icao === 'string' ? icao.trim().toUpperCase() : '';
        if (!id) return none;
        const a = app();
        const fisb = a && a.fisbClient, nasr = a && a._nasrDb;

        try {
            const m = fisb && fisb.getMetar ? fisb.getMetar(id) : null;
            const r = m && fromMetar(id, m.decoded, now, maxAge);
            if (r) return r;
        } catch (_) { /* next source */ }
        try {
            // The internet METAR the airport panel shows (airport-popup.js reads the same map), fetched pre-flight.
            const im = a && a.vectorLayers && a.vectorLayers._internetMetars;
            const e = im && typeof im.get === 'function' ? im.get(id) : null;
            const r = e && fromMetar(id, e.decoded, now, maxAge, e.raw);
            if (r) return r;
        } catch (_) { /* next source */ }
        try {
            const wx = nasr && nasr.getWeather ? await nasr.getWeather(id) : null;
            const r = wx && wx.metar && fromMetar(id, wx.metar.decoded, now, maxAge, wx.metar.raw);
            if (r) return r;
        } catch (_) { /* next source */ }

        try {
            if (fisb && fisb.metars && refLatLon && isLL(refLatLon.lat, refLatLon.lon)) {
                let best = null;
                for (const [stn, entry] of fisb.metars) {
                    if (stn === id || !entry) continue;
                    const r = fromMetar(stn, entry.decoded, now, maxAge);
                    if (!r) continue;
                    const c = await coordsOf(nasr, stn);
                    if (!c) continue;
                    const d = distNm(refLatLon.lat, refLatLon.lon, c.lat, c.lon);
                    if (d <= S.pilot.metarMaxStationNm && (!best || d < best.d)) best = { d, stn, entry };
                }
                if (best) return fromMetar(best.stn, best.entry.decoded, now, maxAge);
            }
        } catch (_) { /* none */ }
        return none;
    }

    // ---- The glide wind (spec 2026-11-06: decision 2, "Surface wind only in the lowest 1,000 ft") ---------

    /** The runway (surface) wind as a model glide wind, or null when there is none. */
    function surfaceGlideWind(runway) {
        const w = runway && runway.wind;
        // noTail: a surface wind never helps the glide (a tailwind component counts as 0; spec 2026-11-06 review)
        if (w && w.kind === 'metar' && isNum(w.from) && isNum(w.kt)) {
            return { from: w.from, kt: w.kt, gustKt: isNum(w.gustKt) ? w.gustKt : null, noTail: true };
        }
        if (w && w.kind === 'vrb') {
            const kts = [w.kt, w.gustKt].filter(isNum);
            if (kts.length) return { headKt: Math.max(...kts) };
        }
        if (w && w.kind === 'calm') return { headKt: 0 };
        return null;
    }

    /**
     * The wind the glide legs use: two layers split at L = surfaceWindMaxAglFt above the field.
     *   upper (above L): the winds aloft (`aloft`, a glideWind() result) when trusted, else none (the assumed
     *                    noWindHeadwindKt headwind);
     *   lower (below L): the runway (surface) wind (`runway`, a runwayWind() result: METAR { from, kt, gustKt,
     *                    noTail: true }, VRB n (gust g) -> { headKt: max(n, g) }, calm -> { headKt: 0 }), else the
     *                    upper layer's wind.
     * Weights over the height glided, from `hAglFt` (current height above the field) down to marginFt:
     * wUp = max(0, h - max(L, margin)) / (that + max(0, min(h, L) - margin)), wLow = 1 - wUp
     * (nothing glided: lower only when h <= L, else upper only; h unknown: upper only).
     * -> { wind, label, assumed, source, parts }
     *   wind    one layer: that wind (null | vector | { headKt }); two: { layers: [{ wind: upper, w: wUp },
     *           { wind: lower, w: wLow }] } (the shape GlideModel.plan takes)
     *   label   one layer: the aloft label ("250/14 at 3,000 ft · FIS-B"), "<runway label> · surface", or
     *           "NO CURRENT WINDS ALOFT · 10 kt headwind assumed"; two: "<aloft label> above 1,000 ft · <runway label>
     *           below" or "assumed 10 kt headwind above 1,000 ft · <runway label> below"
     *   assumed true when the assumed headwind is used (it has weight > 0)
     *   source  'aloft' | 'surface' | 'assumed' (one layer) | 'layered'
     *   parts   [{ text, amber }]: the label's parts, amber = the assumed part (the panel colours only that part)
     */
    function glideWindFor(aloft, runway, settings_, hAglFt) {
        const S = validate(settings_);
        const L = S.pilot.surfaceWindMaxAglFt;
        const aloftOk = !!(aloft && aloft.wind && isNum(aloft.wind.from) && isNum(aloft.wind.kt));
        const low = surfaceGlideWind(runway);
        const h = isNum(hAglFt) ? hAglFt : Infinity;
        // Weights over the height actually glided: from h down to the margin height (the plan's target), split
        // at L. Using the full height overweighted the lower layer (~3% optimistic with a strong headwind aloft).
        const m = S.pilot.marginFt;
        let wUp = 1;
        if (h !== Infinity) {
            const up = Math.max(0, h - Math.max(L, m)), lo = Math.max(0, Math.min(h, L) - m);
            wUp = up + lo > 0 ? up / (up + lo) : (h > L ? 1 : 0);
        }
        const one = (wind, label, assumed, source) => ({ wind, label, assumed, source, parts: [{ text: label, amber: assumed }] });
        const upperOnly = () => (aloftOk ? one(aloft.wind, String(aloft.label || ''), false, 'aloft')
            : one(null, assumedLabel(S), true, 'assumed'));
        if (!low || wUp >= 1) return upperOnly();              // no surface wind (lower = upper), or above it all
        const rwyLabel = String((runway && runway.label) || 'surface wind');
        if (wUp <= 0) return one(low, `${rwyLabel} · surface`, false, 'surface');
        const above = `above ${fmtFt(L)} ft`;
        const upText = aloftOk ? `${String(aloft.label || '')} ${above}` : `assumed ${fmtFt(S.pilot.noWindHeadwindKt)} kt headwind ${above}`;
        const lowText = `${rwyLabel} below`;
        return {
            wind: { layers: [{ wind: aloftOk ? aloft.wind : null, w: wUp }, { wind: low, w: 1 - wUp }] },
            label: `${upText} · ${lowText}`,
            assumed: !aloftOk,
            source: 'layered',
            parts: [{ text: upText, amber: !aloftOk }, { text: lowText, amber: false }],
        };
    }

    return {
        SIT_MAX_AGE_MS, settings, validate, airport, aircraft, aircraftStatus, glideWind, runwayWind, glideWindFor,
        _resetCaches() { stationCoords.clear(); },
    };
})();

if (typeof window !== 'undefined') window.GlideInputs = GlideInputs;
