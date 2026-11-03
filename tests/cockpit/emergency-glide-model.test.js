/**
 * EmergencyGlide (web/cockpit/emergency-glide.js) on the shared glide model (Task 5, ruling R17).
 *
 * Reachability comes from GlideModel.plan() via GlideInputs (the same model and settings as the
 * airport-panel glide block), not from glide_ratio and the old ground-speed / 80 kt range factor.
 *
 * Real: GlideModel, GlideInputs, GpsFix, NasrDB.haversineNm. Stubbed: the Stratux situations, FIS-B
 * winds aloft, the NASR airport query (filters by the radius it is given, like getAirportsNear), and
 * CockpitConfig where a test needs it. No terrain grid (terrain 0 everywhere).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
globalThis.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
globalThis.GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
globalThis.NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const SRC = read('web/cockpit/emergency-glide.js');
const loadEG = () => new Function(SRC + '\nreturn EmergencyGlide;')();

const NOW = Date.parse('2026-10-31T18:00:00Z');

// KLKR exactly as the 2611 NASR bundle has it (same record as tests/cockpit/glide-panel.test.js).
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
    elev_ft: 486, fac_type: 'AIRPORT', longest_rwy_ft: 6004, has_paved_rwy: true, runways: [KLKR_RWY],
};

/** A lat/lon `nm` from KLKR's reference point on true bearing `brg`. */
const at = (brg, nm) => GlideModel.fromLocal(KLKR.lat, KLKR.lon,
    { x: nm * Math.sin(brg * Math.PI / 180), y: nm * Math.cos(brg * Math.PI / 180) });

/** A WebSocket situation (true GPS MSL) `nm` from KLKR on bearing `brg`. */
function situation(brg, nm, alt, trk, over = {}) {
    const p = at(brg, nm);
    return {
        lat: p.lat, lon: p.lon, alt_msl: alt, alt_baro: alt - 200, ground_speed: 150, true_course: trk,
        vertical_speed: -700, gps_fix_quality: 1, timestamp: NOW - 500, ...over,
    };
}

let EmergencyGlide, eg, wsSit, gdlSit, fisbWind, airports, queried, centers, events;

function setApp() {
    globalThis.window.app = {
        stratuxClient: { get situation() { return gdlSit || wsSit; }, get wsSituation() { return wsSit; } },
        fisbClient: { getNearestWind: () => fisbWind, getMetar: () => null, metars: new Map() },
        _nasrDb: {
            getAirportsNear: async (lat, lon, r) => {
                queried.push(r);
                centers.push({ lat, lon });
                return airports.filter((a) => NasrDB.haversineNm(lat, lon, a.lat, a.lon) <= r);
            },
        },
    };
}

const onEmergency = (e) => events.push(e.detail);
const lastRanked = () => events[events.length - 1].ranked;
const reachableIds = () => lastRanked().filter((a) => a._reachable).map((a) => a.icao).sort();
const byId = (id) => lastRanked().find((a) => a.icao === id);

/** The plan the shared model gives for `rec` from situation `s` (what the airport panel would compute). */
function modelPlan(rec, s, wind) {
    const S = GlideInputs.settings();
    const apt = GlideInputs.airport(rec, S);
    const ac = GlideInputs.aircraft(s, S, apt.refLatLon, NOW);
    return GlideModel.plan({ airport: apt, ac, glideWind: wind, runwayWind: { kind: 'none' }, preferDirect: false }, S);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    document.body.innerHTML = '';
    localStorage.clear();
    delete globalThis.CockpitConfig;
    delete globalThis.window.terrainGrid;
    EmergencyGlide = loadEG();
    eg = new EmergencyGlide();
    wsSit = null;
    gdlSit = null;
    fisbWind = null;
    airports = [KLKR];
    queried = [];
    centers = [];
    events = [];
    setApp();
    document.addEventListener('engineml:emergency', onEmergency);
});

afterEach(() => {
    document.removeEventListener('engineml:emergency', onEmergency);
    vi.useRealTimers();
    globalThis.window.app = undefined;
    delete globalThis.CockpitConfig;
});

describe('EmergencyGlide on the shared glide model', () => {
    it('cruise ground speed no longer inflates range', async () => {
        // 8 nm south of KLKR at 6,000 ft, 150 kt GS, no winds aloft. The old code took range as
        // 6,000 x 10 / 6076 x min(1.3, 150 / 80) = 12.8 nm and clearance 6,000 - (8 x 607.6 + 486 + 500) = +153 ft
        // -> reachable. The model (65 KIAS / 700 fpm, 10 kt headwind assumed without wind data) is short.
        wsSit = situation(180, 8, 6000, 360);
        expect(modelPlan(KLKR, wsSit, null).spare).toBeLessThan(0);
        await eg.trigger();
        const k = byId('KLKR');
        expect(k).toBeDefined();
        expect(k._reachable).toBe(false);
        expect(k._clearance).toBe(Math.round(modelPlan(KLKR, wsSit, null).spare));
        expect(document.querySelector('.eg-item--marginal')).not.toBeNull();   // the first item keeps its BEST OPTION badge
        expect(k._descentFpm).toBeGreaterThan(0);                              // a rate exists ...
        expect(document.querySelector('.eg-apt-detail').textContent).not.toContain('fpm');   // ... but MARGINAL hides it
    });

    it('headwind shrinks the reachable set', async () => {
        // A second field 2 nm east of the aircraft (no runway coordinates -> plan to its reference point).
        const p = at(180, 7);
        const near = GlideModel.fromLocal(p.lat, p.lon, { x: 2, y: 0 });
        const KNEAR = { icao: 'KNEAR', name: 'Near', lat: near.lat, lon: near.lon, elev_ft: 500, fac_type: 'AIRPORT', runways: [] };
        airports = [KLKR, KNEAR];
        wsSit = situation(180, 7, 6000, 360);      // 7 nm south of KLKR, 6,000 ft, northbound, same GS both runs

        fisbWind = { dir: 0, spd: 0, alt: 6000, lat: wsSit.lat, lon: wsSit.lon, station: 'CLT', received_at: NOW - 60000 };
        await eg.trigger({ testMode: false });
        expect(reachableIds()).toEqual(['KLKR', 'KNEAR']);

        fisbWind = { ...fisbWind, dir: 360, spd: 30 };     // 30 kt on the nose toward KLKR
        eg._lastTriggerTime = 0;                            // past the 60 s re-trigger debounce
        await eg.trigger();
        expect(reachableIds()).toEqual(['KNEAR']);
        expect(byId('KLKR')._clearance).toBe(Math.round(modelPlan(KLKR, wsSit, { from: 360, kt: 30 }).spare));
    });

    it('keeps the showAboveGsKt ground-speed gate (the airport panel dropped it for ENGINE OUT; this did not)', async () => {
        // KNEAR 2 nm away at 6,000 ft: reachable at 150 kt. The same situation at 12 kt (below the default
        // 25 kt) gives GlideInputs.aircraft() null -> every airport MARGINAL, exactly as before.
        const p = at(180, 7);
        const near = GlideModel.fromLocal(p.lat, p.lon, { x: 2, y: 0 });
        const KNEAR = { icao: 'KNEAR', name: 'Near', lat: near.lat, lon: near.lon, elev_ft: 500, fac_type: 'AIRPORT', runways: [] };
        airports = [KNEAR];
        fisbWind = { dir: 0, spd: 0, alt: 6000, lat: p.lat, lon: p.lon, station: 'CLT', received_at: NOW - 60000 };
        wsSit = situation(180, 7, 6000, 360);
        await eg.trigger({ testMode: false });
        expect(byId('KNEAR')._reachable).toBe(true);

        wsSit = situation(180, 7, 6000, 360, { ground_speed: 12 });
        eg._lastTriggerTime = 0;
        await eg.trigger({ testMode: false });
        expect(byId('KNEAR')._reachable).toBe(false);

        // a configured gate is still honoured: 160 kt minimum -> 150 kt is below it
        globalThis.CockpitConfig = { aircraft: () => undefined, get: (k) => (k === 'engineOutGlide' ? { showAboveGsKt: 160 } : undefined) };
        wsSit = situation(180, 7, 6000, 360);
        eg._lastTriggerTime = 0;
        await eg.trigger({ testMode: false });
        expect(byId('KNEAR')._reachable).toBe(false);
    });

    it('no glide_ratio read', async () => {
        const asked = [];
        globalThis.CockpitConfig = {
            aircraft: (path) => { asked.push(path); return path === 'performance.glide_ratio' ? 30 : undefined; },
            get: () => undefined,
        };
        wsSit = situation(180, 8, 6000, 360);
        await eg.trigger();
        expect(asked.some((p) => /glide_ratio/.test(p))).toBe(false);
        expect(byId('KLKR')._reachable).toBe(false);       // a stored glide_ratio of 30 changes nothing
        expect(SRC).not.toMatch(/glide_ratio|_windAdjustRange|GLIDE_RATIO|GLIDE_SPEED_KT|PATTERN_BUFFER_FT/);
        const ev = events[0];
        expect('glide_ratio' in ev || 'glide_range_nm' in ev || 'adjusted_range_nm' in ev).toBe(false);
        expect(ev.search_radius_nm).toBeGreaterThan(0);
        expect(ev.glide_settings).toEqual(GlideInputs.settings());
    });

    it('airport query radius (R18): height above sea level + 300 ft, still-air ratio, full tailwind, x 1.1, + 2 nm', async () => {
        wsSit = situation(180, 8, 6000, 360);
        fisbWind = { dir: 90, spd: 20, alt: 6000, lat: wsSit.lat, lon: wsSit.lon, station: 'CLT', received_at: NOW - 60000 };
        await eg.trigger();
        const tas = 65 * (1 + 0.02 * 6000 / 1000), sink = 700 * tas / 65;
        const expected = (6000 + 300) / 6076.12 * (tas * 101.269 / sink) * ((tas + 20) / tas) * 1.1 + 2;
        expect(queried[0]).toBeCloseTo(expected, 6);
        expect(events[0].search_radius_nm).toBeCloseTo(expected, 1);
        const sub = document.querySelector('.eg-subtitle').textContent.replace(/\s+/g, ' ');
        expect(sub).toContain(`within ${events[0].search_radius_nm} nm |`);
        expect(sub).not.toContain('glide range');
    });

    it('ridge: a valley airport reachable from high terrain is queried and reachable', async () => {
        // 3 nm south of KLKR at 4,000 ft GPS MSL over a 3,000 ft ridge (1,000 ft AGL) that falls away to the field.
        // A radius from the AGL height (R17) was 1.7 nm and left KLKR out; the model gives it height to spare.
        wsSit = situation(180, 3, 4000, 360);
        const ridge = { lat: wsSit.lat, lon: wsSit.lon };
        globalThis.window.terrainGrid = {
            isLoaded: true,
            getElevationFt: (lat, lon) => (NasrDB.haversineNm(lat, lon, ridge.lat, ridge.lon) < 0.5 ? 3000 : 486),
        };
        expect(modelPlan(KLKR, wsSit, null).spare).toBeGreaterThanOrEqual(0);
        await eg.trigger();
        expect(events[0].alt_agl).toBe(1000);
        expect(queried[0]).toBeGreaterThan(3);
        expect(byId('KLKR')).toBeDefined();
        expect(byId('KLKR')._reachable).toBe(true);
    });

    it('the radius is never smaller than the distance to an airport the model calls reachable', () => {
        const S = GlideInputs.settings();
        const winds = [null, { from: 0, kt: 0 }, { from: 180, kt: 40 }, { from: 0, kt: 40 }, { from: 90, kt: 25 }];
        let reachable = 0, worst = 0;
        for (const alt of [800, 1500, 3000, 6000, 10000, 15000]) {
            for (const brg of [0, 45, 90, 135, 180, 225, 270, 315]) {
                for (const nm of [0.3, 1, 2, 3, 5, 8, 12, 18, 25, 35, 50]) {
                    for (const trk of [0, 90, 180, 270]) {
                        for (const wind of winds) {
                            const s = situation(brg, nm, alt, trk);
                            const plan = modelPlan(KLKR, s, wind);
                            if (!(plan.spare >= 0)) continue;
                            reachable++;
                            const d = NasrDB.haversineNm(s.lat, s.lon, KLKR.lat, KLKR.lon);
                            const r = eg._searchRadiusNm(alt, wind, S);
                            worst = Math.max(worst, d / r);
                            expect(r).toBeGreaterThanOrEqual(d);
                        }
                    }
                }
            }
        }
        expect(reachable).toBeGreaterThan(100);       // the sweep really exercises reachable cases
        expect(worst).toBeLessThan(1);
    });

    it('altitude is the WebSocket situation alt_msl: a later GDL 90 situation (ellipsoid height) is ignored', async () => {
        wsSit = situation(180, 8, 6000, 360);
        gdlSit = { ...wsSit, alt_msl: 9000 };               // 3,000 ft high: would make KLKR reachable at 8 nm
        await eg.trigger();
        expect(byId('KLKR')._reachable).toBe(false);
        expect(events[0].alt_msl).toBe(6000);
        expect(queried[0]).toBeCloseTo(eg._searchRadiusNm(6000, null, GlideInputs.settings()), 9);   // fresh WS: its altitude
    });

    it('WebSocket 6 s old, GDL 90 fresh: position, headings and distances from GDL 90; every airport MARGINAL', async () => {
        // the WebSocket dropped 6 s ago 10 nm further south; GDL 90 keeps the position current, 3 nm south of KLKR
        wsSit = situation(180, 10, 6000, 360, { timestamp: NOW - 6000 });
        gdlSit = situation(200, 3, 6100, 20, { timestamp: NOW - 300 });
        const KNEAR = { ...KLKR, icao: 'KNEAR', name: 'Near', ...at(270, 2), runways: [] };
        airports = [KLKR, KNEAR];
        await eg.trigger();
        expect(centers[0]).toEqual({ lat: gdlSit.lat, lon: gdlSit.lon });
        // radius altitude: GDL 90 alt_msl (ellipsoid height) + the geoid allowance
        expect(queried[0]).toBeCloseTo(eg._searchRadiusNm(6100 + EmergencyGlide.GEOID_ALLOWANCE_FT, null, GlideInputs.settings()), 9);
        expect(EmergencyGlide.GEOID_ALLOWANCE_FT).toBe(350);
        for (const id of ['KLKR', 'KNEAR']) {
            const a = byId(id);
            expect(a._reachable).toBe(false);
            expect(a._descentFpm).toBe(9999);
            expect(Number.isFinite(a._score)).toBe(true);
            expect(a._distNm).toBe(parseFloat(NasrDB.haversineNm(gdlSit.lat, gdlSit.lon, a.lat, a.lon).toFixed(1)));
            expect(a._hdg).toBe(eg._bearingTo(gdlSit.lat, gdlSit.lon, a.lat, a.lon));
        }
        expect(byId('KLKR')._distNm).toBeCloseTo(3, 0);
        expect(events[0].lat).toBe(gdlSit.lat);
        expect(events[0].alt_msl).toBe(null);               // no true-MSL altitude (the WebSocket is stale)
    });

    it('no WebSocket situation at all: GDL 90 position, every airport MARGINAL', async () => {
        gdlSit = situation(180, 3, 6000, 360);
        wsSit = null;
        await eg.trigger();
        expect(byId('KLKR')._reachable).toBe(false);
        expect(centers[0]).toEqual({ lat: gdlSit.lat, lon: gdlSit.lon });
    });

    it('fresh position but no altitude anywhere: the nearest airports (allowance-only radius) as MARGINAL', async () => {
        wsSit = situation(180, 10, 6000, 360, { timestamp: NOW - 6000 });
        gdlSit = situation(180, 1.5, 0, 360, { alt_msl: undefined });
        await eg.trigger();
        expect(queried[0]).toBeCloseTo(eg._searchRadiusNm(0, null, GlideInputs.settings()), 9);
        expect(queried[0]).toBeGreaterThan(EmergencyGlide.RUNWAY_ALLOWANCE_NM);
        expect(byId('KLKR')).toBeDefined();
        expect(byId('KLKR')._reachable).toBe(false);
    });

    it('a fresh Stratux situation with no fix (fix 0, last lat/lon) -> the no-GPS overlay, no list', async () => {
        // Stratux keeps sending the last position after the fix is lost: bearings from it would be wrong.
        wsSit = situation(180, 3, 6000, 360, { gps_fix_quality: 0 });
        await eg.trigger();
        expect(document.querySelector('#emergencyGlideOverlay').textContent).toContain('No GPS');
        expect(events.length).toBe(0);

        // the same through GDL 90 (the position valid bit off maps to 0), and dead reckoning (6) is not a fix
        for (const q of [0, 6]) {
            wsSit = null;
            gdlSit = situation(180, 3, 6000, 360, { gps_fix_quality: q });
            eg._lastTriggerTime = 0;
            await eg.trigger();
            expect(document.querySelector('#emergencyGlideOverlay').textContent).toContain('No GPS');
            expect(events.length).toBe(0);
        }
    });

    it('both situations stale (or none) -> the no-GPS overlay', async () => {
        wsSit = situation(180, 3, 6000, 360, { timestamp: NOW - 6000 });
        gdlSit = situation(180, 3, 6000, 360, { timestamp: NOW - 5001 });
        await eg.trigger();
        expect(document.querySelector('#emergencyGlideOverlay').textContent).toContain('No GPS');
        expect(events.length).toBe(0);

        wsSit = null; gdlSit = null;
        eg._lastTriggerTime = 0;
        await eg.trigger();
        expect(document.querySelector('#emergencyGlideOverlay').textContent).toContain('No GPS');
        expect(events.length).toBe(0);
    });

    /** The situation the real EngineGpsBridge injects from Pi engine data 3 nm S of KLKR (Stratux WS stale). */
    function bridgeSituation(extra = {}) {
        const EngineGpsBridge = new Function(`${read('web/shared/gps-staleness.js')}\n${read('web/shared/engine-gps-bridge.js')}\nreturn EngineGpsBridge;`)();
        const p = at(180, 3);
        const stratux = new EventTarget();
        Object.assign(stratux, { situation: null, wsSituation: null, stale: true, _suppressGpsSituation: false });
        const engine = { stale: false, lastData: { latitude: p.lat, longitude: p.lon, gps_altitude: 6000, ground_speed: 120, course: 360, pitch: 0, bank: 0, acc_vert: 1, ...extra } };
        const bridge = Object.create(EngineGpsBridge.prototype);
        Object.assign(bridge, { _stratux: stratux, _engine: engine, _active: false, _staleTimer: null });
        globalThis.DiagLog = globalThis.DiagLog || { log: () => {} };
        bridge._tick();
        clearTimeout(bridge._staleTimer);
        return { stratux, p };
    }

    it('engine-GPS bridge, Pi cannot reach the Stratux (gps_fix_quality 0, frozen position re-stamped fresh) -> no-GPS overlay', async () => {
        const { stratux } = bridgeSituation({ gps_fix_quality: 0 });
        expect(stratux.situation.timestamp).toBe(NOW);
        expect(stratux.situation.gps_fix_quality).toBe(0);
        window.app.stratuxClient = stratux;
        await eg.trigger();
        expect(document.querySelector('#emergencyGlideOverlay').textContent).toContain('No GPS');
        expect(events.length).toBe(0);
    });

    it('engine-GPS bridge (Stratux situation WS stale, Pi engine data fresh, fix 1): airports listed as MARGINAL, not "No GPS"', async () => {
        // The real EngineGpsBridge builds the situation from the Pi's engine data. It had no timestamp, so the
        // freshness gate above showed the no-GPS overlay whenever the bridge was the position source.
        const { stratux, p } = bridgeSituation({ gps_fix_quality: 1 });
        expect(stratux.situation._source).toBe('engine');
        expect(stratux.situation.timestamp).toBe(NOW);
        window.app.stratuxClient = stratux;

        await eg.trigger();
        expect(document.querySelector('#emergencyGlideOverlay')?.textContent || '').not.toContain('No GPS');
        expect(events).toHaveLength(1);
        expect(centers[0]).toEqual({ lat: p.lat, lon: p.lon });
        expect(byId('KLKR')).toBeDefined();
        expect(byId('KLKR')._reachable).toBe(false);          // no WebSocket altitude -> MARGINAL
        expect(document.querySelector('.eg-badge--marginal, .eg-item--marginal')).not.toBeNull();
    });

    it('test mode on the ground: simulated altitude AGL, glide speed floor, no ground-speed gate', async () => {
        // parked 3 nm south of KLKR at field elevation, 0 kt: aircraft() would give null (below showAboveGsKt)
        wsSit = situation(180, 3, 500, 0, { ground_speed: 0 });
        await eg.trigger({ testMode: true });
        const k = byId('KLKR');
        expect(k._reachable).toBe(true);                     // 5,000 ft AGL simulated (default test_alt_agl_ft)
        expect(Number.isFinite(k._clearance)).toBe(true);
        expect(events[0].alt_agl).toBe(5000);
        expect(document.querySelector('.eg-overlay--test')).not.toBeNull();
        expect(document.querySelector('.eg-apt-detail').textContent).toContain(`${k._descentFpm.toLocaleString()} fpm`);
    });
});
