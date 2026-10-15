/**
 * PR B / B1: traffic drawn at most twice a second, rebuilding only icons that
 * changed.
 *
 * B0 (2026-10-15, 100 traffic msgs/s, 64 markers): 6,433 setIcon calls per
 * second. Every stratux:traffic message re-ran _updateTraffic over ALL targets,
 * and every marker's icon (L.divIcon -> innerHTML) was rebuilt each time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
global.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();

function fakeLeaflet() {
    const markers = [];
    global.L = {
        divIcon: (o) => ({ ...o }),
        marker: (latlng, opts) => {
            const m = {
                latlng, icon: opts.icon,
                setLatLng: vi.fn(function (p) { this.latlng = p; return this; }),
                setIcon: vi.fn(function (i) { this.icon = i; return this; }),
                on: vi.fn(() => m), addTo: () => m,
            };
            markers.push(m);
            return m;
        },
    };
    return markers;
}

const target = (hex, over = {}) => ({ hex, lat: 35.1, lon: -80.1, alt: 5000, track: 90, speed: 140, callsign: `N${hex}`, last_seen: Date.now(), ...over });

function ctx(targets) {
    const c = Object.create(CockpitMap.prototype);
    c.map = { removeLayer: vi.fn() };
    c.trafficMarkers = new Map();
    c.stratux = { traffic: new Map(targets.map((t) => [t.hex, t])), situation: { lat: 35.0, lon: -80.0, alt_msl: 5200 } };
    c._showTrafficAlt = false;
    return c;
}

describe('traffic markers (B1)', () => {
    let markers;
    beforeEach(() => { vi.useFakeTimers(); markers = fakeLeaflet(); delete window.app; });
    afterEach(() => vi.useRealTimers());

    const setIcons = () => markers.reduce((n, m) => n + m.setIcon.mock.calls.length, 0);

    it('an unchanged target is moved but its icon is not rebuilt', () => {
        const c = ctx([target('A1'), target('A2'), target('A3')]);
        c._updateTraffic();
        expect(markers).toHaveLength(3);
        c.stratux.traffic.get('A1').lat = 35.11;            // position only
        c._updateTraffic();
        expect(setIcons()).toBe(0);
        expect(markers[0].setLatLng).toHaveBeenCalledWith([35.11, -80.1]);
    });

    it('only the target whose look changed gets a new icon', () => {
        const c = ctx([target('A1'), target('A2'), target('A3')]);
        c._updateTraffic();
        c.stratux.traffic.get('A2').track = 180;             // turned
        c._updateTraffic();
        expect(markers[1].setIcon).toHaveBeenCalledTimes(1);
        expect(setIcons()).toBe(1);
        c.stratux.traffic.get('A3').lat = 35.005;             // now within 1 nm, 200 ft: red
        c.stratux.traffic.get('A3').lon = -80.0;
        c._updateTraffic();
        expect(markers[2].setIcon).toHaveBeenCalledTimes(1);
        expect(markers[2].icon.html).toContain('#ff4444');
    });

    it('turning on altitude labels rebuilds every icon at once (layer-panel toggle)', () => {
        const c = ctx([target('A1'), target('A2')]);
        c._updateTraffic();
        c.setShowTrafficAlt(true);
        expect(setIcons()).toBe(2);
        expect(markers[0].icon.html).toContain('traffic-alt');
    });

    it('100 traffic messages in a second draw at most 3 times, and the last state is drawn', () => {
        const c = ctx([target('A1')]);
        const spy = vi.spyOn(c, '_updateTraffic');
        for (let i = 0; i < 100; i++) {
            c.stratux.traffic.get('A1').lat = 35.1 + i * 0.0001;
            c._scheduleTraffic();
            vi.advanceTimersByTime(10);
        }
        vi.advanceTimersByTime(CockpitMap.TRAFFIC_RENDER_MS);
        expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(markers[0].latlng[0]).toBeCloseTo(35.1 + 99 * 0.0001, 6);
    });

    it('a lone message is drawn at once (no added delay when traffic is quiet)', () => {
        const c = ctx([target('A1')]);
        c._scheduleTraffic();
        expect(markers).toHaveLength(1);
    });

    it('stratux:traffic events go through the throttle', () => {
        const src = read('web/cockpit/map.js');
        expect(src).toMatch(/addEventListener\('stratux:traffic', \(\) => this\._scheduleTraffic\(\)\)/);
    });
});
