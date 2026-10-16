// @ts-check
'use strict';

const CACHE_KEY  = 'flypi_winds_cache';

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

const FD_PERIODS = ['06', '12', '24'];
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

function cacheKey(cycle) { return `${CACHE_KEY}_${cycle}`; }

function readCachedPeriods() {
    const out = [];
    for (const cycle of FD_PERIODS) {
        try {
            const c = JSON.parse(localStorage.getItem(cacheKey(cycle)) || 'null');
            // Entries from before the FOR USE selection have no header: unusable.
            if (!c?.winds || !c.header) continue;
            const h = { validAt: new Date(c.header.validAt), useFrom: new Date(c.header.useFrom), useTo: new Date(c.header.useTo) };
            if ([h.validAt, h.useFrom, h.useTo].some((d) => !Number.isFinite(d.getTime()))) continue;
            out.push({ cycle, header: h, winds: c.winds });
        } catch (_) {}
    }
    return out;
}

async function fetchPeriod(base, cycle) {
    try {
        const url = `${base}/weather?type=windtemp&region=all&level=low&fcst=${cycle}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return null;
        const text = await resp.text();
        if (typeof WeatherClient === 'undefined' || !WeatherClient.parseAllWindsAloft) return null;
        const winds = WeatherClient.parseAllWindsAloft(text);
        const header = parseFdHeader(text);
        if (!header || Object.keys(winds).length === 0) return null;
        try {
            localStorage.setItem(cacheKey(cycle), JSON.stringify({
                ts: Date.now(), winds,
                header: { validAt: header.validAt.toISOString(), useFrom: header.useFrom.toISOString(), useTo: header.useTo.toISOString() },
            }));
        } catch (_) {}
        return { cycle, header, winds };
    } catch (_) {
        return null;
    }
}

function fisbWinds() {
    try {
        const fisb = (typeof window !== 'undefined') ? window.app?.fisbClient?.winds : null;
        if (!fisb || fisb.size === 0) return null;
        // fisb-client.winds is Map{ "STATION:altFt" -> {dir,spd,temp} }
        const canonical = {};
        for (const [key, wind] of fisb) {
            if (wind.dir == null || wind.spd == null) continue;
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
 * Winds aloft for a departure time, and which forecast they are (2026-10-16).
 * The FD period is chosen by its FOR USE window, not by the hour of day
 * (selectFdCycle gave the 12-hour forecast for a departure "now" at 20Z).
 *   1. flywhere proxy: all three periods (06/12/24 h); direct AWC is CORS-blocked
 *   2. Stratux FIS-B, for a departure within FISB_MAX_AHEAD_MS (it is the current forecast)
 *   3. the cached period (localStorage) whose window holds the departure
 * @param {Date} [departureTime]
 * @returns {Promise<{winds: object|null, source: 'fd'|'fisb'|'cache'|null, cycle?: string,
 *   validAt?: Date, useFrom?: Date, useTo?: Date, reason?: 'beyond'|'unavailable', coverTo?: Date}>}
 */
export async function fetchWindsDetailed(departureTime) {
    const dep = departureTime instanceof Date ? departureTime : new Date();
    const base = (typeof Settings !== 'undefined' && Settings.workerBase)
        ? Settings.workerBase
        : 'https://www.flywhere.app/api';
    const fetched = (await Promise.all(FD_PERIODS.map((c) => fetchPeriod(base, c)))).filter(Boolean);
    const found = (p, source) => ({ winds: p.winds, source, cycle: p.cycle, ...p.header });
    const coverTo = (ps) => ps.reduce((m, p) => (!m || p.header.useTo > m ? p.header.useTo : m), null);

    if (fetched.length) {
        const p = pickFdPeriod(fetched, dep);
        if (p) return found(p, 'fd');
        return { winds: null, source: null, reason: 'beyond', coverTo: coverTo(fetched) };
    }
    if (dep.getTime() - Date.now() <= FISB_MAX_AHEAD_MS) {
        const w = fisbWinds();
        if (w) return { winds: w, source: 'fisb' };
    }
    const cached = readCachedPeriods();
    const p = pickFdPeriod(cached, dep);
    if (p) return found(p, 'cache');
    return { winds: null, source: null, reason: cached.length ? 'beyond' : 'unavailable', coverTo: coverTo(cached) || undefined };
}

/**
 * Winds aloft for a departure time (the winds only; see fetchWindsDetailed).
 * @param {Date} departureTime
 * @returns {Promise<Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>|null>}
 */
export async function fetchWinds(departureTime) {
    return (await fetchWindsDetailed(departureTime)).winds;
}
