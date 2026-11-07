/**
 * GlidePanel (web/cockpit/glide-panel.js): the live engine-out glide block in the airport panel
 * and its line to the planned point on the map (spec 2026-11-06: the nearest part of the runway, the
 * runway end on a short final, nothing over the runway).
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

/** The 06 physical end in KLKR's local plane, and a situation `nm` before it on the 06 extended centreline. */
const PHYS06 = () => GlideModel.toLocal(KLKR.lat, KLKR.lon, KLKR_RWY.base_lat, KLKR_RWY.base_lon);
function onFinal06(nm, alt, over = {}) {
    const e = PHYS06(), b = 239 * Math.PI / 180;
    const p = GlideModel.fromLocal(KLKR.lat, KLKR.lon, { x: e.x + nm * Math.sin(b), y: e.y + nm * Math.cos(b) });
    return {
        lat: p.lat, lon: p.lon, alt_msl: alt, alt_baro: alt - 200, ground_speed: 70, true_course: 59,
        vertical_speed: -500, gps_fix_quality: 1, timestamp: NOW - 500, ...over,
    };
}
/** A situation over the 06/24 centreline, `k` of the way from the 06 end to the 24 end. */
function overRwy(k, alt, trk = 59, over = {}) {
    const lat = KLKR_RWY.base_lat + k * (KLKR_RWY.recip_lat - KLKR_RWY.base_lat);
    const lon = KLKR_RWY.base_lon + k * (KLKR_RWY.recip_lon - KLKR_RWY.base_lon);
    return { lat, lon, alt_msl: alt, alt_baro: alt, ground_speed: 40, true_course: trk, vertical_speed: 0,
        gps_fix_quality: 1, timestamp: NOW - 500, ...over };
}

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
    it('GLIDE OK: the nearest part of the runway is reachable (green, spec 2026-11-06)', () => {
        sit = situation(180, 6, 5500, 360);           // 6 nm south, 5,500 ft, northbound
        panel = new GlidePanel(host, KLKR);
        const plan = panel.start() || panel.render(NOW);
        expect(plan.kind).toBe('direct');
        expect(block().classList.contains('glide-ok')).toBe(true);
        // 2026-11-04 redesign: "N ft high" verdict and the TO / HEADING / DISTANCE / AIRSPEED / DESCENT /
        // GLIDE PATH rows replace "ft to spare", "Fly … to …", "Be at … or higher there" and the
        // TARGET / PROJECTED / MEASURED cells.
        expect(text()).toMatch(/^✓ GLIDE OK · [\d,]+ ft high/);
        expect(host.querySelector('.glide-sub')).toBeNull();
        expect(cellText('TO')).toBe('RWY 06/24 nearest part');
        expect(cellText('HEADING')).toMatch(/^\d{3}° (↑ on course|↱ turn right \d+°|↰ turn left \d+°)$/);
        expect(cellText('DISTANCE')).toMatch(/^\d+\.\d nm$/);
        expect(cellText('AIRSPEED')).toBe('65 KIAS');
        // one situation: no rate from GPS altitude yet, and situation.vertical_speed is never used
        expect(cellText('DESCENT')).toMatch(/^[\d,]+ fpm now —$/);
        expect(cellText('GLIDE PATH')).toMatch(/^\+[\d,]+ ft$/);
        expect(text()).not.toMatch(/Fly |Be at|TARGET|PROJECTED|MEASURED|to spare|FINAL POINT/);
        expect(text()).toContain('Glide: 250/14 at 6,000 ft · FIS-B');
        expect(text()).not.toContain('Runway:');      // no METAR -> no runway part
        // map: line aircraft -> the nearest point of the runway and a ring at it (no dashed final any more)
        const shapes = mapShapes();
        expect(shapes.map((s) => s.type).sort()).toEqual(['polyline', 'ring']);
        expect(shapes.every((s) => s.opts.interactive === false)).toBe(true);
        expect(shapes.some((s) => s.opts.dashArray)).toBe(false);
        const leg = shapes.find((s) => s.type === 'polyline');
        expect(leg.latlngs[0]).toEqual([sit.lat, sit.lon]);
        const pt = GlideModel.fromLocal(KLKR.lat, KLKR.lon, plan.pt);
        expect(leg.latlngs[1]).toEqual([pt.lat, pt.lon]);
        expect(shapes.find((s) => s.type === 'ring').latlngs).toEqual([pt.lat, pt.lon]);
    });

    it('GLIDE OK with a few hundred ft (golden case A, formerly "FINAL POINT OUT OF REACH")', () => {
        sit = situation(0, 5, 4500, 160);              // golden case A: 5 nm north, 4,500 ft
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(block().classList.contains('glide-ok')).toBe(true);
        expect(text()).toMatch(/^✓ GLIDE OK · \d{3} ft high/);
        expect(cellText('TO')).toBe('RWY 06/24 nearest part');
        expect(cellText('GLIDE PATH')).toMatch(/^\+\d{3} ft$/);
        expect(text()).not.toContain('⚠');
    });

    it('on final: lined up within 1 nm -> GLIDE OK, TO "RWY 06 on final", line to the 06 runway end', () => {
        sit = onFinal06(0.6, 900);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        const plan = panel.render(NOW);
        expect(plan.kind).toBe('final');
        expect(plan.needMsl).toBe(459.7);               // the 06 end's elevation
        expect(block().classList.contains('glide-ok')).toBe(true);
        expect(text()).toMatch(/^✓ GLIDE OK · \d{3} ft high/);
        expect(cellText('TO')).toBe('RWY 06 on final');
        expect(cellText('HEADING')).toMatch(/↑ on course$/);
        expect(cellText('DISTANCE')).toBe('0.6 nm');
        const leg = mapShapes().find((s) => s.type === 'polyline');
        expect(leg.latlngs[1][0]).toBeCloseTo(KLKR_RWY.base_lat, 9);
        expect(leg.latlngs[1][1]).toBeCloseTo(KLKR_RWY.base_lon, 9);
        // too low on final: red CANNOT REACH, still "on final"
        sit = onFinal06(0.9, 480);
        panel.render(NOW);
        expect(block().classList.contains('glide-danger')).toBe(true);
        expect(text()).toMatch(/^✗ CANNOT REACH KLKR · \d{1,3} ft low/);
        expect(cellText('TO')).toBe('RWY 06 on final');
    });

    it('crossing the runway at right angles 400 ft up: a turn back, TO note "turn back", not "nearest part"', () => {
        sit = overRwy(0.5, 486 + 400, 149);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        const plan = panel.render(NOW);
        expect(plan.kind).toBe('direct');
        expect(plan.turnBack).toBe(true);
        expect(cellText('TO')).toBe('RWY 06/24 turn back');
        // an ordinary approach from outside keeps "nearest part"
        sit = situation(180, 6, 5500, 360);
        expect(panel.render(NOW).turnBack).toBe(false);
        expect(cellText('TO')).toBe('RWY 06/24 nearest part');
    });

    it('low over the runway: "✓ OVER RWY 06/24", green, no grid, no map line', () => {
        sit = overRwy(0.5, 490, 59);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        expect(panel.render(NOW).kind).toBe('over');
        expect(block().classList.contains('glide-ok')).toBe(true);
        expect(host.querySelector('.glide-verdict').textContent).toBe('✓ OVER RWY 06/24');
        expect(host.querySelector('.glide-grid')).toBeNull();
        expect(host.querySelectorAll('.glide-lbl')).toHaveLength(0);
        expect(text()).not.toMatch(/low|high|turn/);
        expect(map.layers.size).toBe(0);
        // the wind line stays
        expect(text()).toContain('Glide: 250/14 at 6,000 ft · FIS-B');
        // from a line on the map to over the runway: the line goes
        sit = situation(180, 6, 5500, 360);
        panel.render(NOW);
        expect(map.layers.size).toBe(1);
        sit = overRwy(0.7, 480, 239);
        panel.render(NOW);
        expect(map.layers.size).toBe(0);
        expect(host.querySelector('.glide-verdict').textContent).toBe('✓ OVER RWY 06/24');
    });

    it('high pass lined up with the runway ahead: GLIDE OK, no turn, 0.0 nm; crossing it: the turn back to the mid-point', () => {
        // 300 ft above the field near the 06 end, tracking 059: ~5,700 ft of runway ahead, the glide needs ~3,800
        sit = overRwy(0.05, 486 + 300, 59, { ground_speed: 80 });
        panel = new GlidePanel(host, KLKR);
        panel.start();
        let plan = panel.render(NOW);
        expect(plan.kind).toBe('direct');
        expect(plan.spare).toBeCloseTo(300 - 200, 6);
        expect(text()).toMatch(/^✓ GLIDE OK · 100 ft high/);
        expect(cellText('TO')).toBe('RWY 06/24 nearest part');
        expect(cellText('HEADING')).toMatch(/↑ on course$/);
        expect(cellText('DISTANCE')).toBe('0.0 nm');
        // the same height crossing the runway at right angles: a turn back to the mid-point, never "+100"
        sit = overRwy(0.3, 486 + 300, 149, { ground_speed: 80 });
        plan = panel.render(NOW);
        expect(plan.kind).toBe('direct');
        expect(plan.legNm).toBeGreaterThan(0);
        expect(Math.abs(plan.turnNow)).toBeGreaterThan(60);          // toward the mid-point, ~1,200 ft up the runway
        expect(plan.spare).toBeLessThan(0);
        expect(text()).toMatch(/^✗ CANNOT REACH KLKR/);
        expect(cellText('HEADING')).toMatch(/turn (right|left) \d+°$/);
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
        sit = situation(180, 6, 5500, 0);
        panel.start();
        const cue = () => host.querySelector('.glide-turn').textContent;
        const toPoint = (panel.render(NOW).turnNow + 360) % 360;   // the track straight at the point
        sit = situation(180, 6, 5500, toPoint + 2);
        let plan = panel.render(NOW);
        expect(Math.abs(plan.turnNow)).toBeLessThanOrEqual(GlideModel.DEFAULTS.pilot.onCourseDeg);
        expect(cue()).toBe('↑ on course');
        sit = situation(180, 6, 5500, toPoint - 60);       // track left of the point: turn right
        plan = panel.render(NOW);
        expect(plan.turnNow).toBeGreaterThan(5);
        expect(cue()).toBe(`↱ turn right ${Math.round(plan.turnNow)}°`);
        sit = situation(180, 6, 5500, toPoint + 60);       // track right of the point: turn left
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
                glideWind: { from: 250, kt: 14 }, runwayWind: { kind: 'none' },
            }, S);
            expect(plan.spare).toBeCloseTo(want.spare, 6);
            expect(text()).toContain(`✓ GLIDE OK · ${Math.floor(want.spare).toLocaleString('en-US')} ft high`);
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

    it('wind line: runway METAR + the glide wind source; amber only when the 10 kt headwind is assumed; tailwind on final', async () => {
        fisbMetar = {
            raw: 'KLKR 311742Z 24012G18KT 10SM CLR 18/05 A3001',
            decoded: { observed_at: new Date(NOW - 18 * 60000).toISOString(), wind_dir: 240, wind_speed: 12, wind_gust: 18 },
            received_at: NOW - 17 * 60000,
        };
        sit = situation(180, 6, 5500, 360);
        panel = new GlidePanel(host, KLKR);
        panel.start();
        await vi.advanceTimersByTimeAsync(0);              // runwayWind() resolved -> re-rendered
        // 5,014 ft above the field: winds aloft above 1,000 ft, the METAR below (Dana 2026-11-06)
        expect(text()).toContain('Runway: METAR KLKR 240/12G18 (18 min) · Glide: 250/14 at 6,000 ft · FIS-B above 1,000 ft · METAR KLKR 240/12G18 (18 min) below');
        expect(host.querySelector('.glide-wind .glide-amber')).toBeNull();
        const S = GlideInputs.settings(), ref = { lat: KLKR.lat, lon: KLKR.lon };
        const surf = { from: 240, kt: 12, gustKt: 18, noTail: true };
        const h = 5500 - KLKR.elev_ft, wUp = (h - 1000) / ((h - 1000) + (1000 - 200));   // weights over the height glided
        const want = (gw) => GlideModel.plan({ airport: GlideInputs.airport(KLKR, S), ac: { ...GlideInputs.aircraft(sit, S, ref, NOW), vs: null },
            glideWind: gw, runwayWind: { kind: 'metar', from: 240, kt: 12, gustKt: 18 } }, S).spare;
        let plan = panel.render(NOW);
        expect(plan.spare).toBeCloseTo(want({ layers: [{ wind: { from: 250, kt: 14 }, w: wUp }, { wind: surf, w: 1 - wUp }] }), 6);

        // no winds aloft: the assumed 10 kt above 1,000 ft (only that part amber), the METAR below
        fisbWind = null;
        plan = panel.render(NOW);
        expect(text()).toContain('Runway: METAR KLKR 240/12G18 (18 min) · Glide: assumed 10 kt headwind above 1,000 ft · METAR KLKR 240/12G18 (18 min) below');
        expect([...host.querySelectorAll('.glide-wind .glide-amber')].map((e) => e.textContent)).toEqual(['assumed 10 kt headwind above 1,000 ft']);
        expect(plan.spare).toBeCloseTo(want({ layers: [{ wind: null, w: wUp }, { wind: surf, w: 1 - wUp }] }), 6);

        // below 1,000 ft above the field: the METAR alone, named once
        sit = situation(180, 2, 1200, 360);
        plan = panel.render(NOW);
        expect(text()).toContain('Wind: METAR KLKR 240/12G18 (18 min) · runway and glide');
        expect(text()).not.toContain('Runway:');
        expect(text()).not.toContain('Glide:');
        expect(host.querySelector('.glide-wind .glide-amber')).toBeNull();
        expect(plan.spare).toBeCloseTo(want(surf), 6);

        // a VRB METAR below 1,000 ft: a headwind of its speed
        panel.stop();
        fisbMetar = { ...fisbMetar, raw: 'KLKR 311742Z VRB04KT', decoded: { ...fisbMetar.decoded, wind_dir: null, wind_speed: 4, wind_gust: null } };
        panel.start();
        await vi.advanceTimersByTimeAsync(0);
        plan = panel.render(NOW);
        expect(text()).toContain('Wind: METAR KLKR VRB/04 (18 min) · runway and glide');
        expect(host.querySelector('.glide-wind .glide-amber')).toBeNull();
        expect(plan.spare).toBeCloseTo(GlideModel.plan({ airport: GlideInputs.airport(KLKR, S),
            ac: { ...GlideInputs.aircraft(sit, S, ref, NOW), vs: null }, glideWind: { headKt: 4 },
            runwayWind: { kind: 'vrb', kt: 4, gustKt: null } }, S).spare, 6);

        // no METAR and no winds aloft: the amber assumed-headwind text
        panel.stop();
        fisbMetar = null;
        panel.start();
        await vi.advanceTimersByTimeAsync(0);
        const amber = host.querySelectorAll('.glide-wind .glide-amber');
        expect([...amber].map((e) => e.textContent)).toEqual(['Glide: NO CURRENT WINDS ALOFT · 10 kt headwind assumed']);
        expect(text()).not.toContain('Runway:');

        // on final to RWY 06 with the METAR wind straight down it from behind: amber tailwind text
        panel.stop();
        fisbMetar = { raw: 'KLKR 311742Z 23910KT', received_at: NOW - 60000,
            decoded: { observed_at: new Date(NOW - 5 * 60000).toISOString(), wind_dir: 239, wind_speed: 10, wind_gust: null } };
        sit = onFinal06(0.8, 1000);
        panel.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(panel.render(NOW).kind).toBe('final');
        expect(text()).toMatch(/^✓ GLIDE OK/);
        const tw = [...host.querySelectorAll('.glide-wind .glide-amber')].map((e) => e.textContent);
        expect(tw).toEqual(['RWY 06: 10 kt TAILWIND']);    // the glide part (the METAR, surface) is not amber
        expect(text()).toContain('Wind: METAR KLKR 239/10 (5 min) · runway and glide');
        // the same tailwind when not on final: no tailwind line
        sit = situation(180, 6, 5500, 360);
        expect(panel.render(NOW).kind).toBe('direct');
        expect(text()).not.toContain('TAILWIND');
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
        expect(text()).toMatch(/^✓ GLIDE OK · [\d,]+ ft high/);
        expect(mapShapes().map((s) => s.type).sort()).toEqual(['polyline', 'ring']);

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
        expect(text()).toMatch(/^✓ GLIDE OK · [\d,]+ ft high/);
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
