/**
 * Airport panel nav row (web/cockpit/airport-popup.js: AirportPopup.navRow / _navHtml / _startNav):
 *   line 1  "HDG° · D nm · ↓ R fpm"   (magnetic bearing to the airport, great-circle distance, descent)
 *   line 2  "pattern alt: N ft"
 *
 * Every number is checked against an INDEPENDENT reference written here (not the production helpers):
 *   bearing  - unit vectors in Earth-centred coordinates projected on the local north / east axes
 *   distance - the Vincenty special case of the great-circle formula (atan2 form), R = 3440.065 nm
 *   descent  - (alt - patternAlt) / (D / GS * 60) rounded to 10 fpm, by hand from those
 * Real MagVar (WMM2025) and real NasrDB.haversineNm; real NASR records (KLKR, 2CN8) from the bundle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const read = (p) => readFileSync(p, 'utf8');
const MagVar = new Function(read('web/shared/mag-var.js') + '\nreturn MagVar;')();
const GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
const POPUP_SRC = read('web/cockpit/airport-popup.js');
const loadPopup = () => new Function(POPUP_SRC + '\nreturn AirportPopup;')();

const FIX = JSON.parse(read('tests/fixtures/airport-panel/nasr-airports.json'));
const KLKR = FIX.airports.KLKR;
const C2CN8 = FIX.airports['2CN8'];

// ---- Independent reference ---------------------------------------------------------------
const R_NM = 3440.065;
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const vec = (lat, lon) => [Math.cos(rad(lat)) * Math.cos(rad(lon)), Math.cos(rad(lat)) * Math.sin(rad(lon)), Math.sin(rad(lat))];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Initial true bearing: the direction to point 2 in point 1's local north / east plane. */
function refBearing(lat1, lon1, lat2, lon2) {
    const p = vec(lat1, lon1), q = vec(lat2, lon2);
    const east = [-Math.sin(rad(lon1)), Math.cos(rad(lon1)), 0];
    const north = [-Math.sin(rad(lat1)) * Math.cos(rad(lon1)), -Math.sin(rad(lat1)) * Math.sin(rad(lon1)), Math.cos(rad(lat1))];
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    return (deg(Math.atan2(dot(d, east), dot(d, north))) + 360) % 360;
}
/** Great-circle distance, Vincenty's special case for a sphere (well-conditioned at all distances). */
function refDistNm(lat1, lon1, lat2, lon2) {
    const f1 = rad(lat1), f2 = rad(lat2), dl = rad(lon2 - lon1);
    const a = Math.cos(f2) * Math.sin(dl);
    const b = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    const c = Math.sin(f1) * Math.sin(f2) + Math.cos(f1) * Math.cos(f2) * Math.cos(dl);
    return R_NM * Math.atan2(Math.hypot(a, b), c);
}
/** Reference magnetic heading text: 1..360, 3 digits. */
function refHdgTxt(lat, lon, aptLat, aptLon) {
    let m = refBearing(lat, lon, aptLat, aptLon) - MagVar.declination(lat, lon);
    m = Math.round(((m % 360) + 360) % 360);
    if (m === 0) m = 360;
    return String(m).padStart(3, '0');
}
/** Point `nm` from (lat, lon) on true bearing `brg` (sphere) - only to build test positions. */
function dest(lat, lon, brg, nm) {
    const d = nm / R_NM, t = rad(brg), f1 = rad(lat), l1 = rad(lon);
    const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return { lat: deg(f2), lon: ((deg(l2) + 540) % 360) - 180 };
}

const NOW = Date.parse('2026-11-04T18:00:00Z');
const sitAt = (p, over = {}) => ({
    lat: p.lat, lon: p.lon, alt_msl: 3000, ground_speed: 120, true_course: 0, gps_fix_quality: 1,
    timestamp: NOW - 500, ...over,
});
const sc = (situation, wsSituation = situation) => ({ situation, wsSituation });

let AirportPopup;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    globalThis.MagVar = MagVar;
    globalThis.GpsFix = GpsFix;
    globalThis.NasrDB = NasrDB;
    globalThis.wireTap = wireTap;
    delete globalThis.CockpitConfig;
    delete globalThis.GlidePanel;
    delete globalThis.GlideInputs;
    AirportPopup = loadPopup();
});
afterEach(() => {
    vi.useRealTimers();
    globalThis.window.app = undefined;
    for (const k of ['MagVar', 'GpsFix', 'NasrDB', 'CockpitConfig']) delete globalThis[k];
});

describe('real NASR records (fixture = the bundle, verbatim)', () => {
    const BUNDLE = `${homedir()}/flytab-pipeline/data/nasr/bundle.json`;
    it.skipIf(!existsSync(BUNDLE))('the fixture records equal the current bundle\'s KLKR and 2CN8', () => {
        const b = JSON.parse(read(BUNDLE));
        for (const id of ['KLKR', '2CN8']) {
            expect(b.airports.find((a) => a.icao === id)).toEqual(FIX.airports[id]);
        }
    });
    it('KLKR has no published TPA (tpa_ft 0); 2CN8 publishes one, stored MSL (elev 4610 + 800 AGL)', () => {
        expect(KLKR.elev_ft).toBe(486);
        expect(KLKR.tpa_ft).toBe(0);
        expect(C2CN8.elev_ft).toBe(4610);
        expect(C2CN8.tpa_ft).toBe(5410);
    });
});

describe('pattern altitude', () => {
    it('KLKR (tpa_ft 0): elevation + the 1000 ft default -> 1,486', () => {
        expect(AirportPopup.patternAltFt(KLKR)).toBe(1486);
    });
    it('KLKR with CockpitConfig patternAltAboveFieldFt 800 -> 1,286; config null -> the 1000 default', () => {
        globalThis.CockpitConfig = { get: (k) => (k === 'patternAltAboveFieldFt' ? 800 : undefined) };
        expect(AirportPopup.patternAltFt(KLKR)).toBe(1286);
        globalThis.CockpitConfig = { get: () => null };
        expect(AirportPopup.patternAltFt(KLKR)).toBe(1486);
    });
    it('2CN8 (tpa_ft 5410, already MSL): 5,410 as is - never elevation + tpa_ft, whatever the config', () => {
        globalThis.CockpitConfig = { get: () => 800 };
        expect(AirportPopup.patternAltFt(C2CN8)).toBe(5410);
    });
    it('no elevation -> null, and line 2 is omitted', () => {
        const rec = { ...KLKR, elev_ft: null };
        expect(AirportPopup.patternAltFt(rec)).toBeNull();
        expect(AirportPopup._navHtml(AirportPopup.navRow(rec, null, NOW))).toBe('');
    });
    it('line 2 text: "pattern alt: 1,486 ft" (always shown when there is an elevation, even with no GPS)', () => {
        const html = AirportPopup._navHtml(AirportPopup.navRow(KLKR, sc(null, null), NOW));
        const d = document.createElement('div'); d.innerHTML = html;
        expect(d.querySelector('.apt-nav-line')).toBeNull();
        expect(d.querySelector('.apt-nav-pattern').textContent).toBe('pattern alt: 1,486 ft');
    });
});

describe('heading and distance against the independent reference', () => {
    // [name, aircraft position, airport]
    const KCLT = { lat: 35.2140, lon: -80.9431 };
    const YSSY = { lat: -33.9461, lon: 151.1772 }, YSBK = { lat: -33.9244, lon: 150.9881 };
    const NFFN = { lat: -17.7554, lon: 177.4434 };
    const PAIRS = [
        ['KCLT -> KLKR (real pair, ~30 nm)', KCLT, KLKR],
        ['true bearing just west of north from KLKR area (magnetic crosses 360 -> 00x)', dest(KLKR.lat, KLKR.lon, 175, 12), KLKR],
        ['true bearing just east of north', dest(KLKR.lat, KLKR.lon, 183, 12), KLKR],
        ['southern / eastern hemisphere: YSBK -> YSSY (east declination)', YSBK, YSSY],
        ['across the antimeridian: -17.0, -179.8 -> NFFN', { lat: -17.0, lon: -179.8 }, NFFN],
        ['0.3 nm from KLKR', dest(KLKR.lat, KLKR.lon, 300, 0.3), KLKR],
        ['150 nm from KLKR', dest(KLKR.lat, KLKR.lon, 80, 150), KLKR],
    ];
    it.each(PAIRS)('%s', (_name, ac, apt) => {
        const nav = AirportPopup.navRow(apt, sc(sitAt(ac)), NOW);
        expect(nav.pos).toBe(true);
        expect(nav.hdgTrueOnly).toBe(false);
        expect(nav.hdg).toBe(refHdgTxt(ac.lat, ac.lon, apt.lat, apt.lon));
        const ref = refDistNm(ac.lat, ac.lon, apt.lat, apt.lon);
        expect(Math.abs(nav.distNm - ref)).toBeLessThan(1e-6);
        // displayed distance text
        const want = (Math.round(ref * 10) / 10) < 100 ? (Math.round(ref * 10) / 10).toFixed(1) : String(Math.round(ref));
        expect(AirportPopup._fmtNm(nav.distNm)).toBe(want);
    });

    it('the 360 crossing really is exercised: west-of-north true bearing gives a small magnetic heading', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 175, 12);
        const tru = refBearing(ac.lat, ac.lon, KLKR.lat, KLKR.lon);
        expect(tru).toBeGreaterThan(350);               // true ~355
        expect(Number(refHdgTxt(ac.lat, ac.lon, KLKR.lat, KLKR.lon))).toBeLessThan(10);   // magnetic ~003
    });

    it('magnetic = true - declination, with the KLKR declination west (negative) as mag-var.test.js has it', () => {
        const ac = { lat: 35.2140, lon: -80.9431 };
        const decl = MagVar.declination(ac.lat, ac.lon);
        expect(decl).toBeLessThan(-7);
        expect(decl).toBeGreaterThan(-9);
        const nav = AirportPopup.navRow(KLKR, sc(sitAt(ac)), NOW);
        const tru = refBearing(ac.lat, ac.lon, KLKR.lat, KLKR.lon);
        // west declination: magnetic is MORE than true by |decl|
        expect(Number(nav.hdg)).toBe(Math.round(tru - decl));
        expect(Number(nav.hdg)).toBeGreaterThan(Math.round(tru));
        // Sydney: east declination, magnetic LESS than true
        const syd = AirportPopup.navRow({ lat: -33.9461, lon: 151.1772 }, sc(sitAt({ lat: -33.9244, lon: 150.9881 })), NOW);
        expect(MagVar.declination(-33.9244, 150.9881)).toBeGreaterThan(10);
        expect(Number(syd.hdg)).toBeLessThan(refBearing(-33.9244, 150.9881, -33.9461, 151.1772));
    });

    it('heading text is 1..360, 3 digits: 0 / 359.6 / 0.4 -> 360, 0.6 -> 001, 53 -> 053', () => {
        expect(AirportPopup._hdg3(0)).toBe('360');
        expect(AirportPopup._hdg3(359.6)).toBe('360');
        expect(AirportPopup._hdg3(0.4)).toBe('360');
        expect(AirportPopup._hdg3(-0.4)).toBe('360');
        expect(AirportPopup._hdg3(0.6)).toBe('001');
        expect(AirportPopup._hdg3(53)).toBe('053');
        expect(AirportPopup._hdg3(-7)).toBe('353');
    });

    it('distance text: one decimal below 100 nm, whole nm at/above 100 (99.96 -> "100")', () => {
        expect(AirportPopup._fmtNm(0.3)).toBe('0.3');
        expect(AirportPopup._fmtNm(6.24)).toBe('6.2');
        expect(AirportPopup._fmtNm(99.94)).toBe('99.9');
        expect(AirportPopup._fmtNm(99.96)).toBe('100');
        expect(AirportPopup._fmtNm(150.4)).toBe('150');
        expect(AirportPopup._fmtNm(1234.6)).toBe('1,235');
    });

    it('no MagVar: true heading marked "°T", never shown as magnetic', () => {
        delete globalThis.MagVar;
        const ac = { lat: 35.2140, lon: -80.9431 };
        const nav = AirportPopup.navRow(KLKR, sc(sitAt(ac)), NOW);
        expect(nav.hdgTrueOnly).toBe(true);
        expect(nav.hdg).toBe(AirportPopup._hdg3(refBearing(ac.lat, ac.lon, KLKR.lat, KLKR.lon)));
        expect(AirportPopup._navHtml(nav)).toContain(`${nav.hdg}°T ·`);
    });
});

describe('position gate', () => {
    const ac = dest(KLKR.lat, KLKR.lon, 45, 10);
    it('no situation / stale (> 5 s) / no 3D fix / 0,0 -> left side empty (pattern line stays)', () => {
        for (const s of [null, sitAt(ac, { timestamp: NOW - 5001 }), sitAt(ac, { gps_fix_quality: 0 }),
            sitAt(ac, { gps_fix_quality: 6 }), sitAt({ lat: 0, lon: 0 }), sitAt(ac, { gps_3d: false })]) {
            const nav = AirportPopup.navRow(KLKR, sc(s), NOW);
            expect(nav.pos).toBe(false);
            const html = AirportPopup._navHtml(nav);
            expect(html).not.toContain('apt-nav-line');
            expect(html).toContain('pattern alt: 1,486 ft');
        }
    });
    it('exactly 5 s old is still fresh', () => {
        expect(AirportPopup.navRow(KLKR, sc(sitAt(ac, { timestamp: NOW - 5000 })), NOW).pos).toBe(true);
    });
    it('the freshest of situation / wsSituation gives the position (GDL 90 lat/lon are fine)', () => {
        const old = sitAt(dest(KLKR.lat, KLKR.lon, 45, 20), { timestamp: NOW - 3000 });
        const gdl = sitAt(ac, { timestamp: NOW - 200 });
        const nav = AirportPopup.navRow(KLKR, sc(gdl, old), NOW);
        expect(Math.abs(nav.distNm - refDistNm(ac.lat, ac.lon, KLKR.lat, KLKR.lon))).toBeLessThan(1e-6);
    });
    it('a stale GDL 90 situation falls back to a fresh WebSocket one', () => {
        const ws = sitAt(ac, { timestamp: NOW - 1000 });
        const gdl = sitAt(dest(KLKR.lat, KLKR.lon, 45, 20), { timestamp: NOW - 9000 });
        const nav = AirportPopup.navRow(KLKR, sc(gdl, ws), NOW);
        expect(Math.abs(nav.distNm - refDistNm(ac.lat, ac.lon, KLKR.lat, KLKR.lon))).toBeLessThan(1e-6);
    });
});

describe('descent rate', () => {
    const PAT = 1486;
    /** The reference rate for a position `ac`, altitude and ground speed. */
    const refRate = (ac, alt, gs) => {
        const d = refDistNm(ac.lat, ac.lon, KLKR.lat, KLKR.lon);
        return Math.round((alt - PAT) / (d / gs * 60) / 10) * 10;
    };
    it.each([
        // [distance nm, alt, gs]
        [10, 4486, 120],       // 3000 ft over 5 min -> 600
        [6.2, 3486, 140],
        [18.4, 6000, 150],
        [0.6, 2000, 90],
        [9.1, 2500, 30],       // GS exactly 30: shown
    ])('D %s nm, %s ft, %s kt -> reference rate, rounded to 10 fpm', (nm, alt, gs) => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, nm);
        const s = sitAt(ac, { alt_msl: alt, ground_speed: gs });
        const nav = AirportPopup.navRow(KLKR, sc(s), NOW);
        const want = refRate(ac, alt, gs);
        expect(nav.descent).toBe(want);
        expect(want % 10).toBe(0);
        expect(AirportPopup._navHtml(nav)).toContain(`${nav.hdg}° · ${AirportPopup._fmtNm(nav.distNm)} nm · ↓ ${want.toLocaleString('en-US')} fpm`);
    });
    it('hand check: 10 nm, 3,000 ft above pattern alt, 120 kt -> 600 fpm', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, 10);
        expect(refDistNm(ac.lat, ac.lon, KLKR.lat, KLKR.lon)).toBeCloseTo(10, 6);
        expect(AirportPopup.navRow(KLKR, sc(sitAt(ac, { alt_msl: 4486, ground_speed: 120 })), NOW).descent).toBe(600);
    });
    it('within 100 ft of pattern alt (or below it) -> "at pattern alt"; 101 ft above -> a rate', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, 5);
        for (const alt of [PAT + 100, PAT, PAT - 500]) {
            const nav = AirportPopup.navRow(KLKR, sc(sitAt(ac, { alt_msl: alt })), NOW);
            expect(nav.descent).toBe('at');
            expect(AirportPopup._navHtml(nav)).toContain(' nm · at pattern alt</div>');
        }
        expect(Number.isFinite(AirportPopup.navRow(KLKR, sc(sitAt(ac, { alt_msl: PAT + 101 })), NOW).descent)).toBe(true);
    });
    it('above pattern alt but D <= 0.5 nm or GS < 30 kt -> descent omitted (line 1 = "HDG° · D nm")', () => {
        const near = dest(KLKR.lat, KLKR.lon, 230, 0.49);   // (0.5 itself is a float boundary)
        const far = dest(KLKR.lat, KLKR.lon, 230, 8);
        for (const [ac, gs] of [[near, 120], [far, 29], [far, 0]]) {
            const nav = AirportPopup.navRow(KLKR, sc(sitAt(ac, { alt_msl: 5000, ground_speed: gs })), NOW);
            expect(nav.descent).toBeNull();
            const d = document.createElement('div'); d.innerHTML = AirportPopup._navHtml(nav);
            expect(d.querySelector('.apt-nav-line').textContent).toBe(`${nav.hdg}° · ${AirportPopup._fmtNm(nav.distNm)} nm`);
        }
    });
    it('GS missing / non-finite -> descent omitted', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, 8);
        for (const gs of [undefined, null, NaN]) {
            expect(AirportPopup.navRow(KLKR, sc(sitAt(ac, { alt_msl: 5000, ground_speed: gs })), NOW).descent).toBeNull();
        }
    });
    it('GDL 90 altitude is never used: only a GDL 90 situation (no WS) -> position yes, descent omitted', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, 8);
        const gdl = sitAt(ac, { alt_msl: 9000 });
        const nav = AirportPopup.navRow(KLKR, sc(gdl, null), NOW);
        expect(nav.pos).toBe(true);
        expect(nav.descent).toBeNull();
    });
    it('GDL 90 situation is the position, the fresh WS situation gives the altitude (not GDL 90\'s)', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, 8);
        const ws = sitAt(dest(KLKR.lat, KLKR.lon, 230, 8.05), { alt_msl: 4486, ground_speed: 120, timestamp: NOW - 900 });
        const gdl = sitAt(ac, { alt_msl: 4486 + 150, ground_speed: 120, timestamp: NOW - 100 });   // ellipsoid height
        const nav = AirportPopup.navRow(KLKR, sc(gdl, ws), NOW);
        expect(nav.descent).toBe(refRate(ac, 4486, 120));
        expect(nav.descent).not.toBe(refRate(ac, 4486 + 150, 120));
    });
    it('a stale or no-fix WS situation gives no altitude -> descent omitted', () => {
        const ac = dest(KLKR.lat, KLKR.lon, 230, 8);
        const gdl = sitAt(ac, { alt_msl: 5000 });
        for (const ws of [sitAt(ac, { alt_msl: 5000, timestamp: NOW - 6000 }), sitAt(ac, { alt_msl: 5000, gps_fix_quality: 0 }),
            sitAt(ac, { alt_msl: null })]) {
            expect(AirportPopup.navRow(KLKR, sc(gdl, ws), NOW).descent).toBeNull();
        }
    });
    it('2CN8: the descent is to its published 5,410 ft pattern altitude', () => {
        const ac = dest(C2CN8.lat, C2CN8.lon, 90, 10);
        const nav = AirportPopup.navRow(C2CN8, sc(sitAt(ac, { alt_msl: 8410, ground_speed: 120 })), NOW);
        const d = refDistNm(ac.lat, ac.lon, C2CN8.lat, C2CN8.lon);
        expect(nav.patternAlt).toBe(5410);
        expect(nav.descent).toBe(Math.round(3000 / (d / 120 * 60) / 10) * 10);
    });
});

describe('the nav row in the open panel', () => {
    let popup;
    const open = (rec = KLKR) => {
        popup = new AirportPopup({ closePopup() {} }, { getWeather: async () => null });
        popup.initPanel(document.body);
        popup._showPanel(rec, null);
        return popup;
    };
    const line = () => popup._panel.querySelector('.apt-nav-line');
    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.setItem('flytab_engine_out_glide_on', 'false');
        globalThis.CockpitConfig = { get: () => null, aircraft: () => undefined };
    });
    afterEach(() => { popup?.close(); localStorage.clear(); });

    it('header: ICAO + name + ✕ only (no city / CTAF / elevation line); nav row: text left, ENGINE OUT right', () => {
        window.app = { stratuxClient: sc(sitAt(dest(KLKR.lat, KLKR.lon, 230, 6.2), { alt_msl: 3486, ground_speed: 140 })) };
        open();
        const hdr = popup._panel.querySelector('.apt-panel-header');
        expect(hdr.querySelector('.apt-panel-icao').textContent).toBe('KLKR');
        expect(hdr.querySelector('.apt-panel-name').textContent).toBe(KLKR.name);
        expect(hdr.querySelector('.apt-panel-close')).not.toBeNull();
        expect(hdr.querySelector('.apt-glide-toggle')).toBeNull();
        expect(hdr.textContent).not.toMatch(/Lancaster,|UNCONTROLLED|486 ft/);
        expect(popup._panel.querySelector('.apt-panel-meta')).toBeNull();
        const row = popup._panel.querySelector('.apt-nav-row');
        expect(row.previousElementSibling).toBe(hdr);
        expect(row.lastElementChild.classList.contains('apt-glide-toggle')).toBe(true);
        expect(row.firstElementChild.classList.contains('apt-nav-text')).toBe(true);
        expect(line().textContent).toMatch(/^\d{3}° · 6\.2 nm · ↓ [\d,]+0 fpm$/);
        expect(row.textContent).not.toMatch(/FROM HERE/i);
    });

    it('updates about once a second; one timer; stopped on close and on another airport', () => {
        let s = sitAt(dest(KLKR.lat, KLKR.lon, 230, 6.2), { alt_msl: 3486, ground_speed: 140 });
        window.app = { stratuxClient: { get situation() { return s; }, get wsSituation() { return s; } } };
        const base = vi.getTimerCount();      // jsdom's localStorage.setItem queues a timer of its own
        open();
        const first = line().textContent;
        expect(vi.getTimerCount()).toBe(base + 1);
        s = sitAt(dest(KLKR.lat, KLKR.lon, 230, 5.0), { alt_msl: 3400, ground_speed: 140, timestamp: Date.now() });
        vi.advanceTimersByTime(1000);
        expect(line().textContent).not.toBe(first);
        expect(line().textContent).toContain('5.0 nm');
        // GPS lost: left side empties, the row (and the button) stay
        s = null;
        vi.advanceTimersByTime(1000);
        expect(line()).toBeNull();
        expect(popup._panel.querySelector('.apt-nav-pattern').textContent).toBe('pattern alt: 1,486 ft');
        expect(popup._panel.querySelector('.apt-nav-row .apt-glide-toggle')).not.toBeNull();
        // another airport: still one timer
        // (jsdom's storage timer has fired by now: ours is the only one left)
        expect(vi.getTimerCount()).toBe(1);
        popup._showPanel({ ...KLKR, icao: 'KXYZ' }, null);
        expect(vi.getTimerCount()).toBe(1);
        popup.close();
        expect(vi.getTimerCount()).toBe(0);
        expect(popup._navTimer).toBeNull();
    });

    it('a throwing situation getter never stops the panel from opening', () => {
        window.app = { stratuxClient: { get situation() { throw new Error('boom'); }, wsSituation: null } };
        open();
        expect(popup._panel.querySelector('.apt-tabs')).not.toBeNull();
        expect(popup._panel.querySelector('.apt-nav-row .apt-glide-toggle')).not.toBeNull();
        vi.advanceTimersByTime(3000);
        expect(popup._panel.querySelector('.apt-tabs')).not.toBeNull();
    });
});
