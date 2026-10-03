/**
 * route-table.js — a destination followed by a loaded approach's missed-approach
 * fixes. The route planner marks the DEST pill's waypoint isDest.
 *
 * The flight ARRIVES at the marked destination: per-flight totals, the handle's
 * remaining distance and destination label, the DEST fuel badge, the
 * activeroute:legupdate destination and the emitted flight_plan.destination stop
 * there, while the missed-approach rows still render. Once the active waypoint is
 * past the destination, the figures run to the end of the route again. With no
 * marker — or a stale one, with an airport moved after it — every figure behaves
 * as it did before the marker existed.
 *
 * Loaded with the `new Function(src + 'return Class;')()` pattern used by
 * route-table-summary.test.js. ActiveRoute (which owns the shared
 * markedDestIndex / findDestIndex rule) is loaded as a global, as in the app.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const RouteTable  = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
globalThis.ActiveRoute = new Function(read('web/shared/active-route.js') + '\nreturn ActiveRoute;')();

/** 120 kt / 10 gph so every 120 nm leg burns exactly 10 gal. */
const PERF = { 'performance.cruise_gph': 10, 'performance.cruise_speed_kt': 120 };

function installGlobals({ currentFuel }) {
    globalThis.CockpitConfig = {
        aircraft: (path) => (Object.prototype.hasOwnProperty.call(PERF, path) ? PERF[path] : null),
        get: () => null,
    };
    globalThis.FlyTabPlanning = { bearing: () => 0, windCorrectedMagHdg: () => 0, crossTrackDistanceNm: () => 0 };
    globalThis.FuelState = {
        getCurrentFuel: () => ({ gallons: currentFuel, source: 'tank_state', stale: false }),
        getStartFuel:   () => ({ gallons: currentFuel, source: 'tic' }),
    };
}

afterEach(() => {
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.FuelState;
    delete window.enginePanel;
});

/** One CRZ segment burning exactly `gal` gallons at 10 gph / 120 kt. */
const seg = gal => [{ phase: 'CRZ', gph: 10, ete_min: gal * 6, tas: 120, gs: 120, dist: gal * 12 }];

function makeTable(waypoints, activeIndex, { stubLegUpdate = true } = {}) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints   = waypoints;
    rt._activeIndex = activeIndex;
    rt._flights     = [];
    rt._destIcao    = 'KLKR';
    rt._cruisePower = null;
    rt._lastSituation = null;
    rt._editMode    = false;
    rt._editBtn     = null;
    rt._saveBtn     = null;
    if (stubLegUpdate) rt._emitLegUpdate = () => {};
    const summaryEl = document.createElement('div');
    summaryEl.className = 'handle-summary';
    rt._handleEl = { querySelector: (sel) => (sel === '.handle-summary' ? summaryEl : null) };
    rt._summaryEl = summaryEl;
    return rt;
}

/** KCLT → ENO → KLKR (marked destination) → CORON (missed-approach hold), 120 nm legs. */
function klkrWithMissed() {
    return [
        { icao: 'KCLT',  type: 'APT', lat: 35.21, lon: -80.94 },
        { icao: 'ENO',   type: 'VOR', lat: 35.00, lon: -80.50, _legDist: 120, _liveDist: 60, _segments: seg(10) },
        { icao: 'KLKR',  type: 'APT', isDest: true, lat: 34.72, lon: -80.85, _legDist: 120, _segments: seg(10) },
        { icao: 'CORON', type: 'FIX', lat: 34.60, lon: -81.20, _legDist: 120, _liveDist: 50, _segments: seg(10) },
    ];
}

const ARROW = '\u2009\u2192\u2009';   // thin space, arrow, thin space — as rendered in the handle label
const label = (a, b) => `${a}${ARROW}${b}`;
const handleNm = rt => Number(/>(\d+)nm</.exec(rt._summaryEl.innerHTML)?.[1]);
const destBadge = rt => {
    const m = /font-weight:700">([A-Z0-9?]+):(-?\d+\.\d)</.exec(rt._summaryEl.innerHTML);
    return m ? { label: m[1], gal: parseFloat(m[2]) } : null;
};

describe('route table — destination followed by a missed approach', () => {
    it('_buildFlights keeps the missed-approach rows in the flight but arrives at the airport', () => {
        installGlobals({ currentFuel: 30 });
        const rt = makeTable(klkrWithMissed(), 1);
        rt._computeEnroute();

        expect(rt._flights).toHaveLength(1);
        expect(rt._flights[0].destWpIndex).toBe(3);   // CORON row still belongs to the flight
        expect(rt._flights[0].arrWpIndex).toBe(2);    // …but the flight arrives at KLKR
    });

    it('handle distance and DEST fuel run to KLKR, not through to CORON', () => {
        installGlobals({ currentFuel: 30 });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };
        const rt = makeTable(klkrWithMissed(), 1);
        rt._computeEnroute();
        rt._updateSummary();

        // 60 nm left on the active leg + 120 nm to KLKR = 180 nm (300 with CORON).
        expect(handleNm(rt)).toBe(180);
        // 30 gal − (180 nm / 120 kt) × 10 gph = 15.0 (5.0 if projected to CORON).
        expect(destBadge(rt)).toEqual({ label: 'DEST', gal: 15.0 });
        expect(rt._summaryEl.innerHTML).toContain(label('KCLT', 'KLKR'));
    });

    it('while flying the missed approach, distance, label and DEST all describe the route end', () => {
        installGlobals({ currentFuel: 30 });
        window.enginePanel = { lastData: { fuel_flow_gph: 10 } };
        const rt = makeTable(klkrWithMissed(), 3);   // active waypoint is CORON
        rt._computeEnroute();
        rt._updateSummary();

        expect(handleNm(rt)).toBe(50);
        // The label names what the distance measures — CORON, not KLKR behind the aircraft.
        expect(rt._summaryEl.innerHTML).toContain(label('KCLT', 'CORON'));
        // 30 − (50 / 120) × 10 = 25.8, under a plain DEST label that matches the header.
        expect(destBadge(rt).label).toBe('DEST');
        expect(destBadge(rt).gal).toBeCloseTo(25.8, 1);
    });

    it('per-flight totals on a fuel-stop trip exclude the missed-approach leg', () => {
        installGlobals({ currentFuel: 30 });
        // KCLT → KFGX (fuel stop) → KLKR (destination) → CORON (missed approach).
        const wps = [
            { icao: 'KCLT',  type: 'APT', lat: 35.21, lon: -80.94 },
            { icao: 'KFGX',  type: 'APT', lat: 35.50, lon: -80.20, _legDist: 120, _segments: seg(10) },
            { icao: 'KLKR',  type: 'APT', isDest: true, lat: 34.72, lon: -80.85, _legDist: 120, _segments: seg(10) },
            { icao: 'CORON', type: 'FIX', lat: 34.60, lon: -81.20, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 1);
        rt._computeEnroute();

        expect(rt._flights).toHaveLength(2);
        expect(rt._flights[1].arrWpIndex).toBe(2);
        expect(rt._flights[1]._totDist).toBe(120);         // KFGX → KLKR only (240 with CORON)
        expect(rt._flights[1]._totFuel).toBeCloseTo(10, 6);
    });

    it('activeroute:legupdate names KLKR as the destination with its distance and fuel', () => {
        installGlobals({ currentFuel: 30 });
        let detail = null;
        const capture = (e) => { detail = e.detail; };
        window.addEventListener('activeroute:legupdate', capture);
        try {
            const rt = makeTable(klkrWithMissed(), 1, { stubLegUpdate: false });
            rt._getCrossingAlt = () => null;
            rt._computeEnroute();
        } finally {
            window.removeEventListener('activeroute:legupdate', capture);
        }

        expect(detail).not.toBeNull();
        expect(detail.destIcao).toBe('KLKR');
        expect(detail.destDistNm).toBe(180);            // 300 if it measured to CORON
        expect(detail.destFuelRem).toBeCloseTo(10, 6);  // 30 − 2 legs × 10 gal; CORON would be 0
    });
});

describe('route table — the destination marker after edits', () => {
    it('a stale marker (an airport dragged after it) is ignored', () => {
        installGlobals({ currentFuel: 30 });
        // KAAA → KLKR(marked) → KBBB: the pilot dragged KBBB after the old destination.
        const wps = [
            { icao: 'KAAA', type: 'APT', lat: 35.0, lon: -81.0 },
            { icao: 'KLKR', type: 'APT', isDest: true, is_fuel_stop: false, lat: 35.2, lon: -80.8, _legDist: 120, _liveDist: 60, _segments: seg(10) },
            { icao: 'KBBB', type: 'APT', lat: 35.4, lon: -80.6, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 1);
        rt._computeEnroute();
        rt._updateSummary();

        expect(rt._flights.at(-1).arrWpIndex).toBe(2);
        expect(rt._summaryEl.innerHTML).toContain(label('KAAA', 'KBBB'));
        expect(handleNm(rt)).toBe(180);
    });

    it('a fix inserted after the marked destination does not become the destination', () => {
        installGlobals({ currentFuel: 30 });
        const wps = klkrWithMissed();
        wps.splice(3, 0, { icao: 'WITUR', type: 'FIX', lat: 34.79, lon: -80.84, _legDist: 120, _segments: seg(10) });
        const rt = makeTable(wps, 1);
        rt._computeEnroute();
        rt._updateSummary();

        expect(rt._flights[0].arrWpIndex).toBe(2);
        expect(handleNm(rt)).toBe(180);
        expect(rt._summaryEl.innerHTML).toContain(label('KCLT', 'KLKR'));
    });

    it('with no marker, a route ending at a fix still totals to its end', () => {
        installGlobals({ currentFuel: 30 });
        // KAAA → KMID (pilot said "Not a stop") → SAX (VOR, end of route).
        const wps = [
            { icao: 'KAAA', type: 'APT', lat: 35.0, lon: -81.0 },
            { icao: 'KMID', type: 'APT', is_fuel_stop: false, lat: 35.5, lon: -80.5, _legDist: 120, _liveDist: 60, _segments: seg(10) },
            { icao: 'SAX',  type: 'VOR', lat: 36.0, lon: -80.0, _legDist: 120, _segments: seg(10) },
        ];
        const rt = makeTable(wps, 1);
        rt._computeEnroute();
        rt._updateSummary();

        expect(rt._flights[0].arrWpIndex).toBe(2);
        expect(handleNm(rt)).toBe(180);                 // 60 if it stopped at KMID
    });

    it('handle distance does not depend on stale flight data', () => {
        installGlobals({ currentFuel: 30 });
        const rt = makeTable(klkrWithMissed(), 1);
        rt._computeEnroute();
        // _flights left over from an older, shorter route.
        rt._flights = [{ index: 0, depWpIndex: 0, destWpIndex: 1, arrWpIndex: 1 }];
        rt._updateSummary();

        expect(handleNm(rt)).toBe(180);
    });

    it('route-table edits keep the marker and publish the real destination', () => {
        installGlobals({ currentFuel: 30 });
        const rt = makeTable(klkrWithMissed(), 1);
        let emitted = null;
        rt._onRouteChanged = (plan) => { emitted = plan; };
        rt._emitRouteChange();

        expect(emitted.waypoints.map(w => !!w.isDest)).toEqual([false, false, true, false]);
        expect(emitted.flight_plan.destination).toBe('KLKR');
    });
});

describe('ActiveRoute — destination index', () => {
    it('markedDestIndex returns the marked destination, ignoring a stale one', () => {
        const wps = [
            { icao: 'KLKR', type: 'APT' }, { icao: 'CTF' },
            { icao: 'KLKR', type: 'APT', isDest: true }, { icao: 'MAP1' }, { icao: 'CORON' },
        ];
        expect(ActiveRoute.markedDestIndex(wps)).toBe(2);
        expect(ActiveRoute.markedDestIndex([...wps, { icao: 'KBBB', type: 'APT' }])).toBe(-1);   // stale
        expect(ActiveRoute.markedDestIndex(wps.map(({ isDest, ...w }) => w))).toBe(-1);         // unmarked
    });

    it('uses the marked destination ahead of the last-airport rule', () => {
        ActiveRoute.setPlan({ waypoints: [
            { icao: 'KAAA',   type: 'APT' },
            { icao: 'KMID',   type: 'APT' },
            { icao: 'DESTFX', type: 'FIX', isDest: true },
            { icao: 'HOLD',   type: 'FIX' },
        ] });
        expect(ActiveRoute.getDestIndex()).toBe(2);
    });

    it('still falls back to the last airport when nothing is marked', () => {
        ActiveRoute.setPlan({ waypoints: [
            { icao: 'KCLT', type: 'APT' }, { icao: 'KLKR', type: 'APT' }, { icao: 'CORON', type: 'FIX' },
        ] });
        expect(ActiveRoute.getDestIndex()).toBe(1);
    });
});
