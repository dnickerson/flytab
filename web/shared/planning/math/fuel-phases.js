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
        const climbRate = fp?.climb?.rate_fpm
            ?? ((climbRateAtAltitude(profile, 0) + climbRateAtAltitude(profile, leg.altFt)) / 2 || 1);
        const climbHrs = leg.altFt / climbRate / 60;
        const tasClimb = fp?.climb?.ias_kt
            ? iasToTas(fp.climb.ias_kt, leg.altFt / 2)
            : (overrideTas ? overrideTas * 0.9625 : tasAtAltitude(profile, leg.altFt / 2));
        const climbGph = fp?.climb?.gph
            ?? (gphAtPower(profile, 0.75, leg.altFt / 2, 'FULL_RICH') * 1.10);
        const climbDist = (tasClimb + wind) * climbHrs;
        phases.climb = {
            timeHrs: climbHrs,
            fuelGal: climbGph * climbHrs,
            distNm:  Math.min(climbDist, leg.distNm * 0.6),
            altFt:   leg.altFt,
        };
    }

    if (leg.endingAtGround) {
        // Descent — use fuelPhases.descent IAS, rate, and gph when available
        const descRate = fp?.descent?.rate_fpm ?? 500;
        const descHrs  = leg.altFt / descRate / 60;
        const tasDesc  = fp?.descent?.ias_kt
            ? iasToTas(fp.descent.ias_kt, leg.altFt / 2)
            : (overrideTas ? overrideTas * 0.9625 : tasAtAltitude(profile, leg.altFt / 2));
        // Fallback for profiles carrying no measured `fuelPhases.descent.gph`.
        // Floored at the profile's cruise burn, because the bare 55%-power SFC
        // estimate is unsafe on one of its two branches:
        //   - profile WITH `max_hp`:  0.55 * 180 * SFC.FULL_RICH(0.093) = 9.21 gph
        //   - profile WITHOUT it:     fuel_burn_gph * (0.55/0.75)       = 6.16 gph
        //     (6.16 for the RV-9A's 8.4 gph cruise; it was 5.94 when cruise was 8.1)
        // 6.16 is below the RV-9A's measured descent p85 of 6.9 gph, so that
        // branch under-plans descent burn and over-states fuel remaining — the
        // direction that runs tanks dry. Measured descent burn here is 82% of
        // planned cruise (6.9 of 8.4), so "descent costs nothing" is simply
        // wrong for this airframe; absent real data, assume no fuel saving in
        // the descent. Math.max, not a replacement: the 9.21 branch is already
        // conservative and must not be lowered to 8.4 by this change.
        const descGph  = fp?.descent?.gph ?? Math.max(
            gphAtPower(profile, 0.55, leg.altFt / 2, 'FULL_RICH'),
            fp?.cruise?.gph ?? profile.fuel_burn_gph ?? 0,
        );
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
    const cruiseGph  = fp?.cruise?.gph ?? gphAtPower(profile, leg.powerFrac ?? 0.75, leg.altFt, 'LOP');
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
