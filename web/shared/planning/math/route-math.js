// @ts-check
'use strict';

/**
 * Pure great-circle math used throughout the planner. No external deps.
 * Source of truth for distance / bearing / interpolation; existing flytab
 * behaviour pinned by the test suite.
 */

const EARTH_RADIUS_NM = 3440.065;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Great-circle distance in nautical miles.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

/**
 * Initial true bearing from p1 to p2, degrees 0–360.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * RAD, φ2 = lat2 * RAD;
    const Δλ = (lon2 - lon1) * RAD;
    const x = Math.sin(Δλ) * Math.cos(φ2);
    const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(x, y) * DEG + 360) % 360;
}

/**
 * Point along the great-circle path at fraction f∈[0,1].
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} f
 * @returns {{lat: number, lon: number}}
 */
export function intermediatePoint(lat1, lon1, lat2, lon2, f) {
    const φ1 = lat1 * RAD, λ1 = lon1 * RAD;
    const φ2 = lat2 * RAD, λ2 = lon2 * RAD;
    const δ = haversine(lat1, lon1, lat2, lon2) / EARTH_RADIUS_NM;
    if (δ === 0) return { lat: lat1, lon: lon1 };
    const A = Math.sin((1 - f) * δ) / Math.sin(δ);
    const B = Math.sin(f * δ) / Math.sin(δ);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λ = Math.atan2(y, x);
    return { lat: φ * DEG, lon: λ * DEG };
}

/**
 * Perpendicular distance from point P to the great-circle through 1→2, nm.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} latP
 * @param {number} lonP
 * @returns {number}
 */
export function crossTrackDistanceNm(lat1, lon1, lat2, lon2, latP, lonP) {
    const δ13 = haversine(lat1, lon1, latP, lonP) / EARTH_RADIUS_NM;
    const θ13 = bearing(lat1, lon1, latP, lonP) * RAD;
    const θ12 = bearing(lat1, lon1, lat2,  lon2) * RAD;
    return Math.asin(Math.sin(δ13) * Math.sin(θ13 - θ12)) * EARTH_RADIUS_NM;
}

/**
 * Along-track fraction of P projected onto leg 1→2 (0=at start, 1=at end).
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {number} latP
 * @param {number} lonP
 * @returns {number}
 */
export function alongTrackFraction(lat1, lon1, lat2, lon2, latP, lonP) {
    const δ13 = haversine(lat1, lon1, latP, lonP) / EARTH_RADIUS_NM;
    const δxt = Math.abs(crossTrackDistanceNm(lat1, lon1, lat2, lon2, latP, lonP)) / EARTH_RADIUS_NM;
    const δat = Math.acos(Math.cos(δ13) / Math.cos(δxt));
    const δ12 = haversine(lat1, lon1, lat2, lon2) / EARTH_RADIUS_NM;
    return δ12 === 0 ? 0 : δat / δ12;
}

/**
 * Format hours as "H:MM".
 * @param {number} hrs
 * @returns {string}
 */
export function formatTime(hrs) {
    if (!Number.isFinite(hrs) || hrs < 0) return '—';
    const totalMin = Math.round(hrs * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Simplified CONUS magnetic variation (±2° accuracy).
 * @param {number} lat
 * @param {number} lon
 * @returns {number} degrees (positive = west variation)
 */
function _magVarConus(lat, lon) {
    return -6.0 + (lon + 90) * -0.12 + (lat - 35) * 0.05;
}

/**
 * Wind-corrected magnetic heading from a true bearing.
 * @param {number} brgTrue  true bearing to destination, degrees
 * @param {number} lat      midpoint latitude (for mag var)
 * @param {number} lon      midpoint longitude
 * @param {number} tas      true airspeed, kt
 * @param {number} windDir  wind FROM direction, degrees true
 * @param {number} windSpd  wind speed, kt
 * @returns {number} magnetic heading, degrees 0–360
 */
export function windCorrectedMagHdg(brgTrue, lat, lon, tas, windDir, windSpd) {
    const toRad = Math.PI / 180;
    let wcaDeg = 0;
    if (windSpd > 0 && tas > 0) {
        const sinWca = (windSpd * Math.sin((windDir - brgTrue) * toRad)) / tas;
        wcaDeg = Math.asin(Math.max(-1, Math.min(1, sinWca))) / toRad;
    }
    const magVar = _magVarConus(lat, lon);
    return ((brgTrue + wcaDeg - magVar) + 360) % 360;
}

/**
 * Convert indicated airspeed to true airspeed using ISA atmosphere.
 * @param {number} ias   indicated airspeed, kt
 * @param {number} altFt pressure altitude, ft
 * @param {number|null} tempC  OAT in °C; null = ISA standard
 * @returns {number} TAS in kt
 */
export function iasToTas(ias, altFt, tempC) {
    const T0 = 288.15;
    const lapseRate = 0.001981; // K/ft
    const Tstd = T0 - lapseRate * altFt;
    const delta = Math.pow(Tstd / T0, 5.2561);
    const Tactual = (tempC !== null && tempC !== undefined) ? tempC + 273.15 : Tstd;
    const sigma = delta * (T0 / Tactual);
    return ias / Math.sqrt(sigma);
}

/**
 * Ground speed from TAS, course, and wind.
 * @param {number} tas       true airspeed, kt
 * @param {number} course    true course, degrees
 * @param {number} windDir   wind FROM direction, degrees true
 * @param {number} windSpd   wind speed, kt
 * @returns {number} ground speed, kt
 */
export function groundSpeed(tas, course, windDir, windSpd) {
    if (!windSpd) return tas;
    const toRad = Math.PI / 180;
    const wca = (windDir - course) * toRad;
    const headwind = windSpd * Math.cos(wca);
    const crosswind = windSpd * Math.sin(wca);
    const crossSq = crosswind * crosswind;
    const tasSq = tas * tas;
    if (crossSq >= tasSq) return tas * 0.5;
    return Math.max(Math.sqrt(tasSq - crossSq) - headwind, tas * 0.3);
}

/**
 * VFR hemispheric altitude for a given magnetic course and route.
 * @param {number} magCourse  overall magnetic course, degrees
 * @param {{lat:number,lon:number}} depCoord
 * @param {{lat:number,lon:number}} destCoord
 * @returns {number} altitude in feet
 */
export function vfrAltitude(magCourse, depCoord, destCoord) {
    const eastbound = magCourse >= 0 && magCourse < 180;
    const dist = haversine(depCoord.lat, depCoord.lon, destCoord.lat, destCoord.lon);
    let targetAlt;
    if (dist < 50)       targetAlt = 4000;
    else if (dist < 150) targetAlt = 6000;
    else if (dist < 300) targetAlt = 8000;
    else                 targetAlt = 10000;
    if (eastbound) {
        const thousands = Math.round(targetAlt / 2000) * 2 - 1;
        return Math.max(3500, Math.min(thousands * 1000 + 500, 17500));
    } else {
        const thousands = Math.round(targetAlt / 2000) * 2;
        return Math.max(4500, Math.min(thousands * 1000 + 500, 16500));
    }
}
