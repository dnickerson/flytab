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

const CLOUD_M_TO_FT   = 3.28084;
const CLOUD_DB_NAME   = 'flytab_cloud_forecast';
const CLOUD_STORE     = 'forecast';
const CLOUD_API_BASE  = 'https://api.open-meteo.com/v1/forecast';

/**
 * Build the Open-Meteo request for a whole route in one call.
 *
 * DO NOT ADD cloud_base OR cloud_top. The API accepts both, returns them as
 * keys with "units": "undefined", and every value is null — verified across
 * six models (default, best_match, gfs_seamless, icon_seamless,
 * ecmwf_ifs025, gfs_graphcast025). Vertical structure comes from the
 * per-level cloud_cover_<L>hPa + geopotential_height_<L>hPa pairs below.
 */
function cloudBuildUrl(points) {
    const fields = ['freezing_level_height'];
    for (const L of CLOUD_LEVELS_HPA) {
        fields.push(`cloud_cover_${L}hPa`, `geopotential_height_${L}hPa`);
    }
    // latitude/longitude are built by hand, not via URLSearchParams: URLSearchParams
    // percent-encodes the joining comma (39.4%2C39.05), which Open-Meteo also accepts,
    // but keeping it a literal comma matches the multi-point coordinate-list convention
    // used elsewhere and is easier to eyeball/debug in a captured URL.
    const lat = points.map(p => p.lat).join(',');
    const lon = points.map(p => p.lon).join(',');
    const qs = new URLSearchParams({
        hourly:       fields.join(','),
        forecast_days: '2',
        timezone:     'UTC',
        models:       'gfs_hrrr',
    });
    return `${CLOUD_API_BASE}?latitude=${lat}&longitude=${lon}&${qs.toString()}`;
}

/** Open-Meteo returns a bare object for one point, an array for many. */
function cloudNormalize(json, points) {
    const series = Array.isArray(json) ? json : [json];
    const times  = series[0]?.hourly?.time ?? [];

    const coverPct   = [];
    const heightFt   = [];
    const freezingFt = [];

    for (const s of series) {
        const h = s.hourly || {};
        const cov = [], hgt = [], frz = [];
        for (let t = 0; t < times.length; t++) {
            const cRow = [], hRow = [];
            for (const L of CLOUD_LEVELS_HPA) {
                const c = h[`cloud_cover_${L}hPa`]?.[t];
                const g = h[`geopotential_height_${L}hPa`]?.[t];
                cRow.push(c == null ? null : c);
                hRow.push(g == null ? null : g * CLOUD_M_TO_FT);
            }
            cov.push(cRow);
            hgt.push(hRow);
            const f = h.freezing_level_height?.[t];
            frz.push(f == null ? null : f * CLOUD_M_TO_FT);
        }
        coverPct.push(cov);
        heightFt.push(hgt);
        freezingFt.push(frz);
    }

    return {
        routeHash: cloudRouteHash(points),
        fetchedAt: new Date().toISOString(),
        points:    points.map(p => ({ lat: p.lat, lon: p.lon, distNm: p.distNm })),
        times,
        levels:    CLOUD_LEVELS_HPA.slice(),
        coverPct,
        heightFt,
        freezingFt,
    };
}

function cloudStaleness(ageMs) {
    if (ageMs < 1 * 3600000) return 'fresh';
    if (ageMs < 3 * 3600000) return 'aging';
    if (ageMs < 6 * 3600000) return 'stale';
    return 'expired';
}

function cloudAgeLabel(ageMs) {
    const hours = Math.floor(ageMs / 3600000);
    const mins  = Math.floor((ageMs % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
}

/**
 * Merge BKN/OVC cells belonging to one physical layer into a single rectangle
 * carrying a single label.
 *
 * `byPoint[p]` holds sample point p's contour candidates, ascending in
 * altitude, each with explicit `loNm`/`hiNm` edges. Two candidates are the
 * same layer when they sit at CONSECUTIVE sample points — the points tile the
 * route edge to edge, so point adjacency is distance adjacency — share an octa
 * class, and have overlapping altitude bands.
 *
 * levelIdx is deliberately NOT the adjacency key: each point's slab edges come
 * from that point's own geopotential heights, so one deck legitimately sits at
 * different level indices at different points. Band overlap is the physical
 * question; level index is an artefact of the ladder.
 *
 * Classes are not merged into each other — a BKN run beside an OVC run stays
 * two rectangles, because the label has to stay true of everything under it.
 *
 * Without this, a long BKN deck drew as N abutting outlined boxes each
 * labelled "BKN" — visual noise, the opposite of what the hard contour was
 * chosen to deliver.
 */
function cloudMergeContours(byPoint) {
    const closed = [];
    let open = [];                     // runs still extendable from the last point

    for (const candidates of byPoint) {
        const claimed = new Set();     // a candidate can only extend ONE run
        const next = [];

        for (const run of open) {
            let hit = -1;
            for (let k = 0; k < candidates.length; k++) {
                if (claimed.has(k)) continue;
                const c = candidates[k];
                if (c.cover !== run.cover) continue;
                if (c.baseFt > run.topFt || c.topFt < run.baseFt) continue;  // no overlap
                hit = k;
                break;
            }
            if (hit < 0) { closed.push(run); continue; }   // the layer ends here
            claimed.add(hit);
            const c = candidates[hit];
            run.baseFt = Math.min(run.baseFt, c.baseFt);
            run.topFt  = Math.max(run.topFt,  c.topFt);
            run.hiNm   = c.hiNm;
            next.push(run);
        }

        for (let k = 0; k < candidates.length; k++) {
            if (claimed.has(k)) continue;
            const c = candidates[k];
            next.push({ cover: c.cover, baseFt: c.baseFt, topFt: c.topFt,
                        loNm: c.loNm, hiNm: c.hiNm });
        }
        open = next;
    }
    closed.push(...open);

    return closed
        .sort((a, b) => (a.loNm - b.loNm) || (a.baseFt - b.baseFt))
        .map(r => ({
            distNm: (r.loNm + r.hiNm) / 2,
            spanNm: r.hiNm - r.loNm,
            baseFt: r.baseFt,
            topFt:  r.topFt,
            cover:  r.cover,
        }));
}

/**
 * Turn a stored record + per-point ETAs into render-ready arrays.
 *
 * staleness describes FETCH AGE only; 'expired' still draws. `covered` is the
 * sole reason to draw nothing, and it yields empty arrays (not null) so the
 * renderer needs no special case.
 */
function cloudBuildResult(record, etaMs, nowMs) {
    const ageMs     = Math.max(0, nowMs - Date.parse(record.fetchedAt));
    const staleness = cloudStaleness(ageMs);
    const ageLabel  = cloudAgeLabel(ageMs);
    const empty = {
        staleness, covered: false, fetchedAt: record.fetchedAt, ageLabel,
        cells: [], contours: [], freezingLevel: [],
    };

    const hours = record.points.map((_, i) => cloudHourIndex(record.times, etaMs[i]));
    if (hours.some(h => h < 0)) return empty;

    const cells = [], freezingLevel = [];
    /** BKN/OVC candidates grouped by sample point, in distance order — the merge
     *  needs to know which cells are neighbours, and an empty entry is what makes
     *  a gap in the deck read as a gap rather than as adjacency. */
    const contourByPoint = [];

    const nPts       = record.points.length;
    const routeStart = record.points[0].distNm;
    const routeEnd   = record.points[nPts - 1].distNm;

    for (let p = 0; p < nPts; p++) {
        const t       = hours[p];
        const distNm  = record.points[p].distNm;
        // Half-way to each neighbour; at the two ends the shading runs all the way
        // to the route boundary rather than collapsing inward. The old
        // (nextD - prevD)/2 gave the first and last point a QUARTER-width span,
        // because the missing neighbour defaulted to the point's own distance. On
        // a 2-point route — every route <= 50 nm, since n = clamp(ceil(total/25),
        // 2, 20) — that left the middle half of the chart blank with cloud data
        // available for it.
        const loNm = p > 0        ? (record.points[p - 1].distNm + distNm) / 2 : routeStart;
        const hiNm = p < nPts - 1 ? (distNm + record.points[p + 1].distNm) / 2 : routeEnd;
        // The emitted cell contract is {distNm, spanNm} centred on the sample
        // point, so the span is widened to reach the further edge; the renderer
        // clamps the rectangle back into [0, totalDistNm]. Contour candidates
        // carry the exact edges instead, so merged rectangles need no clamping.
        const spanNm = Math.max(1, 2 * Math.max(distNm - loNm, hiNm - distNm));

        const frz = record.freezingFt[p]?.[t];
        if (frz != null) freezingLevel.push({ distNm, altFt: frz });

        const candidates = [];
        for (const slab of cloudSlabEdges(record.heightFt[p]?.[t] ?? [])) {
            const pct   = record.coverPct[p]?.[t]?.[slab.levelIdx];
            const klass = cloudOctaClass(pct);
            if (klass == null || klass === 'SKC') continue;   // null ≠ 0
            cells.push({
                distNm, spanNm,
                baseFt:   slab.baseFt,
                topFt:    slab.topFt,
                coverPct: pct,
                cover:    klass,
            });
            if (klass === 'BKN' || klass === 'OVC') {
                candidates.push({ loNm, hiNm, baseFt: slab.baseFt, topFt: slab.topFt, cover: klass });
            }
        }
        contourByPoint.push(candidates);
    }

    const contours = cloudMergeContours(contourByPoint);

    return { staleness, covered: true, fetchedAt: record.fetchedAt, ageLabel,
             cells, contours, freezingLevel };
}

class CloudForecastStore {
    constructor() {
        this._db   = null;
        this._data = null;
    }

    async open() {
        if (this._db) return;
        await new Promise((resolve, reject) => {
            const req = indexedDB.open(CLOUD_DB_NAME, 1);
            req.onupgradeneeded = e => e.target.result.createObjectStore(CLOUD_STORE);
            req.onsuccess = e => { this._db = e.target.result; resolve(); };
            req.onerror   = () => reject(req.error);
            // A blocked open NEVER fires onsuccess or onerror — the promise would
            // simply never settle, and this call sits in the awaited chain that
            // opens the terrain profile. Fail fast instead of hanging. (The
            // profile's own read is additionally raced against a timeout in
            // route-table.js; this is the belt to that suspenders.)
            req.onblocked = () => reject(new Error('cloud forecast IDB open blocked'));
        });
    }

    async load() {
        await this.open();
        return new Promise(resolve => {
            const tx  = this._db.transaction(CLOUD_STORE, 'readonly');
            const req = tx.objectStore(CLOUD_STORE).get('data');
            req.onsuccess = () => { this._data = req.result ?? null; resolve(this._data); };
            req.onerror   = () => resolve(null);
        });
    }

    async _save(record) {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(CLOUD_STORE, 'readwrite');
            tx.objectStore(CLOUD_STORE).put(record, 'data');
            tx.oncomplete = () => { this._data = record; resolve(); };
            tx.onerror    = () => reject(tx.error);
        });
    }

    /** Ground use only. Throws on failure; the caller keeps the old cache. */
    async fetchAndStore(points) {
        const resp = await fetch(cloudBuildUrl(points), { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) throw new Error(`Cloud fetch failed: ${resp.status} ${resp.statusText}`);
        const json = await resp.json();
        const series = Array.isArray(json) ? json : [json];
        if (!series[0]?.hourly?.time?.length) throw new Error('Cloud fetch returned no hourly data');
        const record = cloudNormalize(json, points);
        await this._save(record);
        return record;
    }

    /** Cache-only read. Returns null when there is nothing usable. */
    async getCells({ routeHash, samplePoints, etaMs }) {
        if (!this._data) await this.load();
        const rec = this._data;
        if (!rec) return null;
        if (rec.routeHash !== (routeHash ?? cloudRouteHash(samplePoints))) return null;
        if (rec.points.length !== etaMs.length) return null;
        return cloudBuildResult(rec, etaMs, Date.now());
    }
}
