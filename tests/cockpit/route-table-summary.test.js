/**
 * route-table.js — route-strip handle summary (_updateSummary) and the
 * destination field published by _emitRouteChange().
 *
 * Covers SDD Task 9:
 *  - the "DEST:X.X" reserve figure reads the canonical fuel source
 *    (FuelState.getCurrentFuel) rather than the engine panel's raw field
 *  - that figure is scoped to the ACTIVE FLIGHT's own destination (which may be
 *    a fuel stop), not the whole remaining trip distance
 *  - the planned fallback and the emitted flight_plan.destination both resolve
 *    the destination with the same APT walk-back the header label already used,
 *    so trailing missed-approach / hold fixes no longer masquerade as the
 *    destination
 *
 * route-table.js is a classic (non-ESM) script, so it is loaded with the same
 * `new Function(src + 'return Class;')()` pattern used by
 * tests/cockpit/route-table-fuel.test.js.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/cockpit/route-table.js'), 'utf8');
const RouteTable = new Function(src + '\nreturn RouteTable;')();

const FUEL_CAP = 40;

/** Config stub. `perf` supplies performance.* values; `get` covers the
 *  enginePage.* caution/warning thresholds _updateSummary colour-codes with. */
function installGlobals({ currentFuel, perf = {}, fuelSource = 'tank_state', fuelStale = false }) {
    globalThis.CockpitConfig = {
        aircraft(path) {
            if (path === 'performance.fuel_capacity_gal') return FUEL_CAP;
            if (Object.prototype.hasOwnProperty.call(perf, path)) return perf[path];
            return null;
        },
        get() { return null; },   // fall back to the built-in 8/4 gal thresholds
    };
    globalThis.FlyTabPlanning = {
        bearing: () => 0,
        windCorrectedMagHdg: () => 0,
        crossTrackDistanceNm: () => 0,
    };
    globalThis.FuelState = {
        getCurrentFuel: () => ({ gallons: currentFuel, source: fuelSource, stale: fuelStale }),
        getStartFuel:   () => ({ gallons: currentFuel, source: 'tic' }),
    };
}

/** 120 kt / 10 gph so every 120 nm leg burns exactly 10 gal. */
const PERF = {
    'performance.cruise_gph': 10,
    'performance.cruise_speed_kt': 120,
};

/** One CRZ segment burning exactly `gal` gallons over `gal/10` hours at 10 gph. */
function seg(gal) {
    return [{ phase: 'CRZ', gph: 10, ete_min: gal * 6, tas: 120, gs: 120, dist: gal * 12 }];
}

function makeTable(waypoints, activeIndex) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints   = waypoints;
    rt._activeIndex = activeIndex;
    rt._flights     = [];
    rt._destIcao    = null;
    rt._cruisePower = null;
    rt._lastSituation = null;      // no GPS → cruiseSpeed comes from config
    rt._editMode    = false;
    rt._editBtn     = null;
    rt._saveBtn     = null;
    rt._emitLegUpdate = () => {};  // DOM/event plumbing not under test
    const summaryEl = document.createElement('div');
    summaryEl.className = 'handle-summary';
    rt._handleEl = { querySelector: (sel) => (sel === '.handle-summary' ? summaryEl : null) };
    rt._summaryEl = summaryEl;     // test-only handle for reading the rendered HTML
    return rt;
}

/** Parse the rendered fuel badge — `{ label, gal }` for `DEST:12.3` / `KFGX:15.0`.
 *  Anchored on the badge span's own style so the ETE stat (`2:30`) can't match. */
function destBadge(rt) {
    const m = /font-weight:700">([A-Z0-9?]+):(-?\d+\.\d)</.exec(rt._summaryEl.innerHTML);
    return m ? { label: m[1], gal: parseFloat(m[2]) } : null;
}

/** Extract the numeric value out of the rendered fuel badge. */
function destFuel(rt) {
    const b = destBadge(rt);
    return b ? b.gal : null;
}

afterEach(() => {
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.FuelState;
    delete window.enginePanel;
});

// ── Step 2: DEST reserve is fuel-stop aware ────────────────────────────────

describe('_updateSummary — DEST reserve is scoped to the active flight', () => {
    it('projects to the active flight\'s own destination (the fuel stop), not the trip end', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        // Live fuel flow only — the fuel QUANTITY must come from FuelState.
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        // KLKR → ENO → KFGX (fuel stop) → KLWA, 120 nm legs, 60 nm to run on the
        // active leg. Active flight (0) ends at KFGX: 60 + 120 = 180 nm to go.
        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _liveDist: 60, _segments: seg(10) },
            { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, _segments: seg(10) },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 1);
        rt._computeEnroute();
        rt._updateSummary();

        expect(wps[1]._flightIndex).toBe(0);           // active wp really is in flight 0
        expect(rt._flights[0].destWpIndex).toBe(2);    // flight 0 ends at the fuel stop

        // 30 gal − (180 nm / 120 kt) × 10 gph = 15.0
        expect(destFuel(rt)).toBeCloseTo(15.0, 6);
        // Trip-wide (60 + 120 + 120 = 300 nm) would read 5.0 — the pre-fix figure.
        expect(destFuel(rt)).not.toBeCloseTo(5.0, 6);

        // The header label still names the TRIP's final destination even though the
        // DEST figure is now fuel at the active flight's endpoint.
        expect(rt._summaryEl.innerHTML).toContain('KLWA');
        // …and because the two differ, the badge names the airport IT describes.
        // A bare `DEST:` here reads as 15.0 gal at KLWA when arriving KLWA without
        // taking the stop is 5.0 — a 10 gal optimistic misread.
        expect(destBadge(rt).label).toBe('KFGX');
    });

    it('scopes to flight 1 once the active waypoint is past the fuel stop', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        // Same trip, but now airborne on the KFGX → KLWA leg with 60 nm to run.
        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _segments: seg(10) },
            { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, _segments: seg(10) },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _liveDist: 60, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 3);
        rt._computeEnroute();
        rt._updateSummary();

        expect(wps[3]._flightIndex).toBe(1);           // active wp is in flight 1
        expect(rt._flights[1].destWpIndex).toBe(3);

        // 30 gal − (60 nm / 120 kt) × 10 gph = 25.0. A hard-wired flight 0 lookup
        // would leave the loop empty (dest index 2 < active index 3) and silently
        // fall through to the planned figure of 20.0.
        expect(destFuel(rt)).toBeCloseTo(25.0, 6);
        expect(destFuel(rt)).not.toBeCloseTo(20.0, 6);

        // Past the stop the active flight's destination IS the header destination,
        // so the badge keeps the plain `DEST:` label.
        expect(destBadge(rt).label).toBe('DEST');
    });

    it('uses FuelState.getCurrentFuel(), not enginePanel.lastData.fuel_remaining_gal', () => {
        installGlobals({ currentFuel: 20, perf: PERF });
        // Engine panel disagrees with the canonical source; canonical must win.
        window.enginePanel = { lastData: { fuel_remaining_gal: 35, fuel_flow_gph: 10 } };

        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 0);
        rt._computeEnroute();
        rt._updateSummary();

        // 20 gal − (120 nm / 120 kt) × 10 gph = 10.0
        expect(destFuel(rt)).toBeCloseTo(10.0, 6);
        // The engine-panel quantity would have read 25.0.
        expect(destFuel(rt)).not.toBeCloseTo(25.0, 6);
    });

    it('falls back to the trip-wide distance when there is no flight-split data', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        // _flights empty (e.g. _updateSummary reached before _computeEnroute ran).
        const wps = [
            { icao: 'KLKR', type: 'APT', _liveDist: 60 },
            { icao: 'KLWA', type: 'APT', _legDist: 120, _fuelRem: 7 },
        ];
        const rt = makeTable(wps, 0);
        rt._flights = [];
        rt._updateSummary();

        // Trip-wide 60 + 120 = 180 nm → 30 − 15 = 15.0. Zeroing the fallback instead
        // would drop through to the planned 7.0.
        expect(destFuel(rt)).toBeCloseTo(15.0, 6);
        expect(destFuel(rt)).not.toBeCloseTo(7.0, 6);
    });
});

// ── Fix round 1: the badge names the airport it actually describes ─────────

describe('_updateSummary — fuel badge label', () => {
    /** KLKR → ENO → KFGX (fuel stop) → KLWA. `liveOnIndex` is the waypoint the
     *  aircraft is inbound to, with 60 nm left to run on that leg. */
    function fuelStopRoute(liveOnIndex) {
        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _segments: seg(10) },
            { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, _segments: seg(10) },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
        ];
        wps[liveOnIndex]._liveDist = 60;
        return wps;
    }

    it('names the fuel stop when the badge does not describe the header destination', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        const rt = makeTable(fuelStopRoute(1), 1);
        rt._computeEnroute();
        rt._updateSummary();

        // Handle label names KLWA; the figure is arrival fuel at KFGX. Arriving KLWA
        // without taking the stop is 5.0 gal, so a `DEST:15.0` badge beside a KLWA
        // label is optimistic by 10 gal — the badge must name KFGX instead.
        expect(rt._summaryEl.innerHTML).toContain('KLWA');
        expect(destBadge(rt)).toEqual({ label: 'KFGX', gal: 15.0 });
        expect(rt._summaryEl.innerHTML).not.toContain('DEST:');
    });

    it('keeps the plain DEST label on a single-flight trip', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _liveDist: 60, _segments: seg(10) },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 1);
        rt._computeEnroute();
        rt._updateSummary();

        expect(rt._flights).toHaveLength(1);
        expect(destBadge(rt)).toEqual({ label: 'DEST', gal: 15.0 });
    });

    // Changed by SDD Task 14. This branch used to be trip-scoped: with no distance
    // left to run it showed `_fuelRem` at the TRIP's final airport, which on a
    // fuel-stop trip is a POST-REFUEL projection — a figure decoupled from what is in
    // the tanks now, and higher than it by the whole planned uplift (22.0 here where
    // arrival at the stop is 15.0). The live branch directly above it is scoped to the
    // active flight, so the two branches also disagreed about which airport they were
    // describing. Both are now scoped to the active flight's own destination.
    it('scopes the planned fallback to the active flight\'s destination, not the post-refuel trip end', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        const wps = [
            { icao: 'KLKR', type: 'APT', _flightIndex: 0 },
            { icao: 'KFGX', type: 'APT', _flightIndex: 1, _fuelRem: 15 },
            { icao: 'KLWA', type: 'APT', _flightIndex: 1, _fuelRem: 22 },
        ];
        const rt = makeTable(wps, 0);
        rt._flights = [
            { index: 0, dep: 'KLKR', dest: 'KFGX', depWpIndex: 0, destWpIndex: 1 },
            { index: 1, dep: 'KFGX', dest: 'KLWA', depWpIndex: 1, destWpIndex: 2 },
        ];
        rt._updateSummary();

        expect(destBadge(rt)).toEqual({ label: 'KFGX', gal: 15.0 });
    });
});

// ── Fix round 1: live fuel flow wins over planned cruise GPH ───────────────

describe('_updateSummary — fuel flow source', () => {
    // Planned cruise GPH is 10; the live figures below deliberately differ from it
    // so the two are distinguishable (they were both 10 before this round).
    const wps = () => ([
        { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
        { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
    ]);

    it('projects at LIVE fuel flow, not planned cruise GPH', () => {
        installGlobals({ currentFuel: 30, perf: PERF });   // planned 10 gph
        window.enginePanel = { lastData: { fuel_flow_gph: 16 } };

        const rt = makeTable(wps(), 0);
        rt._computeEnroute();
        rt._updateSummary();

        // 30 gal − (120 nm / 120 kt) × 16 gph = 14.0
        expect(destFuel(rt)).toBeCloseTo(14.0, 6);
        // Planned 10 gph would have read 20.0 — the optimistic figure.
        expect(destFuel(rt)).not.toBeCloseTo(20.0, 6);
    });

    it('accepts the legacy live-flow field names', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { gph: 16 } };

        const rt = makeTable(wps(), 0);
        rt._computeEnroute();
        rt._updateSummary();

        expect(destFuel(rt)).toBeCloseTo(14.0, 6);
    });

    it('falls back to planned cruise GPH when no live flow is reported', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: {} };            // engine monitor silent

        const rt = makeTable(wps(), 0);
        rt._computeEnroute();
        rt._updateSummary();

        // 30 gal − 1 h × 10 gph = 20.0
        expect(destFuel(rt)).toBeCloseTo(20.0, 6);
    });
});

// ── Fix round 1: the scoped loop must not throw on stale _flights ──────────

describe('_updateSummary — stale/absent _flights', () => {
    it('does not throw when _flights points past the end of _waypoints', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        // _flights left over from a longer route the pilot has since shortened.
        // _updateSummary runs on the 1 Hz GPS path — a throw here blanks the strip
        // on every position update.
        const wps = [
            { icao: 'KLKR', type: 'APT', _liveDist: 60 },
            { icao: 'KLWA', type: 'APT', _legDist: 120 },
        ];
        const rt = makeTable(wps, 0);
        rt._flights = [{ index: 0, dep: 'KLKR', dest: 'KFGX', depWpIndex: 0, destWpIndex: 5 }];

        expect(() => rt._updateSummary()).not.toThrow();
        // Missing waypoints contribute 0 nm: 60 + 120 = 180 nm → 30 − 15 = 15.0
        expect(destFuel(rt)).toBeCloseTo(15.0, 6);
    });

    it('does not throw when _flights is undefined', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        const wps = [
            { icao: 'KLKR', type: 'APT', _liveDist: 60 },
            { icao: 'KLWA', type: 'APT', _legDist: 120 },
        ];
        const rt = makeTable(wps, 0);
        rt._flights = undefined;

        expect(() => rt._updateSummary()).not.toThrow();
        expect(destFuel(rt)).toBeCloseTo(15.0, 6);   // trip-wide fallback
    });
});

// ── Step 2: planned fallback resolves the destination by APT walk-back ──────

describe('_updateSummary — planned DEST fallback', () => {
    it('falls back to the last AIRPORT\'s planned fuel, not a trailing fix', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        // No distance left to run → the live projection cannot be computed and the
        // planned figure is used instead.
        const wps = [
            { icao: 'KLKR',  type: 'APT', _flightIndex: 0 },
            { icao: 'KLWA',  type: 'APT', _flightIndex: 0, _fuelRem: 12 },
            { icao: 'MAPFX', type: 'FIX', _flightIndex: 0, _fuelRem: 9 },
        ];
        const rt = makeTable(wps, 0);
        rt._flights = [{ index: 0, depWpIndex: 0, destWpIndex: 2 }];
        rt._updateSummary();

        expect(destFuel(rt)).toBeCloseTo(12.0, 6);     // KLWA's planned remaining
        expect(destFuel(rt)).not.toBeCloseTo(9.0, 6);  // not the trailing MAP fix's
    });
});

// ── Step 3: emitted flight_plan.destination uses the same walk-back ─────────

describe('_emitRouteChange — destination lookup', () => {
    it('publishes the last airport as the destination, not a trailing fix', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        const wps = [
            { icao: 'KLKR',  type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'KLWA',  type: 'APT', lat: 36.10, lon: -79.94 },
            { icao: 'MAPFX', type: 'FIX', lat: 36.30, lon: -79.80 },
        ];
        const rt = makeTable(wps, 0);
        rt._trip = null;
        rt._emitting = false;
        let emitted = null;
        rt._onRouteChanged = (plan) => { emitted = plan; };

        rt._emitRouteChange();

        expect(emitted).not.toBeNull();
        expect(emitted.flight_plan.departure).toBe('KLKR');
        expect(emitted.flight_plan.destination).toBe('KLWA');
        expect(emitted.flight_plan.destination).not.toBe('MAPFX');
    });

    it('still uses the last waypoint when the route has no APT-typed waypoint', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        const wps = [
            { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50 },
            { icao: 'LIB',  type: 'VOR', lat: 35.60, lon: -80.10 },
        ];
        const rt = makeTable(wps, 0);
        rt._trip = null;
        rt._emitting = false;
        let emitted = null;
        rt._onRouteChanged = (plan) => { emitted = plan; };

        rt._emitRouteChange();

        expect(emitted.flight_plan.destination).toBe('LIB');
    });
});

// ══ SDD Task 14 ═══════════════════════════════════════════════════════════
// Scope items 1-3: containment lookup, capacity gate, staleness marking.

/** The badge's inline colour — `var(--status-ok|warning|danger)`. */
function destColor(rt) {
    const m = /<span style="color:(var\(--status-[a-z]+\));font-weight:700">/.exec(rt._summaryEl.innerHTML);
    return m ? m[1] : null;
}

/** The badge's raw number-plus-marker text, e.g. `15.0` or `25.0?`. */
function destText(rt) {
    const m = /font-weight:700">[A-Z0-9?]+:(-?\d+\.\d\??)</.exec(rt._summaryEl.innerHTML);
    return m ? m[1] : null;
}

// ── Item 2: the active flight is resolved by containment, not _flightIndex ──

describe('_updateSummary — active flight resolved by containment', () => {
    // _buildFlights gives a fuel-stop waypoint the DEPARTING flight's index, because
    // the fuel overlay uses _flightIndex as "next flight". Reading it here selected
    // the DOWNSTREAM flight on the final leg INTO the stop and scoped the projection
    // all the way to the trip's final airport. _emitLegUpdate already used
    // containment, so the route strip and the instrument strip disagreed by 10 gal
    // about fuel at destination at the same instant.
    function tripInboundToFuelStop() {
        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'ENO',  type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _segments: seg(10) },
            { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, _liveDist: 60, _segments: seg(10) },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
        ];
        return wps;
    }

    it('picks the ARRIVING flight when the active waypoint is the fuel stop itself', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        const wps = tripInboundToFuelStop();
        const rt = makeTable(wps, 2);
        rt._computeEnroute();
        rt._updateSummary();

        // The shared-boundary waypoint really does carry the DEPARTING flight's index.
        expect(wps[2]._flightIndex).toBe(1);
        expect(rt._flights[0].destWpIndex).toBe(2);

        // 60 nm to run → 30 − 5 = 25.0 gal on arrival at the stop.
        expect(destFuel(rt)).toBeCloseTo(25.0, 6);
        // The _flightIndex lookup scoped 60 + 120 = 180 nm and read 15.0.
        expect(destFuel(rt)).not.toBeCloseTo(15.0, 6);
        expect(destBadge(rt).label).toBe('KFGX');
    });

    it('agrees with _emitLegUpdate, which already used containment', () => {
        installGlobals({ currentFuel: 30, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        const wps = tripInboundToFuelStop();
        const rt = makeTable(wps, 2);
        let emitted = null;
        rt._emitLegUpdate = RouteTable.prototype._emitLegUpdate;   // restore the real one
        const onLeg = (e) => { emitted = e.detail; };
        window.addEventListener('activeroute:legupdate', onLeg);
        rt._computeEnroute();
        window.removeEventListener('activeroute:legupdate', onLeg);
        rt._updateSummary();

        // Both now describe the same airport.
        expect(emitted.destIcao).toBe('KFGX');
        expect(destBadge(rt).label).toBe('KFGX');
    });
});

// ── Item 3: nothing tracked must not become a projection from full tanks ───

describe('_updateSummary — capacity source is not a measurement', () => {
    it('shows no badge at all when nothing is tracked', () => {
        // getCurrentFuel() returns the capacity fallback here. Reading `.gallons`
        // unguarded projected from FULL TANKS and coloured the result green on a
        // route with no fuel data behind it.
        installGlobals({ currentFuel: 40, perf: PERF, fuelSource: 'capacity' });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };

        const wps = [
            { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
            { icao: 'KLWA', type: 'APT', lat: 36.10, lon: -79.94, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 0);
        rt._computeEnroute();
        rt._updateSummary();

        expect(destBadge(rt)).toBeNull();
        // The route strip itself still renders — only the fuel figure is withheld.
        expect(rt._summaryEl.innerHTML).toContain('KLWA');
    });

    it('withholds the planned fallback too — it is rooted in the same capacity read', () => {
        installGlobals({ currentFuel: 40, perf: PERF, fuelSource: 'capacity' });
        const wps = [
            { icao: 'KLKR', type: 'APT' },
            { icao: 'KLWA', type: 'APT', _fuelRem: 22 },
        ];
        const rt = makeTable(wps, 0);
        rt._flights = [{ index: 0, dep: 'KLKR', dest: 'KLWA', depWpIndex: 0, destWpIndex: 1 }];
        rt._updateSummary();

        expect(destBadge(rt)).toBeNull();
    });

    it('still shows a real 0.0 for dry tracked tanks', () => {
        installGlobals({ currentFuel: 0, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };
        const wps = [
            { icao: 'KLKR', type: 'APT' },
            { icao: 'KLWA', type: 'APT', _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 0);
        rt._computeEnroute();
        rt._updateSummary();

        expect(destFuel(rt)).toBeCloseTo(-10.0, 6);
        expect(destColor(rt)).toBe('var(--status-danger)');
    });
});

// ── Item 1: stale-never-green on the DEST badge ────────────────────────────

describe('_updateSummary — stale tracked fuel is marked, never reassuring', () => {
    const wps = () => ([
        { icao: 'KLKR', type: 'APT' },
        { icao: 'KLWA', type: 'APT', _legDist: 120, _liveDist: 120, _segments: seg(10) },
    ]);

    it('marks a comfortable reserve with the caution colour and a trailing ?', () => {
        // 40 gal − 10 = 30.0, far above every threshold, so without the rule this
        // renders green — on a figure that has not been updated in 45+ minutes and
        // reads HIGH by the whole unrecorded burn.
        installGlobals({ currentFuel: 40, perf: PERF, fuelStale: true });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };
        const rt = makeTable(wps(), 0);
        rt._computeEnroute();
        rt._updateSummary();

        expect(destText(rt)).toBe('30.0?');
        expect(destColor(rt)).toBe('var(--status-warning)');
        expect(destColor(rt)).not.toBe('var(--status-ok)');
    });

    it('leaves the danger colour alone — staleness never softens a warning', () => {
        installGlobals({ currentFuel: 12, perf: PERF, fuelStale: true });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };
        const rt = makeTable(wps(), 0);
        rt._computeEnroute();
        rt._updateSummary();

        expect(destText(rt)).toBe('2.0?');
        expect(destColor(rt)).toBe('var(--status-danger)');
    });

    it('renders the green colour and no marker when the figure is fresh', () => {
        installGlobals({ currentFuel: 40, perf: PERF });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };
        const rt = makeTable(wps(), 0);
        rt._computeEnroute();
        rt._updateSummary();

        expect(destText(rt)).toBe('30.0');
        expect(destColor(rt)).toBe('var(--status-ok)');
    });
});

// ── Item 1: stale-never-green on the REM column ────────────────────────────

describe('_getCellValue fuel_rem — the REM column carries the same marker', () => {
    /** Compute a route, then render one REM cell for the given waypoint index. */
    function remCell({ currentFuel, fuelStale }, wpIndex) {
        installGlobals({ currentFuel, perf: PERF, fuelStale });
        const wps = [
            { icao: 'KLKR', type: 'APT' },
            { icao: 'KLWA', type: 'APT', _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 0);
        rt._computeEnroute();
        return rt._getCellValue(wps[wpIndex], 'fuel_rem');
    }

    it('marks every cell when the start-fuel read is stale', () => {
        // Whole column is startFuel − plannedBurn, so a stale startFuel makes every
        // row read HIGH — including post-fuel-stop rows, whose reset start fuel is
        // derived from the same figure.
        expect(remCell({ currentFuel: 40, fuelStale: true }, 1))
            .toBe('<span class="fuel-yellow">30.0?</span>');
    });

    it('leaves a fresh comfortable cell plain', () => {
        expect(remCell({ currentFuel: 40, fuelStale: false }, 1)).toBe('30.0');
    });

    it('keeps the danger class on a stale low cell — no softening', () => {
        expect(remCell({ currentFuel: 12, fuelStale: true }, 1))
            .toBe('<span class="fuel-red">2.0?</span>');
    });

    it('marks the segment-row branch identically to the waypoint-row branch', () => {
        // The two branches used to carry duplicate copies of this expression; they
        // now share _fuelRemCell, and this pins that they cannot drift apart.
        installGlobals({ currentFuel: 40, perf: PERF, fuelStale: true });
        const wps = [
            { icao: 'KLKR', type: 'APT' },
            { icao: 'KLWA', type: 'APT', _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 0);
        rt._computeEnroute();
        const segRow = rt._getCellValue(wps[1], 'fuel_rem', wps[1]._segments[0], 0);
        const wpRow  = rt._getCellValue(wps[1], 'fuel_rem');
        expect(segRow).toBe('<span class="fuel-yellow">30.0?</span>');
        expect(segRow).toBe(wpRow);
    });

    it('renders the dash for a waypoint with no computed remaining fuel', () => {
        installGlobals({ currentFuel: 40, perf: PERF });
        const rt = makeTable([{ icao: 'KLKR', type: 'APT' }], 0);
        expect(rt._getCellValue({ _fuelRem: null }, 'fuel_rem')).toBe('—');
    });
});
