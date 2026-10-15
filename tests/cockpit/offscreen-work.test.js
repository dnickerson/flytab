/**
 * PR A review #8 (minimal): since A6/A7 FlyTab keeps running off screen (screen
 * off, another app in front) until it's closed with Back. Work that only draws
 * is skipped while off screen and caught up on return; state keeps updating.
 *  - map: no animated re-centre (panTo, ~10 Hz -> moveend -> vector redraws) and
 *    no traffic marker rebuild off screen; on return, one traffic refresh and
 *    one re-centre.
 *  - track log: only fresh positions are recorded. It appended the last-known
 *    situation every 10 s forever (no freshness check), so in the background
 *    after a flight it filled its 12 h ring with copies of one stale point.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
global.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();
const TrackLog = new Function(read('web/cockpit/track-log.js') + '\nreturn TrackLog;')();

const FIX = { lat: 34.72, lon: -80.85, gps_fix_quality: 2, true_course: 90, ground_speed: 120 };

function fakeLayer() {
    return {
        opacity: 1, latlng: null, options: { opacity: 1 },
        setOpacity(o) { this.opacity = o; }, setLatLng(p) { this.latlng = p; }, getLatLng() { return this.latlng; },
        setLatLngs(p) { this.latlng = p; }, setStyle() {}, getElement() { return null; },
    };
}

function mapCtx() {
    const ctx = Object.create(CockpitMap.prototype);
    ctx.map = { removeLayer: vi.fn(), panTo: vi.fn(), getSize: () => ({ x: 1000, y: 600 }), latLngToContainerPoint: () => ({ x: 0, y: 0 }), hasLayer: () => true };
    ctx.ownshipMarker = fakeLayer();
    ctx._ownshipSvgG = null;
    ctx._trackVector = fakeLayer();
    ctx.rangeRings = [fakeLayer()];
    ctx._activeLegLine = fakeLayer();
    ctx._autoPan = true;
    ctx._updateRangeRings = vi.fn();
    ctx._updateActiveLeg = vi.fn();
    ctx.trafficMarkers = new Map();
    let reads = 0;
    ctx.stratux = { get traffic() { reads++; return new Map(); } };
    ctx.trafficReads = () => reads;
    return ctx;
}

describe('map work off screen', () => {
    beforeEach(() => { window.app = { _onScreen: true }; });
    afterEach(() => { delete window.app; });

    it('on screen: own-ship moves and the map follows', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        expect(ctx.ownshipMarker.latlng).toEqual([FIX.lat, FIX.lon]);
        expect(ctx.map.panTo).toHaveBeenCalled();
    });

    it('off screen: own-ship state still updates, but no re-centre', () => {
        const ctx = mapCtx();
        window.app._onScreen = false;
        ctx._updateOwnship(FIX);
        expect(ctx.ownshipMarker.latlng).toEqual([FIX.lat, FIX.lon]);
        expect(ctx.map.panTo).not.toHaveBeenCalled();
    });

    it('off screen: traffic markers are not rebuilt', () => {
        const ctx = mapCtx();
        window.app._onScreen = false;
        ctx._updateTraffic();
        expect(ctx.trafficReads()).toBe(0);
        window.app._onScreen = true;
        ctx._updateTraffic();
        expect(ctx.trafficReads()).toBeGreaterThan(0);
    });

    it('back on screen: traffic refreshed and the map re-centred on own-ship once', () => {
        const ctx = mapCtx();
        window.app._onScreen = false;
        ctx._updateOwnship(FIX);
        window.app._onScreen = true;
        ctx._onScreenChange({ onScreen: true });
        expect(ctx.trafficReads()).toBeGreaterThan(0);
        expect(ctx.map.panTo).toHaveBeenCalledTimes(1);
        expect(ctx.map.panTo.mock.calls[0][0]).toEqual([FIX.lat, FIX.lon]);
    });

    it('back on screen with auto-pan off: no re-centre', () => {
        const ctx = mapCtx();
        ctx._autoPan = false;
        ctx._onScreenChange({ onScreen: true });
        expect(ctx.map.panTo).not.toHaveBeenCalled();
    });

    it('first fix while off screen, auto-pan off: still centred on it once back on screen', () => {
        const ctx = mapCtx();
        ctx._autoPan = false;
        ctx.ownshipMarker = null;                          // no fix yet
        const realL = global.L;
        global.L = { divIcon: () => ({}), marker: (p) => ({ ...fakeLayer(), latlng: p, addTo() { return this; } }) };
        window.app._onScreen = false;
        ctx._updateOwnship(FIX);
        expect(ctx.map.panTo).not.toHaveBeenCalled();
        ctx._onScreenChange({ onScreen: true });
        expect(ctx.map.panTo).toHaveBeenCalledTimes(1);
        ctx._onScreenChange({ onScreen: true });         // only once
        expect(ctx.map.panTo).toHaveBeenCalledTimes(1);
        global.L = realL;
    });

    it('no app yet (startup) counts as on screen', () => {
        delete window.app;
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        expect(ctx.map.panTo).toHaveBeenCalled();
    });
});

describe('track log records only fresh positions', () => {
    beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-14T16:00:00Z')); });
    afterEach(() => vi.useRealTimers());

    const log = (sit) => { const t = new TrackLog({ situation: sit }, null); t._record(); return t.points.length; };

    it('a fresh fix is recorded', () => {
        expect(log({ ...FIX, timestamp: Date.now() - 500 })).toBe(1);
    });

    it('the last-known situation from long ago is not', () => {
        expect(log({ ...FIX, timestamp: Date.now() - 20_000 })).toBe(0);
    });

    it('a situation marked stale (feed stopped) is not', () => {
        expect(log({ ...FIX, timestamp: Date.now() - 500, _stale: true })).toBe(0);
    });

    it('in the background after a flight: an hour of ticks adds nothing', () => {
        const t = new TrackLog({ situation: { ...FIX, timestamp: Date.now() } }, null);
        t._record();
        for (let i = 0; i < 360; i++) { vi.advanceTimersByTime(10_000); t._record(); }
        expect(t.points.length).toBe(1);
    });
});
