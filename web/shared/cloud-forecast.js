/**
 * FlyTab — Cloud Forecast Store
 * Pressure-level cloud cover + freezing level from Open-Meteo, cached in IDB
 * for offline use in flight. Ground-fetch only; the profile reads cache only.
 *
 * See docs/superpowers/specs/2026-08-04-route-cloud-display-design.md
 */

/** Pressure levels requested, ascending altitude (descending pressure). */
const CLOUD_LEVELS_HPA = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500];

/** Route identity at 2dp — used to reject a cache built for a different route. */
function cloudRouteHash(points) {
    return (points || [])
        .map(p => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`)
        .join('|');
}

/**
 * Model cloud fraction (%) → octa class.
 * Returns null for missing data — never 'SKC', which would claim clear sky.
 */
function cloudOctaClass(coverPct) {
    if (coverPct == null) return null;
    const octa = Math.round(coverPct / 12.5);
    if (octa <= 0) return 'SKC';
    if (octa <= 2) return 'FEW';
    if (octa <= 4) return 'SCT';
    if (octa <= 7) return 'BKN';
    return 'OVC';
}

/**
 * Native slab geometry: each level owns the span to the midpoint of its
 * neighbours. No interpolation — the blockiness is an honest statement of
 * what the model resolves. Levels with a null height are dropped, and the
 * surviving entries keep their ORIGINAL index so cover[] stays aligned.
 */
function cloudSlabEdges(heightsFt) {
    const usable = [];
    for (let i = 0; i < (heightsFt || []).length; i++) {
        if (heightsFt[i] != null) usable.push({ levelIdx: i, h: heightsFt[i] });
    }
    if (usable.length < 2) return [];

    const out = [];
    for (let i = 0; i < usable.length; i++) {
        const h = usable[i].h;
        const baseFt = i === 0
            ? h - (usable[1].h - h) / 2
            : (usable[i - 1].h + h) / 2;
        const topFt = i === usable.length - 1
            ? h + (h - usable[i - 1].h) / 2
            : (h + usable[i + 1].h) / 2;
        out.push({ levelIdx: usable[i].levelIdx, baseFt: Math.max(0, baseFt), topFt });
    }
    return out;
}

/**
 * Index of the hourly slot CONTAINING etaMs, or -1 if outside the window.
 * Open-Meteo returns "2026-08-04T00:00" with no timezone suffix; JS would
 * parse that as local time, so 'Z' is appended explicitly.
 */
function cloudHourIndex(times, etaMs) {
    if (!times || times.length === 0 || etaMs == null) return -1;
    const HOUR_MS = 3600000;
    for (let i = 0; i < times.length; i++) {
        const t = Date.parse(`${times[i]}Z`);
        if (Number.isNaN(t)) continue;
        if (etaMs >= t && etaMs < t + HOUR_MS) return i;
    }
    return -1;
}
