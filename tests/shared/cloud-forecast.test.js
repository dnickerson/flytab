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
