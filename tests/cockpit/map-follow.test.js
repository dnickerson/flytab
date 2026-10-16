/**
 * PR B / B2: re-centre only when needed; map layers keep refreshing in flight.
 *
 * B0 (2026-10-15, 10 situations/s): an animated panTo on every situation ->
 * 10 moveend/s, and _updateDynamicLayers ran 1x/min: its 300 ms debounce was
 * reset by every moveend, so while the map followed own-ship, airspace and
 * airports barely refreshed. Now:
 *  - follow: no animation, at most every FOLLOW_MIN_MS, only after own-ship
 *    drifted FOLLOW_MIN_DRIFT_PX from the centre (small steps, few moves);
 *  - the vector-layer and fix-overlay debounces have a max wait;
 *  - the NEXRAD canvas redraws at most once per animation frame on map moves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
global.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();
const VectorMapLayers = new Function(read('web/cockpit/vector-map-layers.js') + '\nreturn VectorMapLayers;')();
const FisbNexrad = new Function(read('web/cockpit/fisb-nexrad.js') + '\nreturn FisbNexrad;')();

const PX_PER_DEG = 4000;    // ~zoom 11-12

/** A map whose centre moves only via panTo; container point = offset from centre. */
function fakeMap() {
    const m = {
        center: [35.0, -80.0],
        getSize: () => ({ x: 1000, y: 600 }),
        latLngToContainerPoint: ([lat, lon]) => ({ x: 500 + (lon - m.center[1]) * PX_PER_DEG, y: 300 - (lat - m.center[0]) * PX_PER_DEG }),
        panTo: vi.fn((p) => { m.center = [p[0], p[1]]; }),
        removeLayer: vi.fn(), hasLayer: () => true,
    };
    return m;
}

function fakeLayer() {
    return {
        latlng: null, options: { opacity: 1 }, setOpacity() {}, setLatLng(p) { this.latlng = p; }, getLatLng() { return this.latlng; },
        setLatLngs() {}, setStyle() {}, getElement() { return null; },
    };
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
    return c;
}

const FIX = (lon) => ({ lat: 35.0, lon, gps_fix_quality: 2, true_course: 90, ground_speed: 140, timestamp: Date.now() });

describe('following own-ship (B2)', () => {
    beforeEach(() => { vi.useFakeTimers(); delete window.app; });
    afterEach(() => vi.useRealTimers());

    it('10 situations a second: at most 2 re-centres a second, never animated', () => {
        const c = mapCtx();
        let lon = -80.0;
        for (let i = 0; i < 100; i++) {           // 10 s at 10 Hz, ~2.6 px per 0.1 s
            lon += 0.00065;
            c._updateOwnship(FIX(lon));
            vi.advanceTimersByTime(100);
        }
        const pans = c.map.panTo.mock.calls;
        expect(pans.length).toBeLessThanOrEqual(21);
        expect(pans.length).toBeGreaterThanOrEqual(15);
        for (const [, opts] of pans) expect(opts?.animate).toBe(false);
        // The map keeps own-ship near the centre: never more than ~a step behind.
        const p = c.map.latLngToContainerPoint([35.0, lon]);
        expect(Math.abs(p.x - 500)).toBeLessThan(20);
    });

    it('own-ship still within a couple of pixels of the centre: no re-centre at all', () => {
        const c = mapCtx();
        c._updateOwnship(FIX(-80.0));
        vi.advanceTimersByTime(1000);
        c._updateOwnship(FIX(-80.0 + 0.0002));    // 0.8 px
        expect(c.map.panTo).not.toHaveBeenCalled();
    });

    it('the first fix centres the map at once', () => {
        const c = mapCtx();
        c.ownshipMarker = null;
        const realL = global.L;
        global.L = { divIcon: () => ({}), marker: (p) => ({ ...fakeLayer(), latlng: p, addTo() { return this; } }) };
        c._updateOwnship(FIX(-79.0));
        expect(c.map.panTo).toHaveBeenCalledTimes(1);
        global.L = realL;
    });

    it('auto-pan off: no re-centring', () => {
        const c = mapCtx();
        c._autoPan = false;
        c._updateOwnship(FIX(-79.9));
        vi.advanceTimersByTime(1000);
        c._updateOwnship(FIX(-79.8));
        expect(c.map.panTo).not.toHaveBeenCalled();
    });
});

describe('layer refresh while the map keeps moving (B2)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('vector layers: a moveend every 100 ms still refreshes at least every ~2 s', () => {
        const v = Object.create(VectorMapLayers.prototype);
        v._updateDynamicLayers = vi.fn();
        for (let i = 0; i < 100; i++) { v._scheduleUpdate(); vi.advanceTimersByTime(100); }   // 10 s
        expect(v._updateDynamicLayers.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(v._updateDynamicLayers.mock.calls.length).toBeLessThanOrEqual(6);
    });

    it('vector layers: a single move still refreshes 300 ms later, once', () => {
        const v = Object.create(VectorMapLayers.prototype);
        v._updateDynamicLayers = vi.fn();
        v._scheduleUpdate();
        vi.advanceTimersByTime(299);
        expect(v._updateDynamicLayers).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(1);
    });

    it('fix overlay: same max wait', () => {
        const c = Object.create(CockpitMap.prototype);
        c._updateFixOverlay = vi.fn();
        for (let i = 0; i < 100; i++) { c._scheduleFixUpdate(); vi.advanceTimersByTime(100); }
        expect(c._updateFixOverlay.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
});

// PR B review #5: at z12-14 a follow re-centre came every 0.5-1 s and each one
// triggered a full 8-layer refresh 300 ms later: 120 refreshes/min, task time
// 36-42 s/min (worse than B0). Refreshes caused by auto-pan are now spaced
// FOLLOW_MIN_INTERVAL_MS apart; the pilot's own moves still refresh in 300 ms.
describe('layer refresh while following (PR B review #5)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('re-centres every 0.5 s for 12 s: refreshes spaced FOLLOW_MIN_INTERVAL_MS apart', () => {
        const v = Object.create(VectorMapLayers.prototype);
        v._updateDynamicLayers = vi.fn();
        for (let i = 0; i < 24; i++) { v._scheduleUpdate(true); vi.advanceTimersByTime(500); }
        const n = v._updateDynamicLayers.mock.calls.length;
        expect(n).toBeLessThanOrEqual(Math.ceil(12000 / VectorMapLayers.FOLLOW_MIN_INTERVAL_MS) + 1);
        expect(n).toBeGreaterThanOrEqual(Math.floor(12000 / VectorMapLayers.FOLLOW_MIN_INTERVAL_MS) - 1);
    });

    it('a pilot pan right after a follow refresh still refreshes within 300 ms', () => {
        const v = Object.create(VectorMapLayers.prototype);
        v._updateDynamicLayers = vi.fn();
        v._scheduleUpdate(true);
        vi.advanceTimersByTime(300);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(1);
        v._scheduleUpdate(true);                      // follow: would wait ~3 s
        vi.advanceTimersByTime(100);
        v._scheduleUpdate(false);                     // the pilot drags the map
        vi.advanceTimersByTime(300);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(2);
    });

    it('the moveend handlers pass whether the move came from auto-pan', () => {
        const vsrc = read('web/cockpit/vector-map-layers.js');
        expect(vsrc).toMatch(/on\('moveend zoomend', \(\) => this\._scheduleUpdate\(this\._map\._flytabFollowMove === true\)\)/);
        const msrc = read('web/cockpit/map.js');
        expect(msrc).toMatch(/on\('moveend zoomend', \(\) => this\._scheduleFixUpdate\(this\.map\._flytabFollowMove === true\)\)/);
    });

    it('_followOwnship marks its own pan, and only for its duration', () => {
        const c = mapCtx();
        let flagDuringPan = null;
        c.map.panTo = vi.fn(() => { flagDuringPan = c.map._flytabFollowMove; });
        c._lastFollowAt = 0;
        c._followOwnship([35.0, -79.9]);
        expect(flagDuringPan).toBe(true);
        expect(c.map._flytabFollowMove).toBe(false);
    });
});

// Second PR B review, #3: an auto-pan re-centre arriving just after the pilot's
// own move must not push the pilot's refresh back to the follow spacing.
describe('pilot move, then an auto-pan re-centre (second PR B review #3)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('vector layers: the pilot\'s refresh still comes 300 ms after their move', () => {
        const v = Object.create(VectorMapLayers.prototype);
        v._updateDynamicLayers = vi.fn();
        v._scheduleUpdate(false);
        vi.advanceTimersByTime(300);                  // a refresh 1 s ago...
        vi.advanceTimersByTime(700);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(1);
        v._scheduleUpdate(false);                     // ...the pilot zooms
        vi.advanceTimersByTime(100);
        v._scheduleUpdate(true);                      // own-ship re-centred 100 ms later
        vi.advanceTimersByTime(200);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(2);
        // and follow spacing applies again after that refresh
        v._scheduleUpdate(true);
        vi.advanceTimersByTime(300);
        expect(v._updateDynamicLayers).toHaveBeenCalledTimes(2);
    });

    it('fix overlay: the same', () => {
        const c = Object.create(CockpitMap.prototype);
        c._updateFixOverlay = vi.fn();
        c._scheduleFixUpdate(false);
        vi.advanceTimersByTime(1000);
        expect(c._updateFixOverlay).toHaveBeenCalledTimes(1);
        c._scheduleFixUpdate(false);
        vi.advanceTimersByTime(100);
        c._scheduleFixUpdate(true);
        vi.advanceTimersByTime(200);
        expect(c._updateFixOverlay).toHaveBeenCalledTimes(2);
    });
});

// Route Planner (preview): tapping a bubble centres the map on it (Dana,
// 2026-10-16). With auto-pan on, following own-ship would undo that within
// 0.5 s, so it is held until the planner closes or the pilot taps auto-pan.
describe('show a point, holding own-ship follow', () => {
    beforeEach(() => { vi.useFakeTimers(); delete window.app; });
    afterEach(() => vi.useRealTimers());

    it('showPoint centres the map and stops following until released', () => {
        const c = mapCtx();
        c._autoPanBtn = document.createElement('button');
        c.showPoint(34.5, -81.0);
        expect(c.map.panTo).toHaveBeenLastCalledWith([34.5, -81.0], { animate: false });
        c.map.panTo.mockClear();
        let lon = -80.0;
        for (let i = 0; i < 20; i++) { lon += 0.01; c._updateOwnship(FIX(lon)); vi.advanceTimersByTime(600); }
        expect(c.map.panTo).not.toHaveBeenCalled();                 // held
        expect(c._autoPanBtn.classList.contains('held')).toBe(true);
        c.releaseFollowHold();
        c._updateOwnship(FIX(lon + 0.01));
        expect(c.map.panTo).toHaveBeenCalled();                     // following again
        expect(c._autoPanBtn.classList.contains('held')).toBe(false);
    });

    it('showPoints fits the whole route and holds follow (Apply, 2026-10-16)', () => {
        const c = mapCtx();
        c._autoPanBtn = document.createElement('button');
        c.map.fitBounds = vi.fn();
        c.showPoints([{ lat: 33.6, lon: -82.0 }, { lat: NaN, lon: 1 }, { lat: 25.6, lon: -80.4 }]);
        expect(c.map.fitBounds).toHaveBeenCalledWith([[33.6, -82.0], [25.6, -80.4]], { padding: [40, 40], maxZoom: 11, animate: false });
        expect(c._followHold).toBe(true);
        expect(c._autoPanBtn.classList.contains('held')).toBe(true);
        c.map.fitBounds.mockClear();
        c.showPoints([{ lat: 33.6, lon: -82.0 }]);              // one point: nothing to fit
        expect(c.map.fitBounds).not.toHaveBeenCalled();
    });

    it('auto-pan off: showing a point moves the map but holds nothing (one tap turns auto-pan on)', () => {
        const c = mapCtx();
        c._autoPan = false;
        c._autoPanBtn = document.createElement('button');
        c.map.fitBounds = vi.fn();
        c.showPoint(34.5, -81.0);
        c.showBounds({ lat: 34, lon: -81 }, { lat: 35, lon: -80 });
        c.showPoints([{ lat: 34, lon: -81 }, { lat: 35, lon: -80 }]);
        expect(c.map.panTo).toHaveBeenCalled();
        expect(c.map.fitBounds).toHaveBeenCalledTimes(2);
        expect(c._followHold).toBeFalsy();
        expect(c._autoPanBtn.classList.contains('held')).toBe(false);
    });

    it('back on screen while held: no jump back to own-ship', () => {
        const c = mapCtx();
        c._autoPanBtn = document.createElement('button');
        c._updateTraffic = vi.fn();
        c.ownshipMarker.setLatLng([35.5, -80.5]);
        c.showPoint(34.5, -81.0);
        c.map.panTo.mockClear();
        c._onScreenChange({ onScreen: true });
        expect(c.map.panTo).not.toHaveBeenCalled();
        c.releaseFollowHold();
        c._onScreenChange({ onScreen: true });
        expect(c.map.panTo).toHaveBeenCalledWith([35.5, -80.5], { animate: false });
    });

    it('the auto-pan button, while held, resumes following (does not turn auto-pan off)', () => {
        const src = read('web/cockpit/map.js');
        const btn = src.slice(src.indexOf("autoPanBtn.title = 'Toggle auto-pan';"), src.indexOf('this._autoPanBtn = autoPanBtn;'));
        expect(btn).toMatch(/if \(this\._followHold\) \{ this\.releaseFollowHold\(\); return; \}/);
    });

    it('switching planners releases the hold and closes the other planner', () => {
        const src = read('web/app.js');
        const old = src.slice(src.indexOf('    openRoutePlanner(plan) {'), src.indexOf('    async reverseActiveRoute('));
        expect(old).toMatch(/routePlannerPreview\?\.close\(\)/);
        expect(old).toMatch(/releaseFollowHold/);
        const pv = src.slice(src.indexOf('    openRoutePlannerPreview(plan) {'), src.indexOf('    async routeFromClearance('));
        expect(pv).toMatch(/routePlannerPanel\?\.close\(\)/);
    });

    it('closing the route planner releases the hold', () => {
        const src = read('web/app.js');
        const close = src.slice(src.indexOf('    closeRoutePlanner() {'), src.indexOf('    async applyRouteEdit('));
        expect(close).toMatch(/this\.cockpitMap\?\.releaseFollowHold\?\.\(\)/);
    });
});

describe('NEXRAD canvas on map moves (B2)', () => {
    it('many move events in one frame: one redraw, on the next frame', () => {
        const frames = [];
        global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
        const n = Object.create(FisbNexrad.prototype);
        n._loopMode = false;
        n._draw = vi.fn();
        // the constructor's handler, bound to this instance
        const ctorSrc = read('web/cockpit/fisb-nexrad.js');
        expect(ctorSrc).toMatch(/this\._onMove = \(\) => this\._scheduleMoveDraw\(\);/);
        for (let i = 0; i < 10; i++) n._scheduleMoveDraw();
        expect(n._draw).not.toHaveBeenCalled();
        frames.splice(0).forEach((f) => f());
        expect(n._draw).toHaveBeenCalledTimes(1);
        n._scheduleMoveDraw();
        frames.splice(0).forEach((f) => f());
        expect(n._draw).toHaveBeenCalledTimes(2);
    });

    it('in loop mode the live canvas is not redrawn', () => {
        const frames = [];
        global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
        const n = Object.create(FisbNexrad.prototype);
        n._loopMode = true;
        n._draw = vi.fn();
        n._scheduleMoveDraw();
        frames.splice(0).forEach((f) => f());
        expect(n._draw).not.toHaveBeenCalled();
    });
});
