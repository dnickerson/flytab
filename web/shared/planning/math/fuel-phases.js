// @ts-check
'use strict';

import { tasAtAltitude, gphAtPower, climbRateAtAltitude } from './engine-data.js';

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
        phases.taxi = {
            timeHrs: 0,
            fuelGal: profile.taxi_burn_gal ?? 1.5,
            distNm: 0,
            altFt: 0,
        };

        // Climb: time = altFt / climbRate(0..altFt avg) ; distance covered = TAS_climb × time
        const climbRate = (climbRateAtAltitude(profile, 0) + climbRateAtAltitude(profile, leg.altFt)) / 2 || 1;
        const climbHrs  = leg.altFt / climbRate / 60;       // fpm → hrs
        const tasClimb  = overrideTas ? overrideTas * (1 - 0.075 * 0.5) : tasAtAltitude(profile, leg.altFt / 2);
        const climbDist = (tasClimb + wind) * climbHrs;
        phases.climb = {
            timeHrs: climbHrs,
            fuelGal: gphAtPower(profile, 0.75, leg.altFt / 2, 'FULL_RICH') * climbHrs * 1.10,  // 10% richer in climb
            distNm:  Math.min(climbDist, leg.distNm * 0.4),
            altFt:   leg.altFt,
        };
    }

    if (leg.endingAtGround) {
        const descRate  = 500;  // standard 500 fpm descent
        const descHrs   = leg.altFt / descRate / 60;
        const tasDesc   = overrideTas ? overrideTas * (1 - 0.075 * 0.5) : tasAtAltitude(profile, leg.altFt / 2);
        const descDist  = (tasDesc + wind) * descHrs;
        phases.descent = {
            timeHrs: descHrs,
            fuelGal: gphAtPower(profile, 0.55, leg.altFt / 2, 'FULL_RICH') * descHrs,
            distNm:  Math.min(descDist, leg.distNm * 0.3),
            altFt:   leg.altFt,
        };
    }

    const cruiseDist = Math.max(0, leg.distNm - phases.climb.distNm - phases.descent.distNm);
    const tasCruise  = overrideTas ?? tasAtAltitude(profile, leg.altFt);
    const gsCruise   = overrideGs  ?? Math.max(1, tasCruise + wind);
    const cruiseHrs  = cruiseDist / Math.max(1, gsCruise);
    phases.cruise = {
        timeHrs: cruiseHrs,
        fuelGal: gphAtPower(profile, 0.75, leg.altFt, 'LOP') * cruiseHrs,
        distNm:  cruiseDist,
        altFt:   leg.altFt,
    };

    const totalTimeHrs = phases.taxi.timeHrs + phases.climb.timeHrs + phases.cruise.timeHrs + phases.descent.timeHrs;
    const totalFuelGal = phases.taxi.fuelGal + phases.climb.fuelGal + phases.cruise.fuelGal + phases.descent.fuelGal;

    return { phases, totalTimeHrs, totalFuelGal };
}
