/**
 * GlidePanel (web/cockpit/glide-panel.js): the live engine-out glide block in the airport panel
 * and its line to the final point on the map.
 *
 * Real model (GlideModel), real adapter (GlideInputs), real MagVar; stubbed: the Stratux situation,
 * FIS-B (winds aloft, METARs), the NASR store and Leaflet. Data shapes as verified for Task 2:
 * KLKR exactly as the 2611 bundle has it; situation fields alt_msl, ground_speed, true_course,
 * vertical_speed (ft/min), gps_fix_quality, timestamp (ms epoch at receipt).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
globalThis.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
globalThis.GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
const REAL_MAGVAR = new Function(read('web/shared/mag-var.js') + '\nreturn MagVar;')();
const loadPanel = () => new Function(read('web/cockpit/glide-panel.js') + '\nreturn GlidePanel;')();

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
    icao: 'KLKR', name: 'Lancaster County-Mc Whirter Fld', lat: 34.722904, lon: -80.85459,
    elev_ft: 486, fac_type: 'AIRPORT', runways: [KLKR_RWY],
};

/** A lat/lon `nm` from KLKR's reference point on true bearing `brg`. */
const at = (brg, nm) => GlideModel.fromLocal(KLKR.lat, KLKR.lon,
    { x: nm * Math.sin(brg * Math.PI / 180), y: nm * Math.cos(brg * Math.PI / 180) });

function situation(brg, nm, alt, trk, over = {}) {
    const p = at(brg, nm);
    return {
        lat: p.lat, lon: p.lon, alt_msl: alt, alt_baro: alt - 200, ground_speed: 110, true_course: trk,
        vertical_speed: -700, gps_fix_quality: 1, timestamp: NOW - 500, ...over,
    };
}

// ---- Leaflet stub: records what the panel puts on the map ----
function fakeMap() {
    return { layers: new Set(), removeLayer(l) { this.layers.delete(l); } };
}
function fakeLeaflet() {
    const made = [];
    const shape = (type, latlngs, opts) => {
        const s = {
            type, latlngs, opts: { ...opts },
            setLatLngs(v) { this.latlngs = v; return this; },
            setLatLng(v) { this.latlngs = v; return this; },
            setStyle(o) { Object.assign(this.opts, o); return this; },
        };
        made.push(s);
        return s;
    };
    return {
        made,
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

let GlidePanel, host, map, sit, fisbWind, fisbMetar, panel;

function setApp() {
    globalThis.window.app = {
        stratuxClient: { get situation() { return sit; } },
        fisbClient: {
            getNearestWind: () => fisbWind,
            getMetar: (id) => (id === 'KLKR' ? fisbMetar : null),
            metars: new Map(),
        },
        _nasrDb: { getWeather: async () => null, getAirport: async () => null },
        cockpitMap: { map },
    };
}

/** The block's text with element boundaries as spaces (what the pilot reads, line by line). */
const text = () => {
    const d = document.createElement('div');
    d.innerHTML = host.innerHTML.replace(/<\/?(div|span)[^>]*>/g, ' ');
    return d.textContent.replace(/\s+/g, ' ').trim();
};
const block = () => host.querySelector('.glide-block');
const mapShapes = () => [...map.layers].flatMap((g) => g.layers);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    GlidePanel = loadPanel();
    document.body.innerHTML = '<div id="host"></div>';
    host = document.getElementById('host');
    map = fakeMap();
    globalThis.L = fakeLeaflet();
    globalThis.MagVar = REAL_MAGVAR;
    delete globalThis.CockpitConfig;
    fisbWind = { dir: 250, spd: 14, alt: 6000, lat: KLKR.lat, lon: KLKR.lon, station: 'CLT', received_at: NOW - 60000 };
    fisbMetar = null;
    sit = null;
    setApp();
    panel = null;
});

afterEach(() => {
    if (panel) panel.stop();
    vi.useRealTimers();
    globalThis.window.app = undefined;
    delete globalThis.L;
    delete globalThis.CockpitConfig;
});

describe('GlidePanel verdicts', () => {
    it('GLIDE OK: a final point is reachable', () => {
        sit = situation(180, 6, 5500, 360);           // 6 nm south, 5,500 ft, northbound
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block().classList.contains('glide-ok')).toBe(true);
        expect(text()).toMatch(/^✓ GLIDE OK · \d{1,3} ft to spare/);
        expect(text()).toMatch(/Fly \d{3}° · \d+\.\d nm to RWY 24 final point/);
        expect(text()).toMatch(/Be at 1,\d{3} ft or higher there/);
        expect(text()).toMatch(/TARGET \d{3} fpm/);
        expect(text()).toMatch(/PROJECTED \d{3} fpm/);
        expect(text()).toMatch(/MEASURED 700 fpm/);
        expect(text()).toContain('Glide: 250/14 at 6,000 ft · FIS-B');
        expect(text()).not.toContain('Runway:');      // no METAR -> no runway part
        // map: line aircraft -> final point, ring at the point, dashed final to the RWY 24 threshold
        const shapes = mapShapes();
        expect(shapes.map((s) => s.type).sort()).toEqual(['polyline', 'polyline', 'ring']);
        expect(shapes.every((s) => s.opts.interactive === false)).toBe(true);
        const dashed = shapes.find((s) => s.opts.dashArray);
        expect(dashed.latlngs[1][0]).toBeCloseTo(KLKR_RWY.recip_thr_lat, 6);
        expect(dashed.latlngs[1][1]).toBeCloseTo(KLKR_RWY.recip_thr_lon, 6);
        const leg = shapes.find((s) => s.type === 'polyline' && !s.opts.dashArray);
        expect(leg.latlngs[0]).toEqual([sit.lat, sit.lon]);
    });

    it('FINAL POINT OUT OF REACH: plan B to the runway is reachable', () => {
        sit = situation(0, 5, 4500, 160);              // golden case A: 5 nm north, 4,500 ft
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block().classList.contains('glide-caution')).toBe(true);
        expect(text()).toMatch(/^⚠ FINAL POINT OUT OF REACH · TURN TO THE AIRPORT \d{3} ft to spare over the runway/);
        expect(text()).toMatch(/Fly \d{3}° · \d+\.\d nm to RWY 06\/24 \(nearest part\)/);
        expect(text()).toContain('Be at 686 ft or higher there');      // 486 + 200 margin
        expect(mapShapes().find((s) => s.opts.dashArray).latlngs).toEqual([]);   // no final, no threshold
    });

    it('CANNOT REACH: plan B is out of reach too', () => {
        sit = situation(0, 15, 3000, 180);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block().classList.contains('glide-danger')).toBe(true);
        expect(text()).toMatch(/^✗ CANNOT REACH KLKR · \d{1,3}(,\d{3})* ft short/);
        // projected sink is far above the target over this distance
        expect(host.querySelectorAll('.glide-rate')[1].classList.contains('glide-rate-steep')).toBe(true);
    });

    it('RUNWAY POSITION NOT KNOWN: runways without coordinates -> check to the airport reference point', () => {
        const noCoords = { id: '06/24', length_ft: 6004, surface: 'CONC-E', base_id: '06', recip_id: '24' };
        sit = situation(0, 5, 4500, 160);
        panel = new GlidePanel(host, { ...KLKR, runways: [noCoords] });
        panel.start();
        expect(block().classList.contains('glide-unknown')).toBe(true);
        expect(block().classList.contains('glide-caution')).toBe(true);
        expect(text()).toMatch(/^RUNWAY POSITION NOT KNOWN · steer to the airport \d{3} ft to spare over the airport/);
        expect(text()).toMatch(/nm to KLKR Be at 686 ft/);

        // out of reach: the CANNOT REACH verdict, the state underneath
        panel.stop();
        sit = situation(0, 15, 3000, 180);
        panel.start();
        expect(block().classList.contains('glide-danger')).toBe(true);
        expect(text()).toMatch(/^✗ CANNOT REACH KLKR · [\d,]+ ft short RUNWAY POSITION NOT KNOWN · steer to the airport/);
    });

    it('NO SUITABLE RUNWAY: no runway long enough for this aircraft', () => {
        globalThis.CockpitConfig = {
            aircraft: (k) => (k === 'performance.min_runway_ft' ? 9000 : undefined),
            get: () => ({}),
        };
        sit = situation(0, 5, 4500, 160);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block().classList.contains('glide-unknown')).toBe(true);
        expect(text()).toMatch(/^NO SUITABLE RUNWAY · steer to the airport \d{3} ft to spare over the airport/);
    });

    it('excluded heliport shows no block', () => {
        sit = situation(0, 5, 4500, 160);
        panel = new GlidePanel(host, { ...KLKR, fac_type: 'HELIPORT' });
        panel.start();
        expect(host.innerHTML).toBe('');
        expect(host.hidden).toBe(true);
        expect(map.layers.size).toBe(0);
    });

    it('no field elevation shows no block', () => {
        sit = situation(0, 5, 4500, 160);
        const { elev_ft, ...noElev } = KLKR;
        panel = new GlidePanel(host, noElev);
        panel.start();
        expect(host.innerHTML).toBe('');
        expect(map.layers.size).toBe(0);
    });
});

describe('GlidePanel live behaviour', () => {
    it('GPS lost hides the block', () => {
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);

        // situation older than 5 s: block and line disappear (not frozen numbers)
        vi.setSystemTime(NOW + 6000);
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(host.innerHTML).toBe('');
        expect(host.hidden).toBe(true);
        expect(map.layers.size).toBe(0);

        // back: fresh situation
        sit = { ...situation(180, 6, 5500, 360), timestamp: NOW + 6500 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);

        // no 3D fix
        sit = { ...sit, gps_fix_quality: 0 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(host.innerHTML).toBe('');
        expect(map.layers.size).toBe(0);

        // on the ground (below showAboveGsKt)
        sit = { ...situation(180, 6, 5500, 360), timestamp: Date.now(), ground_speed: 12 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(host.innerHTML).toBe('');
    });

    it('hysteresis keeps plan B until a final point has 100 ft to spare', () => {
        // 6 nm NE, track 225, wind 060/15: final point spare -40 / 60 / 159 ft at 3,900 / 4,000 / 4,100 ft
        fisbWind = { ...fisbWind, dir: 60, spd: 15 };
        const ac = (alt) => situation(45, 6, alt, 225);
        const finalSpare = (alt) => {
            const s = ac(alt);
            const apt = GlideInputs.airport(KLKR, GlideInputs.settings());
            const a = GlideInputs.aircraft(s, GlideInputs.settings(), { lat: KLKR.lat, lon: KLKR.lon }, NOW);
            return GlideModel.plan({ airport: apt, ac: a, glideWind: { from: 60, kt: 15 }, runwayWind: { kind: 'none' },
                preferDirect: false }, GlideInputs.settings());
        };
        expect(finalSpare(3900).kind).toBe('direct');
        expect(finalSpare(4000).kind).toBe('final');
        expect(finalSpare(4000).spare).toBeGreaterThanOrEqual(0);
        expect(finalSpare(4000).spare).toBeLessThan(100);
        expect(finalSpare(4100).spare).toBeGreaterThanOrEqual(100);

        sit = ac(3900);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(text()).toMatch(/^⚠ FINAL POINT OUT OF REACH/);
        sit = ac(4000);                                   // final point 60 ft spare: not enough to take over
        panel.render(NOW);
        expect(text()).toMatch(/^⚠ FINAL POINT OUT OF REACH/);
        sit = ac(4100);                                   // 159 ft: the final point takes over
        panel.render(NOW);
        expect(text()).toMatch(/^✓ GLIDE OK · 15\d ft to spare/);
        sit = ac(4000);                                   // back to 60 ft: stays on the final point
        panel.render(NOW);
        expect(text()).toMatch(/^✓ GLIDE OK · [56]\d ft to spare/);
        // a restart forgets the hysteresis
        panel.start();
        expect(text()).toMatch(/^✓ GLIDE OK/);
    });

    it('magnetic heading uses MagVar (magnetic = true - declination, 360 not 000)', () => {
        sit = situation(180, 6, 5500, 360);
        const calls = [];
        globalThis.MagVar = { declination: (lat, lon) => { calls.push([lat, lon]); return 0; } };
        panel = new GlidePanel(host, KLKR);
        panel.start();
        const hdg = () => host.querySelector('.glide-hdg').textContent;
        const trueHdg = Number(hdg().replace('°', ''));
        expect(calls[0]).toEqual([sit.lat, sit.lon]);
        expect(text()).toContain(`Fly ${hdg()} ·`);

        globalThis.MagVar = { declination: () => 8 };       // 8° east: magnetic is 8 less
        panel.render(NOW);
        expect(hdg()).toBe(String(trueHdg - 8).padStart(3, '0') + '°');
        globalThis.MagVar = { declination: () => -8 };      // 8° west: magnetic is 8 more
        panel.render(NOW);
        expect(hdg()).toBe(String((trueHdg + 8) % 360 || 360).padStart(3, '0') + '°');

        // the true heading exactly -> magnetic north shows 360
        const plan = panel.render(NOW);
        globalThis.MagVar = { declination: () => plan.hdgTrue };
        panel.render(NOW);
        expect(hdg()).toBe('360°');
    });

    it('turn cue: right / left / on course from turnNow and onCourseDeg', () => {
        panel = new GlidePanel(host, KLKR);
        sit = situation(180, 6, 5500, 5);                  // tracking at the point
        panel.start();
        const cue = () => host.querySelector('.glide-turn').textContent;
        let plan = panel.render(NOW);
        expect(Math.abs(plan.turnNow)).toBeLessThanOrEqual(GlideModel.DEFAULTS.pilot.onCourseDeg);
        expect(cue()).toBe('↑ on course');
        sit = situation(180, 6, 5500, 300);                // track west of the point: turn right
        plan = panel.render(NOW);
        expect(plan.turnNow).toBeGreaterThan(5);
        expect(cue()).toBe(`↱ right ${Math.round(plan.turnNow)}°`);
        sit = situation(180, 6, 5500, 60);                 // track east of the point: turn left
        plan = panel.render(NOW);
        expect(plan.turnNow).toBeLessThan(-5);
        expect(cue()).toBe(`↰ left ${Math.round(-plan.turnNow)}°`);
    });

    it('rates above target show red with "+N too steep"', () => {
        sit = situation(0, 15, 3000, 180, { vertical_speed: -1500 });
        panel = new GlidePanel(host, KLKR);
        panel.start();
        const plan = panel.render(NOW);
        const cells = host.querySelectorAll('.glide-rate');
        expect(cells[0].classList.contains('glide-rate-steep')).toBe(false);       // TARGET itself
        expect(cells[1].classList.contains('glide-rate-steep')).toBe(true);        // PROJECTED > TARGET
        expect(cells[1].textContent).toContain(`+${Math.ceil(plan.projected - plan.target)} too steep`);
        expect(cells[2].classList.contains('glide-rate-steep')).toBe(true);        // MEASURED > target now
        expect(cells[2].textContent).toContain(`+${Math.ceil(1500 - plan.targetNow).toLocaleString('en-US')} too steep`);

        sit = situation(0, 15, 3000, 180, { vertical_speed: undefined });
        panel.render(NOW);
        expect(host.querySelectorAll('.glide-rate')[2].querySelector('.glide-rate-val').textContent).toBe('—');
    });

    it('wind line: runway METAR + glide wind; amber no-wind and tailwind texts', async () => {
        fisbMetar = {
            raw: 'KLKR 311742Z 24012G18KT 10SM CLR 18/05 A3001',
            decoded: { observed_at: new Date(NOW - 18 * 60000).toISOString(), wind_dir: 240, wind_speed: 12, wind_gust: 18 },
            received_at: NOW - 17 * 60000,
        };
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        await vi.advanceTimersByTimeAsync(0);              // runwayWind() resolved -> re-rendered
        expect(text()).toContain('Runway: METAR KLKR 240/12G18 (18 min) · Glide: 250/14 at 6,000 ft · FIS-B');
        expect(host.querySelector('.glide-wind .glide-amber')).toBeNull();

        // no winds aloft at all: the amber assumed-headwind text
        fisbWind = null;
        panel.render(NOW);
        const amber = host.querySelector('.glide-wind .glide-amber');
        expect(amber.textContent).toBe('Glide: NO CURRENT WINDS ALOFT · 10 kt headwind assumed');

        // only RWY 06 known, METAR wind straight down it from behind: amber tailwind text
        panel.stop();
        const only06 = { ...KLKR_RWY };
        for (const k of ['recip_lat', 'recip_lon', 'recip_thr_lat', 'recip_thr_lon']) delete only06[k];
        fisbMetar = { ...fisbMetar, decoded: { ...fisbMetar.decoded, wind_dir: 239, wind_speed: 10, wind_gust: null } };
        fisbWind = { dir: 239, spd: 10, alt: 6000, lat: KLKR.lat, lon: KLKR.lon, station: 'CLT', received_at: NOW - 60000 };
        sit = situation(239, 6, 5500, 59);                 // 6 nm SW, lined up for 06
        panel = new GlidePanel(host, { ...KLKR, runways: [only06] });
        panel.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(text()).toMatch(/^✓ GLIDE OK/);
        const tw = [...host.querySelectorAll('.glide-wind .glide-amber')].map((e) => e.textContent);
        expect(tw).toContain('RWY 06: 10 kt TAILWIND');
    });

    it('stop() clears the timer and the map layers', async () => {
        sit = situation(180, 6, 5500, 360);
        let resolveWx;
        globalThis.window.app._nasrDb.getWeather = () => new Promise((r) => { resolveWx = r; });
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(vi.getTimerCount()).toBe(2);               // 1 s model update + 60 s runway wind
        expect(map.layers.size).toBe(1);
        panel.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(map.layers.size).toBe(0);
        expect(host.innerHTML).toBe('');
        // a runway-wind read still in flight when stopped does not bring the block back
        resolveWx(null);
        await vi.advanceTimersByTimeAsync(GlidePanel.WIND_REFRESH_MS * 2);
        expect(host.innerHTML).toBe('');
        expect(map.layers.size).toBe(0);
    });

    it('runway wind re-read every 60 s without overlapping reads; model every UPDATE_MS', async () => {
        expect(GlidePanel.UPDATE_MS).toBe(1000);
        sit = situation(180, 6, 5500, 360);
        const pending = [];
        globalThis.window.app._nasrDb.getWeather = vi.fn(() => new Promise((r) => pending.push(r)));
        panel = new GlidePanel(host, KLKR);
        const spy = vi.spyOn(panel, 'render');
        panel.start();
        expect(globalThis.window.app._nasrDb.getWeather).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(GlidePanel.WIND_REFRESH_MS);   // first read still pending
        expect(globalThis.window.app._nasrDb.getWeather).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(60);
        pending.shift()(null);
        await vi.advanceTimersByTimeAsync(GlidePanel.WIND_REFRESH_MS);
        expect(globalThis.window.app._nasrDb.getWeather).toHaveBeenCalledTimes(2);
    });
});

describe('AirportPopup mounts the glide block without risking the popup', () => {
    const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
    const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();

    function openPopup() {
        globalThis.wireTap = wireTap;
        globalThis.NasrDB = { haversineNm: () => 5 };
        globalThis.CockpitConfig = { get: () => null, aircraft: () => undefined };
        const p = new AirportPopup({ closePopup() {} }, { getWeather: async () => null });
        p.initPanel(document.body);
        p._showPanel(KLKR, null);
        return p;
    }
    afterEach(() => { delete globalThis.GlidePanel; delete globalThis.NasrDB; });

    it('mounts GlidePanel right after the header and stops it on close()', () => {
        const made = [];
        globalThis.GlidePanel = class { constructor(el, rec) { this.el = el; this.rec = rec; this.start = vi.fn(); this.stop = vi.fn(); made.push(this); } };
        const p = openPopup();
        expect(made).toHaveLength(1);
        expect(made[0].rec).toBe(KLKR);
        expect(made[0].start).toHaveBeenCalledTimes(1);
        expect(made[0].el.previousElementSibling.classList.contains('apt-panel-header')).toBe(true);
        p.close();
        expect(made[0].stop).toHaveBeenCalledTimes(1);
        // a second airport replaces the first block (the old one is stopped first)
        p._showPanel(KLKR, null);
        expect(made).toHaveLength(2);
    });

    it('a throwing GlidePanel never stops the airport panel from opening', () => {
        globalThis.GlidePanel = class { constructor() { throw new Error('boom'); } };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const p = openPopup();
        expect(p._panelOpen).toBe(true);
        expect(document.querySelector('.airport-panel.open .apt-tabs')).not.toBeNull();
        expect(() => p.close()).not.toThrow();
        globalThis.GlidePanel = class { constructor() { this.start = () => {}; this.stop = () => { throw new Error('stop'); }; } };
        const p2 = openPopup();
        expect(() => p2.close()).not.toThrow();
        expect(p2._panelOpen).toBe(false);
        warn.mockRestore();
    });
});
