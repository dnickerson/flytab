/**
 * Own-ship rides through a short Stratux data gap (2026-10-13 flight).
 *
 * The Stratux GPS held a 3D fix, but the tablet's link to Stratux dropped
 * (every WS closed in the same second, engine monitor unreachable too) and
 * the map hid own-ship the moment stratux:stale / stratux:disconnect fired,
 * then showed it again on the next situation -- own-ship faded in and out.
 *
 * Rule (pilot's choice): when position stops ARRIVING, keep the marker at the
 * last fix, dimmed, for up to GpsFix.HOLD_MS (15 s) after that fix, then hide.
 * When Stratux REPORTS no fix (quality 0 / dead reckoning), hide at once as
 * before (v10.86) -- Stratux only says that after 3 s with no GPS fix.
 *
 * Also: the engine-GPS bridge, handing back to a recovered Stratux, used to
 * re-dispatch the fresh Stratux situation as "no fix" -- hiding own-ship again
 * right after it came back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');

global.DiagLog = global.DiagLog || { log: vi.fn() };
if (typeof global.CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(t, o) { super(t); this.detail = o?.detail; }
    };
}

const GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
global.GpsFix = GpsFix;

const FIX = { lat: 34.72, lon: -80.85, gps_fix_quality: 2, true_course: 90, ground_speed: 120 };

function fakeLayer() {
    return {
        opacity: 1, latlng: null, options: { opacity: 1 },
        setOpacity(o) { this.opacity = o; }, setLatLng(p) { this.latlng = p; },
        setLatLngs(p) { this.latlng = p; },
        setStyle(st) { if ('opacity' in st) { this.opacity = st.opacity; this.options.opacity = st.opacity; } },
        getElement() { return null; },
    };
}

describe('CockpitMap — own-ship hold through a data gap', () => {
    const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();

    function mapCtx() {
        const ctx = Object.create(CockpitMap.prototype);
        ctx.map = { removeLayer: vi.fn(), panTo: vi.fn(), hasLayer: () => true };
        ctx.ownshipMarker = fakeLayer();
        ctx._ownshipSvgG = null;
        ctx._trackVector = fakeLayer();
        ctx.rangeRings = [fakeLayer(), fakeLayer()];
        ctx._activeLegLine = fakeLayer();
        ctx._autoPan = true;
        ctx._updateRangeRings = vi.fn();
        ctx._updateActiveLeg = vi.fn();
        return ctx;
    }

    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T15:46:00Z')); });
    afterEach(() => { vi.useRealTimers(); });

    it('hold is 15 s', () => {
        expect(GpsFix.HOLD_MS).toBe(15000);
    });

    it('feed lost right after a fix: marker stays, dimmed, with rings and active leg', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(5000);           // stratux:stale fires 5 s after the last data
        ctx._onFeedLost();
        expect(ctx.ownshipMarker.opacity).toBeGreaterThan(0);
        expect(ctx.ownshipMarker.opacity).toBeLessThan(1);
        expect(ctx.rangeRings).not.toBeNull();
        expect(ctx._activeLegLine).not.toBeNull();
        expect(ctx.ownshipHeld).toBe(true);
    });

    it('hides 15 s after the last fix if no new fix arrives', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(5000);
        ctx._onFeedLost();
        vi.advanceTimersByTime(9999);           // 14.999 s after the fix
        expect(ctx.ownshipMarker.opacity).toBeGreaterThan(0);
        vi.advanceTimersByTime(1);              // 15 s after the fix
        expect(ctx.ownshipMarker.opacity).toBe(0);
        expect(ctx.rangeRings).toBeNull();
        expect(ctx._activeLegLine).toBeNull();
        expect(ctx.ownshipHeld).toBe(false);
    });

    it('a new fix during the hold restores full opacity and cancels the hide', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(5000);
        ctx._onFeedLost();
        vi.advanceTimersByTime(3000);
        ctx._updateOwnship({ ...FIX, lat: 34.73 });
        expect(ctx.ownshipMarker.opacity).toBe(1);
        expect(ctx.ownshipHeld).toBe(false);
        vi.advanceTimersByTime(20000);          // old hide deadline long past
        expect(ctx.ownshipMarker.opacity).toBe(1);
    });

    it('repeated stale/disconnect events do not extend the hold past 15 s from the fix', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(3000);
        ctx._onFeedLost();                      // disconnect
        vi.advanceTimersByTime(2000);
        ctx._onFeedLost();                      // stale
        vi.advanceTimersByTime(10000);          // 15 s after the fix
        expect(ctx.ownshipMarker.opacity).toBe(0);
    });

    it('feed lost with no fix in the last 15 s: hidden at once', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(16000);
        ctx._onFeedLost();
        expect(ctx.ownshipMarker.opacity).toBe(0);
        expect(ctx.ownshipHeld).toBe(false);
    });

    it('feed lost before any fix: nothing is shown', () => {
        const ctx = mapCtx();
        ctx.ownshipMarker = null;
        ctx._onFeedLost();
        expect(ctx.ownshipMarker).toBeNull();
        expect(ctx.ownshipHeld).toBe(false);
    });

    it('Stratux reporting no fix still hides at once, even during a hold', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(5000);
        ctx._onFeedLost();
        ctx._updateOwnship({ ...FIX, gps_fix_quality: 0 });
        expect(ctx.ownshipMarker.opacity).toBe(0);
        expect(ctx.ownshipHeld).toBe(false);
    });

    it('a watchdog-degraded situation (_stale) is a lost feed, not a lost fix: the hold continues', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        vi.advanceTimersByTime(5000);
        ctx._onFeedLost();
        ctx._updateOwnship({ ...FIX, gps_fix_quality: 0, _stale: true });
        expect(ctx.ownshipMarker.opacity).toBeGreaterThan(0);
        vi.advanceTimersByTime(10000);
        expect(ctx.ownshipMarker.opacity).toBe(0);
    });

    it('a held marker is not panned to or moved', () => {
        const ctx = mapCtx();
        ctx._updateOwnship(FIX);
        ctx.map.panTo.mockClear();
        vi.advanceTimersByTime(5000);
        ctx._onFeedLost();
        expect(ctx.map.panTo).not.toHaveBeenCalled();
    });

    it('init wires stratux:stale and stratux:disconnect to the hold, not to an immediate hide', () => {
        const src = read('web/cockpit/map.js');
        expect(src).toMatch(/addEventListener\('stratux:disconnect',\s*\w*[oO]nFeedLost/);
        expect(src).toMatch(/addEventListener\('stratux:stale',\s*\w*[oO]nFeedLost/);
    });
});

describe('degradeGpsSituation marks the situation as a lost feed', () => {
    it('sets gps_fix_quality 0 and _stale: true', () => {
        const degrade = new Function(read('web/shared/gps-staleness.js') + '\nreturn degradeGpsSituation;')();
        const target = new EventTarget();
        target.situation = { ...FIX };
        const events = [];
        target.addEventListener('stratux:situation', (e) => events.push(e.detail));
        degrade(target);
        expect(events).toHaveLength(1);
        expect(events[0].gps_fix_quality).toBe(0);
        expect(events[0]._stale).toBe(true);
    });
});

describe('EngineGpsBridge — handing back to a recovered Stratux', () => {
    const EngineGpsBridge = new Function(
        `${read('web/shared/gps-staleness.js')}\n${read('web/shared/engine-gps-bridge.js')}\nreturn EngineGpsBridge;`
    )();

    function setup() {
        const stratux = new EventTarget();
        stratux.situation = null;
        stratux.stale = true;
        stratux._suppressGpsSituation = false;
        const engine = { stale: false, lastData: { latitude: 34.7, longitude: -80.8, gps_altitude: 3000, ground_speed: 120, course: 90, gps_fix_quality: 1 } };
        const bridge = Object.create(EngineGpsBridge.prototype);
        Object.assign(bridge, { _stratux: stratux, _engine: engine, _active: false, _staleTimer: null });
        return { stratux, engine, bridge };
    }

    afterEach(() => { vi.useRealTimers(); });

    it('does not re-dispatch the fresh Stratux situation as "no fix"', () => {
        const { stratux, bridge } = setup();
        bridge._tick();                                   // Stratux stale: bridge injects
        expect(bridge.active).toBe(true);

        // Stratux recovers: StratuxClient writes its own fresh situation, clears stale.
        const fresh = { ...FIX, lat: 34.75, _source: undefined };
        stratux.situation = fresh;
        stratux.stale = false;

        const events = [];
        stratux.addEventListener('stratux:situation', (e) => events.push(e.detail));
        bridge._tick();                                   // next engine:data

        expect(bridge.active).toBe(false);
        expect(events).toHaveLength(0);
        expect(stratux.situation).toBe(fresh);
        expect(stratux.situation.gps_fix_quality).toBe(2);
    });

    it('the bridge watchdog does not degrade after a hand-back', () => {
        vi.useFakeTimers();
        const { stratux, bridge } = setup();
        bridge._tick();
        const fresh = { ...FIX };
        stratux.situation = fresh;
        stratux.stale = false;
        bridge._tick();
        vi.advanceTimersByTime(20000);
        expect(stratux.situation).toBe(fresh);
        expect(stratux.situation.gps_fix_quality).toBe(2);
    });

    it('engine GPS lost while Stratux is still stale: still degrades its own injected situation', () => {
        const { stratux, engine, bridge } = setup();
        bridge._tick();
        engine.stale = true;
        const events = [];
        stratux.addEventListener('stratux:situation', (e) => events.push(e.detail));
        bridge._tick();
        expect(events).toHaveLength(1);
        expect(events[0].gps_fix_quality).toBe(0);
    });
});
