// @ts-check
'use strict';

/**
 * Engine performance lookups derived from an AircraftProfile. Used by
 * fuel-phases.js to decompose a leg into climb/cruise/descent burn.
 *
 * Altitude effect on TAS for a normally-aspirated piston engine is empirical;
 * we use a two-segment model: linear gain to the profile's "best altitude"
 * (default 8000 ft), then linear falloff above that.
 *
 * @typedef {import('../types/aircraft-profile.js').AircraftProfile} AircraftProfile
 */

const DEFAULT_BEST_ALT_FT = 8000;

/** TAS at a given altitude, knots. */
export function tasAtAltitude(profile, altFt) {
    const best = profile.best_alt_ft ?? DEFAULT_BEST_ALT_FT;
    const tasBest = profile.cruise_ktas;
    if (altFt <= best) {
        // Linear from 0.85 × cruise at sea level to cruise at best alt
        const f = altFt / best;
        return tasBest * (0.85 + 0.15 * f);
    }
    // Above best alt, fall off at ~1 kt per 1000 ft
    return tasBest - (altFt - best) / 1000;
}

/** GPH at a given fractional power 0–1. */
export function gphAtPower(profile, powerFrac) {
    const baseGph = profile.fuel_burn_gph; // assume base is at 75% power
    return baseGph * (powerFrac / 0.75);
}

/** Climb rate fpm at altitude. Linear from sea-level rate to 0 at service ceiling. */
export function climbRateAtAltitude(profile, altFt) {
    const sl = profile.climb_rate_fpm ?? 700;
    const ceil = profile.service_ceiling_ft ?? 14000;
    if (altFt >= ceil) return 0;
    return Math.max(0, sl * (1 - altFt / ceil));
}
