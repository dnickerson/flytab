/**
 * route-table.js — active leg burns measured fuel flow, not planned %PWR (#114)
 *
 * The %PWR selector is a planning control ("if I fly at 65%, where do I stop
 * for fuel?"). Once airborne, the leg actually being flown should burn at
 * whatever the engine is really doing, not a plan/selection — the selector
 * still applies to legs ahead.
 *
 * route-table.js is a classic (non-ESM) script, loaded the same way the other
 * route-table tests load it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { gphForPowerPct } from '../../web/shared/planning/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/cockpit/route-table.js'), 'utf8');
const RouteTable = new Function(src + '\nreturn RouteTable;')();

const START_FUEL = 36;
const PLANNED_CRZ_GPH = 8.4;
const PLANNED_CRZ_TAS = 153;
const LIVE_GPH = 11.5;       // deliberately far from any planned figure below
const LIVE_GS = 140;         // kt, used both as the aircraft's groundspeed and TAS proxy
const LIVE_PCT_POWER = 82;   // deliberately far from any planned %power below

// Synthetic measured-power band table, only for exercising the %PWR override
// on legs ahead — not testing band-lookup accuracy itself (route-table-cruise-
// power.test.js already covers that against the real aircraft-config.json).
const POWER_SETTINGS = [
    { pct_mid: 65, gph: PLANNED_CRZ_GPH },
    { pct_mid: 75, gph: 9.6 },
];

function installGlobals({ perfOverrides = {} } = {}) {
    const perf = {
        cruise_speed_kt: PLANNED_CRZ_TAS, cruise_gph: 9.0, cruise_pwr_pct: 65,
        fuel_capacity_gal: 40, power_settings: POWER_SETTINGS, ...perfOverrides,
    };
    globalThis.CockpitConfig = {
        aircraft(path) {
            const key = path.replace(/^performance\./, '');
            return Object.prototype.hasOwnProperty.call(perf, key) ? perf[key] : null;
        },
        get() { return null; },
    };
    globalThis.FlyTabPlanning = {
        bearing: () => 0,
        windCorrectedMagHdg: () => 0,
        crossTrackDistanceNm: () => 0,
        gphForPowerPct,
    };
    globalThis.FuelState = {
        getCurrentFuel: () => ({ gallons: START_FUEL, source: 'tank_state', stale: false }),
    };
}

/** `connected: false` or omitting engine data entirely simulates no live reading. */
function installEngine({ connected = true, liveGph = LIVE_GPH, livePctPower = LIVE_PCT_POWER } = {}) {
    window.enginePanel = {
        connected,
        lastData: { fuel_flow_gph: liveGph, percent_power: livePctPower },
    };
}

afterEach(() => {
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.FuelState;
    delete window.enginePanel;
});

function crz(distNm, gph = PLANNED_CRZ_GPH, tas = PLANNED_CRZ_TAS, pwr = 65) {
    return {
        phase: 'CRZ', gph, tas, gs: tas, dist: distNm,
        ete_min: (distNm / tas) * 60, percent_power: pwr, rpm: 2390, mp: 22.1,
    };
}

function clb(distNm, gph = 15.0, tas = 120, pwr = 100) {
    return {
        phase: 'CLB', gph, tas, gs: tas, dist: distNm,
        ete_min: (distNm / tas) * 60, percent_power: pwr, rpm: 2700, mp: 25.0,
    };
}

/**
 * KLKR -> LOCAS (active leg, i=1) -> GSO (leg ahead, i=2) -> KFGX (leg ahead, i=3).
 * Active leg is 140 nm; live GPS distance remaining is set explicitly since
 * that's normally populated by the GPS handler, not _computeEnroute itself.
 */
function makeRoute({ liveDistNm = 140 } = {}) {
    return [
        { icao: 'KLKR',  type: 'APT', lat: 34.72, lon: -80.85 },
        { icao: 'LOCAS', type: 'FIX', lat: 35.60, lon: -80.30,
          _legDist: 140, _liveDist: liveDistNm, _segments: [crz(140)] },
        { icao: 'GSO',   type: 'VOR', lat: 36.05, lon: -79.94,
          _legDist: 200, _segments: [crz(200)] },
        { icao: 'KFGX',  type: 'APT', lat: 36.60, lon: -79.30,
          _legDist: 180, _segments: [crz(180)] },
    ];
}

function makeSeglessRoute({ liveDistNm = 140 } = {}) {
    return [
        { icao: 'KLKR',  type: 'APT', lat: 34.72, lon: -80.85 },
        { icao: 'LOCAS', type: 'FIX', lat: 35.60, lon: -80.30, _legDist: 140, _liveDist: liveDistNm },
        { icao: 'GSO',   type: 'VOR', lat: 36.05, lon: -79.94, _legDist: 200 },
    ];
}

function makeTable(waypoints, { activeIndex = 1, cruisePower = null } = {}) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints   = waypoints;
    rt._activeIndex = activeIndex;
    rt._flights     = [];
    rt._destIcao    = waypoints[waypoints.length - 1].icao;
    rt._cruisePower = cruisePower;
    rt._lastSituation = null;
    rt._emitLegUpdate = () => {};
    return rt;
}

// ── Active leg uses measured fuel flow, ignores the %PWR selection ─────────

describe('_computeEnroute — active leg burns measured fuel flow (#114)', () => {
    it('active leg burn comes from live fuel flow when engine data is live and airborne', () => {
        installGlobals();
        installEngine();
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);

        const active = wps[1];
        const expectedGal = (active._ete / 60) * LIVE_GPH;
        expect(active._fuel).toBeCloseTo(expectedGal, 6);
        expect(active._fuelMeasured).toBe(true);
        expect(active._fuel).not.toBeCloseTo((active._ete / 60) * PLANNED_CRZ_GPH, 1);
    });

    it('the %PWR selection does not affect the active leg burn at all', () => {
        installGlobals();
        installEngine();
        const noSelection = makeRoute();
        makeTable(noSelection, { cruisePower: null })._computeEnroute(LIVE_GS);

        const withSelection = makeRoute();
        makeTable(withSelection, { cruisePower: 75 })._computeEnroute(LIVE_GS);

        expect(withSelection[1]._fuel).toBeCloseTo(noSelection[1]._fuel, 6);
        expect(withSelection[1]._fuelMeasured).toBe(true);
    });

    it('displays measured %power on the active leg, not the planned segment value', () => {
        installGlobals();
        installEngine();
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);
        expect(wps[1]._pwr).toBe(LIVE_PCT_POWER);
        expect(wps[1]._pwr).not.toBe(65); // the planned segment's percent_power
    });

    it('legs ahead still use the selected %PWR and are unaffected by measured burn', () => {
        installGlobals();
        installEngine();
        const base = makeRoute();
        makeTable(base, { cruisePower: null })._computeEnroute(LIVE_GS);

        // 75, not 65 — 65 equals cruise_pwr_pct (the aircraft's configured cruise
        // power), which is an intentional no-op by design (see
        // route-table-cruise-power.test.js); this test needs a real override.
        const selected = makeRoute();
        makeTable(selected, { cruisePower: 75 })._computeEnroute(LIVE_GS);

        // Active leg (i=1) identical regardless of selection — measured, not planned.
        expect(selected[1]._fuel).toBeCloseTo(base[1]._fuel, 6);
        expect(selected[1]._fuelMeasured).toBe(true);

        // Leg ahead (i=2, pure CRZ) is NOT measured and DOES respond to the selection —
        // this is what "re-plans downstream fuel stops while airborne" means.
        expect(selected[2]._fuelMeasured).toBeFalsy();
        expect(selected[2]._fuel).not.toBeCloseTo(base[2]._fuel, 1);
    });

    it('downstream REM reflects the corrected running total after a measured active leg', () => {
        installGlobals();
        installEngine();
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);

        // fuelBurned going into leg 2 must include the MEASURED active-leg burn,
        // not the planned segFuel that was provisionally added before the override.
        const expectedRemAfterActive = START_FUEL - wps[1]._fuel;
        expect(wps[1]._fuelRem).toBeCloseTo(expectedRemAfterActive, 6);
        expect(wps[2]._fuelRem).toBeCloseTo(expectedRemAfterActive - wps[2]._fuel, 6);
    });

    it('multi-segment active leg (CLB+CRZ): sub-row FUEL/REM agree with the measured aggregate, not the planned one', () => {
        // A leg that climbs then cruises before reaching the active waypoint is
        // routine (first leg after departure, or any leg with a step climb) — the
        // aggregate waypoint row is measured (#114), but until this fix the CLB/CRZ
        // sub-rows kept showing planned-burn figures with no marking, so the two
        // rows for the leg actually being flown could visibly disagree.
        installGlobals();
        installEngine();
        const wps = makeRoute();
        wps[1]._segments = [clb(50), crz(90)];
        makeTable(wps)._computeEnroute(LIVE_GS);

        const active = wps[1];
        const segFuelSum = active._segments.reduce((s, seg) => s + seg._fuel, 0);
        expect(segFuelSum).toBeCloseTo(active._fuel, 6);
        expect(active._segments.every(seg => seg._fuelMeasured)).toBe(true);

        const lastSeg = active._segments[active._segments.length - 1];
        expect(lastSeg._fuelRem).toBeCloseTo(active._fuelRem, 6);
    });

    it('applies the same measured-burn rule on seg-less (manually added) active legs', () => {
        installGlobals();
        installEngine();
        const wps = makeSeglessRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);

        const active = wps[1];
        const expectedGal = (active._ete / 60) * LIVE_GPH;
        expect(active._fuel).toBeCloseTo(expectedGal, 6);
        expect(active._fuelMeasured).toBe(true);
        expect(active._pwr).toBe(LIVE_PCT_POWER);
    });
});

// ── No live data: falls back to planned, and says so ────────────────────────

describe('_computeEnroute — active leg with no live fuel flow falls back and marks it (#114)', () => {
    it('falls back to planned burn when the engine is disconnected', () => {
        installGlobals();
        installEngine({ connected: false });
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);

        const active = wps[1];
        expect(active._fuelMeasured).toBe(false);
        expect(active._activeNoLiveData).toBe(true);
        // The planned figure, from the segment's own planned ETE (140nm @ 153kt) —
        // NOT active._ete, which is independently live-adjusted (140nm @ groundspeed)
        // regardless of whether fuel flow itself is measured. Falling back to burn
        // ≠ falling back to time; only the burn source changes here.
        const plannedEteMin = (140 / PLANNED_CRZ_TAS) * 60;
        expect(active._fuel).toBeCloseTo((plannedEteMin / 60) * PLANNED_CRZ_GPH, 6);
    });

    it('falls back to planned burn when there is no engine panel at all', () => {
        installGlobals();
        // No installEngine() call — window.enginePanel stays undefined.
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);

        const active = wps[1];
        expect(active._fuelMeasured).toBe(false);
        expect(active._activeNoLiveData).toBe(true);
    });

    it('a genuinely stale cached lastData (connected:false) is not mistaken for live', () => {
        // EnginePanel never nulls lastData on disconnect — a non-null fuel_flow_gph
        // alone must not be trusted as "live". This is the whole point of gating on
        // .connected rather than presence of the field.
        installGlobals();
        installEngine({ connected: false, liveGph: 999 }); // absurd value if wrongly trusted
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);
        expect(wps[1]._fuel).not.toBeCloseTo((wps[1]._ete / 60) * 999, 1);
        expect(wps[1]._fuelMeasured).toBe(false);
    });

    it('does NOT mark legs ahead as activeNoLiveData — only the active leg is "right now"', () => {
        installGlobals();
        installEngine({ connected: false });
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(LIVE_GS);
        expect(wps[2]._activeNoLiveData).toBeFalsy();
        expect(wps[3]._activeNoLiveData).toBeFalsy();
    });

    it('does not apply measured burn before airborne (GS below the live-tracking threshold)', () => {
        installGlobals();
        installEngine();
        const wps = makeRoute();
        makeTable(wps)._computeEnroute(20); // taxiing, not yet airborne by the gs>30 gate
        expect(wps[1]._fuelMeasured).toBe(false);
        expect(wps[1]._activeNoLiveData).toBe(true);
    });
});

// ── Passed legs remain blanked, including the new fields ────────────────────

describe('_computeEnroute — passed legs stay blanked (#114 regression guard)', () => {
    it('blanks _fuelMeasured and _activeNoLiveData on passed legs, not just _fuel', () => {
        installGlobals();
        installEngine();
        const wps = makeRoute();
        // Advance: leg 1 (LOCAS) has been passed, GSO (i=2) is now active.
        makeTable(wps, { activeIndex: 2 })._computeEnroute(LIVE_GS);

        expect(wps[1]._fuel).toBeNull();
        expect(wps[1]._fuelMeasured).toBe(false);
        expect(wps[1]._activeNoLiveData).toBe(false);
    });
});
