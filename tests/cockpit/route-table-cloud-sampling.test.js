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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const REAL_STALENESS = new Function(readFileSync(join(__dirname, '../../web/shared/cloud-forecast.js'), 'utf8') + '\nreturn cloudStaleness;')();

describe('_refreshCloudForecast (review of #213): freshness from the stored record, one fetch at a time, newest wins, 429 back-off', () => {
    const route = (lat0 = 40) => {
        const r = straightRoute([30, 30]);
        r.forEach((w) => { w.lat += lat0 - 40; });
        return r;
    };
    const hashOf = (rt) => globalThis.cloudRouteHash(rt._cloudSamplePoints());
    let calls, pending, stored, hangCurrent, slowStore;
    /** A store whose fetches resolve when the test says so; saves only when opts.isCurrent() allows. */
    class FakeStore {
        constructor() { this._data = stored; }
        async load() { this._data = stored; return stored; }
        current() { return hangCurrent ? new Promise(() => {}) : Promise.resolve(slowStore ? undefined : stored); }
        fetchAndStore(points, opts = {}) {
            const call = { points, opts };
            calls.push(call);
            return new Promise((resolve, reject) => {
                call.resolve = (model = 'RRFS') => {
                    if (opts.isCurrent && !opts.isCurrent()) return resolve(null);
                    stored = { routeHash: globalThis.cloudRouteHash(points), fetchedAt: new Date().toISOString(), model };
                    this._data = stored;
                    resolve(stored);
                };
                call.reject = reject;
                pending.push(call);
            });
        }
    }
    const flush = () => new Promise((r) => setTimeout(r, 0));
    beforeEach(() => {
        calls = []; pending = []; stored = null; hangCurrent = false; slowStore = false;
        globalThis.cloudStaleness = REAL_STALENESS;
        globalThis.app = { networkMode: { mode: 'home' } };
        globalThis.cloudRouteHash = (pts) => pts.map((p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join('|');
        globalThis.CloudForecastStore = FakeStore;
        vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    });
    afterEach(() => { vi.useRealTimers(); delete globalThis.app; delete globalThis.CloudForecastStore; delete globalThis.cloudRouteHash; delete globalThis.cloudStaleness; });
    const noTimers = (rt) => { rt._scheduleCloudRetry = () => { rt._retryScheduled = (rt._retryScheduled || 0) + 1; }; return rt; };

    it('the same route is fetched again only once its stored forecast is over an hour old', async () => {
        const rt = makeTable(route());
        const p = rt._refreshCloudForecast(); await flush(); calls[0].resolve(); await p;
        await rt._refreshCloudForecast();
        expect(calls).toHaveLength(1);
        vi.setSystemTime(T0 + 61 * 60_000);
        const p2 = rt._refreshCloudForecast(); await flush(); calls[1].resolve(); await p2;
        expect(calls).toHaveLength(2);
    });

    it('after a restart (new table) a stored forecast 2 min old for this route is used, not refetched', async () => {
        const rt0 = makeTable(route());
        stored = { routeHash: hashOf(rt0), fetchedAt: new Date(T0 - 2 * 60_000).toISOString(), model: 'RRFS' };
        await makeTable(route())._refreshCloudForecast();
        expect(calls).toHaveLength(0);
    });

    it('a stored forecast "from the future" (clock moved back) counts as stale', async () => {
        const rt = makeTable(route());
        stored = { routeHash: hashOf(rt), fetchedAt: new Date(T0 + 3 * 3600_000).toISOString(), model: 'RRFS' };
        const p = rt._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(1);
        calls[0].resolve(); await p;
    });

    it('two overlapping refreshes for the same route: one request', async () => {
        const rt = makeTable(route());
        const a = rt._refreshCloudForecast(); await flush();
        const b = rt._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(1);
        calls[0].resolve(); await Promise.all([a, b]);
    });

    it('two refreshes in the same tick (before either has read the store): still one request', async () => {
        const rt = makeTable(route());
        const a = rt._refreshCloudForecast(), b = rt._refreshCloudForecast();
        await flush(); await flush();
        expect(calls).toHaveLength(1);
        calls[0].resolve(); await Promise.all([a, b]);
    });

    it('route A (slow) then B: A finishing last does not overwrite B in the cache', async () => {
        const rt = makeTable(route(40));
        const a = rt._refreshCloudForecast(); await flush();          // A starts
        rt._waypoints = route(42);
        const b = rt._refreshCloudForecast(); await flush();          // B starts
        const hashB = hashOf(rt);
        calls[1].resolve(); await b;                                  // B lands
        calls[0].resolve(); await a;                                  // A lands late
        expect(stored.routeHash).toBe(hashB);
    });

    it('a 429: no further requests for 5 minutes, then again', async () => {
        const rt = noTimers(makeTable(route()));
        const p = rt._refreshCloudForecast(); await flush();
        calls[0].reject(Object.assign(new Error('Cloud fetch failed (RRFS): 429'), { status: 429 })); await p;
        await rt._refreshCloudForecast(); await rt._refreshCloudForecast();
        expect(calls).toHaveLength(1);
        vi.setSystemTime(T0 + 5 * 60_000 + 1);
        const p2 = rt._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(2);
        calls[1].resolve(); await p2;
    });

    it('refreshing a good RRFS forecast for the same route asks RRFS only (no downgrade to GFS on a hiccup)', async () => {
        const rt = makeTable(route());
        stored = { routeHash: hashOf(rt), fetchedAt: new Date(T0 - 2 * 3600_000).toISOString(), model: 'RRFS' };
        const p = rt._refreshCloudForecast(); await flush();
        expect(calls[0].opts.rrfsOnly).toBe(true);
        calls[0].resolve(); await p;
        // over 3 h old: GFS allowed again (a stale RRFS forecast must not block a fresh GFS one)
        vi.setSystemTime(T0 + 4 * 3600_000);
        const p3 = rt._refreshCloudForecast(); await flush();
        expect(calls[1].opts.rrfsOnly).toBeFalsy();
        calls[1].resolve('GFS'); await p3;
        // a different route: both models allowed
        rt._waypoints = route(43);
        const p2 = rt._refreshCloudForecast(); await flush();
        expect(calls[2].opts.rrfsOnly).toBeFalsy();
        calls[2].resolve(); await p2;
    });

    it('switching back to a route whose stored forecast is fresh (no fetch) still stops an older request for another route from saving', async () => {
        const rtB = makeTable(route(42));
        stored = { routeHash: hashOf(rtB), fetchedAt: new Date(T0 - 10 * 60_000).toISOString(), model: 'RRFS' };
        const rt = makeTable(route(40));
        const a = rt._refreshCloudForecast(); await flush();          // A starts
        rt._waypoints = route(42);
        await rt._refreshCloudForecast();                             // B: fresh in store, returns
        expect(calls).toHaveLength(1);
        calls[0].resolve(); await a;                                  // A lands late
        expect(stored.routeHash).toBe(hashOf(rtB));
    });

    it('A -> B -> A while A1 is still in flight: no duplicate A request (claims per route), and A1 saves', async () => {
        const rt = noTimers(makeTable(route(40)));
        const a1 = rt._refreshCloudForecast(); await flush();
        rt._waypoints = route(42);
        const b = rt._refreshCloudForecast(); await flush();
        calls[1].reject(new Error('503')); await b;                   // B fails fast
        rt._cloudRetryAfter = 0;                                      // (ignore the back-off for this check)
        rt._waypoints = route(40);
        await rt._refreshCloudForecast(); await flush();              // A1 still in flight: no second A request
        expect(calls).toHaveLength(2);
        calls[0].resolve(); await a1;                                 // A1 lands and saves A (A is wanted again)
        expect(stored.routeHash).toBe(hashOf(rt));
    });

    it('a claim stuck on a hung IndexedDB expires after 150 s (longer than a request can legitimately take)', async () => {
        const rt = makeTable(route());
        hangCurrent = true;
        rt._refreshCloudForecast();                                   // never finishes
        await flush();
        hangCurrent = false;
        await rt._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(0);                                // still claimed
        vi.setSystemTime(T0 + 151_000);
        const p = rt._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(1);
        calls[0].resolve(); await p;
    });

    it('any failure backs off 60 s (edits come in bursts), and a retry is scheduled', async () => {
        const rt = noTimers(makeTable(route()));
        const p = rt._refreshCloudForecast(); await flush();
        calls[0].reject(new Error('Cloud fetch failed (RRFS): 503')); await p;
        await rt._refreshCloudForecast(); await rt._refreshCloudForecast();
        expect(calls).toHaveLength(1);
        expect(rt._retryScheduled).toBeGreaterThan(0);
        vi.setSystemTime(T0 + 61_000);
        const p2 = rt._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(2);
        calls[1].resolve(); await p2;
    });

    it('away from home/internet: never', async () => {
        globalThis.app.networkMode.mode = 'stratux';
        await makeTable(route())._refreshCloudForecast();
        expect(calls).toHaveLength(0);
    });
});

describe('_refreshCloudForecast (review of 35ca27f)', () => {
    const route = (lat0 = 40) => { const r = straightRoute([30, 30]); r.forEach((w) => { w.lat += lat0 - 40; }); return r; };
    let calls, stored, current;
    class Store {
        current() { return Promise.resolve(current === 'slow' ? undefined : stored); }
        fetchAndStore(points, opts = {}) {
            const c = { points, opts }; calls.push(c);
            return new Promise((resolve, reject) => {
                c.resolve = () => { if (opts.isCurrent && !opts.isCurrent()) return resolve(null);
                    stored = { routeHash: globalThis.cloudRouteHash(points), fetchedAt: new Date().toISOString(), model: 'RRFS' }; resolve(stored); };
                c.reject = reject;
            });
        }
    }
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const noTimers = (rt) => { rt._scheduleCloudRetry = () => { rt._retries = (rt._retries || 0) + 1; }; return rt; };
    beforeEach(() => {
        calls = []; stored = null; current = null;
        globalThis.app = { networkMode: { mode: 'home' } };
        globalThis.cloudRouteHash = (pts) => pts.map((p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join('|');
        globalThis.cloudStaleness = REAL_STALENESS;
        globalThis.CloudForecastStore = Store;
        vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    });
    afterEach(() => { vi.useRealTimers(); delete globalThis.app; delete globalThis.CloudForecastStore; delete globalThis.cloudRouteHash; delete globalThis.cloudStaleness; });

    it('an older superseded request finishing (null) does not clear a newer 429 back-off', async () => {
        const rt = noTimers(makeTable(route(40)));
        const a = rt._refreshCloudForecast(); await flush();
        rt._waypoints = route(42);
        const b = rt._refreshCloudForecast(); await flush();
        calls[1].reject(Object.assign(new Error('429'), { status: 429 })); await b;
        calls[0].resolve(); await a;                                  // superseded: null
        expect(rt._cloudRetryAfter).toBeGreaterThan(Date.now());
    });
    it('a superseded request failing (not 429) does not set a back-off for the route now wanted', async () => {
        const rt = noTimers(makeTable(route(40)));
        const a = rt._refreshCloudForecast(); await flush();
        rt._waypoints = route(42);
        const b = rt._refreshCloudForecast(); await flush();
        calls[1].resolve(); await b;
        calls[0].reject(new Error('TimeoutError')); await a;
        expect(rt._cloudRetryAfter || 0).toBeLessThanOrEqual(Date.now());
    });
    it('IndexedDB too slow to answer: no fetch this time (not treated as "nothing stored")', async () => {
        current = 'slow';
        await makeTable(route())._refreshCloudForecast(); await flush();
        expect(calls).toHaveLength(0);
    });
    it('the route cut to one point: an older request for the previous route no longer saves', async () => {
        const rt = makeTable(route(40));
        const a = rt._refreshCloudForecast(); await flush();
        rt._waypoints = rt._waypoints.slice(0, 1);
        await rt._refreshCloudForecast();
        calls[0].resolve(); await a;
        expect(stored).toBeNull();
    });
    it('retries stop after three failures in a row, with a growing delay; a success resets them', async () => {
        const rt = makeTable(route());
        const delays = [];
        rt._scheduleCloudRetry = function () { delays.push(this._cloudRetryAfter - Date.now()); };
        for (let i = 0; i < 4; i++) {
            const p = rt._refreshCloudForecast(); await flush();
            calls[calls.length - 1].reject(new Error('400')); await p;
            vi.setSystemTime(rt._cloudRetryAfter + 1);
        }
        expect(delays.length).toBe(3);                               // the fourth failure schedules nothing
        expect(delays[1]).toBeGreaterThan(delays[0]);
        expect(delays[2]).toBeGreaterThan(delays[1]);
        const ok = rt._refreshCloudForecast(); await flush(); calls[calls.length - 1].resolve(); await ok;
        expect(rt._cloudFailures).toBe(0);
    });
});
