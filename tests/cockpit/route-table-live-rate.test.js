/**
 * PR B / B3: the route table updates at most once a second, and its table
 * cells only while the table is open.
 *
 * B0 (2026-10-15): routeTable.updateLive + _checkFuelStopProximity ran on every
 * situation (10/s); each recomputed every leg and patched the table, reading
 * every cell's innerHTML back (a DOM serialisation) to compare -- even with the
 * table body closed (height 0).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();

function extractMethod(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`method not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error('unbalanced braces');
}
const appSrc = read('web/app.js');
const scheduleRouteLive = new Function('sit', extractMethod(appSrc, '    _scheduleRouteLive(sit) {'));

describe('app: own-position messages to the route table (B3)', () => {
    beforeEach(() => { vi.useFakeTimers(); global.FlyTabApp = { ROUTE_LIVE_MS: 1000 }; });
    afterEach(() => vi.useRealTimers());

    it('10 situations a second reach the route table at most ~once a second, the newest one last', () => {
        const app = { routeTable: { updateLive: vi.fn() }, _checkFuelStopProximity: vi.fn() };
        for (let i = 0; i < 50; i++) {                   // 5 s at 10 Hz
            scheduleRouteLive.call(app, { lat: 35, lon: -80 + i * 0.001, i });
            vi.advanceTimersByTime(100);
        }
        vi.advanceTimersByTime(1000);
        const calls = app.routeTable.updateLive.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(5);
        expect(calls.length).toBeLessThanOrEqual(6);
        expect(calls[calls.length - 1][0].i).toBe(49);
        expect(app._checkFuelStopProximity.mock.calls.length).toBe(calls.length);
    });

    it('the source wires the situation listener through the throttle', () => {
        expect(appSrc).toMatch(/addEventListener\('stratux:situation', \(e\) => this\._scheduleRouteLive\(e\.detail\)\)/);
    });
});

describe('route table: closed table body (B3)', () => {
    function table({ open }) {
        const t = Object.create(RouteTable.prototype);
        t._waypoints = [{ index: 0, lat: 35, lon: -80.5 }, { index: 1, lat: 35, lon: -79.5 }];
        t._activeIndex = 1;
        t._editMode = false;
        t._bodyEl = { offsetHeight: open ? 120 : 0 };
        t._ftpBearing = () => 90;
        t._advanceWaypoint = vi.fn();
        t._computeEnroute = vi.fn();
        t._updateSummary = vi.fn();
        t._updateTableCells = vi.fn(() => true);
        t._renderTable = vi.fn();
        t._openHintEl = null;
        return t;
    }
    beforeEach(() => { global.NasrDB = { haversineNm: () => 30 }; });

    it('closed: legs and the handle summary still update, the table cells do not', () => {
        const t = table({ open: false });
        t.updateLive({ lat: 35, lon: -80.2, ground_speed: 140, true_course: 90 });
        expect(t._computeEnroute).toHaveBeenCalled();
        expect(t._updateSummary).toHaveBeenCalled();
        expect(t._updateTableCells).not.toHaveBeenCalled();
        expect(t._renderTable).not.toHaveBeenCalled();
    });

    it('opening it brings the cells up to date at once, once', () => {
        const t = table({ open: false });
        t.updateLive({ lat: 35, lon: -80.2, ground_speed: 140, true_course: 90 });
        t._bodyEl.offsetHeight = 120;
        t._updateOpenHint(120);
        t._updateOpenHint(130);                         // more drag steps: no repeat
        expect(t._updateTableCells).toHaveBeenCalledTimes(1);
    });

    it('open: cells update as before', () => {
        const t = table({ open: true });
        t.updateLive({ lat: 35, lon: -80.2, ground_speed: 140, true_course: 90 });
        expect(t._updateTableCells).toHaveBeenCalledTimes(1);
    });

    it('waypoint sequencing still happens with the table closed', () => {
        global.NasrDB = { haversineNm: () => 0.5 };     // within 1 nm of the active waypoint
        const t = table({ open: false });
        t._activeIndex = 0;
        t.updateLive({ lat: 35, lon: -80.5, ground_speed: 140, true_course: 90 });
        expect(t._advanceWaypoint).toHaveBeenCalled();
    });
});

describe('route table: cell compare without reading innerHTML (B3)', () => {
    it('an unchanged value does not read or write the cell', () => {
        global.CockpitConfig = { get: (k) => (k === 'routeTable.columns' ? [{ key: 'dist' }] : null) };
        const t = Object.create(RouteTable.prototype);
        t._waypoints = [{ index: 0 }, { index: 1 }];
        t._flights = [];
        t._getCellValue = (wp) => `${wp.index * 10}`;
        document.body.innerHTML = '<table><tbody><tr class="rt-row" data-idx="0"><td></td></tr><tr class="rt-row" data-idx="1"><td></td></tr></tbody><tfoot></tfoot></table>';
        t._tableEl = document.querySelector('table');
        expect(t._updateTableCells()).toBe(true);           // first pass writes the values
        const cells = [...document.querySelectorAll('td')];
        expect(cells.map((c) => c.textContent)).toEqual(['0', '10']);
        const reads = [];
        for (const c of cells) {
            Object.defineProperty(c, 'innerHTML', {
                get() { reads.push('r'); return ''; }, set() { reads.push('w'); }, configurable: true,
            });
        }
        t._updateTableCells();
        expect(reads).toEqual([]);
    });
});
