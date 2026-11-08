// @ts-check
'use strict';

import { fetchModelWinds } from './model-winds.js';

/**
 * Select the AWC FD forecast cycle based on departure UTC hour.
 * Not used for winds any more: it ignores the date and the issue time (at 20Z
 * it gave the 12-hour forecast for a departure now). See pickFdPeriod.
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

// FIS-B winds are the current forecast: only for a departure this soon.
const FISB_MAX_AHEAD_MS = 3 * 3600_000;
// A departure up to this long before the first FOR USE window (between issues) uses that period.
const BEFORE_FIRST_MS = 60 * 60_000;

/** The UTC date with day-of-month `dd` nearest `ref` (this, last or next month). */
function dayNear(dd, hh, mm, ref) {
    let best = null;
    for (const dm of [-1, 0, 1]) {
        const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + dm, dd, hh, mm));
        if (d.getUTCDate() !== dd) continue;               // no such day in that month
        if (!best || Math.abs(d - ref) < Math.abs(best - ref)) best = d;
    }
    return best;
}

/**
 * The validity of an FD (winds aloft) product, from its header:
 * "VALID 170000Z   FOR USE 2000-0300Z" -> { validAt, useFrom, useTo } (Dates, UTC).
 * The FOR USE window brackets the valid time. `ref` (default now) places the
 * day of month in a month.
 * @param {string} text
 * @param {Date} [ref]
 * @returns {{validAt: Date, useFrom: Date, useTo: Date}|null}
 */
export function parseFdHeader(text, ref = new Date()) {
    const m = /VALID\s+(\d{2})(\d{2})(\d{2})Z\s+FOR USE\s+(\d{2})(\d{2})-(\d{2})(\d{2})Z/.exec(String(text || ''));
    if (!m) return null;
    const [dd, hh, mi, fh, fm, th, tm] = m.slice(1).map(Number);
    const validAt = dayNear(dd, hh, mi, ref);
    if (!validAt) return null;
    const at = (h, mn, days) => new Date(Date.UTC(validAt.getUTCFullYear(), validAt.getUTCMonth(), validAt.getUTCDate() + days, h, mn));
    let useFrom = at(fh, fm, 0);
    if (useFrom > validAt) useFrom = at(fh, fm, -1);
    let useTo = at(th, tm, 0);
    if (useTo < validAt) useTo = at(th, tm, 1);
    return { validAt, useFrom, useTo };
}

/**
 * The period whose FOR USE window holds the departure, or null (past the last
 * window, or long before the first).
 * @template {{header: {validAt: Date, useFrom: Date, useTo: Date}}} P
 * @param {P[]} periods
 * @param {Date} departure
 * @returns {P|null}
 */
export function pickFdPeriod(periods, departure) {
    const t = departure.getTime();
    const ok = periods.filter((p) => p?.header).sort((a, b) => a.header.useFrom - b.header.useFrom);
    const hit = ok.find((p) => t >= p.header.useFrom.getTime() && t < p.header.useTo.getTime());
    if (hit) return hit;
    const first = ok[0];
    if (first && t < first.header.useFrom.getTime() && first.header.useFrom.getTime() - t <= BEFORE_FIRST_MS) return first;
    return null;
}

// FIS-B winds beat stored model winds only while they are still arriving (review of #212: the Map keeps
// reports up to 6 h, and CONUS FIS-B winds may have stopped with the FD bulletins on 2026-11-03).
const FISB_FRESH_MS = 60 * 60_000;

function fisbWinds(maxAgeMs = Infinity) {
    try {
        const fisb = (typeof window !== 'undefined') ? window.app?.fisbClient?.winds : null;
        if (!fisb || fisb.size === 0) return null;
        // fisb-client.winds is Map{ "STATION:altFt" -> {dir,spd,temp} }
        const canonical = {};
        for (const [key, wind] of fisb) {
            if (wind.dir == null || wind.spd == null) continue;
            if (maxAgeMs !== Infinity && !(Number.isFinite(wind.received_at) && Date.now() - wind.received_at <= maxAgeMs)) continue;
            const sep = key.lastIndexOf(':');
            if (sep < 0) continue;
            const station = key.slice(0, sep);
            const alt = parseInt(key.slice(sep + 1), 10);
            if (!canonical[station]) canonical[station] = {};
            canonical[station][alt] = { dir: wind.dir, spd: wind.spd, temp: wind.temp != null ? wind.temp : undefined };
        }
        return Object.keys(canonical).length ? canonical : null;
    } catch (_) {
        return null;
    }
}

/**
 * Winds aloft for a departure time, and which forecast they are.
 * NOAA stopped the FB/FD winds bulletins on 2026-11-03 (SCN 26-47 AAD) and
 * AWC's windtemp API answers 400, so the FD fetch is gone (2026-11-08):
 *   1. model winds (RRFS, GFS past RRFS's range) from Open-Meteo at the FD
 *      stations: a fetch younger than an hour, or a new one (model-winds.js)
 *   2. Stratux FIS-B received within FISB_FRESH_MS, for a departure within FISB_MAX_AHEAD_MS
 *   3. older stored model winds that have the departure hour (in the air, offline)
 *   4. any FIS-B winds still held, for a departure within FISB_MAX_AHEAD_MS
 * @param {Date} [departureTime]
 * @returns {Promise<{winds: object|null, source: 'model'|'fisb'|null, model?: string,
 *   validAt?: Date, useFrom?: Date, useTo?: Date, fetchedAt?: Date, stale?: boolean,
 *   reason?: 'beyond'|'unavailable', coverTo?: Date}>}
 */
export async function fetchWindsDetailed(departureTime) {
    const dep = departureTime instanceof Date ? departureTime : new Date();
    const now = Date.now();
    // A departure already past (a delay): the current forecast is the best there is.
    const at = Math.max(dep.getTime(), now);
    const stations = (typeof WeatherClient !== 'undefined' && WeatherClient.FD_STATIONS) || null;
    const m = stations ? await fetchModelWinds(stations, at) : { winds: null, coverTo: null };

    // 1. Model winds fetched within the hour.
    if (m.winds && !m.stale) return m;
    const soon = at - now <= FISB_MAX_AHEAD_MS;
    // 2. Stratux FIS-B still arriving (received within FISB_FRESH_MS), for a departure soon.
    if (soon) {
        const w = fisbWinds(FISB_FRESH_MS);
        if (w) return { winds: w, source: 'fisb' };
    }
    // 3. Older model winds for that hour.
    if (m.winds) return m;
    // 4. Any FIS-B winds still held (fisb-client drops them after 6 h), for a departure soon.
    if (soon) {
        const w = fisbWinds();
        if (w) return { winds: w, source: 'fisb' };
    }

    // None: "beyond" only when the departure is past a forecast that is still current.
    const coverTo = m.coverTo || null;
    const beyond = coverTo && coverTo.getTime() > now && at >= coverTo.getTime();
    return beyond
        ? { winds: null, source: null, reason: 'beyond', coverTo }
        : { winds: null, source: null, reason: 'unavailable' };
}

/**
 * Winds aloft for a departure time (the winds only; see fetchWindsDetailed).
 * @param {Date} departureTime
 * @returns {Promise<Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>|null>}
 */
export async function fetchWinds(departureTime) {
    return (await fetchWindsDetailed(departureTime)).winds;
}
