/**
 * FlyTab - engine-out glide model (web/shared/glide-model.js).
 *
 * Pure computation, no DOM, no network. Ported from the simulator agreed with
 * the pilot on 2026-10-28 (docs/superpowers/specs/2026-10-31-engine-out-glide-reference.js);
 * that file is the algorithm, this module generalises it only by
 *   - reading every model number from a settings object (GlideModel.DEFAULTS
 *     holds the agreed RV-9A values; nothing else in here is a model number),
 *   - taking per-runway-end data (threshold, landing heading, length, width, segment),
 *   - the target choice of the 2026-11-06 amendment (no longer the reference's final point):
 *     over the runway (kind 'over'), on a short final (kind 'final'), else turn toward the
 *     nearest point of the nearest runway segment (kind 'direct'), or toward the airport
 *     reference point when no runway segment is known (kind 'ref'),
 *   - a glide wind that may be a vector, a headwind on every course (VRB / calm surface wind)
 *     or none (the assumed headwind), and a separate runway wind for the final-leg
 *     headwind component.
 * See docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md and
 * docs/superpowers/specs/2026-11-06-engine-out-glide-runway-target.md (which wins where they differ).
 *
 * Geometry: local plane in nautical miles, x east, y north, the airport
 * reference point at 0,0 (GlideModel.toLocal / fromLocal). Bearings are TRUE.
 * Heights are feet MSL, speeds knots, rates feet per minute.
 *
 * Exposes the global GlideModel:
 *   DEFAULTS, triangle(), initialTurn(), plan(), tasAt(), sinkAt(), toLocal(), fromLocal()
 */
const GlideModel = (() => {
    'use strict';

    // ---- Physical constants (not settings) ---------------------------------
    const FT_PER_NM = 6076.12;
    const KT_TO_FPM = 101.269;          // 1 kt in feet per minute
    const STD_RATE_K = 1091;            // standard-rate turn: rate(deg/s) = 1091 * tan(bank) / TAS(kt)
    const NM_PER_DEG_LAT = 60;          // a nautical mile is one minute of latitude
    // ---- Numerical guards / integration steps (not model values) ----------
    const MIN_GS_KT = 1;                // ground speed floor so time = distance / gs stays finite
    const MIN_FINAL_GS_KT = 20;         // ground speed floor on a short final (reference: Math.max(..., 20))
    const TURN_STEP_DEG = 2;            // initialTurn() integration step and "turn finished" tolerance
    const TURN_MAX_STEPS = 200;         // initialTurn() iteration bound
    const MIN_LEG_MIN = 1 / 60;         // 1 s: floor on leg time when deriving a target rate over the field
    // ---- Target-choice gates (spec 2026-11-06, decision 3) ------------------
    const DEFAULT_WIDTH_FT = 100;       // runway width when the record has none
    const OVER_MIN_HALF_FT = 50;        // "over the runway": within max(width / 2, this) + OVER_EXTRA_FT of the centreline
    const OVER_EXTRA_FT = 150;
    const FINAL_MAX_NM = 1.0;           // short final: the runway end ahead by 0 < d <= this along the landing heading,
    const FINAL_LATERAL_NM = 0.1;       // within this of the extended centreline,
    const FINAL_TRACK_DEG = 30;         // track within this of the landing heading
    // ---- Over the runway (spec 2026-11-06, rulings after the critical review) ----
    const LINED_UP_DEG = 30;            // over the runway, "lined up": track within this of either runway direction
    const ROLLOUT_FT = 1000;            // runway needed after touchdown, added to the straight-glide distance ahead

    /**
     * The agreed RV-9A defaults. Aircraft values persist via flypi_user_aircraft, pilot values via cockpit-config.
     * lineUpFtPerDeg, finalPointFraction, finalPointMinFt, finalPointMaxFt and planBHysteresisFt are no longer
     * used (spec 2026-11-06, decision 1); the keys stay so stored settings and GlideInputs.validate keep working.
     */
    const DEFAULTS = Object.freeze({
        aircraft: Object.freeze({
            glide_ias_kt: 65,
            glide_sink_fpm: 700,
            glide_density_pct_per_kft: 2,
            min_runway_ft: null,        // no length filter unless the aircraft config sets one
        }),
        pilot: Object.freeze({
            turnBankDeg: 30,
            marginFt: 200,
            lineUpFtPerDeg: 1.5,
            finalPointFraction: 0.25,
            finalPointMinFt: 500,
            finalPointMaxFt: 1000,
            noWindHeadwindKt: 10,
            planBHysteresisFt: 100,
            onCourseDeg: 5,
            windMaxStationNm: 100,
            metarMaxAgeMin: 75,
            metarMaxStationNm: 10,
            windMaxAgeMin: 360,
            showAboveGsKt: 25,
            surfaceWindMaxAglFt: 1000,  // the surface (METAR) wind is used only in the lowest this-many ft above the field
        }),
    });

    const rad = (d) => d * Math.PI / 180;
    const deg = (r) => r * 180 / Math.PI;
    const norm = (d) => ((d % 360) + 360) % 360;
    const signedDiff = (to, from) => ((to - from + 540) % 360) - 180;
    const toPolar = (dx, dy) => ({ brg: norm(deg(Math.atan2(dx, dy))), nm: Math.hypot(dx, dy) });
    const isPt = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
    const rwyIdOf = (e) => (e.runwayId != null && e.runwayId !== '' ? String(e.runwayId) : null);

    /** Settings with any missing / non-finite key taken from DEFAULTS, and the derived values. */
    function resolve(settings) {
        const a = (settings && settings.aircraft) || {};
        const p = (settings && settings.pilot) || {};
        const pick = (src, def, k) => (typeof src[k] === 'number' && Number.isFinite(src[k]) ? src[k] : def[k]);
        const r = {
            iasKt: pick(a, DEFAULTS.aircraft, 'glide_ias_kt'),
            sinkFpm: pick(a, DEFAULTS.aircraft, 'glide_sink_fpm'),
            densityPct: pick(a, DEFAULTS.aircraft, 'glide_density_pct_per_kft'),
            bankDeg: pick(p, DEFAULTS.pilot, 'turnBankDeg'),
            marginFt: pick(p, DEFAULTS.pilot, 'marginFt'),
            noWindHeadKt: pick(p, DEFAULTS.pilot, 'noWindHeadwindKt'),
            showAboveGsKt: pick(p, DEFAULTS.pilot, 'showAboveGsKt'),
        };
        r.turnSinkFactor = 1 / Math.pow(Math.cos(rad(r.bankDeg)), 1.5);
        return r;
    }

    const tasAt = (R, altFt) => R.iasKt * (1 + (R.densityPct / 100) * altFt / 1000);
    const sinkAt = (R, altFt) => R.sinkFpm * tasAt(R, altFt) / R.iasKt;

    /** { headKt }: a headwind of headKt on every course (a VRB or calm surface wind). */
    const isHeadWind = (w) => !!w && Number.isFinite(w.headKt);
    /** { from, kt, gustKt?, noTail? }: a wind vector. */
    const isVecWind = (w) => !!w && Number.isFinite(w.from) && Number.isFinite(w.kt);
    /** The vector wind's speeds to try: the steady speed, and the gust when there is one. */
    const vecSpeeds = (w) => (Number.isFinite(w.gustKt) ? [w.kt, w.gustKt] : [w.kt]);

    /** The vector triangle for one wind speed. noTail: a tailwind component counts as 0 (it never helps). */
    function solve(courseT, tasKt, from, kt, noTail) {
        const rel = rad(from - courseT);
        const cross = kt * Math.sin(rel);
        const head = noTail ? Math.max(0, kt * Math.cos(rel)) : kt * Math.cos(rel);
        const s = Math.max(-1, Math.min(1, cross / tasKt));
        const wca = deg(Math.asin(s));
        return { hdg: norm(courseT + wca), gs: Math.max(tasKt * Math.cos(rad(wca)) - head, MIN_GS_KT), wca };
    }

    /** { layers: [{ wind, w }, ...] }: the two-layer glide wind (upper first), weights w summing to 1. */
    const isLayered = (w) => !!w && Array.isArray(w.layers);
    /** The layers that count (weight > 0). */
    const liveLayers = (w) => w.layers.filter((l) => l && Number.isFinite(l.w) && l.w > 0);

    function triangleR(R, courseT, tasKt, wind) {
        if (isLayered(wind)) {
            // Two layers (spec 2026-11-06 "Surface wind only in the lowest 1,000 ft"): ground speed = the weighted
            // sum of each layer's own triangle; heading from the layer with the larger weight (the upper on a tie).
            let gs = 0, heavy = null;
            for (const l of liveLayers(wind)) {
                const t = triangleR(R, courseT, tasKt, l.wind);
                gs += l.w * t.gs;
                if (!heavy || l.w > heavy.w) heavy = { w: l.w, t };
            }
            if (!heavy) return triangleR(R, courseT, tasKt, null);
            return { hdg: heavy.t.hdg, gs: Math.max(gs, MIN_GS_KT), wca: heavy.t.wca };
        }
        if (isHeadWind(wind)) return { hdg: courseT, gs: Math.max(tasKt - wind.headKt, MIN_GS_KT), wca: 0 };
        if (!isVecWind(wind)) return { hdg: courseT, gs: Math.max(tasKt - R.noWindHeadKt, MIN_GS_KT), wca: 0 };
        // With a gust: solved with the steady and the gust speed, the LOWER ground speed (and its heading) is used.
        let best = null;
        for (const kt of vecSpeeds(wind)) {
            const t = solve(courseT, tasKt, wind.from, kt, !!wind.noTail);
            if (!best || t.gs < best.gs) best = t;
        }
        return best;
    }

    /**
     * Ground speed along `courseT` for the runway left ahead (needAheadFt): the conservative way round - the
     * HIGHER ground speed (a longer float). A headwind (the assumed one, a { headKt } surface wind, or a headwind
     * component) never shortens it below the still-air TAS; a tailwind component always counts (noTail ignored),
     * and with a gust the faster of the steady / gust solutions is used.
     */
    function floatGsR(courseT, tasKt, wind) {
        if (isLayered(wind)) return Math.max(tasKt, ...liveLayers(wind).map((l) => floatGsR(courseT, tasKt, l.wind)));
        let gs = tasKt;
        if (isVecWind(wind)) {
            for (const kt of vecSpeeds(wind)) gs = Math.max(gs, solve(courseT, tasKt, wind.from, kt, false).gs);
        }
        return gs;
    }

    /**
     * Wind triangle. wind = { from, kt, gustKt?, noTail? } (with a gust: solved with kt and with the gust, the lower
     * ground speed wins; noTail: a tailwind component counts as 0 - a surface METAR wind never helps), { headKt }
     * (that headwind on every course), null (no wind data: the assumed noWindHeadwindKt headwind), or
     * { layers: [{ wind, w }, ...] } (weighted ground speed, heading of the heavier layer).
     * -> { hdg, gs, wca }
     */
    function triangle(courseT, tasKt, wind, settings) {
        return triangleR(resolve(settings), courseT, tasKt, wind);
    }

    function initialTurnR(R, pos, trk, target, altFt, wind) {
        const tasK = tasAt(R, altFt), sinkT = sinkAt(R, altFt) * R.turnSinkFactor;
        const rate = STD_RATE_K * Math.tan(rad(R.bankDeg)) / tasK;       // deg per second
        let p = { x: pos.x, y: pos.y }, t = trk, lost = 0, dg = 0;
        for (let i = 0; i < TURN_MAX_STEPS; i++) {
            const d = signedDiff(toPolar(target.x - p.x, target.y - p.y).brg, t);
            if (Math.abs(d) <= TURN_STEP_DEG) break;
            const stepDeg = Math.sign(d) * Math.min(Math.abs(d), TURN_STEP_DEG), dt = Math.abs(stepDeg) / rate;
            const mv = triangleR(R, t, tasK, wind).gs * dt / 3600;
            p = { x: p.x + Math.sin(rad(t)) * mv, y: p.y + Math.cos(rad(t)) * mv };
            t = norm(t + stepDeg); lost += sinkT * dt / 60; dg += Math.abs(stepDeg);
        }
        return { pos: p, trk: t, lost, deg: dg };
    }

    /**
     * Turn from the current track toward `target` at the settings' bank angle, flown in 2 degree steps
     * with position and wind drift integrated. -> { pos, trk, lost (ft), deg (total turn) }
     */
    function initialTurn(pos, trkTrue, target, altFt, glideWind, settings) {
        return initialTurnR(resolve(settings), pos, trkTrue, target, altFt, glideWind);
    }

    /**
     * Final-leg headwind component (kt, negative = tailwind) of one runway end for a RunwayWind; a malformed METAR
     * wind (no finite from / kt) or kind 'none' falls back on the glide wind, then on the assumed headwind.
     */
    function runwayHead(R, rw, glideWind, hdg) {
        const kind = rw && rw.kind;
        if (kind === 'metar' && Number.isFinite(rw.from) && Number.isFinite(rw.kt)) {
            const c = Math.cos(rad(rw.from - hdg));
            // err high: a headwind component uses the gust (needs more height), a tailwind the steady speed
            const kt = (c >= 0 && Number.isFinite(rw.gustKt)) ? Math.max(rw.gustKt, rw.kt) : rw.kt;
            return kt * c;
        }
        if (kind === 'calm') return 0;
        if (kind === 'vrb') {
            // a variable wind can blow straight down the runway: its speed (the gust when higher) as a headwind
            const kts = [rw.kt, rw.gustKt].filter(Number.isFinite);
            return kts.length ? Math.max(...kts) : R.noWindHeadKt;
        }
        if (isLayered(glideWind)) {
            const live = liveLayers(glideWind);
            const sumW = live.reduce((t, l) => t + l.w, 0);
            if (sumW > 0) return live.reduce((t, l) => t + l.w * runwayHead(R, { kind: 'none' }, l.wind, hdg), 0) / sumW;
            return R.noWindHeadKt;
        }
        if (isHeadWind(glideWind)) return glideWind.headKt;
        if (isVecWind(glideWind)) {
            // err high: the larger headwind / smaller tailwind of the steady and gust speeds
            const c = Math.cos(rad(glideWind.from - hdg));
            const head = Math.max(...vecSpeeds(glideWind).map((kt) => kt * c));
            return glideWind.noTail ? Math.max(0, head) : head;
        }
        return R.noWindHeadKt;
    }

    /** Target descent rate: height to lose / time to the point (floored time, never Infinity), >= 0. */
    function rateFor(toLose, tMin) {
        return Math.max(0, toLose / Math.max(tMin, MIN_LEG_MIN));
    }

    /** A runway end's half-width allowance for "over the runway" (ft): max(width / 2, OVER_MIN_HALF_FT) + OVER_EXTRA_FT. */
    function overHalfFt(e) {
        const w = Number.isFinite(e.widthFt) && e.widthFt > 0 ? e.widthFt : DEFAULT_WIDTH_FT;
        return Math.max(w / 2, OVER_MIN_HALF_FT) + OVER_EXTRA_FT;
    }

    /**
     * The elevation of runway physical end `pt` of end e's runway: the NASR elevation of the end (same runway segment)
     * whose physical end is `pt`; the field elevation when no end there carries one.
     */
    function endElevAt(segEnds, e, pt, fieldElev) {
        for (const o of segEnds) {
            if (o.rwy.a !== e.rwy.a || o.rwy.b !== e.rwy.b) continue;   // ends of the same runway share its segment points
            const q = isPt(o.phys) ? o.phys : null;
            if (q && Math.hypot(q.x - pt.x, q.y - pt.y) < 1e-9 && Number.isFinite(o.elevFt)) return o.elevFt;
        }
        return fieldElev;
    }

    /**
     * input = { airport: { elevFt, ref: {x,y},
     *                      ends: [{ id, runwayId, thr, phys, elevFt, hdgTrue, rwyLenFt, mid, widthFt, rwy: {a, b} }] },
     *           ac: { pos, altMsl, gs, trkTrue, vs },
     *           glideWind: null | { from, kt, gustKt?, noTail? } | { headKt }
     *                      | { layers: [{ wind, w }, { wind, w }] } (two layers, upper first: each `wind` one of the
     *                        shapes above, `w` its weight, summing to 1 - GlideInputs.glideWindFor builds it),
     *           runwayWind: {kind:'metar',from,kt,gustKt}|{kind:'calm'}|{kind:'vrb',kt,gustKt}|{kind:'none'},
     *           preferDirect: accepted and ignored (spec 2026-11-06) }
     * -> { kind: 'over'|'final'|'direct'|'ref', endId, runwayId, pt, needMsl, spare, hdgTrue, legNm, tMin, target,
     *      projected, measured, targetNow, turnNow, headRwy, tailwindKt }
     *
     * Target (spec 2026-11-06-engine-out-glide-runway-target.md), first that applies:
     *   footprint: the aircraft's projection lies on a runway segment (0 < k < 1) within overHalfFt() of its
     *            centreline. Lined up = track within LINED_UP_DEG of either runway direction (dir); aheadFt = the
     *            runway left ahead along dir, to that direction's physical end; needAheadFt = the straight glide
     *            from the height above that end (its NASR elevation, else the field's) at floatGsR() along dir,
     *            sink at altitude, + ROLLOUT_FT. roomAhead = lined up and aheadFt >= needAheadFt.
     *   'over'   on the footprint, alt - elev <= marginFt, and gs < showAboveGsKt (taxi speed) or roomAhead:
     *            needMsl = elev, spare = alt - elev, pt = the runway point under the aircraft, legNm 0, tMin 0,
     *            target 0, targetNow 0, hdgTrue = track, turnNow 0.
     *            High pass (alt - elev > marginFt) with roomAhead: kind 'direct' with those zero-leg numbers,
     *            needMsl = elev + marginFt, spare = alt - elev - marginFt.
     *            Anything else on the footprint: the turn back, kind 'direct' with the flown turn and glide, need =
     *            field + marginFt - to the physical end BEHIND the aircraft along dir when lined up without room
     *            ahead (ruling N1), to the runway MID-POINT when not lined up (crossing).
     *   'final'  short final to one end: its physical end (e.phys; e.thr when unknown) ahead along the landing
     *            heading by 0 < d <= FINAL_MAX_NM, within FINAL_LATERAL_NM of the extended centreline, track within
     *            FINAL_TRACK_DEG of the landing heading. Straight glide to that point, no turn, no margin
     *            (needMsl = the end's elevation e.elevFt, the field elevation when unknown), ground speed
     *            max(tas - headRwy, MIN_FINAL_GS_KT) from the RUNWAY wind (runwayHead); hdgTrue from the glide-wind
     *            triangle on the landing heading. The nearest such end when several.
     *   'direct' turn toward the nearest point of the nearest runway segment and arrive marginFt above the field.
     *   'ref'    no runway segment: the same to the airport reference point.
     * Glide wind: null -> the assumed noWindHeadwindKt headwind on every course; { headKt } -> that headwind on
     * every course; { from, kt, gustKt, noTail } -> wind triangle (triangleR: the lower ground speed of steady /
     * gust; noTail: no tailwind credit); { layers } -> ground speed = sum of w x each layer's ground speed, heading
     * from the heavier layer (the upper on a tie). The runway headwind fallback (runwayWind 'none') takes the
     * weighted mean of the layers' components; needAheadFt the most conservative layer.
     *
     * endId: the chosen end's id ('final'), 'both' for a runway segment ('over' / 'direct'), null for 'ref'.
     * runwayId: the runway of that end / segment, e.g. '06/24'; null for 'ref' or an end without runwayId.
     * hdgTrue: wind-corrected true heading of the straight leg after the turn. target / targetNow: fpm to
     * lose, >= 0, from the wind-triangle / the current ground speed. projected: glide sink at the current
     * altitude. measured: current descent rate (positive = descending, null when vs is unknown).
     * turnNow: signed degrees from the current track to the point (+ right). headRwy: the runway headwind
     * component on final (kt, from runwayHead; null for every other kind); tailwindKt: its tailwind part (>= 0).
     * Every number except measured / headRwy (null as above) is finite in every kind.
     */
    function plan(input, settings) {
        const R = resolve(settings);
        const apt = input.airport, ac = input.ac;
        const glideWind = input.glideWind || null;
        const rw = input.runwayWind || { kind: 'none' };
        const elev = apt.elevFt;
        const alt = ac.altMsl, pos = ac.pos, trk = ac.trkTrue;
        const tasNow = tasAt(R, alt), sinkNow = sinkAt(R, alt);
        const measured = Number.isFinite(ac.vs) ? Math.max(0, -ac.vs) : null;

        const ends = (apt.ends || []).filter((e) => e && isPt(e.thr)
            && Number.isFinite(e.hdgTrue) && Number.isFinite(e.rwyLenFt) && e.rwyLenFt > 0);
        const segEnds = ends.filter((e) => e.rwy && isPt(e.rwy.a) && isPt(e.rwy.b));

        // ---- Over the runway footprint ----
        let over = null;
        for (const e of segEnds) {
            const ux = e.rwy.b.x - e.rwy.a.x, uy = e.rwy.b.y - e.rwy.a.y, len2 = ux * ux + uy * uy;
            if (!(len2 > 0)) continue;
            const k = ((pos.x - e.rwy.a.x) * ux + (pos.y - e.rwy.a.y) * uy) / len2;
            if (!(k > 0 && k < 1)) continue;
            const near = { x: e.rwy.a.x + k * ux, y: e.rwy.a.y + k * uy };
            const offFt = Math.hypot(pos.x - near.x, pos.y - near.y) * FT_PER_NM;
            if (offFt <= overHalfFt(e) && (!over || offFt < over.offFt)) over = { e, near, offFt, k };
        }
        let turnBackTo = null;           // over the footprint, not landable straight ahead: the end behind / the mid-point
        if (over) {
            const { e, k } = over;
            const a = e.rwy.a, b = e.rwy.b;
            const lenFt = Math.hypot(b.x - a.x, b.y - a.y) * FT_PER_NM;
            const brgAB = toPolar(b.x - a.x, b.y - a.y).brg;
            // Lined up: track within LINED_UP_DEG of either runway direction; the runway left ahead runs to that
            // direction's physical end, and the glide straight ahead is judged from the height above that end.
            let ahead = null;
            if (Math.abs(signedDiff(trk, brgAB)) <= LINED_UP_DEG) ahead = { dir: brgAB, end: b, behind: a, ft: (1 - k) * lenFt };
            else if (Math.abs(signedDiff(trk, brgAB + 180)) <= LINED_UP_DEG) ahead = { dir: norm(brgAB + 180), end: a, behind: b, ft: k * lenFt };
            let roomAhead = false;
            if (ahead) {
                const groundFt = endElevAt(segEnds, e, ahead.end, elev);
                const heightFt = Math.max(0, alt - groundFt);
                const floatFt = heightFt / sinkNow * floatGsR(ahead.dir, tasNow, glideWind) * KT_TO_FPM;
                roomAhead = ahead.ft >= floatFt + ROLLOUT_FT;
            }
            const low = alt - elev <= R.marginFt;
            const taxi = Number.isFinite(ac.gs) && ac.gs < R.showAboveGsKt;
            if ((low && (taxi || roomAhead)) || (!low && roomAhead)) {
                // 'over': on the runway at taxi speed, or low and lined up with room to land ahead.
                // High pass lined up with room ahead: 'direct' with no turn and a zero leg.
                const needMsl = low ? elev : elev + R.marginFt;
                return {
                    kind: low ? 'over' : 'direct', endId: 'both', runwayId: rwyIdOf(e), pt: over.near,
                    needMsl, spare: alt - needMsl, hdgTrue: norm(trk), legNm: 0, tMin: 0, target: 0,
                    projected: sinkNow, measured, targetNow: 0, turnNow: 0, headRwy: null, tailwindKt: 0,
                };
            }
            // The turn back (re-review ruling N1): lined up without room ahead -> the physical end BEHIND the aircraft
            // (never a point ahead, which would be a straight glide forward reading GLIDE OK); crossing -> the mid-point.
            turnBackTo = { pt: ahead ? ahead.behind : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, runwayId: rwyIdOf(e) };
        }

        // ---- Short final: to the end's physical end (the threshold when unknown), at that end's elevation ----
        let fin = null;
        for (const e of ends) {
            const tp = isPt(e.phys) ? e.phys : e.thr;
            const h = rad(e.hdgTrue), ux = Math.sin(h), uy = Math.cos(h);
            const dx = tp.x - pos.x, dy = tp.y - pos.y;
            const along = dx * ux + dy * uy;                    // the runway end ahead along the landing heading
            const lateral = Math.abs(dx * uy - dy * ux);        // from the extended centreline
            if (!(along > 0 && along <= FINAL_MAX_NM) || lateral > FINAL_LATERAL_NM) continue;
            if (Math.abs(signedDiff(trk, e.hdgTrue)) > FINAL_TRACK_DEG) continue;
            if (!fin || along < fin.along) fin = { e, tp, along };
        }
        if (fin && !turnBackTo) {
            const e = fin.e, tp = fin.tp;
            const ground = Number.isFinite(e.elevFt) ? e.elevFt : elev;
            const legNm = Math.hypot(tp.x - pos.x, tp.y - pos.y);
            const tri = triangleR(R, e.hdgTrue, tasNow, glideWind);       // the heading (crab) only
            // Ground speed on final from the RUNWAY wind along the landing heading (spec 2026-11-06, review rulings).
            const head = runwayHead(R, rw, glideWind, e.hdgTrue);
            const finalGs = Math.max(tasNow - head, MIN_FINAL_GS_KT);
            const tMin = legNm * 60 / finalGs;
            const toLose = alt - ground;
            const gsNow = Number.isFinite(ac.gs) && ac.gs > 0 ? ac.gs : finalGs;
            return {
                kind: 'final', endId: e.id, runwayId: rwyIdOf(e), pt: tp,
                needMsl: ground, spare: toLose - sinkNow * tMin, hdgTrue: norm(tri.hdg), legNm, tMin,
                target: rateFor(toLose, tMin), projected: sinkNow, measured,
                targetNow: rateFor(toLose, legNm * 60 / Math.max(gsNow, MIN_GS_KT)),
                turnNow: signedDiff(toPolar(tp.x - pos.x, tp.y - pos.y).brg, trk),
                headRwy: head, tailwindKt: head < 0 ? -head : 0,
            };
        }

        // ---- Direct: the nearest point of the nearest runway segment (the turn-back point when over the runway
        // but not landable straight ahead), else the airport reference point ----
        let kind = 'ref', pt = isPt(apt.ref) ? apt.ref : { x: 0, y: 0 }, endId = null, runwayId = null;
        if (turnBackTo) {
            kind = 'direct'; pt = turnBackTo.pt; endId = 'both'; runwayId = turnBackTo.runwayId;
        } else {
            let bestD = Infinity;
            for (const e of segEnds) {
                const ux = e.rwy.b.x - e.rwy.a.x, uy = e.rwy.b.y - e.rwy.a.y, len2 = ux * ux + uy * uy;
                const k = len2 > 0
                    ? Math.max(0, Math.min(1, ((pos.x - e.rwy.a.x) * ux + (pos.y - e.rwy.a.y) * uy) / len2)) : 0;
                const near = { x: e.rwy.a.x + k * ux, y: e.rwy.a.y + k * uy };
                const d = Math.hypot(pos.x - near.x, pos.y - near.y);
                if (d < bestD) { bestD = d; pt = near; kind = 'direct'; endId = 'both'; runwayId = rwyIdOf(e); }
            }
        }
        const it = initialTurnR(R, pos, trk, pt, alt, glideWind);
        const leg = toPolar(pt.x - it.pos.x, pt.y - it.pos.y);
        const tri = triangleR(R, leg.brg, tasNow, glideWind);
        const tMin = leg.nm * 60 / tri.gs, needMsl = elev + R.marginFt, toLose = alt - needMsl - it.lost;

        // targetNow: the same height-to-lose, but over the time the CURRENT ground speed would take.
        const gsNow = Number.isFinite(ac.gs) && ac.gs > 0 ? ac.gs : tri.gs;
        const tMinNow = leg.nm * 60 / Math.max(gsNow, MIN_GS_KT);
        return {
            kind,
            endId,
            runwayId,
            turnBack: !!turnBackTo,      // over the runway, not landable ahead: back to the end behind / the mid-point
            pt,
            needMsl,
            spare: toLose - sinkNow * tMin,
            hdgTrue: norm(tri.hdg),
            legNm: leg.nm,
            tMin,
            target: rateFor(toLose, tMin),
            projected: sinkNow,
            measured,
            targetNow: rateFor(toLose, tMinNow),
            turnNow: signedDiff(toPolar(pt.x - pos.x, pt.y - pos.y).brg, trk),
            headRwy: null,
            tailwindKt: 0,
        };
    }

    /** The model's glide TAS (kt) at `altFt` MSL for these settings (missing / non-finite keys: DEFAULTS). */
    function tasAtAlt(altFt, settings) {
        return tasAt(resolve(settings), altFt);
    }

    /** The model's glide sink (fpm) at `altFt` MSL for these settings (missing / non-finite keys: DEFAULTS). */
    function sinkAtAlt(altFt, settings) {
        return sinkAt(resolve(settings), altFt);
    }

    /** Lat/lon -> local plane nm around (refLat, refLon): equirectangular, x east, y north. */
    function toLocal(refLat, refLon, lat, lon) {
        const dLon = ((lon - refLon + 540) % 360) - 180;
        return { x: dLon * Math.cos(rad(refLat)) * NM_PER_DEG_LAT, y: (lat - refLat) * NM_PER_DEG_LAT };
    }

    /** Inverse of toLocal. -> { lat, lon } */
    function fromLocal(refLat, refLon, p) {
        return { lat: refLat + p.y / NM_PER_DEG_LAT, lon: refLon + p.x / (Math.cos(rad(refLat)) * NM_PER_DEG_LAT) };
    }

    return { DEFAULTS, triangle, initialTurn, plan, tasAt: tasAtAlt, sinkAt: sinkAtAlt, toLocal, fromLocal };
})();

if (typeof window !== 'undefined') window.GlideModel = GlideModel;
