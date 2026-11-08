// @ts-check
'use strict';

/**
 * Winds aloft from model forecasts (Open-Meteo), in the FD station shape the
 * planner already uses: { STATION: { altFt: { dir, spd, temp } } }.
 *
 * Why (2026-11-08): NOAA stopped the FB/FD winds-aloft bulletins on 2026-11-03
 * with the NAM retirement (SCN 26-47 AAD); AWC's windtemp API now answers 400.
 * The forecast here is NOAA's RRFS (ncep_rrfs_conus, 3 km, ~3.5 days), and GFS
 * (gfs_seamless) past RRFS's range. It is fetched at the FD station locations,
 * so findNearestFdStation / getWindAtAlt work unchanged, and converted to
 * 3,000-14,000 ft MSL every 1,000 ft by interpolating u/v against each pressure
 * level's geopotential height. Like FB: nothing within 1,500 ft of the ground.
 *
 * Open-Meteo sends Access-Control-Allow-Origin: * (no proxy). Free for
 * non-commercial use, CC-BY 4.0. One fetch of 92 stations x 36 variables costs
 * ~331 of its 600/min (10,000/day), so a fetch is reused for REUSE_MS.
 * Fetched on the ground only; in the air the cached hours are used.
 */

export const OM_URL = 'https://api.open-meteo.com/v1/forecast';
export const LEVELS_HPA = [950, 925, 900, 850, 800, 750, 700, 650, 600];
export const ALTS_FT = [3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000];
/** Models tried in order; RRFS covers CONUS only (San Juan is outside its grid). */
export const MODELS = [
    { id: 'ncep_rrfs_conus', label: 'RRFS', exclude: ['SJU'] },
    { id: 'gfs_seamless', label: 'GFS', exclude: [] },
];
const CACHE_KEY = 'flytab_model_winds';
const FT_PER_M = 3.28084;
const AGL_MIN_FT = 1500;                 // FB convention: no forecast within 1,500 ft of the station
const WINDOW_BEFORE_H = 1;               // a fetch covers the departure hour -1 h ...
const WINDOW_AFTER_H = 12;               // ... to +12 h (the flight, flown offline)
export const REUSE_MS = 60 * 60_000;     // a fetch younger than this is used without fetching again
const TIMEOUT_MS = 15_000;

/** Open-Meteo's "2026-11-08T12:00" (no zone; asked for GMT) -> ms UTC. */
export function omTimeMs(s) {
    return Date.parse(`${s}:00Z`);
}

/** "2026-11-08T12:00" for a ms UTC time, floored to the hour (Open-Meteo start_hour/end_hour). */
function omHour(ms) {
    return new Date(Math.floor(ms / 3600_000) * 3600_000).toISOString().slice(0, 16);
}

/**
 * The request for `stations` ({ id: [lat, lon] }) and one model, over the
 * hours around `atMs`.
 */
export function buildUrl(stations, model, atMs) {
    const ids = Object.keys(stations).filter((id) => !model.exclude.includes(id));
    const vars = LEVELS_HPA.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`, `geopotential_height_${p}hPa`]);
    const q = new URLSearchParams({
        latitude: ids.map((id) => stations[id][0]).join(','),
        longitude: ids.map((id) => stations[id][1]).join(','),
        hourly: vars.join(','),
        models: model.id,
        wind_speed_unit: 'kn',
        timezone: 'GMT',
        start_hour: omHour(atMs - WINDOW_BEFORE_H * 3600_000),
        end_hour: omHour(atMs + WINDOW_AFTER_H * 3600_000),
    });
    return { url: `${OM_URL}?${q}`, ids };
}

/**
 * One station's profile at one hour -> { altFt: { dir, spd, temp } } on ALTS_FT.
 * levels: [{ hgtM, dir, spd, temp }] (any order). Levels below the ground are
 * dropped (Open-Meteo extrapolates them); an altitude outside the levels, or
 * within AGL_MIN_FT of the ground, is left out. u/v are interpolated, not
 * direction and speed (270/10 and 090/10 average to calm, not to 180/10).
 */
export function profileToAlts(levels, elevM) {
    const groundFt = Number.isFinite(elevM) ? elevM * FT_PER_M : 0;
    const pts = levels
        .filter((l) => [l.hgtM, l.dir, l.spd].every(Number.isFinite) && l.hgtM * FT_PER_M >= groundFt)
        .map((l) => {
            const r = l.dir * Math.PI / 180;
            return { ft: l.hgtM * FT_PER_M, u: -l.spd * Math.sin(r), v: -l.spd * Math.cos(r), temp: l.temp };
        })
        .sort((a, b) => a.ft - b.ft);
    const out = {};
    if (pts.length < 2) return out;
    for (const alt of ALTS_FT) {
        if (alt < groundFt + AGL_MIN_FT) continue;
        const i = pts.findIndex((p) => p.ft >= alt);
        if (i <= 0) continue;                               // below the lowest level above ground, or above the top
        const a = pts[i - 1], b = pts[i];
        const f = (alt - a.ft) / (b.ft - a.ft);
        const u = a.u + f * (b.u - a.u), v = a.v + f * (b.v - a.v);
        const spd = Math.hypot(u, v);
        const dir = spd < 0.05 ? 0 : (Math.round(Math.atan2(-u, -v) * 180 / Math.PI) + 360) % 360;
        const t = Number.isFinite(a.temp) && Number.isFinite(b.temp) ? Math.round(a.temp + f * (b.temp - a.temp)) : undefined;
        out[alt] = { dir: dir === 0 && spd >= 0.05 ? 360 : dir, spd: Math.round(spd), temp: t };
    }
    return out;
}

/**
 * Open-Meteo's answer (an array, or a bare object for one location) for `ids`
 * -> { hours: [ms], data: [[ [[dir, spd, temp] | null per ALTS_FT step] per station ] per hour] }.
 * An hour whose values are all null (past the model's range) is null.
 */
export function parseResponse(json, ids) {
    const locs = Array.isArray(json) ? json : [json];
    if (locs.length !== ids.length || !locs[0]?.hourly?.time) return null;
    const times = locs[0].hourly.time;
    const hours = times.map(omTimeMs);
    const data = times.map((_, h) => {
        const row = locs.map((loc) => {
            const H = loc.hourly;
            const levels = LEVELS_HPA.map((p) => ({
                hgtM: H[`geopotential_height_${p}hPa`]?.[h], dir: H[`wind_direction_${p}hPa`]?.[h],
                spd: H[`wind_speed_${p}hPa`]?.[h], temp: H[`temperature_${p}hPa`]?.[h],
            }));
            if (!levels.some((l) => Number.isFinite(l.spd))) return null;
            // Stored compact (one [dir, spd, temp] or null per ALTS_FT step): a whole
            // fetch is kept in localStorage for the flight (~1/3 the size of objects).
            const o = profileToAlts(levels, loc.elevation);
            return ALTS_FT.map((a) => (o[a] ? [o[a].dir, o[a].spd, o[a].temp ?? null] : null));
        });
        return row.some(Boolean) ? row : null;
    });
    return { hours, data };
}

/** The station winds for the hour nearest `atMs` (within the fetch), or null. */
export function windsAt(fetched, atMs) {
    if (!fetched?.hours?.length) return null;
    let best = -1;
    for (let i = 0; i < fetched.hours.length; i++) {
        if (!fetched.data[i]) continue;
        if (best < 0 || Math.abs(fetched.hours[i] - atMs) < Math.abs(fetched.hours[best] - atMs)) best = i;
    }
    if (best < 0 || Math.abs(fetched.hours[best] - atMs) > 30 * 60_000) return null;
    const winds = {};
    fetched.ids.forEach((id, s) => {
        const row = fetched.data[best][s];
        if (!row) return;
        const w = {};
        row.forEach((v, i) => { if (v) w[ALTS_FT[i]] = { dir: v[0], spd: v[1], temp: v[2] ?? undefined }; });
        if (Object.keys(w).length) winds[id] = w;
    });
    if (!Object.keys(winds).length) return null;
    const validAt = new Date(fetched.hours[best]);
    return {
        winds, source: 'model', model: fetched.model, validAt,
        // One hour's winds: the planner asks again after useTo and gets the next hour.
        useFrom: new Date(validAt.getTime() - 30 * 60_000), useTo: new Date(validAt.getTime() + 30 * 60_000),
        fetchedAt: new Date(fetched.fetchedAt),
    };
}

function readCache() {
    try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (!c || !Array.isArray(c.hours) || !Array.isArray(c.data) || !Array.isArray(c.ids)) return null;
        return c;
    } catch (_) { return null; }
}

function writeCache(f) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(f));
    } catch (err) {
        // Not kept: these winds are used now, but there will be none in the air.
        if (typeof DiagLog !== 'undefined') DiagLog.log('error', 'Model winds not stored (no winds offline)', err?.message);
    }
}

/** The last hour with data in a fetch (for "forecast to ..."). */
function lastHour(f) {
    for (let i = (f?.hours?.length || 0) - 1; i >= 0; i--) if (f.data[i]) return new Date(f.hours[i]);
    return null;
}

/**
 * Model winds for `atMs`:
 *   1. the cached fetch, if younger than REUSE_MS and it has that hour;
 *   2. a new fetch: RRFS, else GFS for an hour RRFS does not have;
 *   3. the cached fetch at any age, if it has that hour (in the air, offline): marked stale.
 * @param {Record<string,[number,number]>} stations  FD station id -> [lat, lon]
 * @param {number} atMs
 * @returns {Promise<{winds: object, source: 'model', model: string, validAt: Date, useFrom: Date, useTo: Date, fetchedAt: Date}
 *   | {winds: null, coverTo: Date|null}>}
 */
export async function fetchModelWinds(stations, atMs) {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < REUSE_MS) {
        const w = windsAt(cached, atMs);
        if (w) return w;
    }
    let coverTo = null;
    for (const model of MODELS) {
        let fetched = null;
        try {
            const { url, ids } = buildUrl(stations, model, atMs);
            const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (resp.status === 429) {
                // Over Open-Meteo's allowance (per IP: shared with anything else on the
                // home network). Another model would cost as much and be refused too.
                if (typeof DiagLog !== 'undefined') DiagLog.log('error', 'Model winds: Open-Meteo rate limit (429)');
                break;
            }
            if (!resp.ok) continue;
            const parsed = parseResponse(await resp.json(), ids);
            if (parsed) fetched = { ...parsed, ids, model: model.label, fetchedAt: Date.now() };
        } catch (_) { break; }                              // offline / timed out: no point trying the next model
        if (!fetched) continue;
        const w = windsAt(fetched, atMs);
        if (w) { writeCache(fetched); return w; }
        const end = lastHour(fetched);
        if (end && (!coverTo || end > coverTo)) coverTo = end;
    }
    // Older than REUSE_MS but has the hour: the caller may prefer fresh FIS-B.
    const stale = cached ? windsAt(cached, atMs) : null;
    if (stale) return { ...stale, stale: true };
    return { winds: null, coverTo: coverTo || lastHour(cached) };
}
