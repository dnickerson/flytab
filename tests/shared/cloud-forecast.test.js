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

const {
    cloudBuildUrl,
    cloudNormalize,
    cloudBuildResult,
    cloudMergeContours,
    CloudForecastStore,
} = new Function(`
    ${src}
    return { cloudBuildUrl, cloudNormalize, cloudBuildResult, cloudMergeContours, CloudForecastStore };
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

    // ── Endpoint spans reach the route ends (review finding 5) ────────────────
    // With only two sample points (every route <= 50 nm) the old
    // (nextD - prevD)/2 gave each endpoint a quarter-width span and left the
    // middle half of the chart blank with data available for it.
    // Real weather decides whether the fixture has cloud at a given point/hour, so
    // the span geometry is pinned against a synthetic overcast record instead.
    const HEIGHTS = [400, 1131, 1873, 2631, 3408, 5013, 6686, 10354, 14520, 19274];
    /** Solid OVC at every level, one hour, at each of `dists`. */
    function overcastRecord(dists) {
        const cov = CLOUD_LEVELS_HPA.map(() => 100);
        return {
            routeHash:  'synthetic',
            fetchedAt:  '2026-08-04T00:00:00.000Z',
            points:     dists.map((d, i) => ({ lat: 39 + i, lon: -78 - i, distNm: d })),
            times:      ['2026-08-04T00:00'],
            levels:     CLOUD_LEVELS_HPA.slice(),
            coverPct:   dists.map(() => [cov.slice()]),
            heightFt:   dists.map(() => [HEIGHTS.slice()]),
            freezingFt: dists.map(() => [8000]),
        };
    }
    const SYNTH_ETA = Date.parse('2026-08-04T00:30:00Z');
    const SYNTH_NOW = Date.parse('2026-08-04T00:00:00Z');

    it('shades from route start to route end with no gap between the endpoints', () => {
        // A 40 nm route samples at exactly 2 points — n = clamp(ceil(40/25), 2, 20).
        const r = cloudBuildResult(overcastRecord([0, 40]), [SYNTH_ETA, SYNTH_ETA], SYNTH_NOW);
        const dep  = r.cells.filter(c => c.distNm === 0);
        const dest = r.cells.filter(c => c.distNm === 40);
        expect(dep.length).toBeGreaterThan(0);
        expect(dest.length).toBeGreaterThan(0);

        // The renderer draws [distNm - span/2, distNm + span/2] clamped to the
        // route, so the departure cell must reach the 20 nm midpoint and the
        // destination cell must reach back to it — no unshaded middle.
        expect(Math.min(40, dep[0].distNm  + dep[0].spanNm  / 2)).toBe(20);
        expect(Math.max(0,  dest[0].distNm - dest[0].spanNm / 2)).toBe(20);
        // Old behaviour: (nextD - prevD)/2 = 20, so the departure reached only
        // 10 nm and the destination back to 30 — half the chart blank.
        expect(dep[0].spanNm).not.toBe(20);
    });

    it('gives interior points one full spacing, unchanged', () => {
        const r = cloudBuildResult(overcastRecord([0, 25, 50]),
                                   [SYNTH_ETA, SYNTH_ETA, SYNTH_ETA], SYNTH_NOW);
        const mid = r.cells.filter(c => c.distNm === 25);
        expect(mid.length).toBeGreaterThan(0);
        expect(mid[0].spanNm).toBe(25);      // 12.5 either side
    });
});

// ── getCells cache guards (spec test 6; review finding 7a) ────────────────────
// Reachable without a real IndexedDB: getCells only calls load() when _data is
// falsy, so seeding _data exercises the guards directly.

describe('CloudForecastStore.getCells — cache guards', () => {
    const rec = cloudNormalize(FIXTURE, FIX_POINTS);
    const eta = Date.parse(`${rec.times[3]}Z`) + 60000;

    it('returns null when the route hash does not match the cache', async () => {
        // The worst available failure mode is editing a route offline and being
        // shown the PREVIOUS route's clouds with full confidence.
        const s = new CloudForecastStore();
        s._data = rec;
        expect(await s.getCells({
            routeHash: 'not-the-real-hash', samplePoints: FIX_POINTS, etaMs: [eta, eta],
        })).toBeNull();
    });

    it('accepts the matching hash, and derives it from the points when omitted', async () => {
        const s = new CloudForecastStore();
        s._data = rec;
        const byHash = await s.getCells({
            routeHash: rec.routeHash, samplePoints: FIX_POINTS, etaMs: [eta, eta],
        });
        expect(byHash).not.toBeNull();
        const derived = await s.getCells({ samplePoints: FIX_POINTS, etaMs: [eta, eta] });
        expect(derived).not.toBeNull();
    });

    it('returns null when the point count does not match etaMs length', async () => {
        // A cube indexed [pointIdx][timeIdx][levelIdx] read with a mismatched ETA
        // list would silently pair the wrong hour with the wrong place.
        const s = new CloudForecastStore();
        s._data = rec;
        expect(await s.getCells({
            routeHash: rec.routeHash, samplePoints: FIX_POINTS, etaMs: [eta],
        })).toBeNull();
    });

    it('returns null when there is no cached record at all', async () => {
        const s = new CloudForecastStore();
        s._data = null;
        s.load = async () => null;      // stand in for an empty IDB
        expect(await s.getCells({
            routeHash: rec.routeHash, samplePoints: FIX_POINTS, etaMs: [eta, eta],
        })).toBeNull();
    });
});

// ── Contour merging (review finding 4) ────────────────────────────────────────

describe('cloudMergeContours', () => {
    const cell = (loNm, hiNm, baseFt, topFt, cover) => ({ loNm, hiNm, baseFt, topFt, cover });

    it('merges two adjacent BKN cells into one labelled rectangle', () => {
        const merged = cloudMergeContours([
            [cell(0,  50, 3000, 5000, 'BKN')],
            [cell(50, 100, 3200, 5400, 'BKN')],
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ cover: 'BKN', distNm: 50, spanNm: 100 });
        // The merged band is the union of the two, not either one alone.
        expect(merged[0].baseFt).toBe(3000);
        expect(merged[0].topFt).toBe(5400);
    });

    it('does NOT merge across a gap — an empty point between two decks', () => {
        const merged = cloudMergeContours([
            [cell(0,   50, 3000, 5000, 'BKN')],
            [],                                       // clear air here
            [cell(100, 150, 3000, 5000, 'BKN')],
        ]);
        expect(merged).toHaveLength(2);
        expect(merged[0]).toMatchObject({ distNm: 25,  spanNm: 50 });
        expect(merged[1]).toMatchObject({ distNm: 125, spanNm: 50 });
    });

    it('does not merge different octa classes into one label', () => {
        const merged = cloudMergeContours([
            [cell(0,  50, 3000, 5000, 'BKN')],
            [cell(50, 100, 3000, 5000, 'OVC')],
        ]);
        expect(merged).toHaveLength(2);
        expect(merged.map(m => m.cover)).toEqual(['BKN', 'OVC']);
    });

    it('does not merge two decks that are adjacent but vertically separated', () => {
        const merged = cloudMergeContours([
            [cell(0,  50, 3000, 5000, 'BKN')],
            [cell(50, 100, 12000, 14000, 'BKN')],     // no band overlap
        ]);
        expect(merged).toHaveLength(2);
    });

    it('tracks two stacked decks independently across three points', () => {
        const merged = cloudMergeContours([
            [cell(0,   50,  3000, 5000, 'BKN'), cell(0,   50,  11000, 13000, 'OVC')],
            [cell(50,  100, 3100, 5100, 'BKN'), cell(50,  100, 11200, 13200, 'OVC')],
            [cell(100, 150, 3200, 5200, 'BKN'), cell(100, 150, 11400, 13400, 'OVC')],
        ]);
        expect(merged).toHaveLength(2);
        for (const m of merged) {
            expect(m.distNm).toBe(75);
            expect(m.spanNm).toBe(150);
        }
        expect(merged.map(m => m.cover)).toEqual(['BKN', 'OVC']);   // sorted by base
    });

    it('emits nothing when there are no candidates', () => {
        expect(cloudMergeContours([[], [], []])).toEqual([]);
    });

    it('collapses a run of cells to strictly fewer rectangles than cells', () => {
        const rec2 = cloudNormalize(FIXTURE, FIX_POINTS);
        const h = Date.parse(`${rec2.times[3]}Z`) + 60000;
        const r = cloudBuildResult(rec2, [h, h], Date.parse(rec2.fetchedAt));
        // Every emitted contour still carries a drawable class and band.
        for (const c of r.contours) {
            expect(['BKN', 'OVC']).toContain(c.cover);
            expect(c.topFt).toBeGreaterThan(c.baseFt);
            expect(c.spanNm).toBeGreaterThan(0);
        }
        const bknOvcCells = r.cells.filter(c => c.cover === 'BKN' || c.cover === 'OVC');
        expect(r.contours.length).toBeLessThanOrEqual(bknOvcCells.length);
    });
});
