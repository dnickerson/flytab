/**
 * When the route table counts a waypoint as passed (2026-10-18, Dana: "the
 * route sequencing to the next waypoint after a waypoint is passed").
 *
 * The old rule -- within 1 nm, or the waypoint > 90° off our track above
 * 30 kt -- passed waypoints that were still ahead: on a takeoff roll away from
 * the route, and in any turn of more than 90°. Replayed on four recorded
 * cross-country flights (not committed: the repo is public), every en-route
 * waypoint went early, up to 120 nm. Now: within 1 nm, or beyond the line
 * through the waypoint square to the leg flown into it ("passed abeam").
 * These flights are synthetic, built to reproduce each of those cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const RealNasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));
const COCKPIT = JSON.parse(read('web/cockpit-config.json'));
const dotted = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

const R = 3440.065, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function bearing(la1, lo1, la2, lo2) {
    const p1 = rad(la1), p2 = rad(la2), dl = rad(lo2 - lo1);
    return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360;
}
function dest([la, lo], brg, nm) {
    const d = nm / R, t = rad(brg), p1 = rad(la), l1 = rad(lo);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    return [deg(p2), deg(l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2)))];
}

const DEP = [34.72, -80.85];
const wp = (id, [lat, lon]) => ({ icao: id, type: 'FIX', lat, lon });

function table(wps, activeIndex = 1) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints = wps.map((w) => ({ ...w }));
    rt._activeIndex = activeIndex;
    Object.assign(rt, { _flights: [], _destIcao: null, _cruisePower: null, _lastSituation: null, _editMode: false,
        _updateSummary() {}, _renderTable() {}, _updateTableCells: () => true, _computeEnroute() {} });
    return rt;
}

/** Fly legs [{ hdg, kt, secs }] from `start`, one situation a second; returns the active index after each. */
function fly(rt, start, legs) {
    let pos = start; const trace = [];
    for (const { hdg, kt, secs } of legs) {
        for (let s = 0; s < secs; s++) {
            pos = dest(pos, hdg, kt / 3600);
            rt.updateLive({ lat: pos[0], lon: pos[1], true_course: hdg, ground_speed: kt });
            trace.push({ idx: rt._activeIndex, pos });
        }
    }
    return trace;
}

beforeEach(() => {
    globalThis.NasrDB = RealNasrDB;
    globalThis.FlyTabPlanning = { bearing };
    FuelTankState._state = null; FuelTankState._loaded = true;
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null, get: () => null, set: () => {} };
    globalThis.CockpitConfig = { aircraft: (p) => dotted(AIRCRAFT, p), get: (p) => dotted(COCKPIT, p) };
});
afterEach(() => { delete globalThis.FlyTabPlanning; delete globalThis.Settings; delete globalThis.CockpitConfig; });

// Route due south of the departure: waypoints at 20, 40 and 60 nm.
const SOUTH = () => [wp('DEP', DEP), wp('W1', dest(DEP, 180, 20)), wp('W2', dest(DEP, 180, 40)), wp('W3', dest(DEP, 180, 60))];

describe('a waypoint is passed within 1 nm or once past it abeam', () => {
    it('takeoff roll on runway 06 with the route to the south: nothing is passed', () => {
        const rt = table(SOUTH());
        // roll and climb-out on 060 at 40-90 kt, then a turn south toward W1 (stop 3 nm short)
        const t = fly(rt, DEP, [{ hdg: 60, kt: 40, secs: 15 }, { hdg: 60, kt: 90, secs: 60 }, { hdg: 120, kt: 110, secs: 30 }]);
        expect(t.every((x) => x.idx === 1)).toBe(true);
    });

    it('the old rule would have passed all three on that roll (the bug this fixes)', () => {
        const wps = SOUTH(); let idx = 1;
        for (const [hdg, kt, secs] of [[60, 40, 15], [60, 90, 60]]) {
            let pos = DEP;
            for (let s = 0; s < secs; s++) {
                pos = dest(pos, hdg, kt / 3600);
                const w = wps[idx];
                if (idx < 3 && kt > 30 && Math.abs(((bearing(pos[0], pos[1], w.lat, w.lon) - hdg + 540) % 360) - 180) > 90) idx++;
            }
        }
        expect(idx).toBe(3);
    });

    it('flying the route: each waypoint passed as it is reached, in order', () => {
        const rt = table(SOUTH());
        const t = fly(rt, DEP, [{ hdg: 180, kt: 120, secs: 31 * 60 }]);   // 62 nm
        const at = (i) => t.findIndex((x) => x.idx === i);
        const nmFlown = (k) => (k + 1) * 120 / 3600;
        expect(nmFlown(at(2))).toBeGreaterThan(18.9); expect(nmFlown(at(2))).toBeLessThan(20.1);
        expect(nmFlown(at(3))).toBeGreaterThan(38.9); expect(nmFlown(at(3))).toBeLessThan(40.1);
        expect(t.at(-1).idx).toBe(3);                                       // never past the last
    });

    it('a 180° turn for weather 10 nm before W1, holding 5 min, then on: W1 is not passed early', () => {
        const rt = table(SOUTH());
        const t = fly(rt, DEP, [{ hdg: 180, kt: 120, secs: 300 }, { hdg: 0, kt: 120, secs: 300 }, { hdg: 180, kt: 120, secs: 280 }]);
        const first = t.findIndex((x) => x.idx === 2);
        expect(first).toBe(-1);                                               // still short of W1
        expect(t.at(-1).idx).toBe(1);
    });

    it('8 nm off course (a deviation): W1 is passed once abeam it, not missed', () => {
        const rt = table(SOUTH());
        const start = dest(DEP, 90, 8);                                       // 8 nm east of the route
        const t = fly(rt, start, [{ hdg: 180, kt: 120, secs: 24 * 60 }]);
        const k = t.findIndex((x) => x.idx === 2);
        expect(k).toBeGreaterThan(0);
        const nmSouth = (k + 1) * 120 / 3600;
        expect(nmSouth).toBeGreaterThan(19.9); expect(nmSouth).toBeLessThan(20.2);   // just past abeam
    });

    it('a plan loaded part-way along: it catches up a waypoint per second, then waits', () => {
        const rt = table(SOUTH());
        const t = fly(rt, dest(DEP, 180, 45), [{ hdg: 180, kt: 120, secs: 5 }]);   // between W2 and W3
        expect(t.map((x) => x.idx)).toEqual([2, 3, 3, 3, 3]);
    });

    it('bearings not available yet (planning lib loading): only the 1 nm rule, no throw', () => {
        delete globalThis.FlyTabPlanning;
        const rt = table(SOUTH());
        const t = fly(rt, dest(DEP, 180, 45), [{ hdg: 180, kt: 120, secs: 3 }]);
        expect(t.map((x) => x.idx)).toEqual([1, 1, 1]);
    });

    it('a waypoint on top of the previous one (zero-length leg): only the 1 nm rule', () => {
        const wps = [wp('DEP', DEP), wp('SAME', DEP), wp('W1', dest(DEP, 180, 20))];
        const rt = table(wps);
        fly(rt, dest(DEP, 0, 5), [{ hdg: 0, kt: 120, secs: 3 }]);             // 5 nm north, flying away
        expect(rt._activeIndex).toBe(1);
    });
});
