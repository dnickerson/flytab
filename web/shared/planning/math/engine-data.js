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
 * Look up GPH for a given %power from a banded power-settings table.
 *
 * The bands come from `aircraft-config.json`'s `performance.power_settings[]`,
 * which is derived from real EDM flight logs — the `gph` figures are MEASURED
 * fuel flow and are the ground truth. The `pct_mid` label they are indexed by
 * is MP/RPM-derived (`(RPM/2700) * (MAP/29.92) * 100`, the Lycoming 50°F-ROP
 * chart convention), NOT the lean-of-peak `HP = GPH * 14.9` definition the
 * engine monitor uses when the mixture is LEAN. Treat `pct_mid` as a lookup
 * key, not as a physically-comparable power number.
 *
 * Tie-break note: when `pct` is exactly equidistant between two bands the
 * FIRST band in array order wins (strict `<`). Callers must not assume that
 * is the higher-GPH / conservative side.
 *
 * @param {Array<{pct_mid:number, gph:number}>} powerSettings
 * @param {number} pct
 * @returns {number|null} measured GPH for the closest band, or null if the table is empty
 */
export function gphForPowerPct(powerSettings, pct) {
    if (!powerSettings || powerSettings.length === 0) return null;
    let best = powerSettings[0];
    let bestDist = Math.abs(pct - best.pct_mid);
    for (const band of powerSettings) {
        const dist = Math.abs(pct - band.pct_mid);
        if (dist < bestDist) {
            best = band;
            bestDist = dist;
        }
    }
    return best.gph;
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
 * Convert IAS to TAS using standard atmosphere model (ISA, no temp deviation).
 * Matches flywhere route-math.ts iasToTas.
 * @param {number} ias knots
 * @param {number} altFt pressure altitude
 * @returns {number} TAS in knots
 */
export function iasToTas(ias, altFt) {
    const T0 = 288.15;
    const lapseRate = 0.001981;  // K/ft standard lapse
    const Tstd = T0 - lapseRate * altFt;
    const delta = Math.pow(Tstd / T0, 5.2561);
    return ias / Math.sqrt(delta);
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
