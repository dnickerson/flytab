# Route Cloud Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the two dead render contracts in `route-profile.js` (`cloudLayers` at line 330, `freezingLevelFt` at line 309) with real cloud and freezing-level data from Open-Meteo pressure levels, pre-fetched on the ground and cached for offline use in flight.

**Architecture:** One new shared module, `web/shared/cloud-forecast.js`, holding top-level pure functions (octa classification, slab geometry, hour selection, route hashing) plus a `CloudForecastStore` class modelled on the existing `HRRRPreflightStore`. `route-table.js` triggers a background fetch on route edit when online, and reads the cache when building profile data. `route-profile.js` renders density cells plus hard BKN/OVC contours at native vertical resolution.

**Tech Stack:** Vanilla ES2020 (no bundler, classic `<script>` tags), IndexedDB, canvas 2D, vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-route-cloud-display-design.md`

## Global Constraints

- **Never request `cloud_base` or `cloud_top` from Open-Meteo.** Both are accepted and always return `null` on every model. A comment stating this must sit next to the URL builder.
- **Level ladder is exactly** `[1000, 975, 950, 925, 900, 850, 800, 700, 600, 500]` hPa.
- **No interpolation between pressure levels, anywhere.** Native slab geometry only.
- **`null` is never coerced to `0`.** `null` means "no data"; `0` means "no cloud".
- **Open-Meteo times come back without a timezone suffix** (`"2026-08-04T00:00"`). JavaScript parses an ISO date-time with no offset as *local* time. Always append `'Z'` before `Date.parse`.
- **No hardcoded hex in component code.** New colours go in `web/style.css` as `var(--…)` tokens.
- **Cloud rendering must never throw into `_render`.** Terrain clearance is the profile's primary job.
- **The profile never performs network I/O.** It reads the IDB cache or renders nothing.
- **`FLYTAB_VERSION` must be bumped before any `bash build.sh`.** Currently `v10.18` → use `v10.19`. Never three digits after the decimal.
- **Files are loaded as classic scripts**, so tests load them via the established `new Function(src + 'return {...}')()` pattern (see `tests/shared/altitude-utils.test.js`).

---

## File Structure

| File | Responsibility |
|---|---|
| `web/shared/cloud-forecast.js` | **Create.** Pure conversion helpers + `CloudForecastStore` (fetch, IDB, staleness, `getCells`) |
| `tests/shared/cloud-forecast.test.js` | **Create.** Unit tests for the pure layer and the store's read path |
| `tests/fixtures/open-meteo-route.json` | **Create.** Real captured API response |
| `web/index.html:91` | **Modify.** Add `<script>` tag after `hrrr-preflight.js` |
| `web/cockpit/route-table.js:759`, `:2574` | **Modify.** Fetch trigger in `_onEdited`, cache read in `_buildProfileData` |
| `web/cockpit/route-profile.js:308-338` | **Modify.** Replace freezing-level and cloud render blocks |
| `web/style.css` | **Modify.** Add `--cloud-fill`, `--cloud-contour` tokens |
| `docs/user-manual.md`, `web/user-manual.md` | **Modify.** Document the new profile content |
| `web/app.js:6` | **Modify.** Version bump |

---

### Task 1: Pure conversion layer

Pure functions only — no IDB, no network, no DOM. Everything here is directly unit-testable.

**Files:**
- Create: `web/shared/cloud-forecast.js`
- Test: `tests/shared/cloud-forecast.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `CLOUD_LEVELS_HPA: number[]`
  - `cloudRouteHash(points: {lat,lon}[]) → string`
  - `cloudOctaClass(coverPct: number|null) → 'SKC'|'FEW'|'SCT'|'BKN'|'OVC'|null`
  - `cloudSlabEdges(heightsFt: (number|null)[]) → ({levelIdx, baseFt, topFt})[]`
  - `cloudHourIndex(times: string[], etaMs: number) → number` (`-1` when out of window)

- [ ] **Step 1: Write the failing test**

Create `tests/shared/cloud-forecast.test.js`:

```js
// tests/shared/cloud-forecast.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// cloud-forecast.js is a classic script (no import/export). Load it in a
// closure and pull out the pure helpers — same pattern as altitude-utils.test.js.
const src = readFileSync('web/shared/cloud-forecast.js', 'utf8');
const {
    CLOUD_LEVELS_HPA,
    cloudRouteHash,
    cloudOctaClass,
    cloudSlabEdges,
    cloudHourIndex,
} = new Function(`
    ${src}
    return { CLOUD_LEVELS_HPA, cloudRouteHash, cloudOctaClass, cloudSlabEdges, cloudHourIndex };
`)();

describe('CLOUD_LEVELS_HPA', () => {
    it('is the exact ten-level ladder, descending pressure', () => {
        expect(CLOUD_LEVELS_HPA).toEqual([1000, 975, 950, 925, 900, 850, 800, 700, 600, 500]);
    });
});

describe('cloudRouteHash', () => {
    it('is stable for identical routes', () => {
        const a = [{ lat: 39.4012, lon: -77.9834 }, { lat: 39.0501, lon: -84.6712 }];
        const b = [{ lat: 39.4038, lon: -77.9799 }, { lat: 39.0488, lon: -84.6743 }];
        expect(cloudRouteHash(a)).toBe(cloudRouteHash(b));  // same at 2dp
    });

    it('changes when a waypoint moves materially', () => {
        const a = [{ lat: 39.40, lon: -77.98 }];
        const b = [{ lat: 39.55, lon: -77.98 }];
        expect(cloudRouteHash(a)).not.toBe(cloudRouteHash(b));
    });

    it('is order-sensitive — a reversed route is a different route', () => {
        const a = [{ lat: 39.40, lon: -77.98 }, { lat: 39.05, lon: -84.67 }];
        const b = [{ lat: 39.05, lon: -84.67 }, { lat: 39.40, lon: -77.98 }];
        expect(cloudRouteHash(a)).not.toBe(cloudRouteHash(b));
    });
});

describe('cloudOctaClass', () => {
    it('maps octa boundaries per round(pct/12.5)', () => {
        expect(cloudOctaClass(0)).toBe('SKC');
        expect(cloudOctaClass(6.24)).toBe('SKC');   // rounds to 0
        expect(cloudOctaClass(6.25)).toBe('FEW');   // rounds to 1
        expect(cloudOctaClass(31.2)).toBe('FEW');   // rounds to 2
        expect(cloudOctaClass(31.3)).toBe('SCT');   // rounds to 3
        expect(cloudOctaClass(56.2)).toBe('SCT');   // rounds to 4
        expect(cloudOctaClass(56.3)).toBe('BKN');   // rounds to 5
        expect(cloudOctaClass(93.7)).toBe('BKN');   // rounds to 7
        expect(cloudOctaClass(93.8)).toBe('OVC');   // rounds to 8
        expect(cloudOctaClass(100)).toBe('OVC');
    });

    it('returns null for missing data, never SKC', () => {
        expect(cloudOctaClass(null)).toBeNull();
        expect(cloudOctaClass(undefined)).toBeNull();
    });
});

describe('cloudSlabEdges', () => {
    it('uses midpoints between levels and half-gap extension at the ends', () => {
        const edges = cloudSlabEdges([1000, 2000, 5000]);
        expect(edges).toHaveLength(3);
        // level 0: base = 1000 - (2000-1000)/2 = 500, top = midpoint(1000,2000) = 1500
        expect(edges[0]).toMatchObject({ levelIdx: 0, baseFt: 500,  topFt: 1500 });
        // level 1: midpoint(1000,2000)=1500 .. midpoint(2000,5000)=3500
        expect(edges[1]).toMatchObject({ levelIdx: 1, baseFt: 1500, topFt: 3500 });
        // level 2: 3500 .. 5000 + (5000-2000)/2 = 6500
        expect(edges[2]).toMatchObject({ levelIdx: 2, baseFt: 3500, topFt: 6500 });
    });

    it('never emits a base below zero', () => {
        const edges = cloudSlabEdges([100, 400, 900]);
        expect(edges[0].baseFt).toBe(0);
    });

    it('drops null heights and keeps original level indices', () => {
        const edges = cloudSlabEdges([1000, null, 5000]);
        expect(edges).toHaveLength(2);
        expect(edges.map(e => e.levelIdx)).toEqual([0, 2]);
    });

    it('returns an empty array when fewer than two heights are usable', () => {
        expect(cloudSlabEdges([null, null])).toEqual([]);
        expect(cloudSlabEdges([3000, null])).toEqual([]);
    });
});

describe('cloudHourIndex', () => {
    // Open-Meteo returns "2026-08-04T00:00" with NO timezone suffix.
    const times = ['2026-08-04T00:00', '2026-08-04T01:00', '2026-08-04T02:00'];

    it('treats bare timestamps as UTC, not local', () => {
        const etaMs = Date.parse('2026-08-04T01:20:00Z');
        expect(cloudHourIndex(times, etaMs)).toBe(1);
    });

    it('snaps to the containing hour, not the nearest', () => {
        expect(cloudHourIndex(times, Date.parse('2026-08-04T01:59:59Z'))).toBe(1);
        expect(cloudHourIndex(times, Date.parse('2026-08-04T02:00:00Z'))).toBe(2);
    });

    it('returns -1 when the ETA is outside the cached window', () => {
        expect(cloudHourIndex(times, Date.parse('2026-08-03T23:00:00Z'))).toBe(-1);
        expect(cloudHourIndex(times, Date.parse('2026-08-04T09:00:00Z'))).toBe(-1);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/shared/cloud-forecast.test.js`
Expected: FAIL — `ENOENT: no such file or directory, open 'web/shared/cloud-forecast.js'`

- [ ] **Step 3: Write the minimal implementation**

Create `web/shared/cloud-forecast.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/shared/cloud-forecast.test.js`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add web/shared/cloud-forecast.js tests/shared/cloud-forecast.test.js
git commit -m "feat(cloud): pure conversion layer for pressure-level cloud data

Octa classification, native slab geometry, route hashing and UTC-safe hour
selection. No interpolation between levels — the slab edges are midpoints,
so a level's band is exactly what the model resolves.

cloudHourIndex appends 'Z' before parsing: Open-Meteo returns bare
timestamps and JS would otherwise read them as local time."
```

---

### Task 2: Fetch, cache and read path

**Files:**
- Modify: `web/shared/cloud-forecast.js` (append the class)
- Create: `tests/fixtures/open-meteo-route.json`
- Modify: `tests/shared/cloud-forecast.test.js` (append store tests)

**Interfaces:**
- Consumes: `CLOUD_LEVELS_HPA`, `cloudRouteHash`, `cloudOctaClass`, `cloudSlabEdges`, `cloudHourIndex` from Task 1
- Produces:
  - `cloudBuildUrl(points: {lat,lon}[]) → string`
  - `cloudNormalize(json, points) → record` — the stored shape
  - `cloudBuildResult(record, etaMs: number[], nowMs: number) → {staleness, covered, fetchedAt, ageLabel, cells, contours, freezingLevel}`
  - `class CloudForecastStore { open(), load(), fetchAndStore(points), getCells({routeHash, samplePoints, etaMs}) }`

- [ ] **Step 1: Capture the fixture**

Run exactly this — it is the command recorded in the spec appendix:

```bash
LEVELS="1000 975 950 925 900 850 800 700 600 500"
Q="freezing_level_height"
for L in $LEVELS; do Q="$Q,cloud_cover_${L}hPa,geopotential_height_${L}hPa"; done
curl -s "https://api.open-meteo.com/v1/forecast?latitude=39.40,39.05&longitude=-77.98,-84.67&hourly=${Q}&forecast_days=2&timezone=UTC&models=gfs_hrrr" \
  -o tests/fixtures/open-meteo-route.json
```

Verify the shape before continuing:

```bash
jq -r 'if type=="array" then "points=\(length) hours=\(.[0].hourly.time|length) fields=\(.[0].hourly|keys|length)" else "ERR" end' tests/fixtures/open-meteo-route.json
```

Expected: `points=2 hours=48 fields=22` (10 levels × 2 + `freezing_level_height` + `time`).

- [ ] **Step 2: Write the failing test**

Append to `tests/shared/cloud-forecast.test.js`:

```js
const {
    cloudBuildUrl,
    cloudNormalize,
    cloudBuildResult,
} = new Function(`
    ${src}
    return { cloudBuildUrl, cloudNormalize, cloudBuildResult };
`)();

const FIXTURE = JSON.parse(readFileSync('tests/fixtures/open-meteo-route.json', 'utf8'));
const FIX_POINTS = [
    { lat: 39.40, lon: -77.98, distNm: 0 },
    { lat: 39.05, lon: -84.67, distNm: 320 },
];

describe('cloudBuildUrl', () => {
    const url = cloudBuildUrl(FIX_POINTS);

    it('never requests cloud_base or cloud_top — both are always null', () => {
        expect(url).not.toContain('cloud_base');
        expect(url).not.toContain('cloud_top');
    });

    it('requests cover and height for every level in the ladder', () => {
        for (const L of CLOUD_LEVELS_HPA) {
            expect(url).toContain(`cloud_cover_${L}hPa`);
            expect(url).toContain(`geopotential_height_${L}hPa`);
        }
    });

    it('requests UTC and the freezing level', () => {
        expect(url).toContain('timezone=UTC');
        expect(url).toContain('freezing_level_height');
    });

    it('joins all points into one call', () => {
        expect(url).toContain('latitude=39.4,39.05');
        expect(url).toContain('longitude=-77.98,-84.67');
    });
});

describe('cloudNormalize', () => {
    const rec = cloudNormalize(FIXTURE, FIX_POINTS);

    it('captures the route hash and both points', () => {
        expect(rec.routeHash).toBe(cloudRouteHash(FIX_POINTS));
        expect(rec.points).toHaveLength(2);
    });

    it('builds a [point][time][level] cube matching the ladder', () => {
        expect(rec.levels).toEqual(CLOUD_LEVELS_HPA);
        expect(rec.coverPct).toHaveLength(2);
        expect(rec.coverPct[0]).toHaveLength(rec.times.length);
        expect(rec.coverPct[0][0]).toHaveLength(CLOUD_LEVELS_HPA.length);
        expect(rec.heightFt[0][0]).toHaveLength(CLOUD_LEVELS_HPA.length);
    });

    it('converts geopotential metres to feet', () => {
        const m = FIXTURE[0].hourly.geopotential_height_850hPa[0];
        const idx = CLOUD_LEVELS_HPA.indexOf(850);
        expect(rec.heightFt[0][0][idx]).toBeCloseTo(m * 3.28084, 1);
    });

    it('uses the field name coverPct, never a bare cover, on the record', () => {
        expect(rec.coverPct).toBeDefined();
        expect(rec.cover).toBeUndefined();
    });
});

describe('cloudBuildResult', () => {
    const rec = cloudNormalize(FIXTURE, FIX_POINTS);
    const hour3 = Date.parse(`${rec.times[3]}Z`) + 60000;
    const nowMs = Date.parse(rec.fetchedAt);

    it('reports covered when every ETA is inside the window', () => {
        const r = cloudBuildResult(rec, [hour3, hour3], nowMs);
        expect(r.covered).toBe(true);
        expect(Array.isArray(r.cells)).toBe(true);
    });

    it('returns empty arrays — not null — when an ETA is out of window', () => {
        const far = Date.parse(`${rec.times[rec.times.length - 1]}Z`) + 86400000;
        const r = cloudBuildResult(rec, [hour3, far], nowMs);
        expect(r.covered).toBe(false);
        expect(r.cells).toEqual([]);
        expect(r.contours).toEqual([]);
        expect(r.freezingLevel).toEqual([]);
    });

    it('still emits cells when the fetch is expired — age is not usability', () => {
        const sevenHoursLater = nowMs + 7 * 3600000;
        const r = cloudBuildResult(rec, [hour3, hour3], sevenHoursLater);
        expect(r.staleness).toBe('expired');
        expect(r.covered).toBe(true);
    });

    it('walks the staleness ladder by fetch age', () => {
        const at = h => cloudBuildResult(rec, [hour3, hour3], nowMs + h * 3600000).staleness;
        expect(at(0.5)).toBe('fresh');
        expect(at(2)).toBe('aging');
        expect(at(4)).toBe('stale');
        expect(at(7)).toBe('expired');
    });

    it('omits SKC cells but keeps every cell it emits classified', () => {
        const r = cloudBuildResult(rec, [hour3, hour3], nowMs);
        for (const c of r.cells) {
            expect(['FEW', 'SCT', 'BKN', 'OVC']).toContain(c.cover);
            expect(c.topFt).toBeGreaterThan(c.baseFt);
        }
    });

    it('only contours BKN and OVC', () => {
        const r = cloudBuildResult(rec, [hour3, hour3], nowMs);
        for (const c of r.contours) {
            expect(['BKN', 'OVC']).toContain(c.cover);
        }
    });

    it('never coerces a null cover into a drawn cell', () => {
        const holed = JSON.parse(JSON.stringify(rec));
        holed.coverPct[0] = holed.coverPct[0].map(row => row.map(() => null));
        const r = cloudBuildResult(holed, [hour3, hour3], nowMs);
        expect(r.cells.every(c => c.distNm !== FIX_POINTS[0].distNm)).toBe(true);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/shared/cloud-forecast.test.js`
Expected: FAIL — `cloudBuildUrl is not defined`

- [ ] **Step 4: Write the minimal implementation**

Append to `web/shared/cloud-forecast.js`:

```js
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
    const qs = new URLSearchParams({
        latitude:     points.map(p => p.lat).join(','),
        longitude:    points.map(p => p.lon).join(','),
        hourly:       fields.join(','),
        forecast_days: '2',
        timezone:     'UTC',
        models:       'gfs_hrrr',
    });
    return `${CLOUD_API_BASE}?${qs.toString()}`;
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

    for (let p = 0; p < record.points.length; p++) {
        const t       = hours[p];
        const distNm  = record.points[p].distNm;
        const prevD   = p > 0 ? record.points[p - 1].distNm : distNm;
        const nextD   = p < record.points.length - 1 ? record.points[p + 1].distNm : distNm;
        const spanNm  = Math.max(1, (nextD - prevD) / 2 || 1);

        const frz = record.freezingFt[p]?.[t];
        if (frz != null) freezingLevel.push({ distNm, altFt: frz });

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
        }
    }

    const contours = cells.filter(c => c.cover === 'BKN' || c.cover === 'OVC');

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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/shared/cloud-forecast.test.js`
Expected: PASS — all tests from Tasks 1 and 2

- [ ] **Step 6: Commit**

```bash
git add web/shared/cloud-forecast.js tests/shared/cloud-forecast.test.js tests/fixtures/open-meteo-route.json
git commit -m "feat(cloud): Open-Meteo fetch, IDB cache and render-ready read path

Stores the raw hourly cube and resolves ETA->hour at read time, so a delayed
departure still renders correctly with no internet.

Cache is keyed by route hash — a mismatch returns null rather than the
previous route's clouds. staleness ('expired' still draws) is kept separate
from covered (the only reason to draw nothing).

Tests run against a real captured API response, not hand-written fakes."
```

---

### Task 3: Wire fetch trigger and profile data

**Files:**
- Modify: `web/index.html:91`
- Modify: `web/cockpit/route-table.js` — `_onEdited()` at :759, `_buildProfileData()` at :2574

**Interfaces:**
- Consumes: `CloudForecastStore`, `cloudRouteHash` from Task 2
- Produces: `routeData.cloudCells`, `routeData.cloudContours`, `routeData.freezingLevel`, `routeData.cloudMeta` (`{staleness, covered, ageLabel}` or `null`) — consumed by Task 4

- [ ] **Step 1: Register the script**

Modify `web/index.html`, inserting after line 91 (`hrrr-preflight.js`) so it sits with its sibling stores and loads before any cockpit component:

```html
    <script src="./shared/hrrr-preflight.js"></script>
    <script src="./shared/cloud-forecast.js"></script>
```

- [ ] **Step 2: Add the sampler and fetch trigger**

In `web/cockpit/route-table.js`, add these two methods immediately before `_buildProfileData()` (currently line 2574):

```js
    /**
     * Even distance sampling along the route, capped at 20 points — the size
     * measured end-to-end against the live API (~16 KB gzipped for 48h).
     */
    _cloudSamplePoints() {
        const wps = this._waypoints.filter(wp => wp.lat != null && wp.lon != null);
        if (wps.length < 2) return [];

        const dists = [];
        let cum = 0;
        for (let i = 0; i < wps.length; i++) {
            if (i > 0) cum += wps[i]._legDist || 0;
            dists.push(cum);
        }
        const total = cum;
        if (total <= 0) return [];

        const n = Math.min(20, Math.max(2, Math.ceil(total / 25)));
        const out = [];
        for (let k = 0; k < n; k++) {
            const d = (total * k) / (n - 1);
            let j = 1;
            while (j < dists.length - 1 && dists[j] < d) j++;
            const d0 = dists[j - 1], d1 = dists[j];
            const f  = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
            const a  = wps[j - 1], b = wps[j];
            out.push({
                lat:    a.lat + (b.lat - a.lat) * f,
                lon:    a.lon + (b.lon - a.lon) * f,
                distNm: d,
                etaMs:  (a._eta != null && b._eta != null)
                    ? a._eta + (b._eta - a._eta) * f
                    : null,
            });
        }
        return out;
    }

    /**
     * Ground pre-fetch. Fires on route edit when online so the cache is warm
     * before departure — the profile itself never touches the network.
     * Failure is deliberately silent: this runs on every edit, and a toast
     * would be noise. The age chip on the panel is the signal.
     */
    async _refreshCloudForecast() {
        if (typeof CloudForecastStore === 'undefined') return;
        const mode = (typeof app !== 'undefined') ? app.networkMode?.mode : null;
        if (mode !== 'home' && mode !== 'internet') return;

        const points = this._cloudSamplePoints();
        if (points.length < 2) return;

        const hash = cloudRouteHash(points);
        if (hash === this._cloudFetchedHash) return;   // already have this route

        this._cloudStore = this._cloudStore || new CloudForecastStore();
        try {
            await this._cloudStore.fetchAndStore(points);
            this._cloudFetchedHash = hash;
            window.DiagLog?.log('cloud', `forecast cached — ${points.length} pts`);
        } catch (e) {
            window.DiagLog?.log('cloud', `forecast fetch failed: ${e?.message}`);
        }
    }
```

- [ ] **Step 3: Call the trigger on route edit**

In `_onEdited()` (line 759), append one line after `this._emitRouteChange();`:

```js
        this._emitRouteChange();
        this._refreshCloudForecast();   // fire-and-forget ground pre-fetch
    }
```

- [ ] **Step 4: Read the cache in `_buildProfileData`**

In `_buildProfileData()`, insert immediately before the `return {` block (currently line 2651):

```js
        // Cloud + freezing level — cache only, never network. A failure here
        // must not cost the pilot the terrain profile.
        let cloudCells = [], cloudContours = [], freezingLevel = [], cloudMeta = null;
        try {
            const pts = this._cloudSamplePoints();
            if (pts.length >= 2 && typeof CloudForecastStore !== 'undefined') {
                this._cloudStore = this._cloudStore || new CloudForecastStore();
                const nowHour = Math.floor(Date.now() / 3600000) * 3600000;
                const etas = pts.map(p => p.etaMs ?? nowHour);
                const res  = await this._cloudStore.getCells({
                    routeHash: cloudRouteHash(pts), samplePoints: pts, etaMs: etas,
                });
                if (res) {
                    cloudCells    = res.cells;
                    cloudContours = res.contours;
                    freezingLevel = res.freezingLevel;
                    cloudMeta     = {
                        staleness: res.staleness,
                        covered:   res.covered,
                        ageLabel:  res.ageLabel,
                        estimated: pts.some(p => p.etaMs == null),
                    };
                }
            }
        } catch (e) {
            console.warn('[RouteTable] cloud forecast failed:', e?.message);
        }
```

Then add these four fields to the returned object, after `fuelStops`:

```js
            fuelStops,   // trip.flights[] boundary markers for the profile chart
            cloudCells,
            cloudContours,
            freezingLevel,
            cloudMeta,
        };
```

- [ ] **Step 5: Verify no regression in the existing suite**

Run: `npm test`
Expected: PASS — the existing `route-table-*.test.js` suites must stay green. If a suite constructs `RouteTable` without `app` defined, `_refreshCloudForecast` returns at the `mode` guard, so no network call occurs.

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/cockpit/route-table.js
git commit -m "feat(cloud): sample route, pre-fetch on the ground, read cache for profile

_onEdited fires a fire-and-forget fetch when NetworkMode is home/internet,
skipping when the route hash already matches what is cached.
_buildProfileData reads cache only and swallows any failure — a cloud bug
must not cost the pilot the terrain profile.

Falls back to the current hour when waypoint ETAs are unavailable, flagged
via cloudMeta.estimated so the panel can say so rather than implying
time-correctness it does not have."
```

---

### Task 4: Render cells, contours, freezing level and age chip

**Files:**
- Modify: `web/style.css` (add tokens)
- Modify: `web/cockpit/route-profile.js:308-338`

**Interfaces:**
- Consumes: `routeData.cloudCells`, `.cloudContours`, `.freezingLevel`, `.cloudMeta` from Task 3
- Produces: nothing consumed downstream

- [ ] **Step 1: Add the colour tokens**

In `web/style.css`, inside the unconditional `:root` block, after the existing `--color-*` entries:

```css
    /* Route profile cloud rendering — fill is texture, contour carries
       legibility. --cloud-contour measures 12.9:1 on white. */
    --cloud-fill:    #5b6b7f;
    --cloud-contour: #1f3348;
```

- [ ] **Step 2: Replace the freezing-level block**

In `web/cockpit/route-profile.js`, replace lines 308-327 (the `// 4. Freezing level line` block) with:

```js
        // 4. Freezing level ──────────────────────────────────────────────────
        // A polyline, not a scalar: the freezing level moves materially over a
        // few hundred miles, and one number would be invented precision.
        const frzPts = routeData.freezingLevel || [];
        if (frzPts.length > 0) {
            ctx.save();
            ctx.strokeStyle = getComputedStyle(document.documentElement)
                .getPropertyValue('--color-danger-on-light').trim() || '#a30d0d';
            ctx.lineWidth = 2;
            ctx.beginPath();
            frzPts.forEach((p, i) => {
                const px = xOf(p.distNm), py = yOf(p.altFt);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
            ctx.stroke();
            const first = frzPts[0];
            const fy = yOf(first.altFt);
            if (fy > pad.top && fy < h - pad.bottom) {
                ctx.fillStyle = ctx.strokeStyle;
                ctx.font = '900 12px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('0°C', pad.left + 4, fy - 5);
            }
            ctx.restore();
        }
```

- [ ] **Step 3: Replace the cloud block**

Replace lines 329-338 (the `// 5. Cloud layers` block) with:

```js
        // 5. Clouds ──────────────────────────────────────────────────────────
        // Native pressure-level slabs. Density fill is texture; the BKN/OVC
        // contour is what has to survive sunlight. Wrapped because terrain
        // clearance must not depend on this code being correct.
        try {
            const css       = getComputedStyle(document.documentElement);
            const fillRGB   = css.getPropertyValue('--cloud-fill').trim()    || '#5b6b7f';
            const contourC  = css.getPropertyValue('--cloud-contour').trim() || '#1f3348';

            const rectOf = (c) => {
                const x  = xOf(Math.max(0, c.distNm - c.spanNm / 2));
                const x2 = xOf(Math.min(totalDist, c.distNm + c.spanNm / 2));
                const y  = yOf(c.topFt);
                return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, yOf(c.baseFt) - y) };
            };

            for (const c of routeData.cloudCells || []) {
                const r = rectOf(c);
                ctx.save();
                ctx.globalAlpha = 0.12 + 0.33 * Math.min(1, (c.coverPct || 0) / 100);
                ctx.fillStyle   = fillRGB;
                ctx.fillRect(r.x, r.y, r.w, r.h);
                ctx.restore();
            }

            if ((routeData.cloudContours || []).length > 0) {
                ctx.save();
                ctx.strokeStyle = contourC;
                ctx.lineWidth   = 2;
                for (const c of routeData.cloudContours) {
                    const r = rectOf(c);
                    ctx.strokeRect(r.x, r.y, r.w, r.h);
                }
                ctx.restore();
            }
        } catch (e) {
            console.warn('[RouteProfile] cloud render skipped:', e?.message);
        }
```

- [ ] **Step 4: Add the age chip to the header**

In `_buildDOM()`, after `titleEl` is appended (line 107) and before `this._chevronBtn`, insert:

```js
        this._wxChip = document.createElement('span');
        Object.assign(this._wxChip.style, {
            fontSize: '11px', fontWeight: '800', marginRight: '4px', display: 'none',
        });
        header.appendChild(this._wxChip);
```

Then add this method after `_render()` and call it as the first line of `_render()` via `this._updateWxChip(routeData);`:

```js
    _updateWxChip(routeData) {
        if (!this._wxChip) return;
        const m = routeData.cloudMeta;
        if (!m) { this._wxChip.style.display = 'none'; return; }

        const css = getComputedStyle(document.documentElement);
        const colour = m.staleness === 'expired'
            ? css.getPropertyValue('--color-danger-on-light').trim()  || '#a30d0d'
            : m.staleness === 'stale'
                ? css.getPropertyValue('--color-caution-on-light').trim() || '#6b4a00'
                : css.getPropertyValue('--text-muted').trim() || '#888888';

        let label;
        if (!m.covered)      label = 'WX: no data for ETA';
        else if (m.estimated) label = `WX ${m.ageLabel} · valid now`;
        else                  label = `WX ${m.ageLabel}`;

        this._wxChip.textContent  = label;
        this._wxChip.style.color  = colour;
        this._wxChip.style.display = 'inline';
    }
```

- [ ] **Step 5: Verify the suite still passes**

Run: `npm test`
Expected: PASS — no existing test touches `route-profile.js`, so this confirms no collateral breakage.

- [ ] **Step 6: Commit**

```bash
git add web/style.css web/cockpit/route-profile.js
git commit -m "feat(cloud): render native cloud slabs, BKN/OVC contours and 0C line

Replaces the two contracts that route-profile.js has drawn against since it
was written but that nothing ever populated.

The old rgba(148,163,184,0.4) cloud fill is gone — a 40% mid-grey on a light
background is ~1.6:1 and invisible in sunlight. Fill is now texture only;
the --cloud-contour outline (12.9:1 on white) carries legibility.

Freezing level becomes a polyline rather than a scalar, and the whole cloud
block is wrapped so a rendering bug cannot take terrain clearance down."
```

---

### Task 5: Manual, version bump, build

**Files:**
- Modify: `docs/user-manual.md`, `web/user-manual.md`
- Modify: `web/app.js:6`

- [ ] **Step 1: Find the profile section in the manual**

Run: `grep -n "Profile" docs/user-manual.md | head -20`

Add a subsection under the route profile documentation covering: the cloud shading and what the density means, the BKN/OVC boxes and their labels, the 0°C freezing-level line, the WX age chip and its three states, and — most importantly — that **cloud data is fetched on the ground and never updates in flight**.

Draft text to adapt to the surrounding style:

```markdown
### Clouds on the profile

When a cloud forecast has been cached, the profile shades cloud along your
route at the altitudes it occupies. Shading density follows how much cloud
the model expects: faint for scattered, solid for overcast. Anywhere cover
reaches broken or worse, a dark outlined box is drawn and labelled.

The bands are deliberately blocky. The forecast samples about every 750 ft
low down but only every 3,000–4,000 ft above roughly 6,700 ft, and the boxes
show the real span the model resolves rather than a smoothed guess. A layer
that sits entirely inside one of those upper gaps will not appear at all.

A solid red line marks the 0°C freezing level, which moves along the route.

**Cloud data is fetched on the ground and does not update in flight.** It
refreshes automatically whenever you edit the route while connected at home
or on the internet. The WX chip in the profile header shows how old the
forecast is — grey when recent, amber past three hours, red past six. Old
data is still drawn; the chip tells you how much to trust it. If the chip
reads "no data for ETA", the cached forecast does not reach far enough
forward in time to cover your arrival and nothing is drawn.
```

Apply the same edit to both `docs/user-manual.md` and `web/user-manual.md` — they are mirrors.

- [ ] **Step 2: Bump the version**

In `web/app.js` line 6:

```js
const FLYTAB_VERSION = 'v10.19';
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Build**

Run: `bash build.sh`
Expected: APK built, `versionCode` 1019.

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual.md web/user-manual.md web/app.js android/app/build.gradle
git commit -m "docs(manual): route profile cloud display; bump to v10.19

Documents the cloud shading, BKN/OVC boxes, freezing-level line and WX age
chip, and states plainly that cloud data is a ground pre-fetch that does not
update in flight."
```

- [ ] **Step 6: Manual verification on the tablet**

Not covered by any automated test — this needs the device:

1. On home wifi, open a route of ~200 nm and edit it. Confirm DiagLog shows `cloud forecast cached`.
2. Open the profile. Confirm cloud shading, at least one outlined BKN/OVC box with a label, and the red 0°C line.
3. Confirm the WX chip shows a recent age in grey.
4. **Take the tablet outside into direct sunlight** and confirm the contour and its label are readable. This is the criterion the whole encoding choice was made for and it cannot be checked on a desk monitor.
5. Switch to Stratux wifi (no internet), reopen the profile, and confirm the clouds still render from cache with no hang.
6. Edit the route while offline and confirm clouds disappear rather than showing the previous route's data.

The tap-handler regression rule does not apply — no map tap handlers (`onAirportClick`, `onNavaidClick`, `onFixClick`) are touched by this work.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Open-Meteo source, CORS, no proxy | 2 |
| `cloud_base`/`cloud_top` trap | 2 (guard test + comment) |
| Ten-level ladder | 1 |
| Native resolution, no interpolation | 1 (`cloudSlabEdges`) |
| Store raw cube, resolve ETA at read time | 2 (`cloudBuildResult`) |
| Route-hash invalidation | 1, 2 |
| Sampling `clamp(ceil(d/25), 2, 20)` | 3 (`_cloudSamplePoints`) |
| ETA interpolation + null fallback | 3 |
| Octa mapping, contour at ≥5/8 | 1, 2 |
| Staleness ladder, `covered` separate | 2 |
| Silent fetch failure → DiagLog | 3 |
| try/catch around cloud render | 3, 4 |
| Colour tokens, no inline hex | 4 |
| Freezing level as polyline | 4 |
| Age chip | 4 |
| Tests against real fixture | 2 |
| Manual update, version bump, build | 5 |

**Gap found and closed:** the spec requires an attribution credit for CC-BY 4.0, which no task covered. Added below as Task 6 rather than left implicit.

**Type consistency:** `coverPct` is the record cube and the raw percentage on a cell; `cover` is only ever the octa class string. `distNm`/`spanNm`/`baseFt`/`topFt` are used identically in Tasks 2, 3 and 4. `cloudMeta` is produced in Task 3 and consumed in Task 4 with the same four keys.

---

### Task 6: Open-Meteo attribution

CC-BY 4.0 requires attribution. This is a licence obligation, not a nicety.

**Files:**
- Modify: `web/cockpit/route-profile.js` (`_buildDOM`)

- [ ] **Step 1: Add the credit line**

In `_buildDOM()`, after the `titleEl` block, add a small credit that sits in the header:

```js
        const creditEl = document.createElement('span');
        creditEl.textContent = 'WX: Open-Meteo (CC-BY 4.0)';
        Object.assign(creditEl.style, {
            fontSize: '9px', fontWeight: '700',
            color: 'var(--text-muted)', marginRight: '6px',
        });
        header.appendChild(creditEl);
```

- [ ] **Step 2: Verify it renders**

Run: `npm test` (confirms nothing broke), then confirm visually on device during Task 5's manual pass.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/route-profile.js
git commit -m "chore(cloud): Open-Meteo CC-BY 4.0 attribution on the profile panel"
```

---

## Execution Notes

- Tasks 1 and 2 are pure logic and fully covered by tests. Tasks 3–6 touch live UI and are verified by the existing suite plus the device pass in Task 5 Step 6.
- The free Open-Meteo tier is **non-commercial only**. This is fine for a sideloaded personal FlyTab and is recorded in the spec; it blocks flywhere.app productization without a paid plan.
- `hrrr-preflight.js`'s 404 against AWC `griddata` is a known adjacent bug and is explicitly **not** in scope here.
