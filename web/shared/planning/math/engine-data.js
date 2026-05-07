// @ts-check
'use strict';

/**
 * @typedef {import('../types/aircraft-profile.js').AircraftProfile} AircraftProfile
 */

const DEFAULT_BEST_ALT_FT = 8000;

// SFC defaults (gal/HP/hr) — ported from flywhere engine-data.ts
const SFC = { LOP: 0.067, ROP: 0.083, FULL_RICH: 0.093 };

/**
 * Maximum available power as a percentage at a given altitude.
 * @param {AircraftProfile} profile
 * @param {number} altFt
 * @returns {number} 0–100
 */
export function maxPowerAtAltitude(profile, altFt) {
    const lossPerKft = profile.alt_power_loss_pct_per_kft ?? 3.0;
    return Math.max(0, 100 - (altFt / 1000) * lossPerKft);
}

/**
 * Fuel burn in GPH at a given power fraction.
 * When profile has max_hp, uses SFC-based model (altitude and mixture aware).
 * Otherwise falls back to linear scaling from fuel_burn_gph (assumed at 75% ROP).
 * @param {AircraftProfile} profile
 * @param {number} powerFrac   0–1 requested power fraction
 * @param {number} [altFt]     altitude for power cap (ignored if no max_hp)
 * @param {string} [mixture]   'LOP' | 'ROP' | 'FULL_RICH' (default 'ROP')
 * @returns {number} GPH
 */
export function gphAtPower(profile, powerFrac, altFt, mixture) {
    if (profile.max_hp) {
        const maxPct = (altFt !== undefined) ? maxPowerAtAltitude(profile, altFt) / 100 : 1.0;
        const effectiveFrac = Math.min(powerFrac, maxPct);
        const mix = mixture || 'ROP';
        const sfcKey = 'sfc_' + mix.toLowerCase();
        const sfc = profile[sfcKey] ?? SFC[mix] ?? SFC.ROP;
        return effectiveFrac * profile.max_hp * sfc;
    }
    return profile.fuel_burn_gph * (powerFrac / 0.75);
}

/**
 * TAS at a given altitude, knots.
 * @param {AircraftProfile} profile
 * @param {number} altFt
 * @returns {number}
 */
export function tasAtAltitude(profile, altFt) {
    const best = profile.best_alt_ft ?? DEFAULT_BEST_ALT_FT;
    const tasBest = profile.cruise_ktas;
    if (altFt <= best) {
        const f = altFt / best;
        return tasBest * (0.85 + 0.15 * f);
    }
    return tasBest - (altFt - best) / 1000;
}

/**
 * Climb rate fpm at altitude. Linear from sea-level rate to 0 at service ceiling.
 * @param {AircraftProfile} profile
 * @param {number} altFt
 * @returns {number}
 */
export function climbRateAtAltitude(profile, altFt) {
    const sl = profile.climb_rate_fpm ?? 700;
    const ceil = profile.service_ceiling_ft ?? 14000;
    if (altFt >= ceil) return 0;
    return Math.max(0, sl * (1 - altFt / ceil));
}
