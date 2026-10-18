/**
 * Two map bugs from the PR B review (plan 2026-10-13, backlog; Dana 2026-10-17):
 *  1. Auto-pan kept re-centring while the pilot dragged or pinched the map.
 *     Now the pilot's own drag or pinch holds following own-ship (button ✋)
 *     until the auto-pan button is tapped (Dana: "Tap ✋ to resume").
 *  2. The magenta active leg advanced only within 1 nm of a waypoint, so
 *     passing one 1.5 nm abeam left it pointing back while the route table had
 *     moved on; it also started at the departure airport (index 0) while the
 *     route table starts at the first en-route waypoint. The map now takes the
 *     active waypoint from ActiveRoute, which the route table and instrument
 *     strip already share.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
global.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const ActiveRoute = new Function(read('web/shared/active-route.js') + '\nreturn ActiveRoute;')();
const CockpitMap = new Function('ActiveRoute', read('web/cockpit/map.js') + '\nreturn CockpitMap;')(ActiveRoute);

const PX_PER_DEG = 4000;
function fakeMap() {
    const handlers = {};
    const m = {
        center: [35.0, -80.0], handlers,
        on: (ev, fn) => { for (const e of ev.split(' ')) (handlers[e] = handlers[e] || []).push(fn); return m; },
        fire: (ev) => (handlers[ev] || []).forEach((fn) => fn({})),
        getSize: () => ({ x: 1000, y: 600 }),
        latLngToContainerPoint: ([lat, lon]) => ({ x: 500 + (lon - m.center[1]) * PX_PER_DEG, y: 300 - (lat - m.center[0]) * PX_PER_DEG }),
        panTo: vi.fn((p) => { m.center = [p[0], p[1]]; }),
        removeLayer: vi.fn(), hasLayer: () => true,
    };
    return m;
}
const fakeLayer = () => ({
    latlng: null, latlngs: null, options: { opacity: 1 }, style: null, setOpacity() {}, setLatLng(p) { this.latlng = p; }, getLatLng() { return this.latlng; },
    setLatLngs(l) { this.latlngs = l; }, setStyle(s) { this.style = s; }, getElement() { return null; },
});
function fakeEl() {
    const h = {};
    return { h, addEventListener: (ev, fn, opts) => { (h[ev] = h[ev] || []).push({ fn, opts }); },
             touch: (n) => (h.touchstart || []).forEach(({ fn }) => fn({ touches: { length: n } })) };
}
function mapCtx() {
    const c = Object.create(CockpitMap.prototype);
    c.map = fakeMap();
    c.ownshipMarker = fakeLayer();
    c._ownshipSvgG = null;
    c._trackVector = fakeLayer();
    c.rangeRings = [fakeLayer()];
    c._activeLegLine = fakeLayer();
    c._autoPan = true;
    c._updateRangeRings = vi.fn();
    c._updateActiveLeg = vi.fn();
    c._refreshAutoPanBtn = vi.fn();
    return c;
}
const FIX = (lat, lon) => ({ lat, lon, gps_fix_quality: 2, true_course: 90, ground_speed: 140, timestamp: Date.now() });

describe('the pilot\'s drag or pinch holds auto-pan until ✋ is tapped', () => {
    beforeEach(() => { vi.useFakeTimers(); delete window.app; });
    afterEach(() => vi.useRealTimers());

    const flyEast = (c, n = 30) => { let lon = -80; for (let i = 0; i < n; i++) { lon += 0.001; c._updateOwnship(FIX(35, lon)); vi.advanceTimersByTime(100); } };

    it('a drag: following stops (no re-centring) until the hold is released', () => {
        const c = mapCtx(); const el = fakeEl();
        c._wirePilotMoveHold(c.map, el);
        c.map.fire('dragstart');
        expect(c._followHold).toBe(true);
        flyEast(c);
        expect(c.map.panTo).not.toHaveBeenCalled();
        c.releaseFollowHold();                               // the ✋ tap
        flyEast(c);
        expect(c.map.panTo).toHaveBeenCalled();
    });

    it('a pinch (two fingers down) holds; one finger (a tap or a drag not started) does not', () => {
        const c = mapCtx(); const el = fakeEl();
        c._wirePilotMoveHold(c.map, el);
        el.touch(1);
        expect(c._followHold).toBeFalsy();
        el.touch(2);
        expect(c._followHold).toBe(true);
        const [{ opts }] = el.h.touchstart;
        expect(opts).toMatchObject({ capture: true, passive: true });   // Leaflet's handlers can't swallow it
    });

    it('auto-pan off: a drag holds nothing (the button would need two taps)', () => {
        const c = mapCtx(); c._autoPan = false; const el = fakeEl();
        c._wirePilotMoveHold(c.map, el);
        c.map.fire('dragstart'); el.touch(2);
        expect(c._followHold).toBeFalsy();
    });

    it('FlyTab\'s own re-centring is not a pilot move (panTo fires no dragstart)', () => {
        const c = mapCtx(); const el = fakeEl();
        c._wirePilotMoveHold(c.map, el);
        flyEast(c);
        expect(c.map.panTo).toHaveBeenCalled();
        expect(c._followHold).toBeFalsy();
    });

    it('the map wires it at construction', () => {
        const src = read('web/cockpit/map.js');
        const ctor = src.slice(src.indexOf('    constructor('), src.indexOf('this._zoomBadgeHandler'));
        expect(src).toMatch(/this\._wirePilotMoveHold\(this\.map, mapDiv\)/);
        expect(src.indexOf('this._wirePilotMoveHold(this.map, mapDiv)')).toBeLessThan(src.indexOf('    // ========== Traffic =========='));
        void ctor;
    });
});

describe('the magenta active leg follows the route table (ActiveRoute)', () => {
    const W = (id, lat, lon) => ({ icao: id, id, lat, lon });
    let c;
    const leg = (pos) => { CockpitMap.prototype._updateActiveLeg.call(c, pos); return c._activeLegLine.latlngs?.[1]; };
    beforeEach(() => {
        c = Object.create(CockpitMap.prototype);
        c.map = fakeMap();
        c._legLines = [fakeLayer(), fakeLayer(), fakeLayer()];
        c._activeLegLine = fakeLayer();
        c._activeWpIdx = 0;
    });

    it('a new route: the leg goes to the first en-route waypoint, not back to the departure', () => {
        const wps = [W('KLKR', 34.72, -80.85), W('CAE', 33.86, -81.05), W('KAIK', 33.65, -81.68)];
        c._routeWaypoints = wps;
        ActiveRoute.setPlan({ waypoints: wps });
        expect(leg([34.6, -80.9])).toEqual([33.86, -81.05]);              // 8 nm out, departure > 1 nm behind
        expect(c._activeWpIdx).toBe(1);
    });

    it('passed 1.5 nm abeam: the route table advances, so does the magenta line', () => {
        const wps = [W('KLKR', 34.72, -80.85), W('CAE', 33.86, -81.05), W('KAIK', 33.65, -81.68)];
        c._routeWaypoints = wps;
        ActiveRoute.setPlan({ waypoints: wps });
        const abeam = [33.86 + 1.5 / 60, -81.06];                        // 1.5 nm north of CAE
        expect(leg(abeam)).toEqual([33.86, -81.05]);
        ActiveRoute.advance();                                            // the route table's passed-abeam rule
        expect(leg(abeam)).toEqual([33.65, -81.68]);
        expect(c._legLines[0].style.opacity).toBeLessThan(1);             // passed legs dimmed
        expect(c._legLines[1].style.opacity).toBeLessThan(1);
    });

    it('the pilot skips ahead in the route table: the line follows', () => {
        const wps = [W('A', 35, -80), W('B', 35, -79), W('C', 35, -78), W('D', 35, -77)];
        c._routeWaypoints = wps; c._legLines = [fakeLayer(), fakeLayer(), fakeLayer()];
        ActiveRoute.setPlan({ waypoints: wps });
        ActiveRoute.setIndex(3);
        expect(leg([35, -80.5])).toEqual([35, -77]);
    });

    it('a fix flown twice: the occurrence at the route table\'s index, not the first', () => {
        const wps = [W('A', 35, -80), W('B', 35, -79), W('A', 35, -80), W('C', 35, -78)];
        c._routeWaypoints = wps;
        ActiveRoute.setPlan({ waypoints: wps });
        ActiveRoute.setIndex(2);
        leg([35, -79.2]);
        expect(c._activeWpIdx).toBe(2);
    });

    it('lists shifted (the map lacks a waypoint the route table has): matched by position', () => {
        const plan = [W('A', 35, -80), W('X', 35, -79.5), W('B', 35, -79), W('C', 35, -78)];
        c._routeWaypoints = [plan[0], plan[2], plan[3]].map((w) => ({ ...w }));   // copies, one fewer
        ActiveRoute.setPlan({ waypoints: plan });
        ActiveRoute.setIndex(2);                                          // B
        expect(leg([35, -79.6])).toEqual([35, -79]);
        expect(c._activeWpIdx).toBe(1);
    });

    it('no route-table plan for this route: the old 1 nm rule still works', () => {
        ActiveRoute.setPlan(null);
        const wps = [W('A', 35, -80), W('B', 35, -79), W('C', 35, -78)];
        c._routeWaypoints = wps;
        leg([35, -79.995]);                                               // within 1 nm of A
        expect(c._activeWpIdx).toBe(1);
    });
});
