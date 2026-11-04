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

// sit: the last WebSocket situation (true GPS MSL); gdlSit: a GDL 90 situation that arrived after it
// (its alt_msl is the height above the ellipsoid), which StratuxClient.situation then holds.
let GlidePanel, host, map, sit, gdlSit, fisbWind, fisbMetar, panel;

function setApp() {
    globalThis.window.app = {
        stratuxClient: { get situation() { return gdlSit || sit; }, get wsSituation() { return sit; } },
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
/** The text of the grid cell next to a row label (TO, HEADING, ...), its parts joined by spaces. */
const cellText = (label) => {
    const lbl = [...host.querySelectorAll('.glide-lbl')].find((e) => e.textContent === label);
    if (!lbl) return null;
    return [...lbl.nextElementSibling.children].map((e) => e.textContent).join(' ');
};
/** DESCENT's second line: "now M fpm · X shallower | too steep" or "now —". */
const nowEl = () => host.querySelector('.glide-now');
const status = () => host.querySelector('.glide-status');
/** The status line instead of the block: exactly one element, the given text, no digits, no map layer. */
function expectStatus(msg) {
    expect(block()).toBeNull();
    expect(host.hidden).toBe(false);
    expect(host.children).toHaveLength(1);
    expect(status()).not.toBeNull();
    expect(text()).toBe(`ENGINE OUT · ${msg}`);
    expect(text().replace(/\b3D\b/g, '')).not.toMatch(/\d/);   // never a number ("3D" aside), so never a stale one
    expect(map.layers.size).toBe(0);
}
/** ENGINE OUT just tapped on in this panel: with no numbers, the status line says why. Default: quiet. */
const LOUD = { showStatus: true };
const NO_GPS = 'no GPS — needs the Stratux GPS over WiFi';
const NO_FIX = 'waiting for a 3D GPS fix';
const NO_ALT = 'no GPS altitude from the Stratux';
const NOT_HERE = 'not available for this airport';
const UNAVAILABLE = 'glide check unavailable';
const mapShapes = () => [...map.layers].flatMap((g) => g.layers);

/**
 * `n` more situations, one per GlidePanel.UPDATE_MS tick, descending at `fpm` (negative = climbing),
 * continuing from `startDrop` ft below base.alt_msl; each is fresh when its tick runs.
 */
function fly(base, n, fpm, startDrop = 0) {
    const step = fpm * GlidePanel.UPDATE_MS / 60000;
    for (let i = 1; i <= n; i++) {
        sit = { ...base, alt_msl: base.alt_msl - startDrop - step * i, timestamp: Date.now() + GlidePanel.UPDATE_MS };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
    }
}

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
    gdlSit = null;
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
        // 2026-11-04 redesign: "N ft high" verdict and the TO / HEADING / DISTANCE / AIRSPEED / DESCENT /
        // GLIDE PATH rows replace "ft to spare", "Fly … to …", "Be at … or higher there" and the
        // TARGET / PROJECTED / MEASURED cells.
        expect(text()).toMatch(/^✓ GLIDE OK · \d{1,3} ft high/);
        expect(cellText('TO')).toBe('RWY 24');
        expect(cellText('HEADING')).toMatch(/^\d{3}° (↑ on course|↱ turn right \d+°|↰ turn left \d+°)$/);
        expect(cellText('DISTANCE')).toMatch(/^\d+\.\d nm$/);
        expect(cellText('AIRSPEED')).toBe('65 KIAS');
        // one situation: no rate from GPS altitude yet, and situation.vertical_speed is never used
        expect(cellText('DESCENT')).toMatch(/^\d{3} fpm now —$/);
        expect(cellText('GLIDE PATH')).toMatch(/^\+\d{1,3} ft$/);
        expect(text()).not.toMatch(/Fly |Be at|TARGET|PROJECTED|MEASURED|to spare/);
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
        expect(text()).toMatch(/^⚠ FINAL POINT OUT OF REACH · \d{3} ft high/);
        expect(host.querySelector('.glide-sub')).toBeNull();
        expect(cellText('TO')).toBe('RWY 06/24 nearest part');
        expect(cellText('GLIDE PATH')).toMatch(/^\+\d{3} ft$/);
        expect(mapShapes().find((s) => s.opts.dashArray).latlngs).toEqual([]);   // no final, no threshold
    });

    it('CANNOT REACH: plan B is out of reach too', () => {
        sit = situation(0, 15, 3000, 180);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block().classList.contains('glide-danger')).toBe(true);
        expect(text()).toMatch(/^✗ CANNOT REACH KLKR · \d{1,3}(,\d{3})* ft low/);
        expect(cellText('GLIDE PATH')).toMatch(/^\u2212\d{1,3}(,\d{3})* ft$/);       // U+2212 minus
        expect(host.querySelector('.glide-path').classList.contains('glide-neg')).toBe(true);
    });

    it('RUNWAY POSITION NOT KNOWN: runways without coordinates -> check to the airport reference point', () => {
        const noCoords = { id: '06/24', length_ft: 6004, surface: 'CONC-E', base_id: '06', recip_id: '24' };
        sit = situation(0, 5, 4500, 160);
        panel = new GlidePanel(host, { ...KLKR, runways: [noCoords] });
        panel.start();
        expect(block().classList.contains('glide-unknown')).toBe(true);
        expect(block().classList.contains('glide-caution')).toBe(true);
        expect(text()).toMatch(/^RUNWAY POSITION NOT KNOWN · steer to the airport · \d{3} ft high/);
        expect(host.querySelector('.glide-sub')).toBeNull();
        expect(cellText('TO')).toBe('KLKR');

        // out of reach: the CANNOT REACH verdict, the state underneath
        panel.stop();
        sit = situation(0, 15, 3000, 180);
        panel.start();
        expect(block().classList.contains('glide-danger')).toBe(true);
        expect(text()).toMatch(/^✗ CANNOT REACH KLKR · [\d,]+ ft low RUNWAY POSITION NOT KNOWN · steer to the airport/);
        expect(host.querySelector('.glide-sub').textContent).toBe('RUNWAY POSITION NOT KNOWN · steer to the airport');
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
        expect(text()).toMatch(/^NO SUITABLE RUNWAY · steer to the airport · \d{3} ft high/);
    });

    it('excluded heliport / seaplane base: no block, "not available for this airport"', () => {
        sit = situation(0, 5, 4500, 160);
        panel = new GlidePanel(host, { ...KLKR, fac_type: 'HELIPORT' }, LOUD);
        panel.start();
        expectStatus(NOT_HERE);
        expect(vi.getTimerCount()).toBe(0);              // nothing ticks for an airport that never has a block
        panel.stop();
        panel = new GlidePanel(host, { ...KLKR, fac_type: 'SEAPLANE BASE' }, LOUD);
        panel.start();
        expectStatus(NOT_HERE);
    });

    it('no field elevation / no reference position: no block, "not available for this airport"', () => {
        sit = situation(0, 5, 4500, 160);
        const { elev_ft, ...noElev } = KLKR;
        panel = new GlidePanel(host, noElev, LOUD);
        panel.start();
        expectStatus(NOT_HERE);
        expect(vi.getTimerCount()).toBe(0);
        panel.stop();
        panel = new GlidePanel(host, { ...KLKR, lat: null }, LOUD);
        panel.start();
        expectStatus(NOT_HERE);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('GlidePanel live behaviour', () => {
    it('GPS lost replaces the block with the status line', () => {
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);

        // situation older than 5 s: block and line disappear (not frozen numbers); the status says why
        vi.setSystemTime(NOW + 6000);
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectStatus(NO_GPS);

        // back: fresh situation
        sit = { ...situation(180, 6, 5500, 360), timestamp: NOW + 6500 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);

        // no 3D fix
        sit = { ...sit, gps_fix_quality: 0 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectStatus(NO_FIX);

        // slow / on the ground: still shown - the panel has no ground-speed gate (ENGINE OUT turns it off)
        sit = { ...situation(180, 6, 5500, 360), timestamp: Date.now(), ground_speed: 12 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(block()).not.toBeNull();
        sit = { ...sit, timestamp: Date.now(), ground_speed: 0 };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);
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
        expect(text()).toMatch(/^✓ GLIDE OK · 15\d ft high/);
        sit = ac(4000);                                   // back to 60 ft: stays on the final point
        panel.render(NOW);
        expect(text()).toMatch(/^✓ GLIDE OK · [56]\d ft high/);
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
        expect(cellText('HEADING').startsWith(`${hdg()} `)).toBe(true);

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
        expect(cue()).toBe(`↱ turn right ${Math.round(plan.turnNow)}°`);
        sit = situation(180, 6, 5500, 60);                 // track east of the point: turn left
        plan = panel.render(NOW);
        expect(plan.turnNow).toBeLessThan(-5);
        expect(cue()).toBe(`↰ turn left ${Math.round(-plan.turnNow)}°`);
    });

    it('measured steeper than the shown target: red "now M fpm · X too steep" (X = shown M - shown target)', () => {
        const base = situation(0, 15, 3000, 180);
        panel = new GlidePanel(host, KLKR);
        sit = { ...base, timestamp: Date.now() };
        panel.start();
        fly(base, 10, 1500);                                // 11 samples over 10 s, 1,500 fpm down
        const plan = panel.render(Date.now());              // same situation again: no new sample
        expect(plan.measured).toBeCloseTo(1500, 6);
        expect(plan.measured).toBeGreaterThan(plan.target);
        expect(nowEl().classList.contains('glide-now-steep')).toBe(true);
        expect(nowEl().textContent).toBe(`now 1,500 fpm · ${(Math.round(plan.measured) - Math.round(plan.target)).toLocaleString('en-US')} too steep`);
        expect(host.querySelector('.glide-target').textContent).toBe(`${Math.round(plan.target).toLocaleString('en-US')} fpm`);
    });

    describe('MEASURED: descent rate from GPS altitude (situation.vertical_speed is not used)', () => {
        const measured = nowEl;
        const measuredVal = () => /^now (—|[\d,]+ fpm)/.exec(nowEl().textContent)[1];

        it('steady descent of 600 fpm over 10 s -> MEASURED 600, with vertical_speed 0 ignored', () => {
            const base = situation(180, 6, 5500, 360, { vertical_speed: 0 });
            panel = new GlidePanel(host, KLKR);
            sit = { ...base, timestamp: Date.now() };
            panel.start();
            fly(base, 10, 600);
            expect(measuredVal()).toBe('600 fpm');
            expect(measured().classList.contains('glide-now-steep')).toBe(false);
            // a climb measures 0 (not descending), a level flight 0
            fly(base, 10, -300, 100);                  // from where the descent ended
            expect(measuredVal()).toBe('0 fpm');
        });

        it('fewer than 3 samples, or less than 5 s of them -> "—" (never 0, never red)', () => {
            const base = situation(0, 15, 3000, 180, { vertical_speed: -3000 });   // would be red if used
            panel = new GlidePanel(host, KLKR);
            sit = { ...base, timestamp: Date.now() };
            panel.start();
            expect(measuredVal()).toBe('—');
            // the same situation rendered again is not a new sample
            panel.render(Date.now()); panel.render(Date.now() + 500);
            expect(measuredVal()).toBe('—');
            fly(base, 1, 3000);                              // 2 samples, 1 s
            expect(measuredVal()).toBe('—');
            fly(base, 3, 3000, 50);                          // 5 samples, 4 s
            expect(measuredVal()).toBe('—');
            expect(measured().classList.contains('glide-now-steep')).toBe(false);
            fly(base, 1, 3000, 200);                         // 6 samples, 5 s: valid
            expect(measuredVal()).toBe('3,000 fpm');
            expect(measured().classList.contains('glide-now-steep')).toBe(true);
        });

        it('only the last 10 s count', () => {
            const base = situation(180, 6, 5500, 360);
            panel = new GlidePanel(host, KLKR);
            sit = { ...base, timestamp: Date.now() };
            panel.start();
            fly(base, 10, 2000);                             // 2,000 fpm for 10 s
            fly(base, 10, 500, 10 * 2000 / 60);              // then 500 fpm for 10 s
            expect(measuredVal()).toBe('500 fpm');
            expect(GlidePanel.VS_WINDOW_MS).toBe(10000);
        });

        it('GPS lost then regained -> "—" until refilled', () => {
            const base = situation(180, 6, 5500, 360);
            panel = new GlidePanel(host, KLKR, LOUD);
            sit = { ...base, timestamp: Date.now() };
            panel.start();
            fly(base, 10, 600);
            expect(measuredVal()).toBe('600 fpm');
            vi.advanceTimersByTime(6000);                    // situation now 6 s old: block replaced by the status
            expectStatus(NO_GPS);
            sit = { ...base, alt_msl: base.alt_msl - 100, timestamp: Date.now() + GlidePanel.UPDATE_MS };
            vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
            expect(measuredVal()).toBe('—');                 // the old samples are gone
            fly(base, 4, 600, 100);
            expect(measuredVal()).toBe('—');                 // 5 samples, 4 s
            fly(base, 1, 600, 100 + 4 * 10);
            expect(measuredVal()).toBe('600 fpm');
        });
    });

    describe('true GPS MSL from the WebSocket situation only (GDL 90 carries height above the ellipsoid)', () => {
        it('interleaved WS and GDL 90 (MSL - 100 ft): spare and MEASURED use only the WS values', () => {
            const base = situation(180, 6, 5500, 360);
            panel = new GlidePanel(host, KLKR);
            sit = { ...base, timestamp: Date.now() - 60 };                  // WS samples exactly 1 s apart
            gdlSit = { ...sit, alt_msl: sit.alt_msl - 100, timestamp: sit.timestamp + 50 };
            panel.start();
            const step = 600 / 60;
            for (let i = 1; i <= 10; i++) {
                const t = Date.now() + GlidePanel.UPDATE_MS;
                sit = { ...base, alt_msl: base.alt_msl - step * i, timestamp: t - 60 };
                // every other tick a GDL 90 situation, 100 ft low, is the newest one
                gdlSit = i % 2 ? { ...sit, alt_msl: sit.alt_msl - 100, timestamp: t - 10 } : null;
                vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
            }
            gdlSit = { ...sit, alt_msl: sit.alt_msl - 100, timestamp: sit.timestamp + 50 };
            const plan = panel.render(Date.now());
            expect(plan.measured).toBeCloseTo(600, 6);
            expect(nowEl().textContent).toMatch(/^now 600 fpm · /);
            const S = GlideInputs.settings(), ref = { lat: KLKR.lat, lon: KLKR.lon };
            const want = GlideModel.plan({
                airport: GlideInputs.airport(KLKR, S), ac: GlideInputs.aircraft(sit, S, ref, Date.now()),
                glideWind: { from: 250, kt: 14 }, runwayWind: { kind: 'none' }, preferDirect: false,
            }, S);
            expect(plan.spare).toBeCloseTo(want.spare, 6);
            expect(text()).toContain(`✓ GLIDE OK · ${Math.floor(want.spare)} ft high`);
        });

        it('only GDL 90 situations arriving: no block ("no GPS altitude from the Stratux")', () => {
            sit = null;
            gdlSit = situation(180, 6, 5500, 360);
            panel = new GlidePanel(host, KLKR, LOUD);
            panel.start();
            expectStatus(NO_ALT);
            expect(status().getAttribute('data-reason')).toBe('noalt');
            // a WS situation that went stale while GDL 90 keeps arriving: no block either
            sit = situation(180, 6, 5500, 360);
            vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
            expect(block()).not.toBeNull();
            vi.advanceTimersByTime(6000);
            gdlSit = { ...gdlSit, timestamp: Date.now() };
            vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
            expectStatus(NO_ALT);
            // and the GDL 90 position stops too: plain "no GPS"
            vi.advanceTimersByTime(GlideInputs.SIT_MAX_AGE_MS + GlidePanel.UPDATE_MS);
            expectStatus(NO_GPS);
        });
    });

    it('a failed runway-wind refresh replaces the block with "glide check unavailable" (no frozen numbers)', async () => {
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expect(block()).not.toBeNull();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(panel, 'render').mockImplementationOnce(() => { throw new Error('render'); });
        await vi.advanceTimersByTimeAsync(0);              // runwayWind resolves -> render throws
        expectStatus(UNAVAILABLE);
        warn.mockRestore();
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

describe('GlidePanel status line while ENGINE OUT is on and no glide numbers can be shown', () => {
    it('no WebSocket situation at all: "no GPS", no numbers, no map layer; ticks on', () => {
        sit = null;
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        expect(status().getAttribute('data-reason')).toBe('nogps');
        expect(vi.getTimerCount()).toBe(2);              // still updating: a fix replaces the status on the next tick
        vi.advanceTimersByTime(5 * GlidePanel.UPDATE_MS);
        expectStatus(NO_GPS);
    });

    it('plain no-GPS cases keep "no GPS — needs the Stratux GPS over WiFi" (not the altitude wording)', () => {
        // nothing at all
        sit = null; gdlSit = null;
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        expect(status().getAttribute('data-reason')).toBe('nogps');
        panel.stop();
        // a fresh GDL 90 situation without a 3D fix
        gdlSit = situation(180, 6, 5500, 360, { gps_fix_quality: 0 });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        panel.stop();
        // a GDL 90 situation that is stale too
        gdlSit = situation(180, 6, 5500, 360, { timestamp: NOW - GlideInputs.SIT_MAX_AGE_MS - 1 });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        panel.stop();
        // the stale WS situation is still the latest situation (nothing arrived after it)
        sit = situation(180, 6, 5500, 360, { timestamp: NOW - 60000 }); gdlSit = null;
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        panel.stop();
        // a fresh fix injected by another source (engine-GPS bridge), not the Stratux's own
        sit = null;
        gdlSit = situation(180, 6, 5500, 360, { _source: 'engine' });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
    });

    it('a situation older than SIT_MAX_AGE_MS: "no GPS" (also when it reports no fix)', () => {
        sit = situation(180, 6, 5500, 360, { timestamp: NOW - GlideInputs.SIT_MAX_AGE_MS - 1 });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        panel.stop();
        sit = situation(180, 6, 5500, 360, { timestamp: NOW - 60000, gps_fix_quality: 0 });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        panel.stop();
        sit = situation(180, 6, 5500, 360, { timestamp: undefined });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
    });

    it('fresh situation without a 3D fix (quality 0, 6, gps_3d false, 0/0): "waiting for a 3D GPS fix"', () => {
        for (const over of [{ gps_fix_quality: 0 }, { gps_fix_quality: 6 }, { gps_3d: false }, { lat: 0, lon: 0 }]) {
            sit = situation(180, 6, 5500, 360, over);
            panel = new GlidePanel(host, KLKR, LOUD);
            panel.start();
            expectStatus(NO_FIX);
            expect(status().getAttribute('data-reason')).toBe('nofix');
            panel.stop();
            panel = null;
        }
    });

    it('a 3D fix without altitude or track: "glide check unavailable"', () => {
        sit = situation(180, 6, 5500, 360, { alt_msl: null });
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(UNAVAILABLE);
    });

    it('a non-finite plan: "glide check unavailable", no numbers, no line', () => {
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expect(block()).not.toBeNull();
        expect(map.layers.size).toBe(1);
        const real = GlideModel.plan;
        GlideModel.plan = (...a) => ({ ...real(...a), spare: NaN });
        try {
            vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
            expectStatus(UNAVAILABLE);
        } finally {
            GlideModel.plan = real;
        }
        sit = { ...sit, timestamp: Date.now() };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(block()).not.toBeNull();
    });

    it('a model update that throws: "glide check unavailable"', () => {
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(panel, 'render').mockImplementationOnce(() => { throw new Error('boom'); });
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectStatus(UNAVAILABLE);
        warn.mockRestore();
    });

    it('fix arrives -> the block with numbers replaces the status and the line is drawn; fix lost -> status, line gone', () => {
        sit = null;
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        sit = situation(180, 6, 5500, 360, { gps_fix_quality: 0, timestamp: Date.now() });
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectStatus(NO_FIX);

        sit = situation(180, 6, 5500, 360, { timestamp: Date.now() + GlidePanel.UPDATE_MS });
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(status()).toBeNull();
        expect(block()).not.toBeNull();
        expect(text()).toMatch(/^✓ GLIDE OK · \d{1,3} ft high/);
        expect(mapShapes().map((s) => s.type).sort()).toEqual(['polyline', 'polyline', 'ring']);

        sit = { ...sit, gps_fix_quality: 0, timestamp: Date.now() + GlidePanel.UPDATE_MS };
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectStatus(NO_FIX);

        vi.advanceTimersByTime(GlideInputs.SIT_MAX_AGE_MS + GlidePanel.UPDATE_MS);   // nothing new arrives
        expectStatus(NO_GPS);
    });

    it('the status line is not rewritten every tick while the reason stays the same', () => {
        sit = null;
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        const el = status();
        vi.advanceTimersByTime(3 * GlidePanel.UPDATE_MS);
        expect(status()).toBe(el);
    });

    it('stop() (ENGINE OUT off) removes the status line too', () => {
        sit = null;
        panel = new GlidePanel(host, KLKR, LOUD);
        panel.start();
        expectStatus(NO_GPS);
        panel.stop();
        expect(host.innerHTML).toBe('');
        expect(host.hidden).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(map.layers.size).toBe(0);
    });

    it('CSS: neutral colours (no verdict fill), text >= --text-sm at weight 800', () => {
        const css = read('web/style.css');
        const i = css.indexOf('.glide-status {');
        expect(i).toBeGreaterThan(-1);
        const rule = css.slice(i, css.indexOf('}', i));
        expect(rule).toMatch(/color:\s*var\(--text-secondary\)/);
        expect(rule).toMatch(/font-size:\s*var\(--text-sm\)/);
        expect(rule).toMatch(/font-weight:\s*800/);
        expect(rule).not.toMatch(/success|caution|danger|#[0-9a-f]{3,6}/i);
    });
});

describe('GlidePanel without showStatus (panel opened with ENGINE OUT already on): quiet', () => {
    /** Nothing on screen: host empty and hidden, no status, no block, no map line. */
    function expectQuiet() {
        expect(status()).toBeNull();
        expect(block()).toBeNull();
        expect(host.innerHTML).toBe('');
        expect(host.hidden).toBe(true);
        expect(map.layers.size).toBe(0);
    }

    it('no GPS: hidden, still ticking; fix arrives -> block + line; fix lost -> hidden again, never a status', () => {
        sit = null;
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expectQuiet();
        expect(vi.getTimerCount()).toBe(2);
        vi.advanceTimersByTime(3 * GlidePanel.UPDATE_MS);
        expectQuiet();

        sit = situation(180, 6, 5500, 360, { gps_fix_quality: 0, timestamp: Date.now() });
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectQuiet();                                     // no 3D fix: no "waiting for a 3D GPS fix" either

        sit = situation(180, 6, 5500, 360, { timestamp: Date.now() + GlidePanel.UPDATE_MS });
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expect(block()).not.toBeNull();
        expect(host.hidden).toBe(false);
        expect(text()).toMatch(/^✓ GLIDE OK · \d{1,3} ft high/);
        expect(map.layers.size).toBe(1);

        vi.advanceTimersByTime(GlideInputs.SIT_MAX_AGE_MS + GlidePanel.UPDATE_MS);   // nothing new: stale
        expectQuiet();
    });

    it('only GDL 90 situations (no GPS altitude): hidden', () => {
        sit = null;
        gdlSit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expectQuiet();
    });

    it('heliport / no elevation: hidden, nothing ticks', () => {
        panel = new GlidePanel(host, { ...KLKR, fac_type: 'HELIPORT' });
        panel.start();
        expectQuiet();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a model update that throws: the block is hidden (no frozen numbers), no status', () => {
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block()).not.toBeNull();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(panel, 'render').mockImplementationOnce(() => { throw new Error('boom'); });
        vi.advanceTimersByTime(GlidePanel.UPDATE_MS);
        expectQuiet();
        warn.mockRestore();
    });

    it('showStatus is per panel: { showStatus: false } and no options are the same', () => {
        sit = null;
        panel = new GlidePanel(host, KLKR, { showStatus: false });
        panel.start();
        expectQuiet();
        panel.stop();
        panel = new GlidePanel(host, KLKR, null);
        panel.start();
        expectQuiet();
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

    it('mounts GlidePanel right after the nav row (under the header) and stops it on close()', () => {
        const made = [];
        globalThis.GlidePanel = class { constructor(el, rec) { this.el = el; this.rec = rec; this.start = vi.fn(); this.stop = vi.fn(); made.push(this); } };
        const p = openPopup();
        expect(made).toHaveLength(1);
        expect(made[0].rec).toBe(KLKR);
        expect(made[0].start).toHaveBeenCalledTimes(1);
        expect(made[0].el.previousElementSibling.classList.contains('apt-nav-row')).toBe(true);
        expect(made[0].el.previousElementSibling.previousElementSibling.classList.contains('apt-panel-header')).toBe(true);
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

    it('a second airport without close(): the first airport\'s block is stopped', () => {
        const made = [];
        globalThis.GlidePanel = class { constructor(el, rec) { this.rec = rec; this.start = vi.fn(); this.stop = vi.fn(); made.push(this); } };
        const p = openPopup();                              // A = KLKR
        const B = { ...KLKR, icao: 'KCLT', name: 'Charlotte' };
        p._showPanel(B, null);
        expect(made).toHaveLength(2);
        expect(made[0].stop).toHaveBeenCalledTimes(1);
        expect(made[1].rec).toBe(B);
        expect(made[1].stop).not.toHaveBeenCalled();
        expect(document.querySelectorAll('.glide-host')).toHaveLength(1);
    });

    it('GlidePanel.start throwing after construction: the panel opens and the block is stopped', () => {
        const made = [];
        globalThis.GlidePanel = class {
            constructor() { this.stop = vi.fn(); made.push(this); }
            start() { throw new Error('start'); }
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const p = openPopup();
        expect(p._panelOpen).toBe(true);
        expect(document.querySelector('.airport-panel.open .apt-tabs')).not.toBeNull();
        expect(made[0].stop).toHaveBeenCalledTimes(1);
        expect(p._glide).toBeNull();
        warn.mockRestore();
    });
});
