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
