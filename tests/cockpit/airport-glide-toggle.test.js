/**
 * ENGINE OUT button (airport panel header, under the close button): turns the engine-out glide
 * block (GlidePanel) and its map line on / off for every airport, remembered across restarts in
 * localStorage 'flytab_engine_out_glide_on' (default ON). While ON the block shows whenever the
 * Stratux WebSocket has a fresh 3D fix - on the ground too (no ground-speed gate for the panel).
 *
 * Real: AirportPopup, GlidePanel, GlideInputs, GlideModel, GpsFix, MagVar, wireTap.
 * Stubbed: the Stratux situation, FIS-B, the NASR store, Leaflet (records the map layers).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
const GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
const GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const MagVar = new Function(read('web/shared/mag-var.js') + '\nreturn MagVar;')();
const POPUP_SRC = read('web/cockpit/airport-popup.js');
const loadPopup = () => new Function(POPUP_SRC + '\nreturn AirportPopup;')();
const KEY = 'flytab_engine_out_glide_on';

const NOW = Date.parse('2026-10-31T18:00:00Z');
const KLKR_RWY = {
    id: '06/24', length_ft: 6004, width_ft: 101, surface: 'CONC-E',
    base_id: '06', base_lat: 34.71859708, base_lon: -80.8631085,
    base_thr_lat: 34.71874788, base_thr_lon: -80.86280972,
    base_elev_ft: 459.7, base_true_hdg: 59, base_displ_ft: 105, base_tch_ft: 41,
    recip_id: '24', recip_lat: 34.72721166, recip_lon: -80.84607163,
    recip_thr_lat: 34.72721166, recip_thr_lon: -80.84607163,
    recip_elev_ft: 485.7, recip_true_hdg: 239, recip_displ_ft: 0, recip_tch_ft: 39,
};
const KLKR = {
    icao: 'KLKR', name: 'Lancaster County-Mc Whirter Fld', city: 'LANCASTER', state: 'SC', lat: 34.722904, lon: -80.85459,
    elev_ft: 486, fac_type: 'AIRPORT', runways: [KLKR_RWY], frequencies: [],
};

const at = (brg, nm) => GlideModel.fromLocal(KLKR.lat, KLKR.lon,
    { x: nm * Math.sin(brg * Math.PI / 180), y: nm * Math.cos(brg * Math.PI / 180) });
function situation(brg, nm, alt, trk, over = {}) {
    const p = at(brg, nm);
    return {
        lat: p.lat, lon: p.lon, alt_msl: alt, alt_baro: alt - 200, ground_speed: 110, true_course: trk,
        vertical_speed: 0, gps_fix_quality: 1, timestamp: Date.now() - 500, ...over,
    };
}

function fakeMap() { return { layers: new Set(), removeLayer(l) { this.layers.delete(l); } }; }
function fakeLeaflet() {
    const shape = (type, latlngs, opts) => ({
        type, latlngs, opts: { ...opts },
        setLatLngs(v) { this.latlngs = v; return this; }, setLatLng(v) { this.latlngs = v; return this; },
        setStyle(o) { Object.assign(this.opts, o); return this; },
    });
    return {
        layerGroup() {
            return {
                layers: [], map: null,
                addLayer(l) { this.layers.push(l); return this; },
                addTo(m) { this.map = m; m.layers.add(this); return this; },
                remove() { if (this.map) this.map.removeLayer(this); this.map = null; return this; },
            };
        },
        polyline: (ll, o) => shape('polyline', ll, o),
        circleMarker: (ll, o) => shape('ring', ll, o),
    };
}

let AirportPopup, map, sit;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    document.body.innerHTML = '';
    globalThis.wireTap = wireTap;
    globalThis.GlideModel = GlideModel;
    globalThis.GpsFix = GpsFix;
    globalThis.MagVar = MagVar;
    globalThis.GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
    globalThis.GlidePanel = new Function(read('web/cockpit/glide-panel.js') + '\nreturn GlidePanel;')();
    globalThis.L = fakeLeaflet();
    globalThis.NasrDB = { haversineNm: () => 5 };
    globalThis.CockpitConfig = { get: () => null, aircraft: () => undefined };
    map = fakeMap();
    sit = situation(180, 6, 5500, 360);
    globalThis.window.app = {
        stratuxClient: { get situation() { return sit; }, get wsSituation() { return sit; } },
        fisbClient: { getNearestWind: () => null, getMetar: () => null, metars: new Map() },
        _nasrDb: { getWeather: async () => null, getAirport: async () => null },
        cockpitMap: { map },
    };
    AirportPopup = loadPopup();
});

afterEach(() => {
    vi.useRealTimers();
    globalThis.window.app = undefined;
    for (const k of ['GlidePanel', 'GlideInputs', 'L', 'NasrDB', 'CockpitConfig']) delete globalThis[k];
});

let cur;   // the popup opened last: every lookup is scoped to ITS panel (several panels can be in the body)
function open(rec = KLKR) {
    const p = new AirportPopup({ closePopup() {} }, { getWeather: async () => null });
    p.initPanel(document.body);
    p._showPanel(rec, null);
    cur = p;
    return p;
}
const btn = () => cur._panel.querySelector('.apt-glide-toggle');
const block = () => cur._panel.querySelector('.glide-host .glide-block');

describe('ENGINE OUT button', () => {
    it('sits directly under the close button, labelled ENGINE OUT, at least the touch minimum', () => {
        open();
        const close = document.querySelector('.apt-panel-close');
        expect(btn()).not.toBeNull();
        expect(close.nextElementSibling).toBe(btn());
        expect(close.parentElement.classList.contains('apt-header-btns')).toBe(true);
        expect(close.parentElement.parentElement.classList.contains('apt-panel-header')).toBe(true);
        expect(btn().textContent.trim()).toBe('ENGINE OUT');
        expect(btn().tagName).toBe('BUTTON');
        const css = read('web/style.css');
        const rule = css.slice(css.indexOf('.apt-glide-toggle {'), css.indexOf('}', css.indexOf('.apt-glide-toggle {')));
        expect(rule).toContain('min-height: var(--touch-min, 56px)');
    });

    it('default ON (nothing stored): lit, and the block + map line show in flight', () => {
        expect(localStorage.getItem(KEY)).toBeNull();
        open();
        expect(btn().classList.contains('is-on')).toBe(true);
        expect(btn().getAttribute('aria-pressed')).toBe('true');
        expect(block()).not.toBeNull();
        expect(document.querySelector('.glide-host').previousElementSibling.classList.contains('apt-panel-header')).toBe(true);
        expect(map.layers.size).toBe(1);
    });

    it('OFF: hides the block, calls GlidePanel.stop, removes the map layers and timers, stores false', () => {
        const stop = vi.spyOn(GlidePanel.prototype, 'stop');
        const p = open();
        const g = p._glide;
        expect(g._timer).not.toBeNull();                    // model update ...
        expect(g._windTimer).not.toBeNull();                // ... and runway wind
        expect(vi.getTimerCount()).toBe(2);
        stop.mockClear();
        btn().click();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(block()).toBeNull();
        expect(document.querySelector('.glide-host')).toBeNull();
        expect(map.layers.size).toBe(0);
        expect(g._timer).toBeNull();
        expect(g._windTimer).toBeNull();
        // (jsdom's localStorage.setItem queues one timer of its own - a storage event - so count ours)
        expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
        expect(p._glide).toBeNull();
        expect(localStorage.getItem(KEY)).toBe('false');
        expect(btn().classList.contains('is-on')).toBe(false);
        expect(btn().getAttribute('aria-pressed')).toBe('false');
        // nothing comes back on later ticks
        vi.advanceTimersByTime(5000);
        expect(block()).toBeNull();
        expect(map.layers.size).toBe(0);
    });

    it('ON again restores the block and the line, stores true; only one block', () => {
        const p = open();
        const first = p._glide;
        btn().click();
        btn().click();
        expect(localStorage.getItem(KEY)).toBe('true');
        expect(btn().classList.contains('is-on')).toBe(true);
        expect(block()).not.toBeNull();
        expect(document.querySelectorAll('.glide-host')).toHaveLength(1);
        expect(map.layers.size).toBe(1);
        expect(p._glide).not.toBe(first);
        expect(first._timer).toBeNull();                    // the old one stays stopped
        expect(p._glide._timer).not.toBeNull();
        expect(p._glide._windTimer).not.toBeNull();
        sit = situation(180, 5.9, 5450, 360);
        vi.advanceTimersByTime(1000);                       // it is live again
        expect(block()).not.toBeNull();
    });

    it('the choice holds for every airport and across a restart (fresh class, stored value)', () => {
        open();
        btn().click();                                      // OFF
        const ctor = vi.spyOn(globalThis, 'GlidePanel');
        AirportPopup = loadPopup();                         // app restart: the stored value is read again
        const p = open({ ...KLKR, icao: 'KCLT', name: 'Charlotte' });
        expect(btn().classList.contains('is-on')).toBe(false);
        expect(block()).toBeNull();
        expect(p._glide).toBeNull();
        expect(ctor).not.toHaveBeenCalled();
        expect(map.layers.size).toBe(0);
        ctor.mockRestore();
    });

    it('ON shows the block on the ground (GS 0) with a fresh WebSocket 3D fix', () => {
        // parked on the KLKR ramp: field elevation, 0 kt (the old gate was 25 kt)
        sit = situation(90, 0.2, 490, 0, { ground_speed: 0 });
        open();
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);
        // the other checks still apply: no 3D fix -> no block, stale -> no block
        sit = { ...sit, gps_fix_quality: 0, timestamp: Date.now() };
        vi.advanceTimersByTime(1000);
        expect(block()).toBeNull();
        sit = { ...situation(90, 0.2, 490, 0, { ground_speed: 0 }), timestamp: Date.now() - 6000 };
        vi.advanceTimersByTime(1000);
        expect(block()).toBeNull();
        expect(map.layers.size).toBe(0);
    });

    it('a configured showAboveGsKt no longer hides the panel block (it is EmergencyGlide\'s only)', () => {
        globalThis.CockpitConfig = { get: (k) => (k === 'engineOutGlide' ? { showAboveGsKt: 200 } : null), aircraft: () => undefined };
        sit = situation(180, 6, 5500, 360, { ground_speed: 60 });
        open();
        expect(block()).not.toBeNull();
        // GlidePanel.noGsGate copies: the settings object it was given keeps its value
        const S = GlideInputs.settings();
        expect(GlidePanel.noGsGate(S).pilot.showAboveGsKt).toBe(0);
        expect(S.pilot.showAboveGsKt).toBe(200);
    });

    it('an airport that can never have a block (heliport) still toggles the choice', () => {
        open({ ...KLKR, icao: 'SC99', fac_type: 'HELIPORT' });
        expect(block()).toBeNull();
        btn().click();
        expect(localStorage.getItem(KEY)).toBe('false');
        expect(btn().classList.contains('is-on')).toBe(false);
        btn().click();
        expect(localStorage.getItem(KEY)).toBe('true');
        expect(btn().classList.contains('is-on')).toBe(true);
        expect(block()).toBeNull();
        expect(map.layers.size).toBe(0);
    });

    it('storage that throws: the button still works for this session', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        try {
            open();
            expect(btn().classList.contains('is-on')).toBe(true);
            btn().click();
            expect(block()).toBeNull();
            expect(btn().classList.contains('is-on')).toBe(false);
            open({ ...KLKR, icao: 'KCLT' });               // next airport, same session: still off
            expect(btn().classList.contains('is-on')).toBe(false);
            expect(block()).toBeNull();
        } finally {
            get.mockRestore();
            set.mockRestore();
        }
    });

    it('storage write fails while an old "true" is stored: the toggle still turns OFF and back ON', () => {
        localStorage.setItem(KEY, 'true');
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        try {
            open();
            expect(btn().classList.contains('is-on')).toBe(true);
            btn().click();                                  // OFF: the write fails, 'true' stays stored
            expect(localStorage.getItem(KEY)).toBe('true');
            expect(btn().classList.contains('is-on')).toBe(false);
            expect(block()).toBeNull();
            expect(map.layers.size).toBe(0);
            open({ ...KLKR, icao: 'KCLT' });               // next airport, same session: still OFF
            expect(btn().classList.contains('is-on')).toBe(false);
            expect(block()).toBeNull();
            btn().click();                                  // and back ON
            expect(btn().classList.contains('is-on')).toBe(true);
            expect(block()).not.toBeNull();
        } finally {
            set.mockRestore();
        }
    });

    it('several panels in the page: each lookup reads the panel under test', () => {
        localStorage.setItem(KEY, 'false');
        open();
        const first = cur;
        expect(btn().classList.contains('is-on')).toBe(false);
        localStorage.setItem(KEY, 'true');
        AirportPopup = loadPopup();
        open({ ...KLKR, icao: 'KCLT' });
        expect(cur).not.toBe(first);
        expect(document.querySelectorAll('.apt-glide-toggle').length).toBe(2);
        expect(btn().classList.contains('is-on')).toBe(true);
        expect(first._panel.querySelector('.apt-glide-toggle').classList.contains('is-on')).toBe(false);
    });

    it('CSS: 12 px between the close button and ENGINE OUT; lit = solid --accent-active fill (10.8:1 white text), off = outlined', () => {
        const css = read('web/style.css');
        const rule = (sel) => { const i = css.indexOf(sel + ' {'); return css.slice(i, css.indexOf('}', i)); };
        expect(rule('.apt-header-btns')).toMatch(/gap:\s*12px/);
        const on = rule('.apt-glide-toggle.is-on');
        expect(on).toMatch(/background:\s*var\(--accent-active\)/);
        expect(on).toMatch(/color:\s*var\(--text-on-accent\)/);
        const off = rule('.apt-glide-toggle');
        expect(off).toMatch(/background:\s*var\(--bg-primary\)/);
        expect(off).toMatch(/border:\s*2px solid var\(--accent-active\)/);
        expect(off).toMatch(/color:\s*var\(--accent-active\)/);
    });

    it('close() with ENGINE OUT on stops the block and removes the line', () => {
        const p = open();
        expect(map.layers.size).toBe(1);
        const g = p._glide;
        p.close();
        expect(map.layers.size).toBe(0);
        expect(g._timer).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(localStorage.getItem(KEY)).toBeNull();      // closing is not a choice
    });
});
