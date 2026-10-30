// @ts-check
'use strict';

import { tasAtAltitude, gphAtPower, climbRateAtAltitude, iasToTas } from './engine-data.js';

/**
 * @typedef {import('../types/aircraft-profile.js').AircraftProfile} AircraftProfile
 *
 * @typedef PhaseResult
 * @property {number} timeHrs
 * @property {number} fuelGal
 * @property {number} distNm
 * @property {number} altFt
 *
 * @typedef LegOpts
 * @property {number}  distNm
 * @property {number}  altFt
 * @property {boolean} [departingFromGround]
 * @property {boolean} [endingAtGround]
 * @property {number}  [windKt]     tailwind +, headwind - (scalar component)
 * @property {number}  [gsKt]       wind-corrected GS override — when set, used for cruise time
 * @property {number}  [tasKt]      altitude-corrected TAS override — when set, used for climb/descent
 * @property {number}  [powerFrac]  cruise power fraction 0–1 (default 0.75)
 * @property {number}  [destElevFt] with endingAtGround: the descent ends at this field
 *                                  elevation instead of 0 (#190). Default 0.
 *
 * @typedef LegDecomposition
 * @property {{climb:PhaseResult,cruise:PhaseResult,descent:PhaseResult,taxi?:PhaseResult}} phases
 * @property {number} totalTimeHrs
 * @property {number} totalFuelGal
 */

/**
 * Decompose a leg into climb/cruise/descent (and taxi if departing from ground).
 * @param {AircraftProfile} profile
 * @param {LegOpts} leg
 * @returns {LegDecomposition}
 */
export function decomposeLeg(profile, leg) {
    const fp          = profile.fuelPhases;
    const wind        = leg.windKt ?? 0;
    const overrideTas = leg.tasKt;
    const overrideGs  = leg.gsKt;
    const phases = {
        taxi:    { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: 0 },
        climb:   { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: leg.altFt },
        cruise:  { timeHrs: 0, fuelGal: 0, distNm: leg.distNm, altFt: leg.altFt },
        descent: { timeHrs: 0, fuelGal: 0, distNm: 0, altFt: leg.altFt },
    };

    if (leg.departingFromGround) {
        // Taxi — use fuelPhases.taxi if present, else fixed burn from profile
        if (fp?.taxi) {
            const taxiHrs = fp.taxi.time_min / 60;
            phases.taxi = { timeHrs: taxiHrs, fuelGal: fp.taxi.gph * taxiHrs, distNm: 0, altFt: 0 };
        } else {
            phases.taxi = { timeHrs: 0, fuelGal: profile.taxi_burn_gal ?? 1.5, distNm: 0, altFt: 0 };
        }

        // Climb — use fuelPhases.climb IAS, rate, and gph when available
        const climbRate = climbRateFpm(profile, 0, leg.altFt);
        const climbHrs = leg.altFt / climbRate / 60;
        const tasClimb = fp?.climb?.ias_kt
            ? iasToTas(fp.climb.ias_kt, leg.altFt / 2)
            : (overrideTas ? overrideTas * 0.9625 : tasAtAltitude(profile, leg.altFt / 2));
        const climbGph = climbGphAt(profile, leg.altFt / 2);
        const climbDist = (tasClimb + wind) * climbHrs;
        phases.climb = {
            timeHrs: climbHrs,
            fuelGal: climbGph * climbHrs,
            distNm:  Math.min(climbDist, leg.distNm * 0.6),
            altFt:   leg.altFt,
        };
    }

    if (leg.endingAtGround) {
        // Descent — use fuelPhases.descent IAS, rate, and gph when available.
        // It ends at the field elevation when the caller knows it (#190), else 0.
        const elevFt   = Math.min(leg.destElevFt ?? 0, leg.altFt);
        const midFt    = (leg.altFt + elevFt) / 2;
        const descRate = descentRateFpm(profile);
        const descHrs  = (leg.altFt - elevFt) / descRate / 60;
        const tasDesc  = fp?.descent?.ias_kt
            ? iasToTas(fp.descent.ias_kt, midFt)
            : (overrideTas ? overrideTas * 0.9625 : tasAtAltitude(profile, midFt));
        const descGph  = descentGphAt(profile, midFt);
        const descDist = (tasDesc + wind) * descHrs;
        phases.descent = {
            timeHrs: descHrs,
            fuelGal: descGph * descHrs,
            distNm:  Math.min(descDist, Math.max(0, leg.distNm - phases.climb.distNm)),
            altFt:   leg.altFt,
        };
    }

    const cruiseDist = Math.max(0, leg.distNm - phases.climb.distNm - phases.descent.distNm);
    const tasCruise  = overrideTas
        ?? (fp?.cruise?.ias_kt ? iasToTas(fp.cruise.ias_kt, leg.altFt) : tasAtAltitude(profile, leg.altFt));
    const gsCruise   = overrideGs ?? Math.max(1, tasCruise + wind);
    const cruiseHrs  = cruiseDist / Math.max(1, gsCruise);
    const cruiseGph  = cruiseGphAt(profile, leg.powerFrac, leg.altFt);
    phases.cruise = {
        timeHrs: cruiseHrs,
        fuelGal: cruiseGph * cruiseHrs,
        distNm:  cruiseDist,
        altFt:   leg.altFt,
    };

    const totalTimeHrs = phases.taxi.timeHrs + phases.climb.timeHrs + phases.cruise.timeHrs + phases.descent.timeHrs;
    const totalFuelGal = phases.taxi.fuelGal + phases.climb.fuelGal + phases.cruise.fuelGal + phases.descent.fuelGal;

    return { phases, totalTimeHrs, totalFuelGal };
}

// ── Phase rates and burns ────────────────────────────────────────────────────
// Shared by decomposeLeg (climb out of / descent into an airport) and
// decomposeTransition (climbs and descents between fixes, #190), so both plan
// a phase with the same numbers.

/** Climb rate (fpm) from fromFt to toFt: fuelPhases.climb.rate_fpm, else the profile's average. */
function climbRateFpm(profile, fromFt, toFt) {
    return profile.fuelPhases?.climb?.rate_fpm
        ?? ((climbRateAtAltitude(profile, fromFt) + climbRateAtAltitude(profile, toFt)) / 2 || 1);
}

/** Climb burn (gph) with the climb's mid altitude. */
function climbGphAt(profile, midFt) {
    return profile.fuelPhases?.climb?.gph
        ?? (gphAtPower(profile, 0.75, midFt, 'FULL_RICH') * 1.10);
}

/** Descent rate (fpm): fuelPhases.descent.rate_fpm, else 500. */
function descentRateFpm(profile) {
    return profile.fuelPhases?.descent?.rate_fpm ?? 500;
}

/**
 * Descent burn (gph) with the descent's mid altitude.
 *
 * Fallback for profiles carrying no measured `fuelPhases.descent.gph`.
 * Floored at the profile's cruise burn, because the bare 55%-power SFC
 * estimate is unsafe on one of its two branches:
 *   - profile WITH `max_hp`:  0.55 * 180 * SFC.FULL_RICH(0.093) = 9.21 gph
 *   - profile WITHOUT it:     fuel_burn_gph * (0.55/0.75)       = 6.16 gph
 *     (6.16 for the RV-9A's 8.4 gph cruise; it was 5.94 when cruise was 8.1)
 * 6.16 is below the RV-9A's measured descent p85 of 6.9 gph, so that
 * branch under-plans descent burn and over-states fuel remaining — the
 * direction that runs tanks dry. Measured descent burn here is 82% of
 * planned cruise (6.9 of 8.4), so "descent costs nothing" is simply
 * wrong for this airframe; absent real data, assume no fuel saving in
 * the descent. Math.max, not a replacement: the 9.21 branch is already
 * conservative and must not be lowered to 8.4 by this change.
 */
function descentGphAt(profile, midFt) {
    const fp = profile.fuelPhases;
    return fp?.descent?.gph ?? Math.max(
        gphAtPower(profile, 0.55, midFt, 'FULL_RICH'),
        fp?.cruise?.gph ?? profile.fuel_burn_gph ?? 0,
    );
}

/** Cruise burn (gph) at altFt and power fraction (default 0.75). */
function cruiseGphAt(profile, powerFrac, altFt) {
    return profile.fuelPhases?.cruise?.gph ?? gphAtPower(profile, powerFrac ?? 0.75, altFt, 'LOP');
}

/**
 * @typedef TransitionPhase
 * @property {number} timeHrs
 * @property {number} fuelGal
 * @property {number} distNm
 * @property {number} altFrom
 * @property {number} altTo
 *
 * @typedef TransitionOpts
 * @property {number}  distNm
 * @property {number}  fromAltFt    altitude the leg starts at (where the previous leg ended)
 * @property {number}  toAltFt      altitude at the leg's to-fix
 * @property {boolean} [wholeLeg]   one climb/descent over the whole leg, no level part
 *                                  (final approach: the glidepath to a runway threshold)
 * @property {number}  cruiseGsKt   ground speed level at toAltFt
 * @property {number}  climbGsKt    ground speed in the climb
 * @property {number}  descentGsKt  ground speed in the descent
 * @property {number}  [powerFrac]  cruise power fraction 0–1 (default 0.75)
 *
 * @typedef TransitionDecomposition
 * @property {{climb:TransitionPhase|null, cruise:TransitionPhase|null, descent:TransitionPhase|null}} phases
 * @property {number} totalTimeHrs
 * @property {number} totalFuelGal
 */

/**
 * A leg between two fixes that changes altitude (#190, the plate profile):
 * the climb or descent at the START of the leg at the profile's rate, then level
 * at toAltFt for the rest of it. When the change does not fit in the leg at that
 * rate, or opts.wholeLeg is set, the whole leg is one climb/descent; it then
 * takes the longer of flying the distance at that phase's ground speed and
 * changing the altitude at the profile's rate (as decomposeLeg times a descent
 * to the field that does not fit: the full descent time). Equal altitudes are
 * the caller's business (decomposeLeg, level).
 * @param {AircraftProfile} profile
 * @param {TransitionOpts} leg
 * @returns {TransitionDecomposition}
 */
export function decomposeTransition(profile, leg) {
    const up     = leg.toAltFt > leg.fromAltFt;
    const change = Math.abs(leg.toAltFt - leg.fromAltFt);
    const midFt  = (leg.toAltFt + leg.fromAltFt) / 2;
    const rate   = up ? climbRateFpm(profile, leg.fromAltFt, leg.toAltFt) : descentRateFpm(profile);
    const gph    = up ? climbGphAt(profile, midFt) : descentGphAt(profile, midFt);
    const gs     = Math.max(1, up ? leg.climbGsKt : leg.descentGsKt);
    const changeHrs  = change / rate / 60;
    const changeDist = gs * changeHrs;

    /** @type {TransitionPhase} */
    let changePhase;
    /** @type {TransitionPhase|null} */
    let cruise = null;
    if (leg.wholeLeg || changeDist >= leg.distNm) {
        const hrs = Math.max(leg.distNm / gs, changeHrs);
        changePhase = { timeHrs: hrs, fuelGal: gph * hrs, distNm: leg.distNm,
                        altFrom: leg.fromAltFt, altTo: leg.toAltFt };
    } else {
        changePhase = { timeHrs: changeHrs, fuelGal: gph * changeHrs, distNm: changeDist,
                        altFrom: leg.fromAltFt, altTo: leg.toAltFt };
        const crzDist = leg.distNm - changeDist;
        const crzHrs  = crzDist / Math.max(1, leg.cruiseGsKt);
        cruise = { timeHrs: crzHrs, fuelGal: cruiseGphAt(profile, leg.powerFrac, leg.toAltFt) * crzHrs,
                   distNm: crzDist, altFrom: leg.toAltFt, altTo: leg.toAltFt };
    }
    const phases = { climb: up ? changePhase : null, cruise, descent: up ? null : changePhase };
    return {
        phases,
        totalTimeHrs: changePhase.timeHrs + (cruise?.timeHrs ?? 0),
        totalFuelGal: changePhase.fuelGal + (cruise?.fuelGal ?? 0),
    };
}
