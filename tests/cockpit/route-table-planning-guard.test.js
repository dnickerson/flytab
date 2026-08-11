/**
 * route-table.js — six FlyTabPlanning.* calls on the live GPS-tick path
 * (updateLive → _computeEnroute → _emitLegUpdate) had no guard against the
 * planning lib still being mid-load (window.FlyTabPlanning starts as `{}` per
 * planning/index.js:7, populated by 11 dynamic imports). Calling e.g.
 * FlyTabPlanning.bearing() while it's still `{}` throws every GPS tick.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();

const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));
const COCKPIT  = JSON.parse(read('web/cockpit-config.json'));
function dotted(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

/** 3-waypoint route, active on the middle waypoint. */
function makeRoute() {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints = [
        { icao: 'KLKR',  type: 'APT', lat: 34.72, lon: -80.78 },
        { icao: 'MDLIN', type: 'FIX', lat: 35.10, lon: -80.50 },
        { icao: 'KFGX',  type: 'APT', lat: 35.50, lon: -80.20,
          _legDist: 120, _segments: [{ phase: 'CRZ', gph: 9, ete_min: 60, tas: 120, gs: 120, dist: 120 }] },
    ];
    rt._activeIndex = 1;
    rt._flights = [];
    rt._destIcao = null;
    rt._cruisePower = null;
    rt._lastSituation = null;
    rt._editMode = false;
    rt._editBtn = null;
    rt._saveBtn = null;
    rt._updateSummary = () => {};
    rt._renderTable = () => {};
    rt._updateTableCells = () => true; // pretend the selective-update path succeeded
    return rt;
}

beforeEach(() => {
    globalThis.NasrDB = { haversineNm: () => 50 }; // >1nm — keeps "within 1nm" branch out of play
    FuelTankState._state = null;
    FuelTankState._loaded = true; // loaded, nothing tracked — fuel math isn't this test's concern
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null, get: () => null, set: () => {} };
    globalThis.CockpitConfig = { aircraft: (p) => dotted(AIRCRAFT, p), get: (p) => dotted(COCKPIT, p) };
});

afterEach(() => {
    delete globalThis.NasrDB;
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete window.enginePanel;
});

describe('_computeEnroute / _emitLegUpdate survive FlyTabPlanning not being ready (Finding 2)', () => {
    it('does not throw when FlyTabPlanning is {} — the real pre-load state per planning/index.js:7', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        expect(() => rt._computeEnroute()).not.toThrow();
    });

    it('leaves wp._brg/_hdg null instead of throwing while the lib loads', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        rt._computeEnroute();
        const wp = rt._waypoints[2];
        expect(wp._brg).toBeNull();
        expect(wp._hdg).toBeNull();
    });

    it('computes real bearing/heading once FlyTabPlanning finishes loading', () => {
        globalThis.FlyTabPlanning = {
            bearing: () => 42,
            windCorrectedMagHdg: () => 45,
            crossTrackDistanceNm: () => 0.3,
        };
        const rt = makeRoute();
        rt._computeEnroute();
        const wp = rt._waypoints[2];
        expect(wp._brg).toBe(42);
        expect(wp._hdg).toBe(45);
    });

    it('_emitLegUpdate publishes xtk as null via the real event while the lib loads, never throws', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        rt._lastSituation = { lat: 35.0, lon: -80.5 };
        let detail = null;
        const listener = (e) => { detail = e.detail; };
        window.addEventListener('activeroute:legupdate', listener);
        try {
            expect(() => rt._computeEnroute()).not.toThrow();
            expect(detail).not.toBeNull();
            expect(detail.xtk).toBeNull();
        } finally {
            window.removeEventListener('activeroute:legupdate', listener);
        }
    });
});

describe('updateLive survives FlyTabPlanning not being ready (Finding 2)', () => {
    it('does not throw on the first GPS tick while the lib is still {}', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        const situation = {
            lat: 35.30, lon: -80.35, true_course: 200, ground_speed: 90, gps_fix_quality: 1,
        };
        expect(() => rt.updateLive(situation)).not.toThrow();
    });

    it('leaves active._liveHdg null (not a bearing() crash) while the lib loads', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        const situation = {
            lat: 35.30, lon: -80.35, true_course: 200, ground_speed: 90, gps_fix_quality: 1,
        };
        rt.updateLive(situation);
        expect(rt._waypoints[rt._activeIndex]._liveHdg).toBeNull();
    });
});
