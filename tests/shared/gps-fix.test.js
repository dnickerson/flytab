/**
 * Own-ship is drawn only with at least a 3D GPS solution.
 *
 * GpsFix (web/shared/gps-fix.js) is the single rule; it mirrors the Stratux
 * status page's "GPS solution" (Stratux main/gen_gdl90.go updateStatus():
 * GPSFixQuality 0 "No Fix", 1 "3D GPS", 2 "3D GPS + SBAS", 6 "Dead Reckoning").
 * These tests cover the rule, every producer that feeds it, and every
 * own-ship display that uses it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
global.WebSocket = global.WebSocket || class { constructor() {} close() {} static OPEN = 1; };
global.CockpitConfig = global.CockpitConfig || { raw: {}, get: () => true };
global.Settings = global.Settings || { stratuxIp: '127.0.0.1', ownshipModeS: '000000' };
global.TrafficDiag = global.TrafficDiag || { wsEvent: vi.fn() };

const GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
global.GpsFix = GpsFix;

const FIX = { lat: 34.72, lon: -80.85, gps_fix_quality: 1, true_course: 90, ground_speed: 0 };

describe('GpsFix.has3DFix — the Stratux "GPS solution" rule', () => {
    it.each([
        [0, false, 'No Fix'],
        [1, true, '3D GPS'],
        [2, true, '3D GPS + SBAS'],
        [3, true, 'PPS'],
        [4, true, 'RTK'],
        [5, true, 'float RTK'],
        [6, false, 'Dead Reckoning'],
        [7, false, 'manual input'],
        [8, false, 'simulator'],
    ])('fix quality %i -> %s (%s)', (q, ok) => {
        expect(GpsFix.has3DFix({ ...FIX, gps_fix_quality: q })).toBe(ok);
    });

    it('rejects a missing or non-numeric fix quality', () => {
        expect(GpsFix.has3DFix({ ...FIX, gps_fix_quality: undefined })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, gps_fix_quality: null })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, gps_fix_quality: '1' })).toBe(false);
    });

    it('rejects 0,0, NaN, missing and out-of-range positions even with a fix', () => {
        expect(GpsFix.has3DFix({ ...FIX, lat: 0, lon: 0 })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, lat: NaN })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, lon: undefined })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, lat: 91 })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, lon: -181 })).toBe(false);
    });

    it('accepts a real position on the equator or prime meridian (only 0,0 together is the sentinel)', () => {
        expect(GpsFix.has3DFix({ ...FIX, lat: 0, lon: -80 })).toBe(true);
        expect(GpsFix.has3DFix({ ...FIX, lat: 51.5, lon: 0 })).toBe(true);
    });

    it('rejects a producer-flagged non-3D solution (gps_3d: false)', () => {
        expect(GpsFix.has3DFix({ ...FIX, gps_3d: false })).toBe(false);
        expect(GpsFix.has3DFix({ ...FIX, gps_3d: true })).toBe(true);
    });

    it('rejects null', () => {
        expect(GpsFix.has3DFix(null)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

describe('StratuxClient — GDL 90 situations use the WS fix quality while the WS is live', () => {
    const StratuxClient = new Function(read('web/shared/stratux-client.js') + '\nreturn StratuxClient;')();
    const WS = { GPSLatitude: 34.72, GPSLongitude: -80.85, GPSSatellites: 9, GPSSatellitesSeen: 12 };
    // What StratuxUdpPlugin emits: no satellites, quality 2 whenever the
    // heartbeat's GPS-valid bit is set (Stratux sets it for dead reckoning too).
    const GDL = { GPSLatitude: 34.72, GPSLongitude: -80.85, GPSFixQuality: 2 };

    let client;
    beforeEach(() => { client = new StratuxClient(); });

    it('a GDL 90 "valid" during WS dead reckoning stays dead reckoning (no flicker back to a fix)', () => {
        client._handleSituation({ ...WS, GPSFixQuality: 6 }, 'ws');
        client._handleSituation(GDL, 'gdl90');
        expect(client.situation.gps_fix_quality).toBe(6);
        expect(GpsFix.has3DFix(client.situation)).toBe(false);
    });

    it('a GDL 90 situation carries the WS satellite counts', () => {
        client._handleSituation({ ...WS, GPSFixQuality: 1 }, 'ws');
        client._handleSituation(GDL, 'gdl90');
        expect(client.situation.gps_fix_quality).toBe(1);
        expect(client.situation.gps_sats).toBe(9);
    });

    it('with no recent WS situation, GDL 90 uses its own value', () => {
        client._handleSituation({ ...WS, GPSFixQuality: 0 }, 'ws');
        client._wsFix.at -= StratuxClient.WS_FIX_FRESH_MS + 1;
        client._handleSituation(GDL, 'gdl90');
        expect(client.situation.gps_fix_quality).toBe(2);
    });

    it('a WS situation is taken as-is', () => {
        client._handleSituation({ ...WS, GPSFixQuality: 0 }, 'ws');
        expect(client.situation.gps_fix_quality).toBe(0);
        client._handleSituation({ ...WS, GPSFixQuality: 2 });   // default transport is ws
        expect(client.situation.gps_fix_quality).toBe(2);
    });
});

describe('EngineGpsBridge — forwards the Pi\'s Stratux fix quality', () => {
    const EngineGpsBridge = new Function(
        read('web/shared/gps-staleness.js') + '\n' + read('web/shared/engine-gps-bridge.js') + '\nreturn EngineGpsBridge;')();

    function tick(engineData) {
        const stratux = new EventTarget();
        stratux.situation = null;
        stratux.stale = true;
        stratux._suppressGpsSituation = false;
        const bridge = Object.create(EngineGpsBridge.prototype);
        bridge._stratux = stratux;
        bridge._engine = { stale: false, lastData: engineData };
        bridge._active = false;
        bridge._staleTimer = null;
        bridge._resetStaleTimer = () => {};
        bridge._tick();
        return stratux.situation;
    }
    const PI = { latitude: 34.72, longitude: -80.85, gps_altitude: 600, ground_speed: 0, course: 0 };

    it('no fix on the Pi (gps_fix_quality 0) -> no own-ship', () => {
        const sit = tick({ ...PI, gps_fix_quality: 0 });
        expect(sit.gps_fix_quality).toBe(0);
        expect(GpsFix.has3DFix(sit)).toBe(false);
    });

    it('a 3D fix on the Pi passes through', () => {
        const sit = tick({ ...PI, gps_fix_quality: 2 });
        expect(GpsFix.has3DFix(sit)).toBe(true);
    });

    it('an older Pi without the field is assumed a fix, but 0,0 is still rejected', () => {
        expect(GpsFix.has3DFix(tick(PI))).toBe(true);
        expect(GpsFix.has3DFix(tick({ ...PI, latitude: 0, longitude: 0 }))).toBe(false);
    });
});

describe('GpsSource — a device fix without altitude is not 3D', () => {
    const src = read('web/shared/gps-source.js');
    it('sets gps_3d from coords.altitude', () => {
        expect(src).toMatch(/gps_3d:\s*c\.altitude != null/);
    });
});

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

function fakeLayer() {
    return {
        opacity: 1, latlng: null, removed: false,
        setOpacity(o) { this.opacity = o; }, setLatLng(p) { this.latlng = p; },
        setStyle(st) { if ('opacity' in st) this.opacity = st.opacity; },
        getElement() { return null; },
    };
}

describe('CockpitMap own-ship marker', () => {
    const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();

    function mapCtx() {
        const removed = [];
        const ctx = Object.create(CockpitMap.prototype);
        ctx.map = { removeLayer: (l) => removed.push(l), panTo: vi.fn(), hasLayer: () => true };
        ctx.ownshipMarker = fakeLayer();
        ctx._ownshipSvgG = null;
        ctx._trackVector = fakeLayer();
        ctx.rangeRings = [fakeLayer(), fakeLayer()];
        ctx._activeLegLine = fakeLayer();
        ctx._autoPan = true;
        ctx._updateRangeRings = vi.fn();
        ctx._updateActiveLeg = vi.fn();
        ctx._removed = removed;
        return ctx;
    }

    it.each([
        ['no fix', { ...FIX, gps_fix_quality: 0 }],
        ['dead reckoning', { ...FIX, gps_fix_quality: 6 }],
        ['0,0 with a fix', { ...FIX, lat: 0, lon: 0 }],
        ['no situation', null],
    ])('%s: marker hidden (not dimmed), map not panned, rings/leg/track removed', (_name, sit) => {
        const ctx = mapCtx();
        const marker = ctx.ownshipMarker, track = ctx._trackVector;
        ctx._updateOwnship(sit);
        expect(marker.opacity).toBe(0);
        expect(track.opacity).toBe(0);
        expect(ctx.rangeRings).toBeNull();
        expect(ctx._activeLegLine).toBeNull();
        expect(ctx.map.panTo).not.toHaveBeenCalled();
        expect(ctx._updateRangeRings).not.toHaveBeenCalled();
        expect(ctx._updateActiveLeg).not.toHaveBeenCalled();
    });

    it('3D fix: marker shown at the position', () => {
        const ctx = mapCtx();
        ctx.ownshipMarker.opacity = 0;
        ctx._updateOwnship({ ...FIX, gps_fix_quality: 1 });
        expect(ctx.ownshipMarker.opacity).toBe(1);
        expect(ctx.ownshipMarker.latlng).toEqual([34.72, -80.85]);
        expect(ctx.map.panTo).toHaveBeenCalled();
    });

    it('never creates the marker from a position without a fix', () => {
        const ctx = mapCtx();
        ctx.ownshipMarker = null;
        ctx._updateOwnship({ ...FIX, gps_fix_quality: 0 });
        expect(ctx.ownshipMarker).toBeNull();
        expect(ctx.map.panTo).not.toHaveBeenCalled();
    });
});

describe('RadarPage own-ship marker', () => {
    const RadarPage = new Function(read('web/cockpit/radar-page.js') + '\nreturn RadarPage;')();

    it('hides the marker and forgets the position without a 3D fix', () => {
        const ctx = Object.create(RadarPage.prototype);
        ctx._ownship = fakeLayer();
        ctx._ownPos = { lat: 1, lon: 1, course: 0 };
        ctx._visible = true;
        ctx._map = {};
        ctx._updateOwnship({ ...FIX, gps_fix_quality: 0 });
        expect(ctx._ownship.opacity).toBe(0);
        expect(ctx._ownPos).toBeNull();
    });

    it('shows it again on a 3D fix', () => {
        const ctx = Object.create(RadarPage.prototype);
        ctx._ownship = fakeLayer();
        ctx._ownship.opacity = 0;
        ctx._visible = true;
        ctx._map = {};
        ctx._updateOwnship(FIX);
        expect(ctx._ownship.opacity).toBe(1);
        expect(ctx._ownship.latlng).toEqual([34.72, -80.85]);
    });
});

describe('ApproachCharts plate own-ship', () => {
    const ApproachCharts = new Function(read('web/cockpit/approach-charts.js') + '\nreturn ApproachCharts;')();

    it('null lat/lon clears the plate own-ship position', () => {
        const ctx = Object.create(ApproachCharts.prototype);
        ctx._currentPlate = null;
        ctx.updateOwnship(34.7, -80.8, 90);
        expect(ctx._ownshipPos).toEqual({ lat: 34.7, lon: -80.8 });
        ctx.updateOwnship(null, null);
        expect(ctx._ownshipPos).toBeNull();
    });

    it('app.js only passes a position to the plate with a 3D fix', () => {
        const app = read('web/app.js');
        expect(app).toMatch(/GpsFix\.has3DFix\(e\.detail\)\)\s*\{\s*this\.approachCharts\.updateOwnship\(e\.detail\.lat/);
        expect(app).toMatch(/this\.approachCharts\.updateOwnship\(null, null\)/);
    });
});
