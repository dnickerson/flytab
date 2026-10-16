/**
 * PR B review #6: the PR B throttles survive the clock being set back.
 *
 * The tablet's clock can step (a GPS or network time sync). Each throttle
 * remembers when it last ran as Date.now(); after a step back, "now - last" is
 * negative. Before the fix, follow stopped until the clock caught up, and the
 * traffic / route-table throttles set a timer as long as the step (an hour
 * back: no traffic and no route-table updates for an hour).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
global.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();

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
const scheduleRouteLive = new Function('sit', extractMethod(read('web/app.js'), '    _scheduleRouteLive(sit) {'));

const T0 = Date.parse('2026-10-15T15:00:00Z');
const HOUR = 3_600_000;

describe('clock set back (PR B review #6)', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); delete window.app; });
    afterEach(() => vi.useRealTimers());

    it('follow: re-centres at once after the clock steps back an hour', () => {
        const c = Object.create(CockpitMap.prototype);
        c.map = {
            getSize: () => ({ x: 1000, y: 600 }),
            latLngToContainerPoint: () => ({ x: 700, y: 300 }),     // 200 px off centre
            panTo: vi.fn(),
        };
        c._lastFollowAt = T0;
        vi.setSystemTime(T0 - HOUR);
        c._followOwnship([35, -80]);
        expect(c.map.panTo).toHaveBeenCalledTimes(1);
        // and the throttle works from the new clock on
        c._followOwnship([35, -80]);
        expect(c.map.panTo).toHaveBeenCalledTimes(1);
        vi.setSystemTime(T0 - HOUR + CockpitMap.FOLLOW_MIN_MS);
        c._followOwnship([35, -80]);
        expect(c.map.panTo).toHaveBeenCalledTimes(2);
    });

    it('traffic: drawn within TRAFFIC_RENDER_MS after the clock steps back an hour', () => {
        const c = Object.create(CockpitMap.prototype);
        c._updateTraffic = vi.fn();
        c._lastTrafficRender = T0;
        vi.setSystemTime(T0 - HOUR);
        c._scheduleTraffic();
        vi.advanceTimersByTime(CockpitMap.TRAFFIC_RENDER_MS);
        expect(c._updateTraffic).toHaveBeenCalledTimes(1);
    });

    it('route table: updated within ROUTE_LIVE_MS after the clock steps back an hour', () => {
        global.FlyTabApp = { ROUTE_LIVE_MS: 1000 };
        const app = { routeTable: { updateLive: vi.fn() }, _checkFuelStopProximity: vi.fn(), _routeLiveAt: T0 };
        vi.setSystemTime(T0 - HOUR);
        scheduleRouteLive.call(app, { lat: 35, lon: -80 });
        vi.advanceTimersByTime(1000);
        expect(app.routeTable.updateLive).toHaveBeenCalledTimes(1);
    });

    it('a step forward still runs at once (unchanged)', () => {
        const c = Object.create(CockpitMap.prototype);
        c._updateTraffic = vi.fn();
        c._lastTrafficRender = T0;
        vi.setSystemTime(T0 + HOUR);
        c._scheduleTraffic();
        expect(c._updateTraffic).toHaveBeenCalledTimes(1);
    });
});
