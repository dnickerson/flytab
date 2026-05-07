// @ts-check
'use strict';

const CACHE_KEY  = 'flypi_winds_cache';
const CACHE_MINS = 60; // re-fetch after 1 hour

/**
 * Select the AWC FD forecast cycle based on departure UTC hour.
 * @param {number} utcHour  0–23
 * @returns {'06'|'12'|'24'}
 */
export function selectFdCycle(utcHour) {
    if (utcHour < 9)  return '06';
    if (utcHour < 21) return '12';
    return '24';
}

/**
 * Get wind entry for the altitude closest to altFt.
 * @param {Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>} stationWinds
 * @param {number} altFt
 * @returns {{dir:number,spd:number,temp?:number,variable?:boolean}|null}
 */
export function getWindAtAlt(stationWinds, altFt) {
    const keys = Object.keys(stationWinds).map(Number);
    if (!keys.length) return null;
    let best = keys[0];
    for (const k of keys) {
        if (Math.abs(k - altFt) < Math.abs(best - altFt)) best = k;
    }
    return stationWinds[best] ?? null;
}

/**
 * Find the nearest FD reporting station to a lat/lon.
 * @param {Record<string,any>} allWinds
 * @param {number} lat
 * @param {number} lon
 * @param {Record<string,[number,number]>} [fdLocs]  override for testing; defaults to WeatherClient.FD_STATIONS
 * @returns {string|null} station ID
 */
export function findNearestFdStation(allWinds, lat, lon, fdLocs) {
    // In browser context, delegate to WeatherClient which has the full FD_STATIONS lookup
    if (typeof WeatherClient !== 'undefined' && WeatherClient.findNearestFdStation) {
        return WeatherClient.findNearestFdStation(allWinds, lat, lon);
    }
    // Test / non-browser fallback using provided fdLocs
    if (!fdLocs) return null;
    let best = null;
    let bestDist = Infinity;
    for (const id of Object.keys(allWinds)) {
        const coords = fdLocs[id];
        if (!coords) continue;
        const dLat = coords[0] - lat;
        const dLon = (coords[1] - lon) * Math.cos(lat * Math.PI / 180);
        const dist = dLat * dLat + dLon * dLon;
        if (dist < bestDist) { bestDist = dist; best = id; }
    }
    return best;
}

/**
 * Fetch winds aloft, trying flywhere proxy → localStorage cache → null.
 * Direct AWC fetch is CORS-blocked from Capacitor's http://localhost origin;
 * route through the flywhere proxy which mirrors the AWC windtemp endpoint.
 * FIS-B fallback: format investigation required at implementation time (see spec).
 * @param {Date} departureTime  used to select FD cycle
 * @returns {Promise<Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>|null>}
 */
export async function fetchWinds(departureTime) {
    const cycle = selectFdCycle((departureTime ?? new Date()).getUTCHours());
    const cacheKey = `${CACHE_KEY}_${cycle}`;

    // 1. Try flywhere proxy (direct AWC is CORS-blocked from Capacitor http://localhost)
    try {
        const base = (typeof Settings !== 'undefined' && Settings.workerBase)
            ? Settings.workerBase
            : 'https://www.flywhere.app/api';
        const url = `${base}/weather?type=windtemp&region=all&level=low&fcst=${cycle}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (resp.ok) {
            const text = await resp.text();
            if (typeof WeatherClient !== 'undefined' && WeatherClient.parseAllWindsAloft) {
                const winds = WeatherClient.parseAllWindsAloft(text);
                if (Object.keys(winds).length > 0) {
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), winds }));
                    } catch (_) {}
                    return winds;
                }
            }
        }
    } catch (_) {}

    // 2. FIS-B winds from Stratux — format investigation required before implementing
    //    When fisb-client.js exposes winds in canonical shape, wire here.

    // 3. Try localStorage cache
    try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        if (cached && Date.now() - cached.ts < CACHE_MINS * 60_000) {
            return cached.winds;
        }
    } catch (_) {}

    return null;
}
