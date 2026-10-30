/**
 * #191 -- route table DIST and TIME show the LEG (previous waypoint -> this
 * one); the running total from the aircraft is a smaller second line in the
 * same cell, on the first row of the waypoint only.
 *
 * Before (02d26e7, March): every row's DIST/TIME was the running total
 * (_cumDist/_cumEte), so a 4.9 nm leg after an 82 nm leg read "87".
 * The active row counts down live: aircraft -> active waypoint (_liveDist,
 * live GS). _cumDist/_cumEte are still computed (nav strip), unchanged.
 *
 * route-table.js is a classic script: loaded with `new Function(src + 'return
 * Class;')()`, as tests/cockpit/route-table-summary.test.js does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/cockpit/route-table.js'), 'utf8');
const RouteTable = new Function(src + '\nreturn RouteTable;')();

function installGlobals() {
    globalThis.CockpitConfig = {
        aircraft(path) {
            if (path === 'performance.fuel_capacity_gal') return 36;
            if (path === 'performance.cruise_gph') return 10;
            if (path === 'performance.cruise_speed_kt') return 120;
            return null;
        },
        get() { return null; },
    };
    globalThis.FlyTabPlanning = { bearing: () => 0, windCorrectedMagHdg: () => 0, crossTrackDistanceNm: () => 0 };
    globalThis.FuelState = {
        getCurrentFuel: () => ({ gallons: 30, source: 'tank_state', stale: false }),
        getStartFuel:   () => ({ gallons: 30, source: 'tic' }),
    };
}

afterEach(() => {
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.FuelState;
});

/** One CRZ segment: `nm` at 120 kt. */
const crz = (nm) => [{ phase: 'CRZ', gph: 10, ete_min: nm / 2, tas: 120, gs: 120, dist: nm, altFrom: 2000, altTo: 2000 }];

function makeTable(waypoints, activeIndex, situation = null) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints   = waypoints;
    rt._activeIndex = activeIndex;
    rt._flights     = [];
    rt._destIcao    = null;
    rt._cruisePower = null;
    rt._lastSituation = situation;
    rt._editMode    = false;
    rt._emitLegUpdate = () => {};
    return rt;
}

/** Render a cell into a <td> and read its two lines. */
function cell(rt, wp, key, seg = null, segIndex = 0) {
    const td = document.createElement('td');
    td.innerHTML = String(seg ? rt._getCellValue(wp, key, seg, segIndex) : rt._getCellValue(wp, key));
    const cum = td.querySelector('.rt-cum-val');
    const cumText = cum ? cum.textContent : null;
    if (cum) cum.remove();
    return { leg: td.textContent, cum: cumText };
}

// DEP -> A 82.1 nm -> B 4.9 nm -> C 30 nm, on the ground at DEP (active = A).
function threeLegs() {
    return [
        { icao: 'KDEP', type: 'APT', lat: 34.7, lon: -80.8 },
        { icao: 'AAA',  type: 'FIX', lat: 35.0, lon: -80.5, _legDist: 82.1, _segments: crz(82.1) },
        { icao: 'BBB',  type: 'FIX', lat: 35.1, lon: -80.4, _legDist: 4.9,  _segments: crz(4.9) },
        { icao: 'KDST', type: 'APT', lat: 35.5, lon: -80.0, _legDist: 30,   _segments: crz(30) },
    ];
}

describe('#191 DIST / TIME show the leg, running total underneath', () => {
    it('3-leg route: each row shows its own leg, the running total below it', () => {
        installGlobals();
        const wps = threeLegs();
        const rt = makeTable(wps, 1);
        rt._computeEnroute(0);

        expect(cell(rt, wps[1], 'dist')).toEqual({ leg: '82', cum: '82' });
        expect(cell(rt, wps[2], 'dist')).toEqual({ leg: '4.9', cum: '87' });   // was "87" alone
        expect(cell(rt, wps[3], 'dist')).toEqual({ leg: '30', cum: '117' });

        // TIME: 120 kt -> 4.9 nm = 2.45 min ("2m"), running 41.05 + 2.45 = 43.5 ("44m")
        expect(cell(rt, wps[2], 'ete')).toEqual({ leg: '2m', cum: '44m' });
        expect(cell(rt, wps[3], 'ete')).toEqual({ leg: '15m', cum: '59m' });
    });

    it('running totals the nav strip reads are unchanged', () => {
        installGlobals();
        const wps = threeLegs();
        const rt = makeTable(wps, 1);
        rt._computeEnroute(0);
        expect(wps.slice(1).map(w => w._cumDist)).toEqual([82, 87, 117]);
        expect(wps[3]._cumEte).toBeCloseTo((82.1 + 4.9 + 30) / 2, 6);
    });

    it('multi-segment waypoint: leg + total on the first sub-row, per-segment ETE on the others', () => {
        installGlobals();
        const wps = threeLegs();
        wps[3]._segments = [
            { phase: 'CRZ', gph: 10, ete_min: 10, tas: 120, gs: 120, dist: 20, altFrom: 2000, altTo: 2000 },
            { phase: 'DES', gph: 7,  ete_min: 5,  tas: 120, gs: 120, dist: 10, altFrom: 2000, altTo: 500 },
        ];
        const rt = makeTable(wps, 1);
        rt._computeEnroute(0);
        const [s0, s1] = wps[3]._segments;
        expect(cell(rt, wps[3], 'dist', s0, 0)).toEqual({ leg: '30', cum: '117' });
        expect(cell(rt, wps[3], 'ete', s0, 0)).toEqual({ leg: '15m', cum: '59m' });
        expect(cell(rt, wps[3], 'dist', s1, 1)).toEqual({ leg: '', cum: null });
        expect(cell(rt, wps[3], 'ete', s1, 1)).toEqual({ leg: '5m', cum: null });
    });

    it('active row counts down live: aircraft -> active waypoint', () => {
        installGlobals();
        const wps = threeLegs();
        wps[2]._liveDist = 3.27;                     // 3.27 nm to BBB, flying at 120 kt
        wps[1]._cumDist = 82;                        // left over from when AAA was ahead
        const rt = makeTable(wps, 2, { ground_speed: 120 });
        rt._computeEnroute(120);
        expect(cell(rt, wps[2], 'dist')).toEqual({ leg: '3.3', cum: '3' });
        expect(wps[2]._ete).toBeCloseTo(3.27 / 120 * 60, 6);
        expect(cell(rt, wps[3], 'dist')).toEqual({ leg: '30', cum: '33' });
        // passed row: no leg, no stale running total
        expect(cell(rt, wps[1], 'dist')).toEqual({ leg: '—', cum: null });
    });

    it('departure row (no inbound leg): dash, no total', () => {
        installGlobals();
        const wps = threeLegs();
        const rt = makeTable(wps, 1);
        rt._computeEnroute(0);
        expect(cell(rt, wps[0], 'dist')).toEqual({ leg: '—', cum: null });
        expect(cell(rt, wps[0], 'ete')).toEqual({ leg: '—', cum: null });
    });
});
