/**
 * route-table.js — fuel computation in _computeEnroute()
 *
 * Covers SDD Task 8:
 *  - the flight currently being flown always reads the live canonical fuel
 *    source (FuelState.getCurrentFuel), regardless of its flight index
 *  - the fuel-stop reset runs AFTER the arriving leg's burn is subtracted,
 *    so REM decreases monotonically into a fuel stop instead of jumping up
 *
 * route-table.js is a classic (non-ESM) script, so it is loaded with the same
 * `new Function(src + 'return Class;')()` pattern used by
 * tests/cockpit/route-planner-panel.test.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/cockpit/route-table.js'), 'utf8');
const RouteTable = new Function(src + '\nreturn RouteTable;')();

const FUEL_CAP = 40;

/** Aircraft config used by _computeEnroute. Only fuel_capacity_gal matters for the
 *  segment-based routes — every leg's burn is supplied explicitly via segment
 *  gph/ete_min. `perf` supplies extra `performance.*` values for the seg-less
 *  route, whose burn comes from the config cruise gph/speed fallbacks instead. */
function installGlobals({ currentFuel, startFuel, perf = {} }) {
    globalThis.CockpitConfig = {
        aircraft(path) {
            if (path === 'performance.fuel_capacity_gal') return FUEL_CAP;
            if (Object.prototype.hasOwnProperty.call(perf, path)) return perf[path];
            return null;
        },
        // _getCellValue reads the caution/warning thresholds; null falls through to
        // its own `|| 8` / `|| 4` defaults.
        get() { return null; },
    };
    globalThis.FlyTabPlanning = {
        bearing: () => 0,
        windCorrectedMagHdg: () => 0,
        crossTrackDistanceNm: () => 0,
    };
    globalThis.FuelState = {
        getCurrentFuel: () => ({ gallons: currentFuel, source: 'tank_state' }),
        getStartFuel:   () => ({ gallons: startFuel,   source: 'tic' }),
    };
}

/** One CRZ segment burning exactly `gal` gallons over `gal/10` hours at 10 gph. */
function seg(gal) {
    return [{ phase: 'CRZ', gph: 10, ete_min: gal * 6, tas: 120, gs: 120, dist: gal * 12 }];
}

/**
 * KLKR -> ENO (VOR) -> KFGX (fuel stop) -> KLWA
 * Flight 0 = wp0..wp2, Flight 1 = wp2..wp3; wp2 is the shared boundary and is
 * annotated _flightIndex = 1 by _buildFlights().
 * Each leg burns 10 gal.
 */
function makeRoute(fuelStopOpts = {}) {
    return [
        { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
        { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _segments: seg(10) },
        { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, _segments: seg(10), ...fuelStopOpts },
        { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
    ];
}

/**
 * Same route, but with NO `_segments` on any waypoint — every leg therefore falls
 * through to the seg-less `else` branch of _computeEnroute's per-waypoint chain,
 * which accumulates fuelBurned from the config gph/speed fallbacks. Used with
 * SEGLESS_PERF below, each 120 nm leg burns exactly 10 gal (120 nm / 120 kt × 10 gph).
 */
function makeSeglessRoute(fuelStopOpts = {}) {
    return [
        { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
        { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120 },
        { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, ...fuelStopOpts },
        { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120 },
    ];
}

const SEGLESS_PERF = {
    'performance.cruise_gph': 10,
    'performance.cruise_speed_kt': 120,
};

function makeTable(waypoints, activeIndex) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints   = waypoints;
    rt._activeIndex = activeIndex;
    rt._flights     = [];
    rt._destIcao    = 'KLWA';
    rt._cruisePower = null;
    rt._lastSituation = null;
    rt._emitLegUpdate = () => {};   // DOM/event plumbing not under test
    return rt;
}

afterEach(() => {
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.FuelState;
});

// ── Step 2: active flight uses the live canonical source ───────────────────

describe('_computeEnroute — active flight start fuel', () => {
    it('uses FuelState.getCurrentFuel() when the active waypoint is in flight 1', () => {
        // Live tanks hold 12 gal after a partial fill at the stop. The old code
        // took flight 1's start fuel from _plannedStartFuel ?? fuelCap (40).
        installGlobals({ currentFuel: 12, startFuel: 30 });
        const wps = makeRoute();
        const rt = makeTable(wps, 2);
        rt._computeEnroute();

        expect(wps[2]._flightIndex).toBe(1);          // active wp really is in flight 1
        expect(wps[2]._fuelRem).toBeCloseTo(2, 6);    // 12 live − 10 burned on the active leg
        expect(wps[2]._fuelRem).not.toBeCloseTo(FUEL_CAP - 10, 6);  // not the full-tank assumption
        expect(wps[3]._fuelRem).toBeCloseTo(-8, 6);   // 12 − 20
    });

    it('uses getCurrentFuel(), not getStartFuel(), for flight 0 as well', () => {
        installGlobals({ currentFuel: 30, startFuel: 25 });
        const wps = makeRoute();
        const rt = makeTable(wps, 0);
        rt._computeEnroute();

        expect(wps[0]._fuelRem).toBeCloseTo(30, 6);
    });
});

// ── Step 5: fuel-stop reset ordering ───────────────────────────────────────

describe('_computeEnroute — fuel-stop reset ordering', () => {
    it('subtracts the arriving leg burn before refuelling (fill to capacity)', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeRoute();                       // KFGX has no fuel_add_gal → fill to cap
        const rt = makeTable(wps, 0);
        rt._computeEnroute();

        expect(wps[0]._fuelRem).toBeCloseTo(30, 6);
        expect(wps[1]._fuelRem).toBeCloseTo(20, 6);
        // Arrival at the fuel stop: 30 − 20 burned. Pre-fix this read 30 (a jump UP).
        expect(wps[2]._fuelRem).toBeCloseTo(10, 6);
        expect(wps[2]._fuelAdded).toBeCloseTo(30, 6);  // topped 10 → 40, not 20 → 40
        expect(wps[3]._fuelRem).toBeCloseTo(30, 6);    // 40 − 10

        // REM must never increase on the way in to the stop.
        const inbound = [wps[0]._fuelRem, wps[1]._fuelRem, wps[2]._fuelRem];
        for (let i = 1; i < inbound.length; i++) {
            expect(inbound[i]).toBeLessThanOrEqual(inbound[i - 1]);
        }
    });

    it('subtracts the arriving leg burn before refuelling (explicit partial fill)', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeRoute({ fuel_add_gal: 5 });
        const rt = makeTable(wps, 0);
        rt._computeEnroute();

        expect(wps[2]._fuelRem).toBeCloseTo(10, 6);    // pre-fix: 15
        expect(wps[2]._fuelAdded).toBeCloseTo(5, 6);
        expect(wps[3]._fuelRem).toBeCloseTo(5, 6);     // (10 + 5) − 10
    });

    // Guards the placement of the reset block itself. The reset sits AFTER the whole
    // if / else-if / else chain because the seg-less `else` branch also accumulates
    // fuelBurned. Move it back inside the `segs.length > 0 && i > 0` branch and a
    // route without _segments never refuels at all — _fuelAdded stays undefined and
    // the post-stop legs keep draining the original tank.
    it('refuels at the stop even when no waypoint has _segments', () => {
        installGlobals({ currentFuel: 30, startFuel: 30, perf: SEGLESS_PERF });
        const wps = makeSeglessRoute();                // fill to capacity (no fuel_add_gal)
        const rt = makeTable(wps, 0);
        rt._computeEnroute();

        // Sanity: these legs really are taking the seg-less path.
        for (const wp of wps) expect(wp._segments).toBeUndefined();
        expect(wps[1]._fuel).toBeCloseTo(10, 6);       // 120 nm / 120 kt × 10 gph

        expect(wps[0]._fuelRem).toBeCloseTo(30, 6);
        expect(wps[1]._fuelRem).toBeCloseTo(20, 6);
        expect(wps[2]._fuelRem).toBeCloseTo(10, 6);    // arrival: 30 − 20 burned
        expect(wps[2]._fuelAdded).toBeCloseTo(30, 6);  // topped 10 → 40; undefined if the reset never fires
        expect(wps[3]._fuelRem).toBeCloseTo(30, 6);    // 40 − 10; 0 if the reset never fires
    });
});

// ── Step 5: explicit fill is clamped to remaining tank capacity ─────────────

describe('_computeEnroute — explicit fuel_add_gal over-capacity clamp', () => {
    it('clamps fuel_add_gal to the headroom left in the tanks', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        // 100 gal requested into a 40 gal tank holding 10 on arrival → only 30 fits.
        const wps = makeRoute({ fuel_add_gal: 100 });
        const rt = makeTable(wps, 0);
        rt._computeEnroute();

        expect(wps[2]._fuelRem).toBeCloseTo(10, 6);    // arrival fuel, unchanged by the clamp
        expect(wps[2]._fuelAdded).toBeCloseTo(30, 6);  // clamped: min(100, 40 − 10), not 100
        expect(wps[2]._fuelRem + wps[2]._fuelAdded).toBeLessThanOrEqual(FUEL_CAP);
        expect(wps[3]._fuelRem).toBeCloseTo(30, 6);    // 40 − 10; unclamped would read 100
    });
});

// ── Task 10: passed multi-segment legs must not keep stale segment fuel ─────

/**
 * A two-segment leg (CLB + CRZ) — the shape that _renderTable draws as one
 * SegmentRow per phase, reading seg._fuel / seg._fuelRem instead of the
 * waypoint-level fields. CLB burns 3.0 gal (15 gph × 12 min), CRZ burns 8.0
 * (10 gph × 48 min); 11.0 gal for the leg, 120 nm total.
 */
function clbCrzSegs() {
    return [
        { phase: 'CLB', gph: 15, ete_min: 12, tas: 100, gs: 100, dist:  20, percent_power: 100 },
        { phase: 'CRZ', gph: 10, ete_min: 48, tas: 120, gs: 120, dist: 100, percent_power:  65 },
    ];
}

/** KLKR -> ENO (multi-segment leg) -> KLWA. No intermediate airport, so
 *  _buildFlights produces a single flight and no fuel-stop reset is involved. */
function makeMultiSegRoute() {
    return [
        { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78, index: 0 },
        { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, index: 1, _legDist: 120, _segments: clbCrzSegs() },
        { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, index: 2, _legDist: 120, _segments: seg(10) },
    ];
}

describe('_computeEnroute — passed multi-segment legs', () => {
    it('clears segment-level fuel fields once the leg is behind the aircraft', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeMultiSegRoute();
        const rt = makeTable(wps, 1);
        rt._computeEnroute();

        // While the leg is active its segments carry real numbers.
        const [clb, crz] = wps[1]._segments;
        expect(clb._fuel).toBeCloseTo(3, 6);
        expect(crz._fuelRem).toBeCloseTo(19, 6);   // 30 − 11

        // Aircraft crosses ENO. The compute loop starts at _activeIndex, so wp1's
        // segments are never revisited — only the "Mark passed waypoints" pass can
        // clear them.
        rt._activeIndex = 2;
        rt._computeEnroute();

        expect(wps[1]._fuelRem).toBeNull();        // waypoint level (already correct)
        for (const s of wps[1]._segments) {
            expect(s._fuel).toBeNull();
            expect(s._fuelRem).toBeNull();
            expect(s._tas).toBeNull();
            expect(s._pwr).toBeNull();
        }
    });

    it('renders em-dashes, not stale numbers, in the passed leg FUEL/REM cells', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeMultiSegRoute();
        const rt = makeTable(wps, 1);
        rt._computeEnroute();
        rt._activeIndex = 2;
        rt._computeEnroute();

        const segs = wps[1]._segments;
        for (let si = 0; si < segs.length; si++) {
            expect(rt._getCellValue(wps[1], 'fuel', segs[si], si)).toBe('—');
            expect(rt._getCellValue(wps[1], 'fuel_rem', segs[si], si)).toBe('—');
        }
    });

    it('does not clear segments of legs still ahead of the aircraft', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeMultiSegRoute();
        const rt = makeTable(wps, 1);
        rt._computeEnroute();

        // wp1 is the ACTIVE leg — not passed — so its segments keep their numbers.
        const [clb, crz] = wps[1]._segments;
        expect(clb._fuel).toBeCloseTo(3, 6);
        expect(crz._fuel).toBeCloseTo(8, 6);
        expect(rt._getCellValue(wps[1], 'fuel', crz, 1)).toBe('8.0');
        expect(rt._getCellValue(wps[1], 'fuel_rem', crz, 1)).toBe('19.0');
    });

    /**
     * Error direction: the stale figure is OPTIMISTIC whenever real burn beat the
     * plan. Here the pilot crosses ENO with 12 gal in the tanks (the plan said 19).
     * Pre-fix the passed CRZ row still read 19.0 — 7 gal MORE than the aircraft
     * actually holds, on a row sitting directly above live rows computed from 12.
     */
    it('never shows a passed-leg REM higher than the live fuel state', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeMultiSegRoute();
        const rt = makeTable(wps, 1);
        rt._computeEnroute();

        installGlobals({ currentFuel: 12, startFuel: 30 });   // burned more than planned
        rt._activeIndex = 2;
        rt._computeEnroute();

        for (const s of wps[1]._segments) {
            expect(s._fuelRem == null || s._fuelRem <= 12).toBe(true);
        }
        expect(wps[2]._fuelRem).toBeCloseTo(2, 6);   // live projection: 12 − 10
    });
});

// ── Step 3: dead _plannedStartFuel back-fill is gone ───────────────────────

describe('_computeEnroute — _plannedStartFuel', () => {
    it('no longer writes _plannedStartFuel onto flights', () => {
        installGlobals({ currentFuel: 30, startFuel: 30 });
        const wps = makeRoute();
        const rt = makeTable(wps, 0);
        rt._computeEnroute();

        for (const f of rt._flights) {
            expect(f._plannedStartFuel).toBeUndefined();
        }
    });
});
