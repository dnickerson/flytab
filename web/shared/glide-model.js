/**
 * FlyTab - engine-out glide model (web/shared/glide-model.js).
 *
 * Pure computation, no DOM, no network. Ported from the simulator agreed with
 * the pilot on 2026-10-28 (docs/superpowers/specs/2026-10-31-engine-out-glide-reference.js);
 * that file is the algorithm, this module generalises it only by
 *   - reading every model number from a settings object (GlideModel.DEFAULTS
 *     holds the agreed RV-9A values; nothing else in here is a model number),
 *   - taking per-runway-end data (threshold, landing heading, length, mid-point),
 *   - plan B to the nearest point of the nearest runway segment, or to the
 *     airport reference point when no runway end is known (kind 'ref'),
 *   - a separate runway wind (METAR / calm / variable / none) for the end
 *     choice and the final-leg headwind component.
 * See docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md.
 *
 * Geometry: local plane in nautical miles, x east, y north, the airport
 * reference point at 0,0 (GlideModel.toLocal / fromLocal). Bearings are TRUE.
 * Heights are feet MSL, speeds knots, rates feet per minute.
 *
 * Exposes the global GlideModel:
 *   DEFAULTS, triangle(), initialTurn(), plan(), toLocal(), fromLocal()
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
    const MIN_FINAL_GS_KT = 20;         // ground speed floor on final (reference: Math.max(..., 20))
    const TURN_STEP_DEG = 2;            // initialTurn() integration step and "turn finished" tolerance
    const TURN_MAX_STEPS = 200;         // initialTurn() iteration bound
    const MIN_LEG_MIN = 1 / 60;         // 1 s: floor on leg time when deriving a target rate over the field

    /** The agreed RV-9A defaults. Aircraft values persist via flypi_user_aircraft, pilot values via cockpit-config. */
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
            showAboveGsKt: 40,
        }),
    });

    const rad = (d) => d * Math.PI / 180;
    const deg = (r) => r * 180 / Math.PI;
    const norm = (d) => ((d % 360) + 360) % 360;
    const signedDiff = (to, from) => ((to - from + 540) % 360) - 180;
    const fromPolar = (brgTrue, nm) => ({ x: nm * Math.sin(rad(brgTrue)), y: nm * Math.cos(rad(brgTrue)) });
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
            lineUpFtPerDeg: pick(p, DEFAULTS.pilot, 'lineUpFtPerDeg'),
            fraction: pick(p, DEFAULTS.pilot, 'finalPointFraction'),
            fpMinFt: pick(p, DEFAULTS.pilot, 'finalPointMinFt'),
            fpMaxFt: pick(p, DEFAULTS.pilot, 'finalPointMaxFt'),
            noWindHeadKt: pick(p, DEFAULTS.pilot, 'noWindHeadwindKt'),
            hysteresisFt: pick(p, DEFAULTS.pilot, 'planBHysteresisFt'),
        };
        r.turnSinkFactor = 1 / Math.pow(Math.cos(rad(r.bankDeg)), 1.5);
        return r;
    }

    const tasAt = (R, altFt) => R.iasKt * (1 + (R.densityPct / 100) * altFt / 1000);
    const sinkAt = (R, altFt) => R.sinkFpm * tasAt(R, altFt) / R.iasKt;

    function triangleR(R, courseT, tasKt, wind) {
        if (!wind) return { hdg: courseT, gs: Math.max(tasKt - R.noWindHeadKt, MIN_GS_KT), wca: 0 };
        const rel = rad(wind.from - courseT);
        const cross = wind.kt * Math.sin(rel), head = wind.kt * Math.cos(rel);
        const s = Math.max(-1, Math.min(1, cross / tasKt));
        const wca = deg(Math.asin(s));
        return { hdg: norm(courseT + wca), gs: Math.max(tasKt * Math.cos(rad(wca)) - head, MIN_GS_KT), wca };
    }

    /** Wind triangle. wind = { from, kt } or null (no wind data: the assumed headwind). -> { hdg, gs, wca } */
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

    /** Final-leg headwind component (kt, negative = tailwind) of one runway end for a RunwayWind. */
    function runwayHead(R, rw, glideWind, hdg) {
        const kind = rw && rw.kind;
        if (kind === 'metar') {
            const c = Math.cos(rad(rw.from - hdg));
            // err high: a headwind component uses the gust (needs more height), a tailwind the steady speed
            const kt = (c >= 0 && Number.isFinite(rw.gustKt)) ? Math.max(rw.gustKt, rw.kt) : rw.kt;
            return kt * c;
        }
        if (kind === 'calm') return 0;
        if (kind === 'vrb') return R.noWindHeadKt;
        return glideWind ? glideWind.kt * Math.cos(rad(glideWind.from - hdg)) : R.noWindHeadKt;
    }

    /** Target descent rate: height to lose / time to the point (floored time, never Infinity), >= 0. */
    function rateFor(toLose, tMin) {
        return Math.max(0, toLose / Math.max(tMin, MIN_LEG_MIN));
    }

    /**
     * input = { airport: { elevFt, ref: {x,y}, ends: [{ id, thr, hdgTrue, rwyLenFt, mid, rwy: {a, b} }] },
     *           ac: { pos, altMsl, gs, trkTrue, vs }, glideWind: {from,kt}|null,
     *           runwayWind: {kind:'metar',from,kt,gustKt}|{kind:'calm'}|{kind:'vrb'}|{kind:'none'},
     *           preferDirect: bool }
     * -> { kind: 'final'|'direct'|'ref', endId, runwayId, pt, needMsl, spare, hdgTrue, legNm, tMin, target, projected,
     *      measured, targetNow, turnNow, headRwy, tailwindKt }
     *
     * endId: the chosen end's id, 'both' for plan B to the runway, null for plan B to the reference point.
     * runwayId: the runway of the chosen end (final) / of the nearest segment (plan B), e.g. '06/24';
     * null for the reference point or an end without runwayId.
     * hdgTrue: wind-corrected true heading of the straight leg after the turn. target / targetNow: fpm to
     * lose, >= 0, from the wind-triangle / the current ground speed. projected: glide sink at the current
     * altitude. measured: current descent rate (positive = descending, null when vs is unknown).
     * turnNow: signed degrees from the current track to the point (+ right). headRwy: runway headwind
     * component on final (kt, null for plan B); tailwindKt: its tailwind part (>= 0).
     */
    function plan(input, settings) {
        const R = resolve(settings);
        const apt = input.airport, ac = input.ac;
        const glideWind = input.glideWind || null;
        const rw = input.runwayWind || { kind: 'none' };
        const elev = apt.elevFt;
        const alt = ac.altMsl, pos = ac.pos, trk = ac.trkTrue;
        const tasNow = tasAt(R, alt), sinkNow = sinkAt(R, alt);

        const ends = (apt.ends || []).filter((e) => e && isPt(e.thr) && isPt(e.mid)
            && Number.isFinite(e.hdgTrue) && Number.isFinite(e.rwyLenFt) && e.rwyLenFt > 0);

        const evalEnd = (e) => {
            const back = norm(e.hdgTrue + 180);
            const offsetFt = Math.min(R.fpMaxFt, Math.max(R.fpMinFt, R.fraction * e.rwyLenFt));
            const off = fromPolar(back, offsetFt / FT_PER_NM);
            const pt = { x: e.thr.x + off.x, y: e.thr.y + off.y };
            const it = initialTurnR(R, pos, trk, pt, alt, glideWind);
            const leg = toPolar(pt.x - it.pos.x, pt.y - it.pos.y);
            const headRwy = runwayHead(R, rw, glideWind, e.hdgTrue);
            const turn = Math.abs(signedDiff(e.hdgTrue, leg.brg));
            const finalGs = Math.max(tasNow - headRwy, MIN_FINAL_GS_KT);
            const ftPerFtFinal = finalGs * KT_TO_FPM / sinkNow;
            const straightFt = Math.hypot(e.mid.x - pt.x, e.mid.y - pt.y) * FT_PER_NM;
            const needMsl = elev + straightFt / ftPerFtFinal + R.lineUpFtPerDeg * turn + R.marginFt;
            const tri = triangleR(R, leg.brg, tasNow, glideWind);
            const tMin = leg.nm * 60 / tri.gs;
            const toLose = alt - needMsl - it.lost;
            return { kind: 'final', endId: e.id, runwayId: rwyIdOf(e), pt, leg, headRwy, turn, needMsl, tri, tMin, toLose,
                     spare: toLose - sinkNow * tMin };
        };
        const cands = ends.map(evalEnd);

        // Plan B: the nearest point of the nearest candidate runway segment, else the airport reference point.
        let kindB = 'ref', ptB = isPt(apt.ref) ? apt.ref : { x: 0, y: 0 }, endIdB = null, rwyIdB = null;
        let bestD = Infinity;
        for (const e of ends) {
            if (!e.rwy || !isPt(e.rwy.a) || !isPt(e.rwy.b)) continue;
            const ux = e.rwy.b.x - e.rwy.a.x, uy = e.rwy.b.y - e.rwy.a.y, len2 = ux * ux + uy * uy;
            const k = len2 > 0
                ? Math.max(0, Math.min(1, ((pos.x - e.rwy.a.x) * ux + (pos.y - e.rwy.a.y) * uy) / len2)) : 0;
            const near = { x: e.rwy.a.x + k * ux, y: e.rwy.a.y + k * uy };
            const d = Math.hypot(pos.x - near.x, pos.y - near.y);
            if (d < bestD) { bestD = d; ptB = near; kindB = 'direct'; endIdB = 'both'; rwyIdB = rwyIdOf(e); }
        }
        const itD = initialTurnR(R, pos, trk, ptB, alt, glideWind);
        const legD = toPolar(ptB.x - itD.pos.x, ptB.y - itD.pos.y);
        const triD = triangleR(R, legD.brg, tasNow, glideWind);
        const tMinD = legD.nm * 60 / triD.gs, needD = elev + R.marginFt, toLoseD = alt - needD - itD.lost;
        const direct = { kind: kindB, endId: endIdB, runwayId: rwyIdB, pt: ptB, leg: legD, headRwy: null, needMsl: needD, tri: triD,
                         tMin: tMinD, toLose: toLoseD, spare: toLoseD - sinkNow * tMinD };

        const need = input.preferDirect ? R.hysteresisFt : 0;
        const reach = cands.filter((c) => c.spare >= need);
        const byWind = rw.kind === 'metar' || ((rw.kind === 'none' || !rw.kind) && !!glideWind);
        const pick = reach.length
            ? reach.reduce((a, b) => (byWind ? (b.headRwy > a.headRwy ? b : a) : (b.turn < a.turn ? b : a)))
            : direct;

        // targetNow: the same height-to-lose, but over the time the CURRENT ground speed would take.
        const gsNow = Number.isFinite(ac.gs) && ac.gs > 0 ? ac.gs : pick.tri.gs;
        const tMinNow = pick.leg.nm * 60 / Math.max(gsNow, MIN_GS_KT);
        const head = pick.headRwy;
        return {
            kind: pick.kind,
            endId: pick.endId,
            runwayId: pick.runwayId,
            pt: pick.pt,
            needMsl: pick.needMsl,
            spare: pick.spare,
            hdgTrue: norm(pick.tri.hdg),
            legNm: pick.leg.nm,
            tMin: pick.tMin,
            target: rateFor(pick.toLose, pick.tMin),
            projected: sinkNow,
            measured: Number.isFinite(ac.vs) ? Math.max(0, -ac.vs) : null,
            targetNow: rateFor(pick.toLose, tMinNow),
            turnNow: signedDiff(toPolar(pick.pt.x - pos.x, pick.pt.y - pos.y).brg, trk),
            headRwy: head,
            tailwindKt: head !== null && head < 0 ? -head : 0,
        };
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

    return { DEFAULTS, triangle, initialTurn, plan, toLocal, fromLocal };
})();

if (typeof window !== 'undefined') window.GlideModel = GlideModel;
