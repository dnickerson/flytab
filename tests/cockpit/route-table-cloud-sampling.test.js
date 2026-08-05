/**
 * route-table.js — _cloudSamplePoints()
 *
 * The route-cloud feature's only piece of non-trivial arithmetic that lived
 * outside cloud-forecast.js, and it had no direct test. Added in the final
 * whole-branch review fix wave, covering:
 *
 *  - the N = clamp(ceil(totalDistNm / 25), 2, 20) sample count (spec: Sampling)
 *  - the bracket search + linear interpolation of lat/lon and ETA
 *  - review finding 2 part B — all-or-nothing ETA: if ANY waypoint's _eta is
 *    unknown, EVERY sample point's etaMs is null, so the caller falls back to
 *    the current hour uniformly instead of mixing "now" and forecast columns
 *  - review finding 6 — a waypoint without coordinates desynchronises _legDist
 *    (indexed on the unfiltered waypoint list) from the filtered list, so the
 *    sampler must refuse rather than interpolate between non-adjacent points
 *
 * route-table.js is a classic (non-ESM) script, loaded with the same
 * `new Function(src + 'return Class;')()` pattern as the other route-table tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/cockpit/route-table.js'), 'utf8');
const RouteTable = new Function(src + '\nreturn RouteTable;')();

const T0 = Date.parse('2026-08-04T14:00:00Z');
const HOUR = 3600000;

function makeTable(waypoints) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints = waypoints;
    return rt;
}

/** A straight north-bound route. `legDists[i]` is the distance INTO waypoint i+1. */
function straightRoute(legDists, { etaHrs = null } = {}) {
    const wps = [{ icao: 'DEP', lat: 40, lon: -80, _legDist: 0 }];
    let lat = 40;
    legDists.forEach((d, i) => {
        lat += 1;
        wps.push({ icao: `WP${i + 1}`, lat, lon: -80, _legDist: d });
    });
    if (etaHrs) wps.forEach((wp, i) => { wp._eta = T0 + etaHrs[i] * HOUR; });
    return wps;
}

// ── Sample count: N = clamp(ceil(total / 25), 2, 20) ───────────────────────────

describe('_cloudSamplePoints — sample count', () => {
    const countFor = total => makeTable(straightRoute([total]))._cloudSamplePoints().length;

    it('never drops below two points on a short route', () => {
        expect(countFor(10)).toBe(2);    // ceil(10/25) = 1, floored to 2
        expect(countFor(50)).toBe(2);    // ceil(50/25) = 2
    });

    it('scales at one point per 25 nm in the middle of the range', () => {
        expect(countFor(300)).toBe(12);  // ceil(300/25)
        expect(countFor(137)).toBe(6);   // ceil(5.48)
    });

    it('caps at twenty — the payload size measured against the live API', () => {
        expect(countFor(1000)).toBe(20); // ceil(1000/25) = 40, capped
        expect(countFor(500)).toBe(20);  // exactly at the cap
        expect(countFor(499)).toBe(20);
    });

    it('spaces points evenly from route start to route end', () => {
        const pts = makeTable(straightRoute([300]))._cloudSamplePoints();
        expect(pts[0].distNm).toBe(0);
        expect(pts[pts.length - 1].distNm).toBeCloseTo(300, 9);
        const step = pts[1].distNm - pts[0].distNm;
        for (let i = 1; i < pts.length; i++) {
            expect(pts[i].distNm - pts[i - 1].distNm).toBeCloseTo(step, 9);
        }
    });

    it('returns nothing when the route has no distance', () => {
        expect(makeTable(straightRoute([0]))._cloudSamplePoints()).toEqual([]);
        expect(makeTable([{ icao: 'DEP', lat: 40, lon: -80 }])._cloudSamplePoints()).toEqual([]);
        expect(makeTable([])._cloudSamplePoints()).toEqual([]);
    });
});

// ── Bracket search + interpolation ─────────────────────────────────────────────

describe('_cloudSamplePoints — interpolation', () => {
    it('interpolates lat/lon and ETA inside the correct leg', () => {
        // Two legs of 25 and 50 nm; n = ceil(75/25) = 3, so samples land at
        // 0, 37.5 and 75 nm. 37.5 nm is 25% of the way along the SECOND leg.
        const wps = straightRoute([25, 50], { etaHrs: [0, 1, 3] });
        const pts = makeTable(wps)._cloudSamplePoints();

        expect(pts).toHaveLength(3);
        expect(pts.map(p => p.distNm)).toEqual([0, 37.5, 75]);

        // lat 41 -> 42 over the second leg, 25% along
        expect(pts[1].lat).toBeCloseTo(41.25, 9);
        expect(pts[1].lon).toBeCloseTo(-80, 9);
        // ETA 1 h -> 3 h over the second leg, 25% along = 1.5 h
        expect(pts[1].etaMs).toBe(T0 + 1.5 * HOUR);

        expect(pts[0].etaMs).toBe(T0);
        expect(pts[2].etaMs).toBe(T0 + 3 * HOUR);
    });
});

// ── Review finding 2 part B: all-or-nothing ETA ────────────────────────────────

describe('_cloudSamplePoints — ETA is all-or-nothing', () => {
    it('carries a real ETA on every point when the route has full timing', () => {
        const pts = makeTable(straightRoute([100, 100], { etaHrs: [0, 1, 2] }))._cloudSamplePoints();
        expect(pts.length).toBeGreaterThan(2);
        expect(pts.every(p => p.etaMs != null)).toBe(true);
        // Monotonic, and bracketed by the route's own endpoints.
        for (let i = 1; i < pts.length; i++) expect(pts[i].etaMs).toBeGreaterThan(pts[i - 1].etaMs);
        expect(pts[0].etaMs).toBe(T0);
        expect(pts[pts.length - 1].etaMs).toBe(T0 + 2 * HOUR);
    });

    it('nulls EVERY etaMs when the departure has no ETA', () => {
        // The case review finding 2 part A fixed at source: before it, wp[0]._eta
        // was structurally null on every route, so only the FIRST leg's points
        // came back null and the chart silently mixed "now" with real forecast
        // hours. Whatever the cause, the fallback has to be uniform.
        const wps = straightRoute([100, 100], { etaHrs: [0, 1, 2] });
        wps[0]._eta = null;
        const pts = makeTable(wps)._cloudSamplePoints();

        expect(pts.length).toBeGreaterThan(2);
        expect(pts.every(p => p.etaMs === null)).toBe(true);
        // Per-point fallback would have left the later points non-null.
        expect(pts.some(p => p.etaMs != null)).toBe(false);
    });

    it('nulls EVERY etaMs when an interior waypoint has no ETA', () => {
        const wps = straightRoute([100, 100], { etaHrs: [0, 1, 2] });
        wps[1]._eta = null;
        const pts = makeTable(wps)._cloudSamplePoints();
        expect(pts.every(p => p.etaMs === null)).toBe(true);
    });

    it('nulls every etaMs when the route has no timing at all', () => {
        const pts = makeTable(straightRoute([100, 100]))._cloudSamplePoints();
        expect(pts.length).toBeGreaterThan(2);
        expect(pts.every(p => p.etaMs === null)).toBe(true);
    });
});

// ── Review finding 6: coordinate completeness ──────────────────────────────────

describe('_cloudSamplePoints — coordinate completeness guard', () => {
    it('returns [] when an interior waypoint has no coordinates', () => {
        // _legDist on the survivor after the gap measures the leg FROM the
        // dropped waypoint, so both the distance axis and the interpolated
        // lat/lon would be wrong — sample points would land off-route.
        const wps = straightRoute([100, 100], { etaHrs: [0, 1, 2] });
        wps[1].lat = null;
        wps[1].lon = null;
        expect(makeTable(wps)._cloudSamplePoints()).toEqual([]);
    });

    it('returns [] when the destination has no coordinates', () => {
        const wps = straightRoute([100, 100], { etaHrs: [0, 1, 2] });
        wps[2].lat = null;
        expect(makeTable(wps)._cloudSamplePoints()).toEqual([]);
    });

    it('still samples normally when every waypoint has coordinates', () => {
        const wps = straightRoute([100, 100], { etaHrs: [0, 1, 2] });
        const pts = makeTable(wps)._cloudSamplePoints();
        expect(pts.length).toBe(8);          // ceil(200/25)
        expect(pts.every(p => p.lat != null && p.lon != null)).toBe(true);
    });
});
